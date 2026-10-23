import { type Database, inOrg, schema } from "@hekate/db";
import { groupInput } from "@hekate/shared";
import { and, asc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { actorOf, can, type MemberActor } from "../access.ts";
import { NotFound } from "../errors.ts";
import { zValidator } from "../openapi/validator.ts";
import type { TenantVariables } from "../tenancy.ts";
import { resolvePerson } from "./reviews.ts";

const { groups, groupMembers, users, guests } = schema;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const idParam = zValidator("param", z.object({ id: z.uuid() }));
const groupParam = zValidator("param", z.object({ id: z.uuid(), groupId: z.uuid() }));

/** True when a statement failed on the named unique index. */
function violates(error: unknown, index: string): boolean {
  const cause = (error as { cause?: { code?: string; constraint_name?: string } }).cause;
  return cause?.code === "23505" && cause.constraint_name === index;
}
const nameTaken = () =>
  new HTTPException(409, { message: "This project already has a group with that name" });

/** A project's groups, each with its people in order. */
async function groupsOf(db: Database, organisationId: string, projectId: string) {
  const rows = await db
    .select({ id: groups.id, name: groups.name })
    .from(groups)
    .where(inOrg(groups, organisationId, eq(groups.projectId, projectId)))
    .orderBy(asc(groups.name));
  const people = await db
    .select({
      groupId: groupMembers.groupId,
      userId: groupMembers.userId,
      guestId: groupMembers.guestId,
      name: sql<string>`coalesce(${users.name}, ${guests.name})`,
      email: sql<string>`coalesce(${users.email}, ${guests.email})`,
      label: guests.label,
    })
    .from(groupMembers)
    .innerJoin(
      groups,
      and(eq(groups.id, groupMembers.groupId), eq(groups.organisationId, organisationId)),
    )
    .leftJoin(users, eq(users.id, groupMembers.userId))
    .leftJoin(
      guests,
      and(eq(guests.id, groupMembers.guestId), eq(guests.organisationId, organisationId)),
    )
    .where(and(inOrg(groupMembers, organisationId), eq(groups.projectId, projectId)))
    .orderBy(asc(groupMembers.position));
  return rows.map((g) => ({
    ...g,
    members: people
      .filter((p) => p.groupId === g.id)
      .map(({ groupId: _, ...p }) => ({ ...p, guest: p.guestId !== null })),
  }));
}

/** Replace a group's people: each must be able to see the project, or be a guest. */
async function setMembers(
  tx: Tx,
  actor: MemberActor,
  projectId: string,
  groupId: string,
  people: z.infer<typeof groupInput>["members"],
) {
  const resolved = [];
  for (const entry of people) {
    resolved.push(await resolvePerson(tx, actor, { projectId, kind: null }, entry));
  }
  await tx
    .delete(groupMembers)
    .where(inOrg(groupMembers, actor.organisationId, eq(groupMembers.groupId, groupId)));
  // Two entries can name one guest (two spellings of one address are one guest).
  const seen = new Set<string>();
  const rows = resolved
    .filter((p) => {
      const key = p.userId ?? p.guestId;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((p, position) => ({
      organisationId: actor.organisationId,
      groupId,
      userId: p.userId ?? null,
      guestId: p.guestId ?? null,
      position,
    }));
  await tx.insert(groupMembers).values(rows);
}

/**
 * `/api/projects/:id/groups`: named sets of members and guests, for example "Soloists",
 * that a review can ask as one step. Anyone who can see the project can see them;
 * changing them needs the project's "add or remove reviewers and guests" permission.
 */
export const projectGroupRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
    .get("/:id/groups", idParam, async (c) => {
      const { projectId } = await can(db, actorOf(c.var), "view", c.req.valid("param").id);
      return c.json({ groups: await groupsOf(db, c.var.organisationId, projectId) });
    })
    .post("/:id/groups", idParam, zValidator("json", groupInput), async (c) => {
      const actor = actorOf(c.var);
      const { projectId } = await can(db, actor, "manage_reviewers", c.req.valid("param").id);
      const input = c.req.valid("json");
      const id = await db
        .transaction(async (tx) => {
          const [group] = await tx
            .insert(groups)
            .values({
              organisationId: actor.organisationId,
              projectId,
              name: input.name,
              createdBy: actor.userId,
            })
            .returning({ id: groups.id });
          if (!group) throw new Error("Group insert returned no row");
          await setMembers(tx, actor, projectId, group.id, input.members);
          return group.id;
        })
        .catch((error: unknown) => {
          throw violates(error, "groups_name_idx") ? nameTaken() : error;
        });
      const all = await groupsOf(db, actor.organisationId, projectId);
      return c.json({ group: all.find((g) => g.id === id) }, 201);
    })
    .put("/:id/groups/:groupId", groupParam, zValidator("json", groupInput), async (c) => {
      const actor = actorOf(c.var);
      const { id, groupId } = c.req.valid("param");
      const { projectId } = await can(db, actor, "manage_reviewers", id);
      const input = c.req.valid("json");
      await db
        .transaction(async (tx) => {
          const [group] = await tx
            .update(groups)
            .set({ name: input.name, updatedAt: new Date() })
            .where(
              inOrg(
                groups,
                actor.organisationId,
                eq(groups.id, groupId),
                eq(groups.projectId, projectId),
              ),
            )
            .returning({ id: groups.id });
          if (!group) throw new NotFound("Group");
          await setMembers(tx, actor, projectId, group.id, input.members);
        })
        .catch((error: unknown) => {
          throw violates(error, "groups_name_idx") ? nameTaken() : error;
        });
      const all = await groupsOf(db, actor.organisationId, projectId);
      return c.json({ group: all.find((g) => g.id === groupId) });
    })
    // Reviews already sent keep their reviewers; they only lose the group's name.
    .delete("/:id/groups/:groupId", groupParam, async (c) => {
      const actor = actorOf(c.var);
      const { id, groupId } = c.req.valid("param");
      const { projectId } = await can(db, actor, "manage_reviewers", id);
      const [gone] = await db
        .delete(groups)
        .where(
          inOrg(
            groups,
            actor.organisationId,
            eq(groups.id, groupId),
            eq(groups.projectId, projectId),
          ),
        )
        .returning({ id: groups.id });
      if (!gone) throw new NotFound("Group");
      return c.body(null, 204);
    });
