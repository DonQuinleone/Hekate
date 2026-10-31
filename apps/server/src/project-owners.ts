import { type Database, inOrg, schema } from "@hekate/db";
import { creatorRole } from "@hekate/shared";
import { asc, eq, sql } from "drizzle-orm";
import { NotFound } from "./errors.ts";

/**
 * A project's owners (#507, decision 285): fixed above its roles, at least one always. Every
 * change to who owns a project runs in a transaction that first takes `lockOwners`, so two
 * owners stepping down at once cannot each leave it to the other.
 */

const { members, projectMembers, projectOwners, projectRoles } = schema;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Holds a project's owners for the rest of the transaction: whoever changes them next waits,
 * and then counts them afresh. A lock of its own, so making an owner (an insert, which no row
 * lock would hold) waits too.
 */
export async function lockOwners(tx: Pick<Database, "execute">, projectId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`project-owners:${projectId}`}))`);
}

/** The ids of a project's owners. */
export async function ownersOf(
  tx: Pick<Database, "select">,
  organisationId: string,
  projectId: string,
): Promise<string[]> {
  const rows = await tx
    .select({ userId: projectOwners.userId })
    .from(projectOwners)
    .where(inOrg(projectOwners, organisationId, eq(projectOwners.projectId, projectId)));
  return rows.map((r) => r.userId);
}

/**
 * Locks someone's membership of the workspace for the transaction, or 404 when they are not a
 * member: someone leaving it at the same moment either goes first or waits for this to finish.
 */
export async function lockWorkspaceMember(tx: Tx, organisationId: string, userId: string) {
  const [member] = await tx
    .select({ id: members.id })
    .from(members)
    .where(inOrg(members, organisationId, eq(members.userId, userId)))
    .for("update");
  if (!member) throw new NotFound("Member");
}

/** Makes someone an owner of a project; one already is stays as they were. */
export async function addOwner(tx: Tx, organisationId: string, projectId: string, userId: string) {
  await tx
    .insert(projectOwners)
    .values({ organisationId, projectId, userId })
    .onConflictDoNothing({
      target: [projectOwners.organisationId, projectOwners.projectId, projectOwners.userId],
    });
}

/**
 * The role a former owner who holds none takes as a member: the creator's (a Producer that may
 * run the project), else the first role that may, else the project's first.
 */
export async function ownersRole(tx: Tx, organisationId: string, projectId: string) {
  const roles = await tx
    .select({ id: projectRoles.id, name: projectRoles.name, permissions: projectRoles.permissions })
    .from(projectRoles)
    .where(inOrg(projectRoles, organisationId, eq(projectRoles.projectId, projectId)))
    .orderBy(asc(projectRoles.position), asc(projectRoles.id));
  const runs = (r: { permissions: string[] }) =>
    r.permissions.includes("view") && r.permissions.includes("manage_roles");
  const role = roles.find((r) => r.name === creatorRole && runs(r)) ?? roles.find(runs) ?? roles[0];
  if (!role) throw new NotFound("Role");
  return role.id;
}

/**
 * After people lose their place (leaving the workspace, deleting their account, a project
 * moving to a workspace they are not in): each of these projects left with no owner is given
 * one, its earliest member still there, else the workspace's earliest owner, so a project with
 * no owner never exists.
 */
export async function keepAnOwner(tx: Tx, organisationId: string, projectIds: string[]) {
  for (const projectId of [...new Set(projectIds)]) {
    await lockOwners(tx, projectId);
    if ((await ownersOf(tx, organisationId, projectId)).length > 0) continue;
    const [member] = await tx
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(inOrg(projectMembers, organisationId, eq(projectMembers.projectId, projectId)))
      .orderBy(asc(projectMembers.createdAt), asc(projectMembers.id))
      .limit(1);
    const [owner] = member
      ? [member]
      : await tx
          .select({ userId: members.userId })
          .from(members)
          .where(inOrg(members, organisationId, eq(members.role, "owner")))
          .orderBy(asc(members.createdAt), asc(members.id))
          .limit(1);
    if (owner) await addOwner(tx, organisationId, projectId, owner.userId);
  }
}

/** Takes someone's ownership of every project in a workspace, giving each an owner still. */
export async function dropOwnerships(tx: Tx, organisationId: string, userId: string) {
  const owned = await tx
    .delete(projectOwners)
    .where(inOrg(projectOwners, organisationId, eq(projectOwners.userId, userId)))
    .returning({ projectId: projectOwners.projectId });
  await keepAnOwner(
    tx,
    organisationId,
    owned.map((o) => o.projectId),
  );
}
