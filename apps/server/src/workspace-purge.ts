import { type Database, inOrg, schema, withAuditPurge } from "@hekate/db";
import type { Backends } from "@hekate/storage";
import { and, eq, inArray, isNotNull, lte } from "drizzle-orm";
import { recordInstanceEvent } from "./instance-events.ts";
import type { Keyring } from "./keyring.ts";

/**
 * Deletes a workspace set to be deleted, by an operator (#174) or by its owners (#186), once its
 * grace period is over: every row it owns (its keys, its exports and its access log among them,
 * the log through its explicit purge, decision 020), then every stored object under its prefix
 * in every backend, then whatever of its keys this process holds in memory. The rows go first,
 * in one transaction, so a failure leaves the workspace whole; bytes left behind by a backend
 * that fails are orphans, which the storage reconciliation reports and removes. Unfinished
 * uploads are aborted first. Returns how many objects it removed, or null when it did not purge.
 */
export async function purgeWorkspace(
  db: Database,
  backends: Backends,
  organisationId: string,
  now = new Date(),
  keyring?: Pick<Keyring, "forget">,
) {
  if (!(await due(db, organisationId, now))) return null;
  // Unfinished uploads keep their parts where no listing of the prefix finds them, so they
  // are aborted while their rows still say where; if one cannot be, the purge waits an hour.
  const unfinished = await db
    .select({
      id: schema.uploads.id,
      backend: schema.uploads.backend,
      key: schema.uploads.key,
      backendUploadId: schema.uploads.backendUploadId,
    })
    .from(schema.uploads)
    .where(
      inOrg(schema.uploads, organisationId, inArray(schema.uploads.status, ["open", "completing"])),
    );
  for (const upload of unfinished) {
    try {
      await backends.get(upload.backend).abortMultipart(upload.key, upload.backendUploadId);
    } catch (error) {
      console.error(`Could not abort upload ${upload.id} before the purge; will retry`, error);
      return null;
    }
  }
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
    // Reinstated, or kept, since it was chosen: it stays.
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
  keyring?.forget(organisationId);
  await recordInstanceEvent(db, {
    actorId: null,
    action: "workspace.purged",
    target: name,
    details: { organisationId, objects: removed },
  });
  return removed;
}

/** Suspended, set to be deleted, and its grace period over. */
async function due(db: Pick<Database, "select">, organisationId: string, now: Date) {
  const [row] = await db
    .select({
      suspendedAt: schema.organisations.suspendedAt,
      deleteAfter: schema.organisations.deleteAfter,
    })
    .from(schema.organisations)
    .where(eq(schema.organisations.id, organisationId));
  return !!row?.suspendedAt && !!row.deleteAfter && row.deleteAfter <= now;
}

/** Purges every workspace whose grace period is over. Run hourly. */
export async function purgeDueWorkspaces(
  db: Database,
  backends: Backends,
  now = new Date(),
  keyring?: Pick<Keyring, "forget">,
) {
  const due = await db
    .select({ id: schema.organisations.id })
    .from(schema.organisations)
    .where(
      and(isNotNull(schema.organisations.suspendedAt), lte(schema.organisations.deleteAfter, now)),
    );
  let purged = 0;
  for (const w of due)
    if ((await purgeWorkspace(db, backends, w.id, now, keyring)) !== null) purged += 1;
  return purged;
}
