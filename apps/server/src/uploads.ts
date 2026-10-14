import { type Database, inOrg, schema } from "@hekate/db";
import { and, eq, lt } from "drizzle-orm";
import type { Storage, UploadSession } from "./storage.ts";

const { uploads } = schema;

export type UploadRow = typeof uploads.$inferSelect;

/** Unfinished uploads are discarded after this long. */
export const UPLOAD_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

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
 * Abort every open upload past its expiry, freeing its stored parts. Deliberately
 * instance-wide (no organisation condition): it runs as a scheduled job, never for a
 * request, and each row is then updated within its own organisation.
 */
export async function expireUploads(
  db: Database,
  storage: Storage,
  now = new Date(),
): Promise<number> {
  const expired = await db
    .select()
    .from(uploads)
    .where(and(eq(uploads.status, "open"), lt(uploads.expiresAt, now)));
  let aborted = 0;
  for (const row of expired) {
    const [claimed] = await db
      .update(uploads)
      .set({ status: "aborted" })
      .where(inOrg(uploads, row.organisationId, eq(uploads.id, row.id), eq(uploads.status, "open")))
      .returning({ id: uploads.id });
    if (!claimed) continue;
    await storage.abortUpload(sessionOf(row)).catch((error: unknown) => {
      console.error(`Could not discard the parts of expired upload ${row.id}`, error);
    });
    aborted += 1;
  }
  return aborted;
}
