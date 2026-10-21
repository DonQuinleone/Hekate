import { type Database, inOrg, schema } from "@hekate/db";
import { type HealthChecks, newerReleases, type WorkspaceOperations } from "@hekate/shared";
import { desc, max, sql } from "drizzle-orm";
import { Hono } from "hono";
import type { InstanceSettingsStore } from "../instance-settings.ts";
import { metricsLastRead, noQueueYet } from "../metrics/index.ts";
import { HEKATE_VERSION } from "../system-info.ts";
import { requireRole, type TenantVariables } from "../tenancy.ts";
import { pendingRewrap } from "../workspace-keys.ts";

/** This workspace's jobs: waiting, running, and failed for good in the last day. */
async function queueOf(db: Database, organisationId: string) {
  try {
    const rows = await db.execute<{ state: string; n: number }>(
      sql`select state::text as state, count(*)::int as n from pgboss.job
          where data->>'organisationId' = ${organisationId}
            and (state in ('created', 'retry', 'active')
              or (state = 'failed' and completed_on > now() - interval '1 day'))
          group by state`,
    );
    const n = (...states: string[]) =>
      rows.filter((r) => states.includes(r.state)).reduce((sum, r) => sum + r.n, 0);
    return { waiting: n("created", "retry"), running: n("active"), failed: n("failed") };
  } catch (error) {
    // Before the queue's tables are made there is nothing in it; otherwise it cannot be read.
    if (noQueueYet(error)) return { waiting: 0, running: 0, failed: 0 };
    console.error("The job queue could not be read:", error);
    return null;
  }
}

/**
 * `/api/organisation/operations` (#165): for the owner, what the instance runs and how it is
 * doing for this workspace: the release, the worker, this workspace's queue, its encryption,
 * metrics and upgrades. Owners only.
 */
export const operationsRoutes = (deps: {
  db: Database;
  checks: () => Promise<HealthChecks>;
  settings: InstanceSettingsStore;
  build: string;
  updateCheck: boolean;
  metricsOn: boolean;
}) =>
  new Hono<{ Variables: TenantVariables }>().use("*", requireRole("owner")).get("/", async (c) => {
    const { db } = deps;
    const org = c.var.organisationId;
    const keys = schema.organisationKeys;
    const [checks, queue, [key], [checked], settings] = await Promise.all([
      deps.checks(),
      queueOf(db, org),
      db
        .select({ version: keys.version, createdAt: keys.createdAt })
        .from(keys)
        .where(inOrg(keys, org))
        .orderBy(desc(keys.version))
        .limit(1),
      db.select().from(schema.releaseChecks),
      deps.settings.get(),
    ]);
    // Read by whichever replica was scraped (#188): this one's, or the latest any replica measured.
    const [measured] = await db
      .select({ at: max(schema.healthSamples.metricsReadAt) })
      .from(schema.healthSamples);
    const read = [metricsLastRead(), measured?.at ?? null].reduce<Date | null>(
      (latest, at) => (at && (!latest || at > latest) ? at : latest),
      null,
    );
    return c.json({
      version: HEKATE_VERSION,
      build: deps.build,
      worker: checks.worker,
      queue,
      encryption: {
        keyVersion: key?.version ?? null,
        keySince: key?.createdAt.toISOString() ?? null,
        behind: key ? await pendingRewrap(db, org, key.version) : 0,
      },
      metrics: { on: deps.metricsOn, lastReadAt: read?.toISOString() ?? null },
      release: {
        checkOn: deps.updateCheck,
        newer: deps.updateCheck
          ? (newerReleases(HEKATE_VERSION, checked?.releases ?? [], settings.updates.channel)[0] ??
            null)
          : null,
      },
    } satisfies WorkspaceOperations);
  });
