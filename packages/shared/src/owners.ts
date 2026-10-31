import { z } from "zod";
import type { OrganisationRole } from "./organisation.ts";

/**
 * A project's owners (#507, decision 285): fixed above its configurable roles, so an owner may
 * do everything in it whatever their role says. Its creator is the first; there may be several,
 * as a Slack workspace has; and there is always one, so the last steps down or leaves only by
 * handing it on.
 */

/** Someone with a place in a project, as its People page lists them. */
export interface ProjectMember {
  userId: string;
  name: string;
  email: string;
  /** Their role here; null for an owner who holds none (they take the creator's as a member). */
  roleId: string | null;
  /** Their role in the workspace: an owner or admin keeps every tool, whatever the project says. */
  workspaceRole: OrganisationRole | null;
  /** When they became one of its owners, or null when they are not one. */
  ownerSince: string | null;
}

/** Leaving a project: the last owner names who takes over, a member of the workspace. */
export const projectLeaveInput = z.object({
  successorId: z.string().min(1).max(64).optional(),
});
export type ProjectLeaveInput = z.infer<typeof projectLeaveInput>;

/** Why someone may not stop being an owner: they are not one, or no other owner would remain. */
export type StepDownRefusal = "not_owner" | "last_owner";

/** Whether an owner may be made a member again: only while another owner remains. */
export function stepDownRefusal(
  ownerIds: readonly string[],
  userId: string,
): StepDownRefusal | null {
  if (!ownerIds.includes(userId)) return "not_owner";
  return ownerIds.some((id) => id !== userId) ? null : "last_owner";
}

/** Why someone may not leave a project as they ask. */
export type LeaveRefusal = "successor_needed" | "successor_is_you";

/**
 * Whether someone may leave a project: anyone but its last owner may; the last owner names a
 * successor, someone other than themself, who becomes an owner as they go. A successor named
 * by anyone else is not needed and ignored.
 */
export function leaveRefusal(
  ownerIds: readonly string[],
  userId: string,
  successorId: string | undefined,
): LeaveRefusal | null {
  if (stepDownRefusal(ownerIds, userId) !== "last_owner") return null;
  if (!successorId) return "successor_needed";
  return successorId === userId ? "successor_is_you" : null;
}

/** Whether someone may make owners and make them members again: an owner, or a workspace admin. */
export const managesOwners = (organisationRole: OrganisationRole | null, owner: boolean) =>
  owner || organisationRole === "owner" || organisationRole === "admin";
