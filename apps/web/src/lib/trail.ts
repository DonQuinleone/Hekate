/**
 * How a breadcrumb trail fits its bar (#547): every crumb whole, never cut. When they do not
 * all fit, the middle goes into one "…" menu: first the crumbs between the first and the last,
 * then the last as well; the first stays, as the way up the project. The page's own name takes
 * what is left, and is cut with an ellipsis only when even that does not fit.
 */
export interface TrailPlan {
  /** The crumbs drawn in the bar, by index, in order. */
  shown: number[];
  /** The crumbs in the "…" menu, by index; where it stands, between the first and the rest. */
  folded: number[];
}

export interface TrailWidths {
  /** The room the trail has. */
  available: number;
  /** Each crumb's natural width, its separator included. */
  crumbs: number[];
  /** The page's name, whole, with whatever stands beside it. */
  title: number;
  /** The "…" button, its separator included. */
  more: number;
  /** The space between items. */
  gap: number;
}

const range = (from: number, to: number) =>
  Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);

/** The plans to try, from the whole trail to the most folded one. */
export function trailPlans(count: number): TrailPlan[] {
  const plans: TrailPlan[] = [{ shown: range(0, count), folded: [] }];
  if (count >= 3) plans.push({ shown: [0, count - 1], folded: range(1, count - 1) });
  if (count >= 2) plans.push({ shown: [0], folded: range(1, count) });
  return plans;
}

/** The width a plan takes, its title whole. */
export function planWidth(plan: TrailPlan, w: Omit<TrailWidths, "available">): number {
  const items = plan.shown.length + (plan.folded.length > 0 ? 1 : 0) + 1;
  return (
    plan.shown.reduce((sum, i) => sum + (w.crumbs[i] ?? 0), 0) +
    (plan.folded.length > 0 ? w.more : 0) +
    w.title +
    w.gap * Math.max(0, items - 1)
  );
}

/** The fullest plan whose crumbs and title fit whole; failing that, the most folded one. */
export function fitTrail(w: TrailWidths): TrailPlan {
  const plans = trailPlans(w.crumbs.length);
  return plans.find((p) => planWidth(p, w) <= w.available) ?? (plans.at(-1) as TrailPlan);
}
