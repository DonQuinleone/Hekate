import { type Database, inOrg, schema } from "@hekate/db";
import { and, eq } from "drizzle-orm";
import type { Actor } from "./access.ts";

const { guests, projectMembers, projectRoles, users } = schema;

/** Who asked for a report or a sheet, and their part in the project: their role, or Guest. */
export async function requesterOf(db: Database, actor: Actor, projectId: string) {
  if (actor.kind === "guest") {
    const [guest] = await db
      .select({ name: guests.name })
      .from(guests)
      .where(inOrg(guests, actor.organisationId, eq(guests.id, actor.guestId)));
    return { name: guest?.name ?? "A guest", role: "Guest" };
  }
  const [user] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, actor.userId));
  const [role] = await db
    .select({ name: projectRoles.name })
    .from(projectMembers)
    .innerJoin(
      projectRoles,
      and(
        eq(projectRoles.id, projectMembers.roleId),
        eq(projectRoles.organisationId, actor.organisationId),
      ),
    )
    .where(
      inOrg(
        projectMembers,
        actor.organisationId,
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.userId, actor.userId),
      ),
    );
  // Owners and admins see every project without a role in it.
  const fallback = actor.organisationRole === "member" ? null : actor.organisationRole;
  return {
    name: user?.name ?? "A member",
    role: role?.name ?? (fallback ? `${fallback[0]?.toUpperCase()}${fallback.slice(1)}` : null),
  };
}
