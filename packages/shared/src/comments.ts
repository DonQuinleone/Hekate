import { z } from "zod";
import { type Anchor, anchor } from "./anchor.ts";
import type { FileKind } from "./files.ts";
import { allowsAnchor, type ProjectProfile } from "./profile.ts";
import { type CommentReferences, referenceProblem } from "./references.ts";

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
/**
 * The members a comment mentions, by account, as the mention picker chose them (#133). The
 * server refuses anyone outside the project; the text still reads "@Name".
 */
export const commentMentions = z.array(z.string().min(1).max(64)).max(20);

export const createCommentInput = z
  .object({
    body: commentBody,
    anchor: anchor.nullish(),
    parentId: z.uuid().nullish(),
    mentions: commentMentions.optional(),
    /**
     * The thread's category from the start (#43), as triage would set it: for those who
     * triage, as when a finding becomes a comment.
     */
    categoryId: z.uuid().nullish(),
    /** The channel it is about (#74), by its place in the file's order: "the left", "the LFE". */
    channel: z.number().int().min(0).max(63).nullish(),
  })
  .refine((c) => !(c.parentId && c.anchor), {
    message: "A reply takes its thread's anchor",
    path: ["anchor"],
  })
  .refine((c) => !(c.parentId && c.categoryId), {
    message: "A reply takes its thread's category",
    path: ["categoryId"],
  })
  .refine((c) => !(c.parentId && c.channel != null), {
    message: "A reply takes its thread's channel",
    path: ["channel"],
  });

export const editCommentInput = z.object({
  body: commentBody,
  mentions: commentMentions.optional(),
});

/** A thread as a task (#133): made one by triage, and done by triage or whoever it is for. */
export const commentTodoInput = z.object({ todo: z.boolean(), done: z.boolean().default(false) });

/** A comment's attachments (#133): how many, and how large each may be. */
export const COMMENT_ATTACHMENTS_MAX = 5;
export const COMMENT_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

/** An attachment's name, as the person's computer called it: no paths, no control characters. */
export const attachmentName = z
  .string()
  .trim()
  .min(1, "An attachment needs a name")
  .max(200, "An attachment's name can be at most 200 characters")
  .refine(
    (n) =>
      [...n].every((ch) => {
        const code = ch.charCodeAt(0);
        return ch !== "/" && ch !== "\\" && code >= 32 && code !== 127;
      }),
    "Not a file name",
  );

/** A file attached to a comment, as the thread shows it. */
export interface CommentAttachment {
  id: string;
  name: string;
  contentType: string;
  byteSize: number;
}

/** Someone a comment mentions, named as they were when it was written. */
export interface CommentMention {
  id: string;
  name: string;
}

export const resolveCommentInput = z.object({ resolved: z.boolean() });

export type CreateCommentInput = z.infer<typeof createCommentInput>;

/** A little slack for players that report the end a few frames late. */
export const END_TOLERANCE = 0.5;

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
  file: {
    kind: FileKind;
    duration?: number;
    pages?: number | null;
    profile?: ProjectProfile;
    /** The project's references (#240), which decide bars, pages and beats over its profile. */
    references?: CommentReferences;
  },
): string | null {
  if (value.kind === "bar" && file.references) {
    const problem = referenceProblem(value, file.references);
    if (problem) return problem;
  } else if (file.profile && !allowsAnchor(file.profile, value.kind)) {
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
      if (value.at !== undefined) {
        if (file.kind !== "audio" && file.kind !== "video")
          return "Only audio and video have a timeline";
        if (file.duration !== undefined && value.at > file.duration + END_TOLERANCE)
          return "The time is past the end of the file";
      }
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
  const a = anchorTime(from);
  const b = anchorTime(to);
  return a === null || b === null ? 0 : a - b;
}

/** Where in a recording an anchor plays from: a time's start, or the moment a bar was named. */
export function anchorTime(anchor: Anchor | null): number | null {
  if (anchor?.kind === "time") return anchor.start;
  if (anchor?.kind === "bar" && anchor.at !== undefined) return anchor.at;
  return null;
}
