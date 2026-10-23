import { type Database, inOrg, schema } from "@hekate/db";
import { type RegistrationMode, ssoStartInput } from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { type HostVariables, rootAddress, type Subdomains } from "../hosts.ts";

const { directories, organisations, ssoProviders } = schema;

/**
 * `/api/sign-in-methods`: what the sign-in page offers beyond a password and a passkey, read
 * before anyone is signed in. Deliberately across workspaces: an instance-wide yes or no for
 * each, never a workspace's data; which workspace is asked on the page.
 */
export const signInMethodRoutes = (
  db: Database,
  subdomains: Subdomains | null = null,
  /** The instance's registration (#184): open sign-up is offered from the root's sign-in. */
  registration: () => Promise<RegistrationMode> = async () => "closed",
) =>
  new Hono<{ Variables: HostVariables }>()
    .get("/", async (c) => {
      // On a workspace's host (#176), what that workspace offers, and which it is: the page
      // need not ask. Elsewhere, an instance-wide yes or no.
      const host = c.var.hostWorkspace;
      const [directory] = await db
        .select({ id: directories.id })
        .from(directories)
        .where(
          host
            ? inOrg(directories, host.id, eq(directories.enabled, true))
            : eq(directories.enabled, true),
        )
        .limit(1);
      const [sso] = await db
        .select({ providerId: ssoProviders.providerId })
        .from(ssoProviders)
        .where(
          host
            ? inOrg(ssoProviders, host.id, eq(ssoProviders.enabled, true))
            : eq(ssoProviders.enabled, true),
        )
        .limit(1);
      return c.json({
        directory: Boolean(directory),
        sso: Boolean(sso),
        workspace: host
          ? { name: host.name, slug: host.slug, providerId: sso?.providerId ?? null }
          : null,
        root: subdomains ? rootAddress(subdomains) : null,
        // A workspace's own host signs in to that workspace; making another starts at the root.
        signUp: !host && (await registration()) === "open",
      });
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
