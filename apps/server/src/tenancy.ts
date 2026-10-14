import { type Database, schema } from "@hekate/db";
import { asc } from "drizzle-orm";
import { createMiddleware } from "hono/factory";

export interface TenantVariables {
  organisationId: string;
}

/**
 * Ensures a self-hosted install has its default organisation and returns its id.
 * A hosted deployment will create organisations at sign-up instead.
 */
export async function ensureDefaultOrganisation(db: Database, name: string): Promise<string> {
  const [existing] = await db
    .select({ id: schema.organisations.id })
    .from(schema.organisations)
    .orderBy(asc(schema.organisations.createdAt))
    .limit(1);
  if (existing) return existing.id;
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "studio";
  const [created] = await db.insert(schema.organisations).values({ name, slug }).returning();
  if (!created) throw new Error("Could not create the default organisation");
  return created.id;
}

/**
 * Resolves the organisation for the request. Until authentication lands (issue 5) this is the
 * install's default organisation; afterwards it comes from the session's membership.
 */
export const tenant = (organisationId: () => Promise<string>) =>
  createMiddleware<{ Variables: TenantVariables }>(async (c, next) => {
    c.set("organisationId", await organisationId());
    await next();
  });
