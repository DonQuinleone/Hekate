import { type Database, schema } from "@hekate/db";
import { directorySettingsInput } from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { type Audit, requestInfo } from "../audit.ts";
import { directoryConfig, directoryOf, saveDirectory, testDirectory } from "../directory.ts";
import type { Keyring } from "../keyring.ts";
import { requireRole, type TenantVariables } from "../tenancy.ts";

/**
 * `/api/organisation/directory`: the workspace's directory (LDAP) for signing in. Admins read,
 * change and test it; the bind password goes in and is never sent back.
 */
export const directoryRoutes = (
  db: Database,
  keyring: Keyring,
  audit: Audit,
  trustProxy: boolean,
) =>
  new Hono<{ Variables: TenantVariables }>()
    .use("*", requireRole("admin"))
    // With the workspace's short name, which people type to sign in with its directory.
    .get("/", async (c) => {
      const [organisation] = await db
        .select({ slug: schema.organisations.slug })
        .from(schema.organisations)
        .where(eq(schema.organisations.id, c.var.organisationId));
      return c.json({
        directory: await directoryOf(db, c.var.organisationId),
        workspace: organisation?.slug ?? "",
      });
    })
    .put("/", zValidator("json", directorySettingsInput), async (c) => {
      const input = c.req.valid("json");
      await saveDirectory(db, keyring, c.var.organisationId, input);
      const { bindPassword, ...change } = input;
      await audit.record(
        c.var.organisationId,
        await audit.member(c.var.userId),
        {
          action: "organisation.directory",
          details: { ...change, bindPassword: bindPassword === undefined ? "kept" : "changed" },
        },
        requestInfo(c, trustProxy),
      );
      return c.json({ directory: await directoryOf(db, c.var.organisationId) });
    })
    // Connect with the saved settings, bind as the service account and read the user base.
    .post("/test", async (c) => {
      const config = await directoryConfig(db, keyring, c.var.organisationId);
      if (!config) return c.json({ ok: false, problem: "Save the directory first." });
      const problem = await testDirectory(config);
      return c.json({ ok: problem === null, problem });
    });
