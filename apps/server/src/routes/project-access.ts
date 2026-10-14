import { type Database, inOrg, schema } from "@hekate/db";
import { projectMemberInput, roleInput } from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { and, asc, count, eq, max } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { actorOf, can } from "../access.ts";
import { NotFound } from "../errors.ts";
import type { TenantVariables } from "../tenancy.ts";

const { projectRoles, projectMembers, members, users } = schema;

const idParam = zValidator("param", z.object({ id: z.uuid() }));
const roleParam = zValidator("param", z.object({ id: z.uuid(), roleId: z.uuid() }));
const memberParam = zValidator(
  "param",
  z.object({ id: z.uuid(), userId: z.string().min(1).max(64) }),
);

/** True when a statement failed on the named unique index. */
function violates(error: unknown, index: string): boolean {
  const cause = (error as { cause?: { code?: string; constraint_name?: string } }).cause;
  return cause?.code === "23505" && cause.constraint_name === index;
}

const nameTaken = () =>
  new HTTPException(409, { message: "This project already has a role with that name" });

/**
 * `/api/projects/:id/roles` and `/api/projects/:id/members`: a project's roles and who
 * holds them. Anyone who can see the project can see these; changing them needs the
 * project's "manage roles and members" permission.
 */
export const projectAccessRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
    .get("/:id/roles", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const { projectId } = await can(db, actorOf(c.var), "view", c.req.valid("param").id);
      const roles = await db
        .select({
          id: projectRoles.id,
          name: projectRoles.name,
          permissions: projectRoles.permissions,
          position: projectRoles.position,
          members: count(projectMembers.id),
        })
        .from(projectRoles)
        .leftJoin(
          projectMembers,
          and(
            eq(projectMembers.roleId, projectRoles.id),
            eq(projectMembers.organisationId, organisationId),
          ),
        )
        .where(inOrg(projectRoles, organisationId, eq(projectRoles.projectId, projectId)))
        .groupBy(projectRoles.id)
        .orderBy(asc(projectRoles.position), asc(projectRoles.createdAt));
      return c.json({ roles });
    })
    .post("/:id/roles", idParam, zValidator("json", roleInput), async (c) => {
      const organisationId = c.var.organisationId;
      const { projectId } = await can(db, actorOf(c.var), "manage_roles", c.req.valid("param").id);
      const input = c.req.valid("json");
      try {
        const [role] = await db.transaction(async (tx) => {
          const [last] = await tx
            .select({ position: max(projectRoles.position) })
            .from(projectRoles)
            .where(inOrg(projectRoles, organisationId, eq(projectRoles.projectId, projectId)));
          return tx
            .insert(projectRoles)
            .values({
              organisationId,
              projectId,
              name: input.name,
              permissions: input.permissions,
              position: (last?.position ?? -1) + 1,
            })
            .returning();
        });
        return c.json({ role }, 201);
      } catch (error) {
        if (violates(error, "project_roles_name_idx")) throw nameTaken();
        throw error;
      }
    })
    .patch("/:id/roles/:roleId", roleParam, zValidator("json", roleInput), async (c) => {
      const organisationId = c.var.organisationId;
      const { id, roleId } = c.req.valid("param");
      const { projectId } = await can(db, actorOf(c.var), "manage_roles", id);
      const input = c.req.valid("json");
      try {
        const [role] = await db
          .update(projectRoles)
          .set({ name: input.name, permissions: input.permissions, updatedAt: new Date() })
          .where(
            inOrg(
              projectRoles,
              organisationId,
              eq(projectRoles.id, roleId),
              eq(projectRoles.projectId, projectId),
            ),
          )
          .returning();
        if (!role) throw new NotFound("Role");
        return c.json({ role });
      } catch (error) {
        if (violates(error, "project_roles_name_idx")) throw nameTaken();
        throw error;
      }
    })
    .delete("/:id/roles/:roleId", roleParam, async (c) => {
      const organisationId = c.var.organisationId;
      const { id, roleId } = c.req.valid("param");
      const { projectId } = await can(db, actorOf(c.var), "manage_roles", id);
      try {
        const [role] = await db
          .delete(projectRoles)
          .where(
            inOrg(
              projectRoles,
              organisationId,
              eq(projectRoles.id, roleId),
              eq(projectRoles.projectId, projectId),
            ),
          )
          .returning({ id: projectRoles.id });
        if (!role) throw new NotFound("Role");
      } catch (error) {
        // The database refuses to delete a role someone still holds.
        if ((error as { cause?: { code?: string } }).cause?.code === "23503") {
          throw new HTTPException(409, {
            message: "Someone holds this role; give them another before deleting it",
          });
        }
        throw error;
      }
      return c.body(null, 204);
    })
    .get("/:id/members", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const { projectId } = await can(db, actorOf(c.var), "view", c.req.valid("param").id);
      const rows = await db
        .select({
          userId: projectMembers.userId,
          name: users.name,
          email: users.email,
          roleId: projectMembers.roleId,
        })
        .from(projectMembers)
        .innerJoin(users, eq(users.id, projectMembers.userId))
        .where(inOrg(projectMembers, organisationId, eq(projectMembers.projectId, projectId)))
        .orderBy(asc(users.name));
      return c.json({ members: rows });
    })
    // Give someone in the organisation a role in this project, or change it.
    .put("/:id/members/:userId", memberParam, zValidator("json", projectMemberInput), async (c) => {
      const organisationId = c.var.organisationId;
      const { id, userId } = c.req.valid("param");
      const { projectId } = await can(db, actorOf(c.var), "manage_roles", id);
      const { roleId } = c.req.valid("json");
      const [member] = await db
        .select({ id: members.id })
        .from(members)
        .where(inOrg(members, organisationId, eq(members.userId, userId)));
      if (!member) throw new NotFound("Member");
      const [role] = await db
        .select({ id: projectRoles.id })
        .from(projectRoles)
        .where(
          inOrg(
            projectRoles,
            organisationId,
            eq(projectRoles.id, roleId),
            eq(projectRoles.projectId, projectId),
          ),
        );
      if (!role) throw new NotFound("Role");
      await db
        .insert(projectMembers)
        .values({ organisationId, projectId, userId, roleId: role.id })
        .onConflictDoUpdate({
          target: [projectMembers.organisationId, projectMembers.projectId, projectMembers.userId],
          set: { roleId: role.id, updatedAt: new Date() },
        });
      return c.body(null, 204);
    })
    .delete("/:id/members/:userId", memberParam, async (c) => {
      const organisationId = c.var.organisationId;
      const { id, userId } = c.req.valid("param");
      const { projectId } = await can(db, actorOf(c.var), "manage_roles", id);
      const [removed] = await db
        .delete(projectMembers)
        .where(
          inOrg(
            projectMembers,
            organisationId,
            eq(projectMembers.projectId, projectId),
            eq(projectMembers.userId, userId),
          ),
        )
        .returning({ id: projectMembers.id });
      if (!removed) throw new NotFound("Member");
      return c.body(null, 204);
    });
