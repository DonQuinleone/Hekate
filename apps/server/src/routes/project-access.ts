import { type Database, inOrg, schema } from "@hekate/db";
import {
  levelsOf,
  listeningTools,
  type PlayerTool,
  playerTools,
  projectMemberInput,
  roleInput,
  type ToolException,
  toolExceptionInput,
  toolExceptionUpdate,
} from "@hekate/shared";
import { and, asc, count, eq, max, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { actorOf, can } from "../access.ts";
import { NotFound } from "../errors.ts";
import { zValidator } from "../openapi/validator.ts";
import type { TenantVariables } from "../tenancy.ts";

const {
  projectRoles,
  projectMembers,
  projectToolExceptions,
  members,
  users,
  guests,
  groups,
  groupMembers,
  reviews,
  reviewReviewers,
} = schema;

const idParam = zValidator("param", z.object({ id: z.uuid() }));
const roleParam = zValidator("param", z.object({ id: z.uuid(), roleId: z.uuid() }));
const exceptionParam = zValidator("param", z.object({ id: z.uuid(), exceptionId: z.uuid() }));
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

/** Who may read the project's roles: as above, and those who build its workflows (#26). */
const choosesRoles = [...choosesPeople, "edit_workflows"] as const;

const nameTaken = () =>
  new HTTPException(409, { message: "This project already has a role with that name" });

type Reader = Pick<Database, "select">;

/** A project's tool exceptions (decision 258), each with whom it is for, by name. */
async function exceptionsOf(
  db: Reader,
  organisationId: string,
  projectId: string,
): Promise<ToolException[]> {
  const rows = await db
    .select({
      id: projectToolExceptions.id,
      userId: projectToolExceptions.userId,
      guestId: projectToolExceptions.guestId,
      groupId: projectToolExceptions.groupId,
      tools: projectToolExceptions.tools,
      userName: users.name,
      guestName: guests.name,
      groupName: groups.name,
    })
    .from(projectToolExceptions)
    .leftJoin(users, eq(users.id, projectToolExceptions.userId))
    .leftJoin(
      guests,
      and(eq(guests.id, projectToolExceptions.guestId), eq(guests.organisationId, organisationId)),
    )
    .leftJoin(
      groups,
      and(eq(groups.id, projectToolExceptions.groupId), eq(groups.organisationId, organisationId)),
    )
    .where(
      inOrg(projectToolExceptions, organisationId, eq(projectToolExceptions.projectId, projectId)),
    )
    .orderBy(asc(projectToolExceptions.createdAt), asc(projectToolExceptions.id));
  return rows.map((r) => ({
    id: r.id,
    kind: r.userId ? "member" : r.guestId ? "guest" : "group",
    subjectId: r.userId ?? r.guestId ?? r.groupId ?? "",
    name: r.userName ?? r.guestName ?? r.groupName ?? "",
    tools: playerTools.filter((t) => r.tools.includes(t)),
  }));
}

/**
 * Whom an exception may be for: someone with a role in the project, a guest its reviews or
 * groups have asked, or one of its groups. Anyone else is not found here.
 */
async function assertSubject(
  db: Reader,
  organisationId: string,
  projectId: string,
  subject: { userId?: string; guestId?: string; groupId?: string },
) {
  if (subject.userId) {
    const [held] = await db
      .select({ id: projectMembers.id })
      .from(projectMembers)
      .where(
        inOrg(
          projectMembers,
          organisationId,
          eq(projectMembers.projectId, projectId),
          eq(projectMembers.userId, subject.userId),
        ),
      );
    if (!held) throw new NotFound("Member");
    return;
  }
  if (subject.groupId) {
    const [group] = await db
      .select({ id: groups.id })
      .from(groups)
      .where(
        inOrg(
          groups,
          organisationId,
          eq(groups.id, subject.groupId),
          eq(groups.projectId, projectId),
        ),
      );
    if (!group) throw new NotFound("Group");
    return;
  }
  const guestId = subject.guestId ?? "";
  const [asked] = await db
    .select({ id: guests.id })
    .from(guests)
    .where(
      inOrg(
        guests,
        organisationId,
        eq(guests.id, guestId),
        or(
          sql`exists (select 1 from ${reviewReviewers} join ${reviews} on ${reviews.id} = ${reviewReviewers.reviewId}
            where ${reviewReviewers.organisationId} = ${organisationId}
              and ${reviews.organisationId} = ${organisationId}
              and ${reviews.projectId} = ${projectId}
              and ${reviewReviewers.guestId} = ${guests.id})`,
          sql`exists (select 1 from ${groupMembers} join ${groups} on ${groups.id} = ${groupMembers.groupId}
            where ${groupMembers.organisationId} = ${organisationId}
              and ${groups.organisationId} = ${organisationId}
              and ${groups.projectId} = ${projectId}
              and ${groupMembers.guestId} = ${guests.id})`,
        ),
      ),
    );
  if (!asked) throw new NotFound("Guest");
}

const exceptionTaken = () =>
  new HTTPException(409, { message: "They already have an exception in this project" });

/**
 * `/api/projects/:id/roles` and `/api/projects/:id/members`: a project's roles and who
 * holds them. Seeing them needs the People level (or work that chooses among them);
 * changing them needs the project's "manage roles and members" permission.
 */
export const projectAccessRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
    .get("/:id/roles", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const { projectId } = await can(db, actorOf(c.var), choosesRoles, c.req.valid("param").id);
      const roles = await db
        .select({
          id: projectRoles.id,
          name: projectRoles.name,
          permissions: projectRoles.permissions,
          tools: projectRoles.tools,
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
              // A new role listens, unless it says which tools it has.
              tools: input.tools ?? listeningTools,
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
            .set({
              name: input.name,
              permissions: input.permissions,
              ...(input.tools ? { tools: input.tools } : {}),
              updatedAt: new Date(),
            })
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
    // Exceptions to the player tools (decision 258): read by whoever reads the roles, made and
    // changed by whoever manages them.
    .get("/:id/tool-exceptions", idParam, async (c) => {
      const { projectId } = await can(db, actorOf(c.var), choosesRoles, c.req.valid("param").id);
      return c.json({ exceptions: await exceptionsOf(db, c.var.organisationId, projectId) });
    })
    .post("/:id/tool-exceptions", idParam, zValidator("json", toolExceptionInput), async (c) => {
      const organisationId = c.var.organisationId;
      const { projectId } = await can(db, actorOf(c.var), "manage_roles", c.req.valid("param").id);
      const input = c.req.valid("json");
      await assertSubject(db, organisationId, projectId, input);
      const [made] = await db
        .insert(projectToolExceptions)
        .values({
          organisationId,
          projectId,
          userId: input.userId ?? null,
          guestId: input.guestId ?? null,
          groupId: input.groupId ?? null,
          tools: input.tools,
          createdBy: c.var.userId,
        })
        .onConflictDoNothing()
        .returning({ id: projectToolExceptions.id });
      if (!made) throw exceptionTaken();
      const exception = (await exceptionsOf(db, organisationId, projectId)).find(
        (e) => e.id === made.id,
      );
      return c.json({ exception }, 201);
    })
    .patch(
      "/:id/tool-exceptions/:exceptionId",
      exceptionParam,
      zValidator("json", toolExceptionUpdate),
      async (c) => {
        const organisationId = c.var.organisationId;
        const { id, exceptionId } = c.req.valid("param");
        const { projectId } = await can(db, actorOf(c.var), "manage_roles", id);
        const { tools } = c.req.valid("json");
        const [changed] = await db
          .update(projectToolExceptions)
          .set({ tools: tools satisfies PlayerTool[], updatedAt: new Date() })
          .where(
            inOrg(
              projectToolExceptions,
              organisationId,
              eq(projectToolExceptions.id, exceptionId),
              eq(projectToolExceptions.projectId, projectId),
            ),
          )
          .returning({ id: projectToolExceptions.id });
        if (!changed) throw new NotFound("Exception");
        const exception = (await exceptionsOf(db, organisationId, projectId)).find(
          (e) => e.id === changed.id,
        );
        return c.json({ exception });
      },
    )
    .delete("/:id/tool-exceptions/:exceptionId", exceptionParam, async (c) => {
      const { id, exceptionId } = c.req.valid("param");
      const { projectId } = await can(db, actorOf(c.var), "manage_roles", id);
      const [removed] = await db
        .delete(projectToolExceptions)
        .where(
          inOrg(
            projectToolExceptions,
            c.var.organisationId,
            eq(projectToolExceptions.id, exceptionId),
            eq(projectToolExceptions.projectId, projectId),
          ),
        )
        .returning({ id: projectToolExceptions.id });
      if (!removed) throw new NotFound("Exception");
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
          // Their role in the workspace: owners and admins keep every tool whatever an
          // exception says (decision 258), so the web app offers none for them.
          workspaceRole: members.role,
        })
        .from(projectMembers)
        .innerJoin(users, eq(users.id, projectMembers.userId))
        .leftJoin(
          members,
          and(
            eq(members.userId, projectMembers.userId),
            eq(members.organisationId, organisationId),
          ),
        )
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
