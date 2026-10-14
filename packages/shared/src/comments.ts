import { z } from "zod";
import { type Anchor, anchor } from "./anchor.ts";
import type { FileKind } from "./files.ts";
import { allowsAnchor, type ProjectProfile } from "./profile.ts";

/** A comment's text: trimmed, never empty, at most 10,000 characters. */
export const commentBody = z
  .string()
  .trim()
  .min(1, "A comment needs some text")
  .max(10_000, "A comment can be at most 10,000 characters");

/**
 * A new comment. A top-level comment may carry an anchor (none means the whole file);
 * a reply belongs to its thread and takes the thread's anchor, so it carries none.
 */
export const createCommentInput = z
  .object({
    body: commentBody,
    anchor: anchor.nullish(),
    parentId: z.uuid().nullish(),
  })
  .refine((c) => !(c.parentId && c.anchor), {
    message: "A reply takes its thread's anchor",
    path: ["anchor"],
  });

export const editCommentInput = z.object({ body: commentBody });

export const resolveCommentInput = z.object({ resolved: z.boolean() });

export type CreateCommentInput = z.infer<typeof createCommentInput>;

/** A little slack for players that report the end a few frames late. */
const END_TOLERANCE = 0.5;

/**
 * Why an anchor cannot point into a file, or null when it can: time needs audio or video
 * and must lie within it; a region needs a page or a frame; bars need a recording or a
 * score.
 */
export function anchorProblem(
  value: Anchor,
  /**
   * `pages` is how many pages a document was drawn with, once it has been; `profile`, the
   * project's, which decides whether bars are offered at all.
   */
  file: { kind: FileKind; duration?: number; pages?: number | null; profile?: ProjectProfile },
): string | null {
  if (file.profile && !allowsAnchor(file.profile, value.kind)) {
    return value.kind === "bar"
      ? "Bars belong to music projects"
      : "This project has no such anchor";
  }
  switch (value.kind) {
    case "time":
      if (file.kind !== "audio" && file.kind !== "video")
        return "Only audio and video have a timeline";
      if (file.duration !== undefined && value.end > file.duration + END_TOLERANCE)
        return "The time is past the end of the file";
      return null;
    case "region":
      if (file.kind === "audio" || file.kind === "other") return "Regions need a page or a frame";
      if (value.at !== undefined && file.kind !== "video") return "Only video has frames in time";
      if (value.page !== undefined && file.kind !== "document") return "Only documents have pages";
      // Say where: a document's page, a video's moment. An image is one picture.
      if (file.kind === "document" && value.page === undefined) return "Say which page";
      if (file.kind === "video" && value.at === undefined) return "Say which frame";
      if (value.page !== undefined && file.pages && value.page > file.pages)
        return "The document has no such page";
      return null;
    case "bar":
      if (file.kind === "image" || file.kind === "other") return "Bars need a recording or a score";
      return null;
  }
}

/**
 * Comments across versions (docs/domain.md). A thread raised on one version is carried
 * to the next while it is unresolved; on each version it has a status the editor or
 * producer sets, and can be hidden there.
 */
export const carryStatuses = ["open", "fixed", "not_fixed", "wont_fix"] as const;
export const carryStatus = z.enum(carryStatuses);
export type CarryStatus = z.infer<typeof carryStatus>;

/** Fixed and won't fix settle a thread; open and not fixed keep it going to the next version. */
export const carrySettles = (status: CarryStatus) => status === "fixed" || status === "wont_fix";

/** How a status reads on the version it was set on: "Fixed in V5". */
export function carryStatusLabel(status: CarryStatus, versionNumber: number): string {
  switch (status) {
    case "open":
      return "Open";
    case "fixed":
      return `Fixed in V${versionNumber}`;
    case "not_fixed":
      return "Not fixed";
    case "wont_fix":
      return "Won't fix";
  }
}

/** Triage on a carried thread: its status here, whether it shows here, and where it points. */
export const updateCarryInput = z
  .object({
    status: carryStatus.optional(),
    visible: z.boolean().optional(),
    /** The corrected mapping; null is the whole file. */
    anchor: anchor.nullable().optional(),
  })
  .refine((u) => u.status !== undefined || u.visible !== undefined || u.anchor !== undefined, {
    message: "Nothing to change",
  });
export type UpdateCarryInput = z.infer<typeof updateCarryInput>;

/**
 * Which file of a new version a thread moves to: the variation with the same name as the
 * one it was on (the wet mix to the wet mix), otherwise the new version's primary.
 */
export function carryTarget<T extends { name: string; isPrimary: boolean }>(
  fromName: string,
  targets: T[],
): T | undefined {
  const named = targets.find((t) => t.name.trim().toLowerCase() === fromName.trim().toLowerCase());
  return named ?? targets.find((t) => t.isPrimary) ?? targets[0];
}

/**
 * How far a carried anchor has moved from where the thread began, in seconds: what a
 * before-and-after comparison offsets the earlier version by. Zero unless both are times.
 */
export function anchorShift(from: Anchor | null, to: Anchor | null): number {
  if (from?.kind !== "time" || to?.kind !== "time") return 0;
  return from.start - to.start;
}
