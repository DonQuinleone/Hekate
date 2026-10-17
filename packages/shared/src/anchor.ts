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
  /** Bar 0 is an upbeat, before the first full bar. */
  bar: z.number().int().nonnegative(),
  /** 1-based beat within the bar; fractional beats are allowed for off-beat positions. */
  beat: z.number().positive().default(1),
});

export const barAnchor = z
  .object({
    kind: z.literal("bar"),
    from: barPosition,
    /** End of a bar range, inclusive. Omitted for a single bar position. */
    to: z.object({ bar: z.number().int().nonnegative() }).optional(),
    /** The score's page the bars are on, as the reviewer reads it (#240); optional. */
    page: z.number().int().positive().max(100_000).optional(),
    /**
     * Where in a recording the reviewer was when they named the bar, in seconds, so the
     * comment plays from there. Bars are typed by people, never synced to the recording.
     */
    at: seconds.optional(),
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

/** The largest bar number a reference accepts; long enough for any score. */
const MAX_BAR = 100_000;
/** The most beats a bar can have; enough for any metre. */
const MAX_BEAT = 32;

/**
 * A bar reference as people type it: "25", "0" for an upbeat, or a range such as "9-12",
 * "9–12" or "9 to 12"; with beats, a bar and its beat such as "25.3". Null when the text is
 * not one.
 */
export function parseBars(
  text: string,
  options: { beats?: boolean } = {},
): { from: { bar: number; beat: number }; to?: { bar: number } } | null {
  if (options.beats) {
    const b = /^\s*(?:bar\.?\s*)?(\d{1,6})[.:](\d{1,2}(?:\.\d{1,2})?)\s*$/i.exec(text);
    if (b) {
      const bar = Number(b[1]);
      const beat = Number(b[2]);
      return bar <= MAX_BAR && beat >= 1 && beat <= MAX_BEAT ? { from: { bar, beat } } : null;
    }
  }
  const m = /^\s*(?:bars?\.?\s*)?(\d{1,6})\s*(?:(?:-|–|—|to)\s*(\d{1,6}))?\s*$/i.exec(text);
  if (!m) return null;
  const from = Number(m[1]);
  const to = m[2] === undefined ? undefined : Number(m[2]);
  if (from > MAX_BAR || (to !== undefined && (to > MAX_BAR || to < from))) return null;
  return to === undefined || to === from
    ? { from: { bar: from, beat: 1 } }
    : { from: { bar: from, beat: 1 }, to: { bar: to } };
}
