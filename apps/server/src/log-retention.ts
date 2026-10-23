import { type Database, inOrg, schema, withAuditPurge } from "@hekate/db";
import type { InstanceSettings } from "@hekate/shared";
import { asc, inArray, lt, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { idAt } from "./logs.ts";
import { recordInstanceEvent } from "./routes/instance.ts";

/**
 * Each log kept as long as the instance's settings say (#157), and no longer: a job once a day.
 * Every log goes a batch at a time, oldest first by its time-ordered ids, so no transaction
 * holds a year of it; the access log only through its purge setting (decision 020), one
 * workspace at a time. What went is itself an instance event, written even when a later batch
 * fails, so nothing that was trimmed goes unrecorded.
 */

const DAY = 24 * 60 * 60_000;
/** Rows deleted in one transaction. */
const BATCH = 5_000;

const cutoff = (days: number, now: Date) => new Date(now.getTime() - days * DAY);

export interface Purged {
  audit: number;
  auth: number;
  mail: number;
  /** Events (#161), each with its deliveries. */
  webhooks: number;
}

/** Delete batches until one comes back short, counting each as it commits. */
async function inBatches(
  batch: number,
  deleteOne: () => Promise<number>,
  add: (n: number) => void,
): Promise<void> {
  for (;;) {
    const n = await deleteOne();
    add(n);
    if (n < batch) return;
  }
}

/** A log of the instance's own, trimmed to what came after a moment, oldest first. */
function trim(
  db: Database,
  table: typeof schema.authEvents | typeof schema.mailEvents | typeof schema.instanceEvents,
  at: PgColumn,
  before: Date,
  batch: number,
  add: (n: number) => void,
): Promise<void> {
  return inBatches(
    batch,
    async () => {
      const [gone] = await db.execute<{ n: number }>(sql`
      with gone as (
        delete from ${table} where ${table.id} in (
          select ${table.id} from ${table} where ${at} < ${before.toISOString()}::timestamptz
          order by ${table.id} limit ${batch})
        returning 1)
      select count(*)::int as n from gone`);
      return gone?.n ?? 0;
    },
    add,
  );
}

export async function purgeLogs(
  db: Database,
  keep: InstanceSettings["logs"],
  now = new Date(),
  { batch = BATCH }: { batch?: number } = {},
): Promise<Purged> {
  const purged: Purged = { audit: 0, auth: 0, mail: 0, webhooks: 0 };
  let complete = false;
  try {
    if (keep.auth !== null) {
      const t = schema.authEvents;
      await trim(db, t, t.occurredAt, cutoff(keep.auth, now), batch, (n) => {
        purged.auth += n;
      });
    }
    if (keep.mail !== null) {
      const t = schema.mailEvents;
      await trim(db, t, t.occurredAt, cutoff(keep.mail, now), batch, (n) => {
        purged.mail += n;
      });
    }
    if (keep.webhooks !== null) {
      // Each workspace's events, oldest first; their deliveries go with them.
      const e = schema.events;
      const before = cutoff(keep.webhooks, now);
      const workspaces = await db
        .selectDistinct({ id: e.organisationId })
        .from(e)
        .where(lt(e.createdAt, before));
      for (const { id: organisationId } of workspaces) {
        await inBatches(
          batch,
          async () => {
            const oldest = db
              .select({ id: e.id })
              .from(e)
              .where(inOrg(e, organisationId, lt(e.createdAt, before)))
              .orderBy(asc(e.createdAt))
              .limit(batch);
            const gone = await db
              .delete(e)
              .where(inOrg(e, organisationId, inArray(e.id, oldest)))
              .returning({ id: e.id });
            return gone.length;
          },
          (n) => {
            purged.webhooks += n;
          },
        );
      }
    }
    if (keep.audit !== null) {
      const before = cutoff(keep.audit, now);
      const t = schema.instanceEvents;
      const add = (n: number) => {
        purged.audit += n;
      };
      await trim(db, t, t.createdAt, before, batch, add);
      // Each workspace's access log, in its own scope.
      const a = schema.accessEvents;
      const workspaces = await db
        .select({ id: schema.organisations.id })
        .from(schema.organisations);
      for (const { id: organisationId } of workspaces) {
        await inBatches(
          batch,
          () =>
            withAuditPurge(db, async (tx) => {
              const oldest = tx
                .select({ id: a.id })
                .from(a)
                .where(inOrg(a, organisationId, lt(a.id, idAt(before))))
                .orderBy(asc(a.id))
                .limit(batch);
              const gone = await tx
                .delete(a)
                .where(inOrg(a, organisationId, inArray(a.id, oldest)))
                .returning({ id: a.id });
              return gone.length;
            }),
          add,
        );
      }
    }
    complete = true;
  } finally {
    if (purged.audit + purged.auth + purged.mail + purged.webhooks > 0)
      await recordInstanceEvent(db, {
        actorId: null,
        action: "logs.purged",
        target: "The logs",
        details: { ...purged, keep, ...(complete ? {} : { incomplete: true }) },
      });
  }
  return purged;
}
