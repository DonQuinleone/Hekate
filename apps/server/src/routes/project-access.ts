import { type Database, inOrg, schema } from "@hekate/db";
import { levelsOf, projectMemberInput, roleInput } from "@hekate/shared";
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

/**
 * Who may look up the project's people: those who see them, and those whose work is choosing
 * among them (requesting a review, assigning feedback) whatever their level in People.
 */
const choosesPeople = ["view_people", "request_reviews", "triage"] as const;

const nameTaken = () =>
  new HTTPException(409, { message: "This project already has a role with that name" });

/**
 * `/api/projects/:id/roles` and `/api/projects/:id/members`: a project's roles and who
 * holds them. Seeing them needs the People level (or work that chooses among them);
 * changing them needs the project's "manage roles and members" permission.
 */
export const projectAccessRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
    .get("/:id/roles", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const { projectId } = await can(db, actorOf(c.var), choosesPeople, c.req.valid("param").id);
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
      // Each role as people choose it too: a level in each area.
      return c.json({ roles: roles.map((r) => ({ ...r, levels: levelsOf(r.permissions) })) });
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
        return c.json({ role: role && { ...role, levels: levelsOf(role.permissions) } }, 201);
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
        const role = await db.transaction(async (tx) => {
          // The project's roles, held while this one changes: the last that manages people
          // keeps that level, and two changes at once cannot each leave it to the other.
          const roles = await tx
            .select({ id: projectRoles.id, permissions: projectRoles.permissions })
            .from(projectRoles)
            .where(inOrg(projectRoles, organisationId, eq(projectRoles.projectId, projectId)))
            .for("update");
          if (!roles.some((r) => r.id === roleId)) throw new NotFound("Role");
          const manages = roles.filter((r) => r.permissions.includes("manage_roles"));
          if (
            !input.permissions.includes("manage_roles") &&
            manages.length === 1 &&
            manages[0]?.id === roleId
          ) {
            throw new HTTPException(409, {
              message: "Another role must manage people before this one stops",
            });
          }
          const [updated] = await tx
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
          if (!updated) throw new NotFound("Role");
          return updated;
        });
        return c.json({ role: { ...role, levels: levelsOf(role.permissions) } });
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
        await db.transaction(async (tx) => {
          // Under the same hold as a change, so a role cannot go while another stops
          // managing people on the strength of it.
          const roles = await tx
            .select({ id: projectRoles.id, permissions: projectRoles.permissions })
            .from(projectRoles)
            .where(inOrg(projectRoles, organisationId, eq(projectRoles.projectId, projectId)))
            .for("update");
          const role = roles.find((r) => r.id === roleId);
          if (!role) throw new NotFound("Role");
          const manages = roles.filter((r) => r.permissions.includes("manage_roles"));
          if (manages.length === 1 && manages[0]?.id === roleId) {
            throw new HTTPException(409, {
              message: "Another role must manage people before this one goes",
            });
          }
          await tx
            .delete(projectRoles)
            .where(
              inOrg(
                projectRoles,
                organisationId,
                eq(projectRoles.id, roleId),
                eq(projectRoles.projectId, projectId),
              ),
            );
        });
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
      const { projectId } = await can(db, actorOf(c.var), choosesPeople, c.req.valid("param").id);
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
      await db.transaction(async (tx) => {
        // Lock their membership: someone leaving the organisation at the same moment either
        // goes first (and this finds no member) or waits, and then takes this role with them.
        const [member] = await tx
          .select({ id: members.id })
          .from(members)
          .where(inOrg(members, organisationId, eq(members.userId, userId)))
          .for("update");
        if (!member) throw new NotFound("Member");
        const [role] = await tx
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
        await tx
          .insert(projectMembers)
          .values({ organisationId, projectId, userId, roleId: role.id })
          .onConflictDoUpdate({
            target: [
              projectMembers.organisationId,
              projectMembers.projectId,
              projectMembers.userId,
            ],
            set: { roleId: role.id, updatedAt: new Date() },
          });
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
