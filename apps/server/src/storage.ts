import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { type Database, inOrg, schema, uuidv7 } from "@hekate/db";
import { type Backends, type ByteRange, objectKey, StorageConfigError } from "@hekate/storage";
import { eq } from "drizzle-orm";
import { NotFound } from "./errors.ts";

const { blobs, organisations } = schema;

export type Blob = typeof blobs.$inferSelect;

/**
 * Hekate's view of storage: every object is a blob row in an organisation plus
 * bytes in one configured backend. Callers never see backend keys or URLs.
 */
export interface Storage {
  readonly backends: Backends;
  /** The backend new objects for this organisation go to. */
  backendFor(organisationId: string): Promise<string>;
  /** Store bytes for an organisation and record the blob. */
  put(
    organisationId: string,
    body: Readable | Uint8Array,
    options?: { contentType?: string },
  ): Promise<Blob>;
  /** Read a blob, or a byte range of it, within its organisation. */
  open(
    organisationId: string,
    blobId: string,
    range?: ByteRange,
  ): Promise<{ blob: Blob; stream: Readable }>;
  /** Delete a blob and its bytes. Refused while a file still uses it. */
  remove(organisationId: string, blobId: string): Promise<void>;
}

export function createStorage(db: Database, backends: Backends): Storage {
  const blobIn = async (organisationId: string, blobId: string) => {
    const [blob] = await db
      .select()
      .from(blobs)
      .where(inOrg(blobs, organisationId, eq(blobs.id, blobId)));
    if (!blob) throw new NotFound("Blob");
    return blob;
  };

  const backendFor = async (organisationId: string) => {
    const [organisation] = await db
      .select({ storageBackend: organisations.storageBackend })
      .from(organisations)
      .where(eq(organisations.id, organisationId));
    const name = organisation?.storageBackend ?? backends.defaultBackend;
    if (!backends.has(name)) {
      // The organisation chose a backend the operator has since removed: fail loudly, never fall back silently.
      throw new StorageConfigError(
        `Organisation ${organisationId} uses storage backend "${name}", which is not configured`,
      );
    }
    return name;
  };

  return {
    backends,
    backendFor,

    async put(organisationId, body, options) {
      const name = await backendFor(organisationId);
      const backend = backends.get(name);
      const id = uuidv7();
      const key = objectKey(organisationId, id);

      const hash = createHash("sha256");
      const hashing = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      const source = body instanceof Uint8Array ? Readable.from([body]) : body;
      source.on("error", (error) => hashing.destroy(error));
      source.pipe(hashing);

      const { size } = await backend.put(
        key,
        hashing,
        options?.contentType ? { contentType: options.contentType } : {},
      );
      try {
        const [blob] = await db
          .insert(blobs)
          .values({
            id,
            organisationId,
            backend: name,
            key,
            byteSize: size,
            sha256: hash.digest("hex"),
            contentType: options?.contentType ?? null,
          })
          .returning();
        if (!blob) throw new Error("Blob insert returned no row");
        return blob;
      } catch (error) {
        // Never leave bytes in storage that no row accounts for. If even the
        // clean-up fails, say exactly what is orphaned so it can be reconciled.
        await backend.delete(key).catch((cleanup: unknown) => {
          console.error(
            `Orphaned object "${key}" in storage backend "${name}": the blob record failed and so did removing the bytes`,
            cleanup,
          );
        });
        throw error;
      }
    },

    async open(organisationId, blobId, range) {
      const blob = await blobIn(organisationId, blobId);
      const stream = await backends.get(blob.backend).get(blob.key, range);
      return { blob, stream };
    },

    async remove(organisationId, blobId) {
      const blob = await blobIn(organisationId, blobId);
      // The row goes first, inside a transaction: a file still using the blob
      // fails the delete before any bytes are touched, and if removing the
      // bytes fails the row is restored, so the removal can be retried.
      await db.transaction(async (tx) => {
        await tx.delete(blobs).where(inOrg(blobs, organisationId, eq(blobs.id, blob.id)));
        await backends.get(blob.backend).delete(blob.key);
      });
    },
  };
}
