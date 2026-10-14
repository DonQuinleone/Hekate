import { type Database, inOrg, schema } from "@hekate/db";
import { and, eq, lt, or } from "drizzle-orm";
import type { Storage, UploadSession } from "./storage.ts";

const { uploads, blobs } = schema;

export type UploadRow = typeof uploads.$inferSelect;

/** Unfinished uploads are discarded after this long. */
export const UPLOAD_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/** A completion claim older than this was abandoned (a crash, a failed request) and can be retaken. */
export const COMPLETION_LEASE_MS = 15 * 60 * 1000;
export const staleClaim = (now = Date.now()) => new Date(now - COMPLETION_LEASE_MS);

export function sessionOf(row: UploadRow): UploadSession {
  return {
    blobId: row.blobId,
    backend: row.backend,
    key: row.key,
    backendUploadId: row.backendUploadId,
    wrappedKey: row.wrappedKey,
    keyVersion: row.keyVersion,
    noncePrefix: row.noncePrefix,
    byteSize: row.byteSize,
    contentType: row.contentType,
  };
}

/**
 * Discard every unfinished upload past its expiry: open ones, and ones whose
 * completion was abandoned. Stored parts go first; the row is marked aborted only
 * once that worked, so a storage outage is simply retried on the next run.
 * Deliberately instance-wide (no organisation condition): it runs as a scheduled job,
 * never for a request, and each row is then handled within its own organisation.
 */
export async function expireUploads(
  db: Database,
  storage: Storage,
  now = new Date(),
): Promise<number> {
  const expired = await db
    .select()
    .from(uploads)
    .where(
      and(
        lt(uploads.expiresAt, now),
        or(
          eq(uploads.status, "open"),
          and(eq(uploads.status, "completing"), lt(uploads.updatedAt, staleClaim(now.getTime()))),
        ),
      ),
    );
  let aborted = 0;
  for (const row of expired) {
    try {
      await storage.abortUpload(sessionOf(row));
      if (row.status === "completing") {
        // The parts may already have been joined; without a blob record the object is an orphan.
        const [blob] = await db
          .select({ id: blobs.id })
          .from(blobs)
          .where(inOrg(blobs, row.organisationId, eq(blobs.id, row.blobId)));
        if (blob) continue;
        await storage.backends.get(row.backend).delete(row.key);
      }
    } catch (error) {
      console.error(`Could not discard the parts of expired upload ${row.id}; will retry`, error);
      continue;
    }
    const [marked] = await db
      .update(uploads)
      .set({ status: "aborted" })
      .where(
        inOrg(uploads, row.organisationId, eq(uploads.id, row.id), eq(uploads.status, row.status)),
      )
      .returning({ id: uploads.id });
    if (marked) aborted += 1;
  }
  return aborted;
}
