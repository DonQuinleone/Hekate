import { z } from "zod";
import { type Anchor, anchor } from "./anchor.ts";
import type { FileKind } from "./files.ts";

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
  file: { kind: FileKind; duration?: number },
): string | null {
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
      return null;
    case "bar":
      if (file.kind === "image" || file.kind === "other") return "Bars need a recording or a score";
      return null;
  }
}
