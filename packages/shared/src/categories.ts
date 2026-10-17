import { z } from "zod";
import type { Anchor } from "./anchor.ts";

/**
 * Comment categories and deferral (docs/domain.md, Categories and deferral): each project
 * names the kinds of comment it gets, and each kind is handled one way by default.
 */
export const categoryHandlings = ["normal", "deferred", "information"] as const;
export type CategoryHandling = (typeof categoryHandlings)[number];

/** How each handling reads in settings and on a category's row. */
export const handlingWords: Record<CategoryHandling, string> = {
  normal: "Handled on this version",
  deferred: "Deferred to a stage",
  information: "Information only: no action expected",
};

/** A stage's name, as a deferred comment waits for it until workflows give stages ids. */
export const stageName = z.string().trim().min(1, "Name the stage").max(80);

export const categoryInput = z
  .object({
    name: z.string().trim().min(1, "A category needs a name").max(40),
    handling: z.enum(categoryHandlings),
    /** Deferred categories only: the stage their comments wait for. */
    stage: stageName.nullish(),
  })
  .refine((c) => c.handling !== "deferred" || Boolean(c.stage), {
    message: "Say which stage it defers to",
    path: ["stage"],
  })
  .transform((c) => ({ ...c, stage: c.handling === "deferred" ? (c.stage ?? null) : null }));
export type CategoryInput = z.input<typeof categoryInput>;

/** Every project starts with these, as the prototype has them (Noise waits for its stage). */
export const defaultCategories: {
  name: string;
  handling: CategoryHandling;
  stage: string | null;
}[] = [
  { name: "Noise", handling: "deferred", stage: "Noise reduction" },
  { name: "Edit", handling: "normal", stage: null },
  { name: "Balance", handling: "normal", stage: null },
  { name: "Performance", handling: "normal", stage: null },
  { name: "Information", handling: "information", stage: null },
];

/**
 * Triage on one or more threads at once (#132): a category, deferral to a stage or back,
 * who it is assigned to, and whether it is resolved. Leaving a field out leaves it as it is;
 * null clears it. A category that defers carries its stage unless `deferredTo` says
 * otherwise.
 */
export const triageInput = z
  .object({
    commentIds: z.array(z.uuid()).min(1, "Choose a comment").max(200),
    categoryId: z.uuid().nullable().optional(),
    deferredTo: stageName.nullable().optional(),
    assigneeId: z.string().min(1).max(64).nullable().optional(),
    resolved: z.boolean().optional(),
  })
  .refine(
    (t) =>
      t.categoryId !== undefined ||
      t.deferredTo !== undefined ||
      t.assigneeId !== undefined ||
      t.resolved !== undefined,
    { message: "Nothing to change" },
  );
export type TriageInput = z.infer<typeof triageInput>;

/** Sending someone the comments assigned to them on a file, as a list by mail. */
export const sendListInput = z.object({ userId: z.string().min(1).max(64) });

/**
 * Where a thread's deferral ends up after triage: what `deferredTo` says when it says
 * anything; otherwise, when the category changes, that category's stage (or none, for a
 * category that does not defer); otherwise as it was.
 */
export function deferralAfter(
  current: string | null,
  input: Pick<TriageInput, "categoryId" | "deferredTo">,
  category: { handling: CategoryHandling; stage: string | null } | null,
): string | null {
  if (input.deferredTo !== undefined) return input.deferredTo;
  if (input.categoryId === undefined) return current;
  return category?.handling === "deferred" ? category.stage : null;
}

/** What the triage queue needs of a thread. */
export interface TriageThread {
  id: string;
  anchor: Anchor | null;
  resolved: boolean;
  deferredTo: string | null;
  information: boolean;
}

/** Where a thread sits in playing order: its time, else the moment a bar or region was at. */
const startOf = (anchor: Anchor | null): number => {
  if (!anchor) return Number.POSITIVE_INFINITY;
  if (anchor.kind === "time") return anchor.start;
  return anchor.at ?? Number.MAX_SAFE_INTEGER;
};

/**
 * The threads a version still needs triaged, in the order they play: open, not deferred
 * and not information only; those anchored to the whole file come last.
 */
export function triageQueue<T extends TriageThread>(threads: T[]): T[] {
  return threads
    .filter((t) => !t.resolved && !t.deferredTo && !t.information)
    .sort((a, b) => startOf(a.anchor) - startOf(b.anchor));
}
