import { type Database, inOrg, schema, withAuditPurge } from "@hekate/db";
import type { Backends } from "@hekate/storage";
import { and, eq, isNotNull, lte } from "drizzle-orm";
import { recordInstanceEvent } from "./routes/instance.ts";

/**
 * Deletes a workspace an operator set to be deleted, once its grace period is over (#174):
 * every row it owns, its access log among them, and then every stored object under its
 * prefix in every backend. The rows go first, in one transaction, so a failure leaves the
 * workspace whole; bytes left behind by a backend that fails are orphans, which the storage
 * reconciliation reports and removes. Returns how many objects it removed.
 */
export async function purgeWorkspace(
  db: Database,
  backends: Backends,
  organisationId: string,
  now = new Date(),
) {
  const name = await withAuditPurge(db, async (tx) => {
    const [row] = await tx
      .select({
        name: schema.organisations.name,
        suspendedAt: schema.organisations.suspendedAt,
        deleteAfter: schema.organisations.deleteAfter,
      })
      .from(schema.organisations)
      .where(eq(schema.organisations.id, organisationId))
      .for("update");
    // Reinstated, or its deletion cancelled, since it was chosen: it stays.
    if (!row?.suspendedAt || !row.deleteAfter || row.deleteAfter > now) return null;
    // A variation holds on to its file, so variations go before the cascade reaches files.
    await tx.delete(schema.variations).where(inOrg(schema.variations, organisationId));
    await tx.delete(schema.organisations).where(eq(schema.organisations.id, organisationId));
    return row.name;
  });
  if (name === null) return null;
  let removed = 0;
  for (const backendName of backends.names()) {
    const backend = backends.get(backendName);
    try {
      for await (const object of backend.list(`org/${organisationId}/`)) {
        await backend.delete(object.key);
        removed += 1;
      }
    } catch (error) {
      console.error(`Purging ${name} from storage ${backendName} stopped:`, error);
    }
  }
  await recordInstanceEvent(db, {
    actorId: null,
    action: "workspace.purged",
    target: name,
    details: { organisationId, objects: removed },
  });
  return removed;
}

/** Purges every workspace whose grace period is over. Run hourly. */
export async function purgeDueWorkspaces(db: Database, backends: Backends, now = new Date()) {
  const due = await db
    .select({ id: schema.organisations.id })
    .from(schema.organisations)
    .where(
      and(isNotNull(schema.organisations.suspendedAt), lte(schema.organisations.deleteAfter, now)),
    );
  let purged = 0;
  for (const w of due) if ((await purgeWorkspace(db, backends, w.id, now)) !== null) purged += 1;
  return purged;
}
