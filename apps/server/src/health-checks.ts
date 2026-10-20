import type { Database } from "@hekate/db";
import type { CheckState, HealthChecks } from "@hekate/shared";
import type { Backends } from "@hekate/storage";
import { sql } from "drizzle-orm";
import type { Mailer } from "./mail.ts";

/** How long an answer is kept: probes come every few seconds, and a storage check writes. */
const KEEP_MS = 10_000;

/** How long a check may take: a probe that waits longer has failed anyway. */
export const CHECK_MS = 3_000;

/**
 * A check's state: ok, or failed for any error or for taking too long (a mail server that
 * never answers must not hold up the answer); never a message, as readiness is public.
 */
export const stateOf = async (
  check: () => Promise<unknown>,
  limitMs: number,
): Promise<CheckState> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), limitMs);
      }),
    ]);
    return "ok";
  } catch {
    return "failed";
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Each part of the machine's state (#156), for the readiness probe and the System health
 * page: the database, storage, the worker and mail, kept for ten seconds.
 */
export function createHealthChecks(
  db: Database,
  deps: { backends?: Backends; mailer?: Mailer; now?: () => number; checkMs?: number } = {},
): () => Promise<HealthChecks> {
  const now = deps.now ?? Date.now;
  const limit = deps.checkMs ?? CHECK_MS;
  const verify = deps.mailer?.verify?.bind(deps.mailer);
  let kept: { at: number; checks: HealthChecks } | null = null;
  return async () => {
    if (kept && now() - kept.at < KEEP_MS) return kept.checks;
    const [database, storage, worker, mail] = await Promise.all([
      stateOf(() => db.execute(sql`select 1`), limit),
      deps.backends ? stateOf(() => (deps.backends as Backends).checkAll(), limit) : "off",
      // A worker finishes a scheduled job every minute; none for ten means none is running.
      (async (): Promise<CheckState> => {
        let recent = false;
        const read = await stateOf(async () => {
          const [row] = await db.execute<{ recent: boolean }>(
            sql`select exists (select 1 from pgboss.job where state = 'completed'
                  and completed_on > now() - interval '10 minutes') as recent`,
          );
          recent = row?.recent ?? false;
        }, limit);
        return read === "failed" ? "failed" : recent ? "ok" : "stale";
      })(),
      verify ? stateOf(verify, limit) : "off",
    ] as const);
    kept = { at: now(), checks: { database, storage, worker, mail } };
    return kept.checks;
  };
}
