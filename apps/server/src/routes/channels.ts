import { type Database, inOrg, schema, uuidv7 } from "@hekate/db";
import {
  type ChannelKind,
  type ChannelRow,
  channelKindLabels,
  channelTarget,
  channelUrlProblem,
  createChannelInput,
  type PingBody,
  updateChannelInput,
} from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { type Audit, requestInfo } from "../audit.ts";
import { type ChannelConfig, newSigningSecret, outgoing, type Send } from "../channels.ts";
import { openConfig, resumeChannel, sealConfig, sealContext } from "../events.ts";
import type { Jobs } from "../jobs.ts";
import type { Keyring } from "../keyring.ts";
import { mayFetch } from "../sso.ts";
import { requireRole, type TenantVariables } from "../tenancy.ts";

const { channels, organisations } = schema;

const idParam = zValidator("param", z.object({ id: z.uuid() }));

export interface ChannelDeps {
  db: Database;
  keyring: Keyring;
  audit: Audit;
  jobs: Pick<Jobs, "send">;
  send: Send;
  publicUrl: string;
  /** Origins on a private network a channel may reach (WEBHOOK_TRUSTED_ORIGINS). */
  trusted: string[];
  trustProxy: boolean;
}

const rowOf = (c: typeof channels.$inferSelect): ChannelRow => ({
  id: c.id,
  kind: c.kind,
  name: c.name,
  target: c.target,
  events: c.events,
  pausedUntil: c.pausedUntil && c.pausedUntil > new Date() ? c.pausedUntil.toISOString() : null,
  failures: c.failures,
  lastDeliveredAt: c.lastDeliveredAt?.toISOString() ?? null,
  createdAt: c.createdAt.toISOString(),
});

/**
 * `/api/organisation/channels` (#161): where the workspace's events go, which events each
 * carries, and a test. Admins only. An address goes in and is never sent back; a webhook's
 * signing secret is shown once, when it is made.
 */
export const channelRoutes = (deps: ChannelDeps) => {
  const { db, keyring, audit } = deps;

  /** Refuse an address that is malformed, or on a private network the operator has not allowed. */
  const checked = async (kind: ChannelKind, url: string) => {
    let origin = "";
    try {
      origin = new URL(url).origin;
    } catch {
      // channelUrlProblem says so.
    }
    const problem = channelUrlProblem(kind, url, { allowHttp: deps.trusted.includes(origin) });
    if (problem) throw new HTTPException(422, { message: problem });
    if (!(await mayFetch(url, deps.trusted)))
      throw new HTTPException(422, {
        message:
          "That address is on a private network, or cannot be found. The operator can allow a private one with WEBHOOK_TRUSTED_ORIGINS.",
      });
    return url;
  };

  const find = async (organisationId: string, id: string) => {
    const [row] = await db
      .select()
      .from(channels)
      .where(inOrg(channels, organisationId, eq(channels.id, id)));
    if (!row) throw new HTTPException(404, { message: "No such channel" });
    return row;
  };

  const seal = async (organisationId: string, id: string, config: ChannelConfig) => {
    const { version, key } = await keyring.current(organisationId);
    return {
      configSealed: sealConfig(key, config, sealContext(organisationId, id)),
      keyVersion: version,
    };
  };

  const open = async (row: typeof channels.$inferSelect) =>
    openConfig(
      await keyring.version(row.organisationId, row.keyVersion),
      row.configSealed,
      sealContext(row.organisationId, row.id),
    );

  return (
    new Hono<{ Variables: TenantVariables }>()
      .use("*", requireRole("admin"))
      .get("/", async (c) => {
        const rows = await db
          .select()
          .from(channels)
          .where(inOrg(channels, c.var.organisationId))
          .orderBy(asc(channels.createdAt));
        return c.json({ channels: rows.map(rowOf) });
      })
      .post("/", zValidator("json", createChannelInput), async (c) => {
        const input = c.req.valid("json");
        const organisationId = c.var.organisationId;
        const url = await checked(input.kind, input.url);
        const id = uuidv7();
        const secret = input.kind === "webhook" ? newSigningSecret() : undefined;
        const [row] = await db
          .insert(channels)
          .values({
            id,
            organisationId,
            kind: input.kind,
            name: input.name,
            target: channelTarget(input.kind, url),
            events: input.events,
            createdBy: c.var.userId,
            ...(await seal(organisationId, id, { url, ...(secret ? { secret } : {}) })),
          })
          .returning();
        if (!row) throw new Error("The channel was not saved");
        await audit.record(
          organisationId,
          await audit.member(c.var.userId),
          {
            action: "organisation.channel_add",
            details: { channel: row.name, kind: row.kind, events: row.events },
          },
          requestInfo(c, deps.trustProxy),
        );
        // The secret, once: it is never shown again.
        return c.json({ channel: rowOf(row), ...(secret ? { secret } : {}) }, 201);
      })
      .patch("/:id", idParam, zValidator("json", updateChannelInput), async (c) => {
        const input = c.req.valid("json");
        const organisationId = c.var.organisationId;
        const row = await find(organisationId, c.req.valid("param").id);
        const url = input.url !== undefined ? await checked(row.kind, input.url) : undefined;
        const secret = row.kind === "webhook" && input.newSecret ? newSigningSecret() : undefined;
        const resealing = url !== undefined || secret !== undefined;
        // Opened only to seal it again: a new address keeps the secret, a new secret the address.
        const config = resealing ? await open(row) : null;
        const [changed] = await db
          .update(channels)
          .set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.events !== undefined ? { events: input.events } : {}),
            ...(config
              ? {
                  target: channelTarget(row.kind, url ?? config.url),
                  ...(await seal(organisationId, row.id, {
                    url: url ?? config.url,
                    ...((secret ?? config.secret) ? { secret: secret ?? config.secret } : {}),
                  })),
                }
              : {}),
            updatedAt: new Date(),
          })
          .where(inOrg(channels, organisationId, eq(channels.id, row.id)))
          .returning();
        if (!changed) throw new HTTPException(404, { message: "No such channel" });
        if (input.resume) await resumeChannel(db, deps.jobs, organisationId, row.id);
        await audit.record(
          organisationId,
          await audit.member(c.var.userId),
          {
            action: "organisation.channel_change",
            details: {
              channel: changed.name,
              ...(input.name !== undefined && input.name !== row.name ? { was: row.name } : {}),
              ...(input.events !== undefined ? { events: changed.events } : {}),
              ...(input.url !== undefined ? { address: "changed" } : {}),
              ...(secret ? { secret: "new" } : {}),
              ...(input.resume ? { resumed: true } : {}),
            },
          },
          requestInfo(c, deps.trustProxy),
        );
        const [fresh] = await db
          .select()
          .from(channels)
          .where(inOrg(channels, organisationId, eq(channels.id, row.id)));
        return c.json({ channel: rowOf(fresh ?? changed), ...(secret ? { secret } : {}) });
      })
      .delete("/:id", idParam, async (c) => {
        const organisationId = c.var.organisationId;
        const row = await find(organisationId, c.req.valid("param").id);
        // Its deliveries go with it.
        await db.delete(channels).where(inOrg(channels, organisationId, eq(channels.id, row.id)));
        await audit.record(
          organisationId,
          await audit.member(c.var.userId),
          { action: "organisation.channel_remove", details: { channel: row.name, kind: row.kind } },
          requestInfo(c, deps.trustProxy),
        );
        return c.body(null, 204);
      })
      // A message that says the channel works, sent now and not kept; what came back is shown.
      .post("/:id/test", idParam, async (c) => {
        const organisationId = c.var.organisationId;
        const row = await find(organisationId, c.req.valid("param").id);
        const config = await open(row).catch(() => null);
        if (!config)
          return c.json({
            ok: false,
            result: "Not sent: the channel's address could not be opened. Give it again in Edit.",
          });
        const [workspace] = await db
          .select({ id: organisations.id, name: organisations.name })
          .from(organisations)
          .where(eq(organisations.id, organisationId));
        const name = workspace?.name ?? "";
        const ping: PingBody = {
          id: uuidv7(),
          type: "ping",
          createdAt: new Date().toISOString(),
          workspace: { id: organisationId, name },
          summary: `Hekate is connected: ${name}'s events will arrive here, through ${channelKindLabels[row.kind]}.`,
          url: new URL("/settings/notifications", deps.publicUrl).toString(),
        };
        const out = outgoing(row.kind, ping, {
          deliveryId: ping.id,
          ...(config.secret ? { secret: config.secret } : {}),
        });
        try {
          const answer = await deps.send(config.url, out);
          const ok = answer.status >= 200 && answer.status < 300;
          return c.json({
            ok,
            result: ok ? `Sent: it answered ${answer.status}` : `It answered ${answer.status}`,
          });
        } catch (error) {
          return c.json({
            ok: false,
            result: `Not sent: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`,
          });
        }
      })
  );
};
