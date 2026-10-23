import { z } from "zod";
import { formatBytes } from "./format.ts";

/**
 * Usage metering and quotas (#175). A workspace may be held to a storage quota and a number of
 * members, set by an operator and seeded from the instance's defaults; uploads and new members
 * are refused at the limit, and the workspace is warned from 90% of it. What it uses is counted
 * as it goes for the limits, and each month for the record: its storage at the month's peak,
 * its plays and downloads.
 */

/** The storage quotas offered, in bytes (decimal, as operating systems count them). */
export const storageQuotas = [250e9, 1e12, 2e12, 5e12] as const;
/** The member limits offered. */
export const memberLimits = [5, 10, 25, 50, 100] as const;

/** From here the workspace is warned that a limit is near. */
export const WARN_AT = 0.9;

/** A workspace's limits; null is none. */
export const workspaceLimits = z.object({
  /** Up to a petabyte. */
  storageQuota: z.number().int().positive().max(1e15).nullable(),
  memberLimit: z.number().int().positive().max(100_000).nullable(),
  /** Projects (#177); a client that leaves it out keeps what is set. */
  projectLimit: z.number().int().positive().max(100_000).nullable().optional(),
});
export type WorkspaceLimits = z.infer<typeof workspaceLimits>;

export const noLimits: WorkspaceLimits = {
  storageQuota: null,
  memberLimit: null,
  projectLimit: null,
};

/** How near a limit a count is: under, near (from 90%) or reached. Under, with no limit. */
export function standing(used: number, limit: number | null): "under" | "near" | "reached" {
  if (limit === null) return "under";
  if (used >= limit) return "reached";
  return used >= limit * WARN_AT ? "near" : "under";
}

/** The refusal at a limit, with where it stands: "Storage quota reached: 1.0 TB of 1.0 TB". */
export function limitRefusal(
  kind: "storage" | "members" | "projects",
  used: number,
  limit: number,
): string {
  if (kind === "storage")
    return `Storage quota reached: ${formatBytes(used)} of ${formatBytes(limit)}. Remove files, or ask the instance's operators for more.`;
  if (kind === "members")
    return `Member limit reached: ${used} of ${limit}. Remove someone, or ask the instance's operators for more.`;
  return `Project limit reached: ${used} of ${limit}. Delete a project, or ask the instance's operators for more.`;
}

/** What a workspace uses now, against its limits, and in the month so far. */
export interface WorkspaceUsage {
  limits: WorkspaceLimits;
  /** Bytes stored, before encryption, with the uploads still arriving. */
  storageBytes: number;
  /** Members, and the invitations waiting to be accepted, which take a place too. */
  members: number;
  invited: number;
  guests: number;
  projects: number;
  /** The month so far, as last counted; null before the first count. */
  month: {
    /** The month's first day, `2026-10-01`. */
    month: string;
    storagePeak: number;
    plays: number;
    downloads: number;
    measuredAt: string;
  } | null;
}

/** The month's first day, by UTC: the key a month's usage is kept under. */
export function monthOf(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}-01`;
}
