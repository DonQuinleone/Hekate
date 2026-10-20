import type { Database } from "@hekate/db";
import { type CheckState, type HealthChecks, readiness } from "@hekate/shared";
import type { Backends } from "@hekate/storage";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import type { Mailer } from "../mail.ts";
import { version } from "../version.ts";

/** How long a readiness answer is kept: probes come every few seconds, a storage check writes. */
const READY_MS = 10_000;

/** A check's state: ok, or failed for any error; never a message, as the answer is public. */
const state = async (check: () => Promise<unknown>): Promise<CheckState> => {
  try {
    await check();
    return "ok";
  } catch {
    return "failed";
  }
};

/**
 * `/api/health` (#156): `/` the database and the release, as the image's HEALTHCHECK asks;
 * `/live` that the process answers; `/ready` whether it can serve, with each part's state.
 */
export const health = (
  db: Database,
  deps: { backends?: Backends; mailer?: Mailer; now?: () => number } = {},
) => {
  const now = deps.now ?? Date.now;
  const verify = deps.mailer?.verify?.bind(deps.mailer);
  let kept: { at: number; checks: HealthChecks } | null = null;
  const checks = async (): Promise<HealthChecks> => {
    if (kept && now() - kept.at < READY_MS) return kept.checks;
    const [database, storage, worker, mail] = await Promise.all([
      state(() => db.execute(sql`select 1`)),
      deps.backends ? state(() => (deps.backends as Backends).checkAll()) : "off",
      // A worker finishes a scheduled job every minute; none for ten means none is running.
      db
        .execute<{ recent: boolean }>(
          sql`select exists (select 1 from pgboss.job where state = 'completed'
                and completed_on > now() - interval '10 minutes') as recent`,
        )
        .then(([row]): CheckState => (row?.recent ? "ok" : "stale"))
        .catch((): CheckState => "failed"),
      verify ? state(verify) : "off",
    ] as const);
    kept = { at: now(), checks: { database, storage, worker, mail } };
    return kept.checks;
  };
  return new Hono()
    .get("/", async (c) => {
      let database: "ok" | "unreachable" = "ok";
      try {
        await db.execute(sql`select 1`);
      } catch {
        database = "unreachable";
      }
      return c.json(
        { status: database === "ok" ? "ok" : "degraded", version, database } as const,
        database === "ok" ? 200 : 503,
      );
    })
    .get("/live", (c) => c.json({ status: "ok", version } as const))
    .get("/ready", async (c) => {
      const answer = readiness(version, await checks());
      return c.json(answer, answer.status === "ready" ? 200 : 503);
    });
};
