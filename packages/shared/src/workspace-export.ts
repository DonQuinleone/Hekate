import { z } from "zod";
import { DOWNLOAD_LINK_SECONDS } from "./downloads.ts";
import type { OrganisationRole } from "./organisation.ts";
import type { ProjectDeletion } from "./project-deletion.ts";

/**
 * Exporting and deleting a workspace (#186, decision 220). An owner, or an operator from the
 * instance, exports everything the workspace holds: its records as JSON and its files'
 * originals, in a tar archive encrypted with age to a key shown once. Its owners delete it as a
 * project is deleted, two of them agreeing; it is then suspended for the grace period operators
 * give a deletion, and purged.
 */

export const workspaceExportStatuses = [
  "queued",
  "building",
  "ready",
  "failed",
  "expired",
] as const;
export type WorkspaceExportStatus = (typeof workspaceExportStatuses)[number];

/** How long a finished archive is kept for its download, in days. */
export const WORKSPACE_EXPORT_DAYS = 7;

/** How long a download link for an archive works, once, in the session that asked for it. */
export const WORKSPACE_EXPORT_LINK_SECONDS = DOWNLOAD_LINK_SECONDS;

/** An age public key, as `age-keygen` prints it: Bech32, lower case, 32 bytes. */
export const ageRecipient = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^age1[02-9ac-hj-np-z]{58}$/, "That is not an age public key (age1…)");

/**
 * Starting an export: to an age public key of the person's own, or, without one, to a key made
 * for it and shown once.
 */
export const workspaceExportInput = z.object({ recipient: ageRecipient.optional() }).strict();
export type WorkspaceExportInput = z.infer<typeof workspaceExportInput>;

/** An export as its list shows it. */
export interface WorkspaceExport {
  id: string;
  status: WorkspaceExportStatus;
  /** Who asked, by name; null once their account is gone. */
  requestedBy: string | null;
  /** Asked by one of the instance's operators. */
  byOperator: boolean;
  /** The age public key it is encrypted to. */
  recipient: string;
  createdAt: string;
  finishedAt: string | null;
  /** Once ready: its size as it downloads, and how many stored files it holds. */
  byteSize: number | null;
  fileCount: number | null;
  /** When a ready archive goes. */
  expiresAt: string | null;
  /** Why it failed. */
  error: string | null;
}

/** A new export, and its secret key when one was made for it: shown now, and never again. */
export interface WorkspaceExportStarted {
  export: WorkspaceExport;
  key: string | null;
}

/** The archive's name as it downloads: the workspace's address and the day it was made. */
export function exportFileName(slug: string, made: Date): string {
  const safe = slug.replace(/[^a-z0-9-]/gi, "").toLowerCase() || "workspace";
  return `${safe}-export-${made.toISOString().slice(0, 10)}.tar.age`;
}

/**
 * Whom a deletion of the workspace waits on, as an owner sees it: the project's deletion view
 * (#240), the same two people and the same day's wait for a sole owner.
 */
export type WorkspaceDeletion = ProjectDeletion;

/** Confirming a deletion: the workspace's name, typed. */
export const workspaceDeletionConfirm = z.object({ name: z.string().trim().min(1).max(200) });

/**
 * Why a workspace its owners are deleting is suspended, and how it is told apart from an
 * operator's suspension: its owners may still keep it, and export it, until it goes.
 */
export const OWNER_DELETION_REASON =
  "Its owners are deleting it. Until it goes, an owner can keep it, or export everything in it.";

/** Whether a workspace role may export or delete the workspace: its owners only. */
export const mayExportWorkspace = (role: OrganisationRole | null | undefined) => role === "owner";
