import { createHash } from "node:crypto";
import { type Database, inOrg, schema } from "@hekate/db";
import { cleanContentType, fileKindOf } from "@hekate/shared";
import { CHUNK_SIZE, chunkCount, chunkLength, MAX_PARTS } from "@hekate/storage";
import { and, asc, eq, lt, or } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { Actor, Audit, RequestInfo } from "./audit.ts";
import type { Jobs } from "./jobs.ts";
import { pageSourceOf } from "./media/pages.ts";
import { metrics } from "./metrics/index.ts";
import type { Storage } from "./storage.ts";
import { sessionOf, staleClaim, UPLOAD_LIFETIME_MS, type UploadRow } from "./uploads.ts";

const { uploads, uploadParts, files, accessEvents } = schema;
export type FileRow = typeof files.$inferSelect;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** `Content-Digest: sha-256=:<base64>:` (RFC 9530), when the client sends one. */
function digestOf(header: string | undefined): Buffer | undefined {
  const match = header?.match(/sha-256=:([A-Za-z0-9+/=]+):/);
  return match?.[1] ? Buffer.from(match[1], "base64") : undefined;
}

/** What an upload looks like to the browser sending it. */
export function uploadView(row: UploadRow, chunks: number[]) {
  return {
    id: row.id,
    projectId: row.projectId,
    folderId: row.folderId,
    name: row.name,
    size: row.byteSize,
    status: row.status,
    chunkSize: CHUNK_SIZE,
    chunkCount: chunkCount(row.byteSize),
    receivedChunks: chunks,
    expiresAt: row.expiresAt,
  };
}

/**
 * The steps of a resumable upload (docs/security.md, decision 021), whoever sends it: a member
 * through `/api/uploads`, or a visitor through an upload request (#139). Each chunk is
 * encrypted on arrival and stored as one part of a multipart upload, so plaintext never waits
 * on the server; completing it makes the blob and the file. Who may touch an upload is the
 * caller's to decide before calling.
 */
export function uploadEngine(deps: {
  db: Database;
  storage: Storage;
  jobs: Pick<Jobs, "send">;
  audit: Audit;
}) {
  const { db, storage, jobs, audit } = deps;

  const received = (organisationId: string, uploadId: string) =>
    db
      .select({ chunk: uploadParts.chunk, tag: uploadParts.tag })
      .from(uploadParts)
      .where(inOrg(uploadParts, organisationId, eq(uploadParts.uploadId, uploadId)))
      .orderBy(asc(uploadParts.chunk));

  const assertOpen = (row: UploadRow) => {
    if (row.status !== "open")
      throw new HTTPException(409, { message: `This upload is ${row.status}` });
    if (row.expiresAt.getTime() < Date.now())
      throw new HTTPException(409, { message: "This upload has expired" });
  };

  return {
    received,

    /** Starts an upload into a project's folder (checked by the caller). */
    async begin(input: {
      organisationId: string;
      projectId: string;
      folderId: string | null;
      name: string;
      size: number;
      contentType?: string | undefined;
      createdBy: string | null;
      /** Recorded with the upload, in the same transaction: an upload request's sender. */
      also?: (tx: Tx, row: UploadRow) => Promise<void>;
    }): Promise<UploadRow> {
      if (chunkCount(input.size) > MAX_PARTS) {
        throw new HTTPException(400, {
          message: `Files can be at most ${(MAX_PARTS * CHUNK_SIZE) / 1024 ** 3} GiB`,
        });
      }
      const contentType = cleanContentType(input.contentType);
      // Into the project's own backend, if it has one (#240).
      const session = await storage.beginUpload(
        input.organisationId,
        input.size,
        contentType,
        input.projectId,
      );
      try {
        const row = await db.transaction(async (tx) => {
          const [inserted] = await tx
            .insert(uploads)
            .values({
              organisationId: input.organisationId,
              projectId: input.projectId,
              folderId: input.folderId,
              createdBy: input.createdBy,
              name: input.name,
              ...session,
              expiresAt: new Date(Date.now() + UPLOAD_LIFETIME_MS),
            })
            .returning();
          if (!inserted) throw new Error("Upload insert returned no row");
          await input.also?.(tx, inserted);
          return inserted;
        });
        return row;
      } catch (error) {
        // No row means nothing would ever find this multipart session again: discard it now.
        await storage.abortUpload(session).catch(() => undefined);
        throw error;
      }
    },

    /** Stores one chunk: the exact length the upload's size gives it, checked if a digest came. */
    async putChunk(row: UploadRow, index: number, body: Uint8Array, digestHeader?: string) {
      assertOpen(row);
      let expected: number;
      try {
        expected = chunkLength(row.byteSize, index);
      } catch {
        throw new HTTPException(400, { message: `This upload has no chunk ${index}` });
      }
      if (body.length !== expected) {
        throw new HTTPException(400, {
          message: `Chunk ${index} must be ${expected} bytes, not ${body.length}`,
        });
      }
      const digest = digestOf(digestHeader);
      if (digest && !createHash("sha256").update(body).digest().equals(digest)) {
        throw new HTTPException(400, {
          message: `Chunk ${index} was damaged in transit; send it again`,
        });
      }
      const tag = await storage.putUploadChunk(row.organisationId, sessionOf(row), index, body);
      await db
        .insert(uploadParts)
        .values({ organisationId: row.organisationId, uploadId: row.id, chunk: index, tag })
        .onConflictDoUpdate({
          target: [uploadParts.uploadId, uploadParts.chunk],
          set: { tag, receivedAt: new Date() },
        });
    },

    /**
     * Completes an upload into its file, or returns the file it already became (a retry after
     * a lost response). `created` says whether this call made it. `also` runs in the
     * transaction that makes the file, and `after` once it is stored, both only the first time.
     */
    async complete(
      row: UploadRow,
      opts: {
        uploadedBy: string | null;
        actor: () => Promise<Actor>;
        request: RequestInfo;
        also?: (tx: Tx, file: FileRow) => Promise<void>;
      },
    ): Promise<{ file: FileRow; created: boolean }> {
      const { organisationId, id } = row;
      const fileOf = async () =>
        (
          await db
            .select()
            .from(files)
            .where(inOrg(files, organisationId, eq(files.blobId, row.blobId)))
        )[0];

      /**
       * What follows a completed upload. Idempotent, and run again whenever a completed
       * upload is completed again, so work lost to a failure after the file was created
       * (the access log event, the jobs) is caught up by the client's retry.
       */
      const finalise = async (file: FileRow) => {
        const [logged] = await db
          .select({ id: accessEvents.id })
          .from(accessEvents)
          .where(
            inOrg(
              accessEvents,
              organisationId,
              eq(accessEvents.fileId, file.id),
              eq(accessEvents.action, "file.upload"),
            ),
          )
          .limit(1);
        if (!logged) {
          await audit.record(
            organisationId,
            await opts.actor(),
            {
              action: "file.upload",
              projectId: file.projectId,
              fileId: file.id,
              details: { name: file.name, size: file.byteSize, kind: file.kind },
            },
            opts.request,
          );
        }
        // Single-instance keys drop duplicates; the jobs themselves are idempotent too.
        await jobs.send(
          "blob-checksum",
          { organisationId, blobId: file.blobId },
          { singletonKey: file.blobId },
        );
        if (file.kind === "audio" || file.kind === "video") {
          await jobs.send(
            "media-probe",
            { organisationId, fileId: file.id },
            { singletonKey: file.id },
          );
        } else if (pageSourceOf(file.name, file.contentType)) {
          // Scores, documents and artwork are seen only as pages the server draws.
          await jobs.send(
            "document-render",
            { organisationId, fileId: file.id },
            { singletonKey: file.id },
          );
        }
      };

      if (row.status === "completed") {
        const file = await fileOf();
        if (file) {
          await finalise(file);
          return { file, created: false };
        }
      }
      if (row.status === "open") assertOpen(row);
      // Claim it, so two completions cannot race. A claim is a lease: one left behind by
      // a crash or a failed request can be taken again once it is stale.
      const [claimed] = await db
        .update(uploads)
        .set({ status: "completing" })
        .where(
          inOrg(
            uploads,
            organisationId,
            eq(uploads.id, id),
            or(
              eq(uploads.status, "open"),
              and(eq(uploads.status, "completing"), lt(uploads.updatedAt, staleClaim())),
            ),
          ),
        )
        .returning();
      if (!claimed) {
        throw new HTTPException(409, {
          message:
            row.status === "completing"
              ? "This upload is already being completed"
              : `This upload is ${row.status}`,
        });
      }
      const reopen = () =>
        db
          .update(uploads)
          .set({ status: "open" })
          .where(
            inOrg(uploads, organisationId, eq(uploads.id, id), eq(uploads.status, "completing")),
          );

      const parts = await received(organisationId, id);
      const count = chunkCount(claimed.byteSize);
      const missing = [...Array(count).keys()].filter((i) => parts[i]?.chunk !== i);
      if (parts.length !== count || missing.length > 0) {
        await reopen();
        throw new HTTPException(409, {
          message: `Chunks still to send: ${missing.slice(0, 20).join(", ")}${missing.length > 20 ? " and more" : ""}`,
        });
      }

      let file: FileRow | undefined;
      try {
        // Each step is safe to repeat, so a stale claim can simply run them again.
        const blob = await storage.completeUpload(
          organisationId,
          sessionOf(claimed),
          parts.map((p) => p.tag),
        );
        const kind = fileKindOf(claimed.name, claimed.contentType);
        file = await db.transaction(async (tx) => {
          const [existing] = await tx
            .select()
            .from(files)
            .where(inOrg(files, organisationId, eq(files.blobId, blob.id)));
          const [created] = existing
            ? [existing]
            : await tx
                .insert(files)
                .values({
                  organisationId,
                  projectId: claimed.projectId,
                  folderId: claimed.folderId,
                  name: claimed.name,
                  kind,
                  blobId: blob.id,
                  contentType: claimed.contentType,
                  byteSize: claimed.byteSize,
                  uploadedBy: opts.uploadedBy,
                  streamStatus:
                    kind === "audio" ||
                    kind === "video" ||
                    pageSourceOf(claimed.name, claimed.contentType)
                      ? "pending"
                      : "none",
                })
                .returning();
          if (!created) throw new Error("File insert returned no row");
          if (!existing) await opts.also?.(tx, created);
          await tx
            .update(uploads)
            .set({ status: "completed" })
            .where(inOrg(uploads, organisationId, eq(uploads.id, id)));
          await tx
            .delete(uploadParts)
            .where(inOrg(uploadParts, organisationId, eq(uploadParts.uploadId, id)));
          return created;
        });
      } catch (error) {
        await reopen();
        throw error;
      }
      if (!file) throw new Error("File insert returned no row");
      // Counted once, as soon as the upload is stored: completing again returns the same file
      // without counting it, and finishing it off (queueing its processing) can still fail.
      metrics.uploadsBytes.inc({ workspace: organisationId }, file.byteSize);
      await finalise(file);
      return { file, created: true };
    },

    /** Abandons an open upload: its stored parts first, so a failure leaves it open to retry. */
    async abort(row: UploadRow) {
      if (row.status !== "open") {
        throw new HTTPException(409, { message: `This upload is ${row.status}` });
      }
      await storage.abortUpload(sessionOf(row));
      await db
        .update(uploads)
        .set({ status: "aborted" })
        .where(
          inOrg(uploads, row.organisationId, eq(uploads.id, row.id), eq(uploads.status, "open")),
        );
    },
  };
}

export type UploadEngine = ReturnType<typeof uploadEngine>;
