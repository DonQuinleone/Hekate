import type { ReviewDetail } from "./queries";

/** A reviewer on the new review page, by key: `member:<user id>`, `guest:<email>` or `group:<id>`. */
export type ReviewerKey = string;

/** One step of the order on the new review page (#500): who is asked together, and its name. */
export interface FormStep {
  name: string;
  people: ReviewerKey[];
}

export const emptyStep = (): FormStep => ({ name: "", people: [] });

/** The step someone is in, or -1. */
export const stepIndexOf = (steps: FormStep[], key: ReviewerKey) =>
  steps.findIndex((s) => s.people.includes(key));

/** Someone added to a step, unless they are already asked somewhere. */
export function addToStep(steps: FormStep[], index: number, key: ReviewerKey): FormStep[] {
  if (stepIndexOf(steps, key) !== -1) return steps;
  return steps.map((s, i) => (i === index ? { ...s, people: [...s.people, key] } : s));
}

/** Someone taken out of the order, wherever they were. */
export const dropFromSteps = (steps: FormStep[], key: ReviewerKey): FormStep[] =>
  steps.map((s) => ({ ...s, people: s.people.filter((k) => k !== key) }));

/** Someone moved to another step, at its end. */
export const moveToStep = (steps: FormStep[], key: ReviewerKey, to: number): FormStep[] =>
  dropFromSteps(steps, key).map((s, i) => (i === to ? { ...s, people: [...s.people, key] } : s));

/** A step renamed. */
export const renameStep = (steps: FormStep[], index: number, name: string): FormStep[] =>
  steps.map((s, i) => (i === index ? { ...s, name } : s));

/**
 * A step removed: whoever was in it joins the step before it (or the first), so nobody is
 * dropped from the review by taking a step away. The last step left is emptied, not removed.
 */
export function removeStep(steps: FormStep[], index: number): FormStep[] {
  const gone = steps[index];
  if (!gone) return steps;
  if (steps.length === 1) return [emptyStep()];
  const rest = steps.filter((_, i) => i !== index);
  const into = Math.max(0, index - 1);
  return rest.map((s, i) => (i === into ? { ...s, people: [...s.people, ...gone.people] } : s));
}

/** Every step folded into one, in order: what "All at once" sends. */
export const mergeSteps = (steps: FormStep[]): FormStep[] => [
  { name: "", people: steps.flatMap((s) => s.people) },
];

/**
 * A review's reviewers as the new review page holds them, to ask the same people again
 * (#502): by step, a group once per step it was asked at, everyone else by themselves. A
 * guest whose address the viewer may not see cannot be asked again and is left out.
 */
export function stepsFromReview(review: {
  order: ReviewDetail["order"];
  stepNames: ReviewDetail["stepNames"];
  reviewers: Pick<ReviewDetail["reviewers"][number], "step" | "userId" | "email" | "group">[];
}): FormStep[] {
  const positions = [...new Set(review.reviewers.map((r) => r.step))].sort((a, b) => a - b);
  const steps = positions.map((position): FormStep => {
    const people: ReviewerKey[] = [];
    for (const r of review.reviewers.filter((x) => x.step === position)) {
      const key = r.group
        ? `group:${r.group.id}`
        : r.userId
          ? `member:${r.userId}`
          : r.email
            ? `guest:${r.email}`
            : null;
      if (key && !people.includes(key)) people.push(key);
    }
    return { name: review.stepNames?.[position] ?? "", people };
  });
  return review.order === "sequence" ? steps : mergeSteps(steps);
}

/** A review's items as the page chooses them: a track at the version it asked about, or a file. */
export function itemsFromReview(
  review: Pick<ReviewDetail, "items">,
): Map<string, { versionId: string | null }> {
  return new Map(
    review.items.map((item) =>
      item.kind === "track"
        ? [
            `track:${item.trackId}`,
            { versionId: item.follows === "version" ? (item.version?.id ?? null) : null },
          ]
        : [`file:${item.fileId}`, { versionId: null }],
    ),
  );
}

/** A due instant as a date field holds it, on the viewer's calendar; empty for none. */
export function dueDateOf(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
