import { type Database, inOrg, schema } from "@hekate/db";
import { unwrapKey, wrapKey } from "@hekate/storage";
import { and, count, eq, isNotNull, lt, max, sql } from "drizzle-orm";
import { sealContext } from "./directory.ts";
import type { Keyring } from "./keyring.ts";
import { openSecret, sealSecret } from "./secrets.ts";
import { dataKeyContext } from "./storage.ts";

const { blobs, directories, renditions, uploads } = schema;

/** A table whose rows hold a key wrapped by a version of the organisation's key. */
type Wrapped = typeof blobs | typeof uploads | typeof renditions;

/** What each table's wrapped key is bound to, so it opens only where it belongs. */
const bound: { table: Wrapped; context: (row: { id: string; blobId?: string }) => string }[] = [
  { table: blobs, context: (r) => dataKeyContext(r.id) },
  { table: uploads, context: (r) => dataKeyContext(r.blobId ?? "") },
  { table: renditions, context: (r) => `rendition:${r.id}` },
];

/**
 * Rewraps every workspace still holding keys wrapped by an earlier version: the safety net for
 * a rotation whose job could not be queued, or stopped part-way. Run hourly.
 */
export async function rewrapBehind(db: Database, keyring: Keyring) {
  const latest = await db
    .select({
      organisationId: schema.organisationKeys.organisationId,
      version: max(schema.organisationKeys.version),
    })
    .from(schema.organisationKeys)
    .groupBy(schema.organisationKeys.organisationId)
    .having(sql`max(${schema.organisationKeys.version}) > 1`);
  let rewrapped = 0;
  for (const { organisationId, version } of latest) {
    if (version === null) continue;
    if ((await pendingRewrap(db, organisationId, version)) === 0) continue;
    rewrapped += await rewrapOrganisation(db, keyring, organisationId);
  }
  return rewrapped;
}

/** How many keys and secrets are still wrapped by a version older than `current`. */
export async function pendingRewrap(db: Database, organisationId: string, current: number) {
  let pending = 0;
  for (const { table } of bound) {
    const [row] = await db
      .select({ n: count() })
      .from(table)
      .where(inOrg(table, organisationId, lt(table.keyVersion, current)));
    pending += row?.n ?? 0;
  }
  const [directory] = await db
    .select({ n: count() })
    .from(directories)
    .where(
      inOrg(
        directories,
        organisationId,
        isNotNull(directories.bindPasswordSealed),
        lt(directories.bindPasswordKeyVersion, current),
      ),
    );
  return pending + (directory?.n ?? 0);
}

/**
 * After a rotation (#174), wraps every data key, rendition key and sealed secret of the
 * organisation with its current key, in batches. Each row is rewritten only if no one else
 * has changed it since it was read, so it is safe to run while the workspace is in use; a row
 * written with an older key meanwhile is caught by the next run. Returns how many it rewrapped.
 */
export async function rewrapOrganisation(db: Database, keyring: Keyring, organisationId: string) {
  const { version: current, key } = await keyring.current(organisationId);
  let rewrapped = 0;
  for (const { table, context } of bound) {
    for (;;) {
      const rows = await db
        .select({
          id: table.id,
          wrappedKey: table.wrappedKey,
          keyVersion: table.keyVersion,
          ...(table === uploads ? { blobId: uploads.blobId } : {}),
        })
        .from(table)
        .where(inOrg(table, organisationId, lt(table.keyVersion, current)))
        .limit(200);
      if (rows.length === 0) break;
      let changed = 0;
      for (const row of rows) {
        const older = await keyring.version(organisationId, row.keyVersion);
        const plain = unwrapKey(older, row.wrappedKey, context(row));
        const updated = await db
          .update(table)
          .set({ wrappedKey: wrapKey(key, plain, context(row)), keyVersion: current })
          .where(
            inOrg(
              table,
              organisationId,
              and(eq(table.id, row.id), eq(table.keyVersion, row.keyVersion)),
            ),
          )
          .returning({ id: table.id });
        changed += updated.length;
      }
      rewrapped += changed;
      // Rows someone else changed meanwhile are not read again; none changed means none left.
      if (changed === 0) break;
    }
  }
  const [directory] = await db
    .select()
    .from(directories)
    .where(
      inOrg(
        directories,
        organisationId,
        isNotNull(directories.bindPasswordSealed),
        lt(directories.bindPasswordKeyVersion, current),
      ),
    );
  if (directory?.bindPasswordSealed && directory.bindPasswordKeyVersion !== null) {
    const older = await keyring.version(organisationId, directory.bindPasswordKeyVersion);
    const secret = openSecret(older, directory.bindPasswordSealed, sealContext(organisationId));
    const updated = await db
      .update(directories)
      .set({
        bindPasswordSealed: sealSecret(key, secret, sealContext(organisationId)),
        bindPasswordKeyVersion: current,
      })
      .where(
        inOrg(
          directories,
          organisationId,
          eq(directories.id, directory.id),
          eq(directories.bindPasswordKeyVersion, directory.bindPasswordKeyVersion),
        ),
      )
      .returning({ id: directories.id });
    rewrapped += updated.length;
  }
  return rewrapped;
}
