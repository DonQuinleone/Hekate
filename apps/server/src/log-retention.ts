import { type Database, schema, withAuditPurge } from "@hekate/db";
import type { InstanceSettings } from "@hekate/shared";
import { lt, sql } from "drizzle-orm";
import { idAt } from "./logs.ts";
import { recordInstanceEvent } from "./routes/instance.ts";

/**
 * Each log kept as long as the instance's settings say (#157), and no longer: a job once a day.
 * The access log goes only through its purge setting (decision 020), a batch at a time so one
 * transaction never holds a year of it; what went is itself an instance event.
 */

const DAY = 24 * 60 * 60_000;
/** Rows of the access log deleted in one transaction. */
const BATCH = 5_000;

const cutoff = (days: number, now: Date) => new Date(now.getTime() - days * DAY);

export interface Purged {
  audit: number;
  auth: number;
  mail: number;
}

export async function purgeLogs(
  db: Database,
  keep: InstanceSettings["logs"],
  now = new Date(),
): Promise<Purged> {
  const purged: Purged = { audit: 0, auth: 0, mail: 0 };
  if (keep.auth !== null) {
    const gone = await db
      .delete(schema.authEvents)
      .where(lt(schema.authEvents.occurredAt, cutoff(keep.auth, now)))
      .returning({ id: schema.authEvents.id });
    purged.auth = gone.length;
  }
  if (keep.mail !== null) {
    const gone = await db
      .delete(schema.mailEvents)
      .where(lt(schema.mailEvents.occurredAt, cutoff(keep.mail, now)))
      .returning({ id: schema.mailEvents.id });
    purged.mail = gone.length;
  }
  if (keep.audit !== null) {
    const before = cutoff(keep.audit, now);
    const instance = await db
      .delete(schema.instanceEvents)
      .where(lt(schema.instanceEvents.createdAt, before))
      .returning({ id: schema.instanceEvents.id });
    purged.audit = instance.length;
    // Every workspace's access log, oldest first, by id: UUIDv7, so the primary key is time.
    for (;;) {
      const gone = await withAuditPurge(db, (tx) =>
        tx.execute<{ id: string }>(sql`
          delete from access_events where id in (
            select id from access_events where id < ${idAt(before)}::uuid
            order by id limit ${BATCH})
          returning id`),
      );
      purged.audit += gone.length;
      if (gone.length < BATCH) break;
    }
  }
  if (purged.audit + purged.auth + purged.mail > 0)
    await recordInstanceEvent(db, {
      actorId: null,
      action: "logs.purged",
      target: "The logs",
      details: { ...purged, keep },
    });
  return purged;
}
