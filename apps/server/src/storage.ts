import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { buffer } from "node:stream/consumers";
import { type Database, inOrg, schema, uuidv7 } from "@hekate/db";
import {
  type Backends,
  type ByteRange,
  decryptor,
  encryptChunk,
  encryptedSize,
  encryptor,
  generateKey,
  HEADER_SIZE,
  newNoncePrefix,
  objectKey,
  planRead,
  StorageConfigError,
  StorageError,
  unwrapKey,
  wrapKey,
} from "@hekate/storage";
import { eq } from "drizzle-orm";
import { NotFound } from "./errors.ts";
import type { Keyring } from "./keyring.ts";

const { blobs, organisations } = schema;

export type Blob = typeof blobs.$inferSelect;

/**
 * Hekate's view of storage: every object is a blob row in an organisation plus
 * encrypted bytes in one configured backend. Callers see plaintext streams only;
 * backends see ciphertext only (docs/security.md). Nobody sees keys or URLs.
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

  /** Start a resumable upload of `byteSize` bytes: keys and a backend multipart upload. */
  beginUpload(
    organisationId: string,
    byteSize: number,
    contentType: string,
  ): Promise<UploadSession>;
  /** Encrypt and store one chunk. Returns the tag needed to complete. */
  putUploadChunk(
    organisationId: string,
    session: UploadSession,
    index: number,
    plain: Uint8Array,
  ): Promise<string>;
  /** Join the chunks into the blob and record it. Its checksum is computed later by a job. */
  completeUpload(organisationId: string, session: UploadSession, tags: string[]): Promise<Blob>;
  /** Discard an unfinished upload's stored parts. */
  abortUpload(session: UploadSession): Promise<void>;
}

/** Everything needed to continue an upload, stored on its row between requests. */
export interface UploadSession {
  blobId: string;
  backend: string;
  key: string;
  backendUploadId: string;
  wrappedKey: string;
  keyVersion: number;
  /** Base64. */
  noncePrefix: string;
  byteSize: number;
  contentType: string;
}

/** Binds a blob's ciphertext and data key to that blob, so neither can be moved to another. */
const blobAad = (blobId: string) => Buffer.from(`blob:${blobId}`);
const dataKeyContext = (blobId: string) => `blob:${blobId}`;

export function createStorage(db: Database, backends: Backends, keyring: Keyring): Storage {
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

      const organisationKey = await keyring.current(organisationId);
      const dataKey = generateKey();
      const wrappedKey = wrapKey(organisationKey.key, dataKey, dataKeyContext(id));

      // Plaintext is hashed and counted on its way into the cipher; only ciphertext leaves.
      const hash = createHash("sha256");
      let plainSize = 0;
      const hashing = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk);
          plainSize += chunk.length;
          callback(null, chunk);
        },
      });
      const encrypt = encryptor(dataKey, blobAad(id));
      const source = body instanceof Uint8Array ? Readable.from([body]) : body;
      source.on("error", (error) => hashing.destroy(error));
      hashing.on("error", (error) => encrypt.destroy(error));
      source.pipe(hashing).pipe(encrypt);

      try {
        const { size } = await backend.put(
          key,
          encrypt,
          options?.contentType ? { contentType: options.contentType } : {},
        );
        if (size !== encryptedSize(plainSize)) {
          await backend.delete(key).catch(() => undefined);
          throw new StorageError(
            `Stored ${size} bytes for "${key}", expected ${encryptedSize(plainSize)}`,
          );
        }
      } finally {
        dataKey.fill(0);
      }
      try {
        const [blob] = await db
          .insert(blobs)
          .values({
            id,
            organisationId,
            backend: name,
            key,
            byteSize: plainSize,
            sha256: hash.digest("hex"),
            wrappedKey,
            keyVersion: organisationKey.version,
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
      const plan = planRead(blob.byteSize, range);
      const backend = backends.get(blob.backend);
      const organisationKey = await keyring.version(organisationId, blob.keyVersion);
      const dataKey = unwrapKey(organisationKey, blob.wrappedKey, dataKeyContext(blob.id));
      // A read from the middle needs the header's nonce prefix: one small extra request.
      const header =
        plan.cipher.start === 0
          ? undefined
          : await buffer(await backend.get(blob.key, { start: 0, end: HEADER_SIZE - 1 }));
      const ciphertext = await backend.get(blob.key, plan.cipher);
      const decrypt = decryptor({
        key: dataKey,
        aad: blobAad(blob.id),
        plainSize: blob.byteSize,
        plan,
        ...(header ? { header } : {}),
      });
      ciphertext.on("error", (error) => decrypt.destroy(error));
      decrypt.on("close", () => dataKey.fill(0));
      return { blob, stream: ciphertext.pipe(decrypt) };
    },

    async beginUpload(organisationId, byteSize, contentType) {
      const name = await backendFor(organisationId);
      const blobId = uuidv7();
      const key = objectKey(organisationId, blobId);
      const organisationKey = await keyring.current(organisationId);
      const dataKey = generateKey();
      try {
        const wrappedKey = wrapKey(organisationKey.key, dataKey, dataKeyContext(blobId));
        const backendUploadId = await backends.get(name).createMultipart(key, { contentType });
        return {
          blobId,
          backend: name,
          key,
          backendUploadId,
          wrappedKey,
          keyVersion: organisationKey.version,
          noncePrefix: newNoncePrefix().toString("base64"),
          byteSize,
          contentType,
        };
      } finally {
        dataKey.fill(0);
      }
    },

    async putUploadChunk(organisationId, session, index, plain) {
      const organisationKey = await keyring.version(organisationId, session.keyVersion);
      const dataKey = unwrapKey(
        organisationKey,
        session.wrappedKey,
        dataKeyContext(session.blobId),
      );
      try {
        const sealed = encryptChunk({
          key: dataKey,
          aad: blobAad(session.blobId),
          prefix: Buffer.from(session.noncePrefix, "base64"),
          plainSize: session.byteSize,
          index,
          plain,
        });
        return await backends
          .get(session.backend)
          .putPart(session.key, session.backendUploadId, index + 1, sealed);
      } finally {
        dataKey.fill(0);
      }
    },

    async completeUpload(organisationId, session, tags) {
      const backend = backends.get(session.backend);
      const { size } = await backend.completeMultipart(
        session.key,
        session.backendUploadId,
        tags.map((tag, i) => ({ partNumber: i + 1, tag })),
      );
      try {
        if (size !== encryptedSize(session.byteSize)) {
          throw new StorageError(
            `Upload produced ${size} bytes, expected ${encryptedSize(session.byteSize)}`,
          );
        }
        const [blob] = await db
          .insert(blobs)
          .values({
            id: session.blobId,
            organisationId,
            backend: session.backend,
            key: session.key,
            byteSize: session.byteSize,
            sha256: null,
            wrappedKey: session.wrappedKey,
            keyVersion: session.keyVersion,
            contentType: session.contentType,
          })
          .returning();
        if (!blob) throw new Error("Blob insert returned no row");
        return blob;
      } catch (error) {
        await backend.delete(session.key).catch((cleanup: unknown) => {
          console.error(
            `Orphaned object "${session.key}" in storage backend "${session.backend}"`,
            cleanup,
          );
        });
        throw error;
      }
    },

    async abortUpload(session) {
      await backends.get(session.backend).abortMultipart(session.key, session.backendUploadId);
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
