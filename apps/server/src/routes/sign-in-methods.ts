import { type Database, schema } from "@hekate/db";
import { ssoStartInput } from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

const { directories, organisations, ssoProviders } = schema;

/**
 * `/api/sign-in-methods`: what the sign-in page offers beyond a password and a passkey, read
 * before anyone is signed in. Deliberately across workspaces: an instance-wide yes or no for
 * each, never a workspace's data; which workspace is asked on the page.
 */
export const signInMethodRoutes = (db: Database) =>
  new Hono()
    .get("/", async (c) => {
      const [directory] = await db
        .select({ id: directories.id })
        .from(directories)
        .where(eq(directories.enabled, true))
        .limit(1);
      const [sso] = await db
        .select({ id: ssoProviders.id })
        .from(ssoProviders)
        .where(eq(ssoProviders.enabled, true))
        .limit(1);
      return c.json({ directory: Boolean(directory), sso: Boolean(sso) });
    })
    // The provider to start single sign-on with, for a workspace's short name.
    .get("/sso", zValidator("query", ssoStartInput), async (c) => {
      const { workspace } = c.req.valid("query");
      const [row] = await db
        .select({ providerId: ssoProviders.providerId })
        .from(ssoProviders)
        .innerJoin(organisations, eq(organisations.id, ssoProviders.organisationId))
        .where(
          and(eq(organisations.slug, workspace.toLowerCase()), eq(ssoProviders.enabled, true)),
        );
      if (!row)
        throw new HTTPException(404, {
          message: "That workspace does not sign in with single sign-on.",
        });
      return c.json({ providerId: row.providerId });
    });
