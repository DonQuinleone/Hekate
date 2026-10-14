import { z } from "zod";

/**
 * Every comment in Hekate points at something. An anchor says where.
 *
 * - `time`: a range of a recording or video in seconds; an instant when `start` equals `end`.
 *   `frame` is set for frame-accurate anchors in video.
 * - `region`: a rectangle on a document page or a video frame, in normalised 0 to 1 coordinates.
 * - `bar`: a bar and beat in a score-synced recording, or a range of bars.
 *
 * A comment with no anchor is about the whole file. Vocabulary: docs/domain.md.
 */
const seconds = z.number().finite().nonnegative();
const unit = z.number().min(0).max(1);

export const timeAnchor = z
  .object({
    kind: z.literal("time"),
    start: seconds,
    end: seconds,
    frame: z.number().int().nonnegative().optional(),
  })
  .refine((a) => a.end >= a.start, { message: "end must not be before start", path: ["end"] });

export const regionAnchor = z
  .object({
    kind: z.literal("region"),
    /** 1-based page number for documents; omitted for video frames. */
    page: z.number().int().positive().optional(),
    /** Time in seconds when the region is drawn on a video frame. */
    at: seconds.optional(),
    x: unit,
    y: unit,
    width: unit,
    height: unit,
  })
  .refine((a) => a.x + a.width <= 1 && a.y + a.height <= 1, {
    message: "region must lie inside the page or frame",
  });

const barPosition = z.object({
  bar: z.number().int().positive(),
  /** 1-based beat within the bar; fractional beats are allowed for off-beat positions. */
  beat: z.number().positive().default(1),
});

export const barAnchor = z
  .object({
    kind: z.literal("bar"),
    from: barPosition,
    /** End of a bar range, inclusive. Omitted for a single bar position. */
    to: z.object({ bar: z.number().int().positive() }).optional(),
  })
  .refine((a) => a.to === undefined || a.to.bar >= a.from.bar, {
    message: "a bar range must not end before it starts",
    path: ["to"],
  });

export const anchor = z.union([timeAnchor, regionAnchor, barAnchor]);

export type TimeAnchor = z.infer<typeof timeAnchor>;
export type RegionAnchor = z.infer<typeof regionAnchor>;
export type BarAnchor = z.infer<typeof barAnchor>;
export type Anchor = z.infer<typeof anchor>;
export type AnchorKind = Anchor["kind"];
