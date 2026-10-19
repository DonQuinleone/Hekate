import { z } from "zod";
import type { OrganisationRole } from "./organisation.ts";

/**
 * Moving a project to another workspace (#240, decisions 135 and 136). Someone whose role may
 * delete the project (`delete_project`) asks. Where they are also an owner or admin of the
 * gaining workspace, it moves at once; otherwise it waits for a second member of the losing
 * workspace with the same permission to approve, and an owner or admin of the gaining one to
 * accept. Every step is confirmed by typing the project's name and the person's password (or
 * a sign-in in the last ten minutes, for an account without one), as deleting an account is.
 */

/** A transfer no one acts on lapses after a week. */
export const TRANSFER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const transferStatuses = [
  "pending",
  /** Approved and accepted: the move is under way. */
  "moving",
  "moved",
  "cancelled",
  "refused",
  "expired",
] as const;
export type TransferStatus = (typeof transferStatuses)[number];

/** How a step is confirmed: the project's name, typed, and the person's password if they have one. */
export const transferConfirmation = z.object({
  name: z.string().trim().min(1).max(200),
  password: z.string().max(1024).optional(),
});
export type TransferConfirmation = z.infer<typeof transferConfirmation>;

/**
 * Asking to move a project: to one of the person's own workspaces by its id, or to another by
 * its address, which its owners can give them.
 */
export const transferRequestInput = transferConfirmation.extend({
  to: z.union([
    z.object({ id: z.uuid() }).strict(),
    z
      .object({
        address: z.string().trim().toLowerCase().min(1).max(100),
      })
      .strict(),
  ]),
});
export type TransferRequestInput = z.infer<typeof transferRequestInput>;

/** The operator's move (#240): straight to a workspace by its id, without approval or acceptance. */
export const operatorMoveInput = transferConfirmation.extend({ to: z.uuid() });
export type OperatorMoveInput = z.infer<typeof operatorMoveInput>;

/** Whether a typed name is the project's: the same, ignoring case and the spaces around it. */
export const nameMatches = (typed: string, name: string) =>
  typed.trim().toLocaleLowerCase() === name.trim().toLocaleLowerCase();

/** Whether a workspace role may take a project into the workspace. */
export const mayTakeProjects = (role: OrganisationRole | null | undefined) =>
  role === "owner" || role === "admin";

/** A transfer's two sign-offs, and whether it may move now. */
export interface TransferSteps {
  approvedAt: Date | null;
  acceptedAt: Date | null;
}
export const readyToMove = (t: TransferSteps) => t.approvedAt !== null && t.acceptedAt !== null;

/** Whether a pending transfer has lapsed. */
export const lapsed = (t: { status: TransferStatus; expiresAt: Date }, now: Date) =>
  t.status === "pending" && t.expiresAt.getTime() <= now.getTime();

/**
 * Why this person may not approve the transfer for the losing workspace now, or null when they
 * may: a second member, not the one who asked, whose role may delete the project.
 */
export function approvalProblem(
  t: { status: TransferStatus; requestedBy: string | null; approvedAt: Date | null },
  approver: { userId: string; mayDelete: boolean },
): string | null {
  if (t.status !== "pending") return "This transfer is no longer waiting";
  if (t.approvedAt) return "This transfer is already approved";
  if (!approver.mayDelete) return "Your role in this project does not allow that";
  if (approver.userId === t.requestedBy) return "A second member must approve it";
  return null;
}

/** Why this person may not accept the transfer for the gaining workspace now, or null. */
export function acceptanceProblem(
  t: { status: TransferStatus; acceptedAt: Date | null },
  accepter: { role: OrganisationRole | null },
): string | null {
  if (t.status !== "pending") return "This transfer is no longer waiting";
  if (t.acceptedAt) return "This transfer is already accepted";
  if (!mayTakeProjects(accepter.role))
    return "Only an owner or admin of the workspace may accept a project";
  return null;
}

/** A transfer as either workspace sees it. */
export interface ProjectTransfer {
  id: string;
  project: { id: string; name: string };
  from: { id: string; name: string };
  to: { id: string; name: string };
  status: TransferStatus;
  requestedBy: string | null;
  requestedAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  acceptedBy: string | null;
  acceptedAt: string | null;
  expiresAt: string;
  /** What the person looking may do about it now. */
  you: { mayApprove: boolean; mayAccept: boolean; mayRefuse: boolean; mayCancel: boolean };
}

/** Where someone may ask to move a project: their other workspaces, and whether it would move at once. */
export interface TransferDestination {
  id: string;
  name: string;
  /** They are an owner or admin there, so the project moves as soon as they confirm. */
  atOnce: boolean;
}
