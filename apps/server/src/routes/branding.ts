import { buffer } from "node:stream/consumers";
import { type Database, schema } from "@hekate/db";
import {
  accentRefusal,
  brandingAccentInput,
  type StoredBranding,
  storedBrandingOf,
} from "@hekate/shared";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { type Audit, requestInfo } from "../audit.ts";
import { LogoRefused, sanitiseLogo } from "../branding.ts";
import { CodedException, NotFound } from "../errors.ts";
import { zValidator } from "../openapi/validator.ts";
import type { Storage } from "../storage.ts";
import { requireRole, type TenantVariables } from "../tenancy.ts";
import { assertStorageRoom } from "../usage.ts";

const { organisations } = schema;

export interface BrandingDeps {
  db: Database;
  storage: Storage;
  audit: Audit;
  trustProxy: boolean;
  workDir?: string;
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Changes a workspace's branding under a lock on its row, so a logo and an accent set at once
 * both stay, and logs the change with it. Gives back the branding as it was and as it is.
 */
async function changeBranding(
  deps: BrandingDeps,
  c: Context<{ Variables: TenantVariables }>,
  change: (current: StoredBranding, tx: Tx) => Promise<StoredBranding> | StoredBranding,
  details: Record<string, unknown>,
) {
  const organisationId = c.var.organisationId;
  const who = await deps.audit.member(c.var.userId);
  return deps.db.transaction(async (tx) => {
    const [row] = await tx
      .select({ branding: organisations.branding })
      .from(organisations)
      .where(eq(organisations.id, organisationId))
      .for("update");
    if (!row) throw new NotFound("Workspace");
    const before = storedBrandingOf(row.branding);
    const after = await change(before, tx);
    await tx
      .update(organisations)
      .set({ branding: after, updatedAt: new Date() })
      .where(eq(organisations.id, organisationId));
    await deps.audit.record(
      organisationId,
      who,
      { action: "organisation.branding", details },
      requestInfo(c, deps.trustProxy),
      tx,
    );
    return { before, after };
  });
}

/** Removes a logo no longer shown; one left behind is the reconciliation's to take. */
async function forget(deps: BrandingDeps, organisationId: string, blobId: string | undefined) {
  if (!blobId) return;
  await deps.storage.remove(organisationId, blobId).catch((error: unknown) => {
    console.warn(`Could not remove a replaced logo: ${String(error)}`);
  });
}

/**
 * `/api/organisation/branding` (#185): the workspace's logo and accent, set by its owners and
 * admins. Every member reads them.
 */
export const brandingRoutes = (deps: BrandingDeps) =>
  new Hono<{ Variables: TenantVariables }>()
    .get("/", async (c) => {
      const [row] = await deps.db
        .select({ branding: organisations.branding })
        .from(organisations)
        .where(eq(organisations.id, c.var.organisationId));
      if (!row) throw new NotFound("Workspace");
      return c.json({ branding: storedBrandingOf(row.branding) });
    })
    // The accent, refused where it would not read on the dark ground; null goes back to the signal.
    .put("/accent", requireRole("admin"), zValidator("json", brandingAccentInput), async (c) => {
      const { accent } = c.req.valid("json");
      const refusal = accent ? accentRefusal(accent) : null;
      if (refusal) throw new CodedException(422, "accent_illegible", refusal);
      const { after } = await changeBranding(deps, c, (current) => ({ ...current, accent }), {
        accent,
      });
      return c.json({ branding: after });
    })
    // A logo: the image is drawn again as a plain PNG before anything of it is kept.
    .post("/logo", requireRole("admin"), async (c) => {
      const organisationId = c.var.organisationId;
      let logo: Awaited<ReturnType<typeof sanitiseLogo>>;
      try {
        logo = await sanitiseLogo(new Uint8Array(await c.req.arrayBuffer()), deps.workDir);
      } catch (error) {
        if (error instanceof LogoRefused)
          throw new CodedException(422, "logo_refused", error.message);
        throw error;
      }
      // The workspace's quota (#175), before the bytes are stored and again under the lock.
      await deps.db.transaction((tx) => assertStorageRoom(tx, organisationId, logo.png.length));
      const blob = await deps.storage.put(organisationId, logo.png, { contentType: "image/png" });
      try {
        const { before, after } = await changeBranding(
          deps,
          c,
          async (current, tx) => {
            await assertStorageRoom(tx, organisationId, 0);
            return {
              ...current,
              logo: { blobId: blob.id, width: logo.width, height: logo.height },
            };
          },
          { logo: "set", width: logo.width, height: logo.height },
        );
        await forget(deps, organisationId, before.logo?.blobId);
        return c.json({ branding: after }, 201);
      } catch (error) {
        // Nothing points at the bytes: take them back.
        await deps.storage.remove(organisationId, blob.id).catch(() => undefined);
        throw error;
      }
    })
    .delete("/logo", requireRole("admin"), async (c) => {
      const { before, after } = await changeBranding(
        deps,
        c,
        (current) => ({ ...current, logo: null }),
        { logo: "removed" },
      );
      await forget(deps, c.var.organisationId, before.logo?.blobId);
      return c.json({ branding: after });
    });

/**
 * `/api/branding`: a workspace's logo, to anyone, as its sign-in page and its mail show it
 * before anyone signs in (decision 226). Only the blob a workspace's branding names as its logo answers,
 * and only as the PNG it was drawn again as when it was set: never another stored object, and
 * never what was uploaded. Its address changes with each new logo, so it is cached for good.
 */
export const logoRoutes = (deps: { db: Database; storage: Storage }) =>
  new Hono().get(
    "/:organisationId/logo/:blobId",
    zValidator("param", z.object({ organisationId: z.uuid(), blobId: z.uuid() })),
    async (c) => {
      const { organisationId, blobId } = c.req.valid("param");
      const [row] = await deps.db
        .select({ branding: organisations.branding })
        .from(organisations)
        .where(eq(organisations.id, organisationId));
      const logo = row ? storedBrandingOf(row.branding).logo : null;
      if (!logo || logo.blobId !== blobId) throw new NotFound("Logo");
      const { blob, stream } = await deps.storage.open(organisationId, blobId);
      const body = await buffer(stream);
      return c.body(body, 200, {
        "Content-Type": "image/png",
        "Content-Length": String(blob.byteSize),
        "Content-Disposition": 'inline; filename="logo.png"',
        "Cache-Control": "public, max-age=31536000, immutable",
        // Mail clients and other hosts may show it; it runs nothing wherever it is opened.
        "Cross-Origin-Resource-Policy": "cross-origin",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      });
    },
  );
