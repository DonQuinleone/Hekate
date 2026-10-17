import type { OrganisationRole } from "./organisation.ts";

/**
 * Deleting a project takes two people (#240): someone whose role may delete it asks, and a
 * workspace owner other than them confirms. A workspace with one owner cannot find a second,
 * so its owner confirms their own request, but only a day after asking, so a deletion is never
 * one moment's decision.
 */
export const SOLE_OWNER_WAIT_MS = 24 * 60 * 60 * 1000;

/** Once confirmed, a project waits this long, archived, before it goes for good. */
export const DELETION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** A deletion waiting for its second person, as the danger zone shows it. */
export interface ProjectDeletion {
  /** Who asked, by name; null once their account is gone. */
  requestedBy: string | null;
  requestedAt: string;
  /** Whether the person looking may confirm it now, and may withdraw it. */
  mayConfirm: boolean;
  mayCancel: boolean;
  /** For a sole owner who asked: when they may confirm. */
  confirmableAt: string | null;
  /** Once confirmed: when it goes for good. Until then it can be kept. */
  deleteAfter: string | null;
}

/** Why this person may not confirm the deletion now, or null when they may. */
export function deletionProblem(
  request: { requestedBy: string | null; requestedAt: Date | null },
  confirmer: { userId: string; role: OrganisationRole },
  owners: number,
  now: Date,
): string | null {
  if (!request.requestedAt) return "No one has asked to delete this project";
  if (confirmer.role !== "owner") return "Only a workspace owner may confirm a deletion";
  if (confirmer.userId !== request.requestedBy) return null;
  if (owners > 1) return "Another owner of the workspace must confirm";
  return now.getTime() - request.requestedAt.getTime() >= SOLE_OWNER_WAIT_MS
    ? null
    : "As the workspace's only owner, confirm a day after asking";
}

/** When a sole owner who asked may confirm, or null when the wait does not apply. */
export function confirmableAt(
  request: { requestedBy: string | null; requestedAt: Date | null },
  confirmer: { userId: string; role: OrganisationRole },
  owners: number,
): Date | null {
  if (!request.requestedAt || confirmer.role !== "owner") return null;
  if (confirmer.userId !== request.requestedBy || owners > 1) return null;
  return new Date(request.requestedAt.getTime() + SOLE_OWNER_WAIT_MS);
}
