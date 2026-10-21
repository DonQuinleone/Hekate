/**
 * The lanes jobs run in (#189): a worker takes some or all of them, each as many at once as it
 * is told, so media work scales by adding workers that take only the heavy lanes.
 * transcode: streaming renditions; analyse: measuring, analysing, aligning and checksums;
 * pages: documents drawn as pages; mail: notifications, digests and reminders; system: the
 * instance's own sweeps, purges and checks.
 */
export const lanes = ["transcode", "analyse", "pages", "mail", "system"] as const;
export type Lane = (typeof lanes)[number];

/** What a process does: everything, only answer requests, or only run jobs. */
export const roles = ["all", "api", "worker"] as const;
export type Role = (typeof roles)[number];

/**
 * The lanes a worker takes, and how many of each at once where it says; null means every lane,
 * each as many at once as the job asks. Written `transcode:4,analyse` (WORKER_LANES).
 */
export type LanePlan = Map<Lane, number | null> | null;

/** WORKER_LANES read, or why it cannot be. */
export function parseLanes(text: string): { plan: LanePlan } | { error: string } {
  const plan = new Map<Lane, number | null>();
  for (const part of text.split(",").map((p) => p.trim())) {
    const [name, count, ...rest] = part.split(":");
    const lane = lanes.find((l) => l === name);
    if (!lane || rest.length > 0) return { error: `"${part}" is not a lane (${lanes.join(", ")})` };
    if (plan.has(lane)) return { error: `${lane} is named twice` };
    if (count === undefined) {
      plan.set(lane, null);
      continue;
    }
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > 64)
      return { error: `${lane}'s jobs at once must be a number from 1 to 64` };
    plan.set(lane, n);
  }
  return { plan };
}

/** How many of a lane's jobs to run at once, or none when the plan leaves the lane out. */
export function concurrencyIn(plan: LanePlan, lane: Lane, asked: number): number | null {
  if (!plan) return asked;
  if (!plan.has(lane)) return null;
  return plan.get(lane) ?? asked;
}

/** The role a process takes: ROLE, or, without it, WORKER's older switch. */
export const roleOf = (role: Role | undefined, worker: boolean): Role =>
  role ?? (worker ? "all" : "api");

/** Whether a role serves a path: a worker answers only its health and metrics. */
export const servesPath = (role: Role, path: string) =>
  role !== "worker" || path === "/metrics" || path.startsWith("/api/health");
