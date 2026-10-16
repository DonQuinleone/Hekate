import { type Database, inOrg, schema } from "@hekate/db";
import { fileColumnsInput } from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { membershipOf, type TenantVariables } from "../tenancy.ts";

export const meRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
    .get("/", async (c) => {
      const [user] = await db
        .select({ id: schema.users.id, name: schema.users.name, email: schema.users.email })
        .from(schema.users)
        .where(eq(schema.users.id, c.var.userId));
      const organisations = await db
        .select({
          id: schema.organisations.id,
          name: schema.organisations.name,
          role: schema.members.role,
        })
        .from(schema.members)
        .innerJoin(schema.organisations, eq(schema.members.organisationId, schema.organisations.id))
        .where(eq(schema.members.userId, c.var.userId))
        .orderBy(asc(schema.organisations.name));
      return c.json({ user, organisations, activeOrganisationId: c.var.organisationId });
    })
    .put("/organisation", zValidator("json", z.object({ organisationId: z.uuid() })), async (c) => {
      const { organisationId } = c.req.valid("json");
      if (!(await membershipOf(db, c.var.userId, organisationId))) {
        throw new HTTPException(403, { message: "You are not a member of that workspace" });
      }
      await db
        .update(schema.authSessions)
        .set({ activeOrganisationId: organisationId })
        .where(eq(schema.authSessions.id, c.var.sessionId));
      return c.json({ activeOrganisationId: organisationId });
    })
    // The file browser's columns, as this member arranged them in this workspace.
    .get("/file-columns", async (c) => {
      const [row] = await db
        .select({ columns: schema.members.fileColumns })
        .from(schema.members)
        .where(
          inOrg(schema.members, c.var.organisationId, eq(schema.members.userId, c.var.userId)),
        );
      return c.json({ columns: row?.columns ?? null });
    })
    .put("/file-columns", zValidator("json", fileColumnsInput), async (c) => {
      const { columns } = c.req.valid("json");
      await db
        .update(schema.members)
        .set({ fileColumns: columns, updatedAt: new Date() })
        .where(
          inOrg(schema.members, c.var.organisationId, eq(schema.members.userId, c.var.userId)),
        );
      return c.json({ columns });
    });
