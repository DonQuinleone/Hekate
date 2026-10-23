import { type Database, schema } from "@hekate/db";

/** Writes what an operator, or the instance itself, did, for the Overview and the audit (#157). */
export async function recordInstanceEvent(
  db: Pick<Database, "insert">,
  event: {
    actorId: string | null;
    action: string;
    target?: string | null;
    details?: Record<string, unknown>;
    ipAddress?: string | null;
  },
) {
  await db.insert(schema.instanceEvents).values({
    actorId: event.actorId,
    action: event.action,
    target: event.target ?? null,
    details: event.details ?? null,
    ipAddress: event.ipAddress ?? null,
  });
}
