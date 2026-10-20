import { z } from "zod";

/**
 * Repertoire and venues (#48, docs/domain.md): a project's works, each with its tracks in order,
 * and the places it records in. A work's track is numbered as the score prints it ("1", "I",
 * "2a"); a single-track work is just one track. A track belongs to one work at most.
 */
const text = (max: number) => z.string().trim().max(max);

export const workTrackInput = z.object({
  trackId: z.uuid(),
  /** As typed: "1", "I", "2a". */
  number: text(12).default(""),
});

/** One track's number in its work, typed in place: changed alone, so two edits do not cross. */
export const workTrackNumberInput = z.object({ number: text(12) });

export const workInput = z
  .object({
    title: text(160).min(1, "Give the work a title"),
    composer: text(120).default(""),
    /** What it is for: "piano trio", "SATB and organ". */
    forces: text(160).default(""),
    /** Short enough for a schedule's column: "RAGS". */
    abbreviation: text(16).default(""),
    notes: text(2000).default(""),
    tracks: z.array(workTrackInput).max(200).default([]),
  })
  .refine((w) => new Set(w.tracks.map((t) => t.trackId)).size === w.tracks.length, {
    message: "A track is in a work once",
    path: ["tracks"],
  });
export type WorkInput = z.input<typeof workInput>;

export interface WorkTrack {
  trackId: string;
  name: string;
  number: string;
}

export interface Work {
  id: string;
  title: string;
  composer: string;
  forces: string;
  abbreviation: string;
  notes: string;
  tracks: WorkTrack[];
}

export const venueInput = z.object({
  name: text(120).min(1, "Name the venue"),
  /** As it is written on an envelope, a line each. */
  address: text(600).default(""),
  /** For the get-in: doors, parking, the piano's tuning. */
  notes: text(2000).default(""),
});
export type VenueInput = z.input<typeof venueInput>;

export interface Venue {
  id: string;
  name: string;
  address: string;
  notes: string;
}

/** The orders a repertoire is listed in. */
export const repertoireOrders = ["schedule", "alphabetical"] as const;
export type RepertoireOrder = (typeof repertoireOrders)[number];

/**
 * Works alphabetically, as a library shelves them: by title, ignoring a leading article and
 * case, numbers in order ("No. 2" before "No. 10").
 */
export function alphabetical<W extends Pick<Work, "title">>(works: W[]): W[] {
  const key = (title: string) => title.replace(/^(the|a|an)\s+/i, "");
  const collator = new Intl.Collator("en-GB", { numeric: true, sensitivity: "base" });
  return [...works].sort((a, b) => collator.compare(key(a.title), key(b.title)));
}

/** A work as a schedule or a list names it in one line: "RAGS · Rags (Scott Joplin)". */
export function workLine(w: Pick<Work, "title" | "composer" | "abbreviation">): string {
  const title = w.composer ? `${w.title} (${w.composer})` : w.title;
  return w.abbreviation ? `${w.abbreviation} · ${title}` : title;
}
