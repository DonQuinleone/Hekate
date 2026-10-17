import { z } from "zod";
import type { BarAnchor } from "./anchor.ts";
import type { ProjectProfile } from "./profile.ts";

/**
 * What reviewers may type beside a comment, as they read it from the score (#240): the page,
 * the bars, and beats within a bar. Never derived from the time, never on the scrub bar. A
 * project chooses them; until it does, a music project has them all and the others none.
 */
export const commentReferences = z.object({
  page: z.boolean(),
  bar: z.boolean(),
  beat: z.boolean(),
});
export type CommentReferences = z.infer<typeof commentReferences>;

export const defaultReferences = (profile: ProjectProfile): CommentReferences =>
  profile === "music"
    ? { page: true, bar: true, beat: true }
    : { page: false, bar: false, beat: false };

/** A project's references as stored, or its profile's when it has chosen none. */
export function referencesOf(stored: unknown, profile: ProjectProfile): CommentReferences {
  const parsed = commentReferences.safeParse(stored);
  return parsed.success ? parsed.data : defaultReferences(profile);
}

/** A file's references: its track's own choice, else its project's, else its profile's. */
export function effectiveReferences(
  stored: { track?: unknown; project: unknown },
  profile: ProjectProfile,
): CommentReferences {
  const own = commentReferences.safeParse(stored.track);
  return own.success ? own.data : referencesOf(stored.project, profile);
}

/**
 * The sets a track may choose from, named as people say them. Pages and beats only make sense
 * beside bars, so the others are never offered.
 */
export const referenceSets = [
  { id: "none", label: "None", references: { page: false, bar: false, beat: false } },
  { id: "bars", label: "Bars", references: { page: false, bar: true, beat: false } },
  { id: "bars-beats", label: "Bars and beats", references: { page: false, bar: true, beat: true } },
  { id: "pages-bars", label: "Pages and bars", references: { page: true, bar: true, beat: false } },
  {
    id: "pages-bars-beats",
    label: "Pages, bars and beats",
    references: { page: true, bar: true, beat: true },
  },
] as const satisfies readonly { id: string; label: string; references: CommentReferences }[];
export type ReferenceSetId = (typeof referenceSets)[number]["id"];

/** Which set some references are, or null for one that is not offered (beats without bars). */
export function referenceSetOf(references: CommentReferences): ReferenceSetId | null {
  // Without bars, pages and beats say nothing: the set is none.
  if (!references.bar) return "none";
  return (
    referenceSets.find(
      (set) =>
        set.references.bar &&
        set.references.page === references.page &&
        set.references.beat === references.beat,
    )?.id ?? null
  );
}

/** Choosing a track's own references, or null to keep the project's. */
export const trackReferencesInput = z.object({ references: commentReferences.nullable() }).strict();

/** A beat as typed in its own field: from 1 to 32, halves and quarters allowed. Null when not one. */
export function parseBeat(text: string): number | null {
  const m = /^\s*(\d{1,2}(?:\.\d{1,2})?)\s*$/.exec(text);
  if (!m) return null;
  const beat = Number(m[1]);
  return beat >= 1 && beat <= 32 ? beat : null;
}

/** Why a bar anchor asks for a reference the project does not take, or null. */
export function referenceProblem(anchor: BarAnchor, references: CommentReferences): string | null {
  if (!references.bar) return "This project takes no bar references";
  if (anchor.page !== undefined && !references.page) return "This project takes no page references";
  if (anchor.from.beat !== 1 && !references.beat) return "This project takes no beats";
  return null;
}
