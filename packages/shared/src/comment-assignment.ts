import { z } from "zod";

/**
 * Who a comment is given to as it is opened (#499, decision 279): a member of the project, or
 * whoever holds a role of it (the engineer at Mix, the editor at Edit). The rule sits in three
 * places, each over the next: on a stage of a workflow (in the stage's own JSON, `assign`),
 * on a track, and on a project. Null in `assign` says nobody, and stops the fall-through.
 */
export const commentAssignee = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("member"), userId: z.string().min(1).max(64) }).strict(),
  z.object({ kind: z.literal("role"), roleId: z.uuid() }).strict(),
]);
export type CommentAssignee = z.infer<typeof commentAssignee>;

export const commentAssignment = z.object({ assign: commentAssignee.nullable() }).strict();
export type CommentAssignment = z.infer<typeof commentAssignment>;

/** A track's own rule, over the project's; null keeps the project's. */
export const trackCommentAssignmentInput = z
  .object({ assignment: commentAssignment.nullable() })
  .strict();
export type TrackCommentAssignmentInput = z.infer<typeof trackCommentAssignmentInput>;

/** A member of a project, in the order they joined it, with the role they hold there. */
export interface AssignableMember {
  userId: string;
  roleId: string;
}

/**
 * Whom a comment opened now is for: the first rule set, of the stage's, the track's and the
 * project's, decides; a rule may say nobody. A member named is assigned while they are still
 * in the project; a role names the member who has held it longest (the first in `members`
 * with it), and nobody when no one holds it. A rule left unset (null or undefined) falls
 * through to the next; `{ assign: null }` does not.
 */
export function assigneeFor(
  stageRule: CommentAssignment | null | undefined,
  trackOverride: CommentAssignment | null | undefined,
  projectDefault: CommentAssignment | null | undefined,
  members: readonly AssignableMember[],
): string | null {
  const rule = stageRule ?? trackOverride ?? projectDefault;
  if (!rule?.assign) return null;
  const chosen = rule.assign;
  if (chosen.kind === "member")
    return members.some((m) => m.userId === chosen.userId) ? chosen.userId : null;
  return members.find((m) => m.roleId === chosen.roleId)?.userId ?? null;
}

/**
 * How a rule reads where it is shown: the member's or the role's name, "Nobody" for a rule that
 * says so, and `inherits` (such as "Project default") for one left unset. A member or role no
 * longer there reads as gone.
 */
export function assignmentWords(
  rule: CommentAssignment | null | undefined,
  names: {
    members: readonly { userId: string; name: string }[];
    roles: readonly { id: string; name: string }[];
  },
  inherits = "Nobody",
): string {
  if (!rule) return inherits;
  if (!rule.assign) return "Nobody";
  if (rule.assign.kind === "member") {
    const userId = rule.assign.userId;
    return names.members.find((m) => m.userId === userId)?.name ?? "Someone no longer here";
  }
  const roleId = rule.assign.roleId;
  const role = names.roles.find((r) => r.id === roleId);
  return role ? `Whoever is ${role.name}` : "A role no longer here";
}
