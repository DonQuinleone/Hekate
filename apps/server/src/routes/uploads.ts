import { createHash } from "node:crypto";
import { type Database, inOrg, schema } from "@hekate/db";
import { cleanContentType, createUploadInput, fileKindOf } from "@hekate/shared";
import { CHUNK_SIZE, chunkCount, chunkLength, MAX_PARTS } from "@hekate/storage";
import { zValidator } from "@hono/zod-validator";
import { and, asc, eq, lt, or } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { type Audit, requestInfo } from "../audit.ts";
import { NotFound } from "../errors.ts";
import type { Jobs } from "../jobs.ts";
import type { Storage } from "../storage.ts";
import type { TenantVariables } from "../tenancy.ts";
import { sessionOf, staleClaim, UPLOAD_LIFETIME_MS, type UploadRow } from "../uploads.ts";

const { uploads, uploadParts, projects, folders, files, accessEvents } = schema;
type FileRow = typeof files.$inferSelect;

const idParam = zValidator("param", z.object({ id: z.uuid() }));
const chunkParam = zValidator(
  "param",
  z.object({
    id: z.uuid(),
    index: z.coerce
      .number()
      .int()
      .min(0)
      .max(MAX_PARTS - 1),
  }),
);

async function received(db: Database, organisationId: string, uploadId: string) {
  const rows = await db
    .select({ chunk: uploadParts.chunk, tag: uploadParts.tag })
    .from(uploadParts)
    .where(inOrg(uploadParts, organisationId, eq(uploadParts.uploadId, uploadId)))
    .orderBy(asc(uploadParts.chunk));
  return rows;
}

function view(row: UploadRow, chunks: number[]) {
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

/** `Content-Digest: sha-256=:<base64>:` (RFC 9530), when the client sends one. */
function digestOf(header: string | undefined): Buffer | undefined {
  const match = header?.match(/sha-256=:([A-Za-z0-9+/=]+):/);
  return match?.[1] ? Buffer.from(match[1], "base64") : undefined;
}

/**
 * Resumable uploads (docs/security.md, docs/decisions.md). The browser creates an
 * upload, sends 8 MiB chunks in any order (re-sending any that fail), then completes
 * it. Each chunk is encrypted on arrival and stored as one part of a multipart
 * upload, so plaintext never waits on the server. An upload belongs to the member
 * who started it.
 */
export const uploadRoutes = (
  db: Database,
  storage: Storage,
  jobs: Pick<Jobs, "send">,
  audit: Audit,
  trustProxy: boolean,
) => {
  /** The caller's own open-or-finished upload, or 404. */
  const own = async (organisationId: string, userId: string, id: string) => {
    const [row] = await db
      .select()
      .from(uploads)
      .where(inOrg(uploads, organisationId, eq(uploads.id, id), eq(uploads.createdBy, userId)));
    if (!row) throw new NotFound("Upload");
    return row;
  };
  const assertOpen = (row: UploadRow) => {
    if (row.status !== "open")
      throw new HTTPException(409, { message: `This upload is ${row.status}` });
    if (row.expiresAt.getTime() < Date.now())
      throw new HTTPException(409, { message: "This upload has expired" });
  };

  return new Hono<{ Variables: TenantVariables }>()
    .post("/", zValidator("json", createUploadInput), async (c) => {
      const input = c.req.valid("json");
      const organisationId = c.var.organisationId;
      const [project] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(inOrg(projects, organisationId, eq(projects.id, input.projectId)));
      if (!project) throw new NotFound("Project");
      if (input.folderId) {
        const [folder] = await db
          .select({ id: folders.id })
          .from(folders)
          .where(
            inOrg(
              folders,
              organisationId,
              eq(folders.id, input.folderId),
              eq(folders.projectId, project.id),
            ),
          );
        if (!folder) throw new NotFound("Folder");
      }
      if (chunkCount(input.size) > MAX_PARTS) {
        throw new HTTPException(400, {
          message: `Files can be at most ${(MAX_PARTS * CHUNK_SIZE) / 1024 ** 3} GiB`,
        });
      }
      const contentType = cleanContentType(input.contentType);
      const session = await storage.beginUpload(organisationId, input.size, contentType);
      let row: UploadRow | undefined;
      try {
        [row] = await db
          .insert(uploads)
          .values({
            organisationId,
            projectId: project.id,
            folderId: input.folderId ?? null,
            createdBy: c.var.userId,
            name: input.name,
            ...session,
            expiresAt: new Date(Date.now() + UPLOAD_LIFETIME_MS),
          })
          .returning();
      } catch (error) {
        // No row means nothing would ever find this multipart session again: discard it now.
        await storage.abortUpload(session).catch(() => undefined);
        throw error;
      }
      if (!row) throw new Error("Upload insert returned no row");
      return c.json({ upload: view(row, []) }, 201);
    })

    .get("/:id", idParam, async (c) => {
      const row = await own(c.var.organisationId, c.var.userId, c.req.valid("param").id);
      const chunks = await received(db, row.organisationId, row.id);
      return c.json({
        upload: view(
          row,
          chunks.map((p) => p.chunk),
        ),
      });
    })

    .put(
      "/:id/chunks/:index",
      chunkParam,
      bodyLimit({
        maxSize: CHUNK_SIZE + 1024,
        onError: () => {
          throw new HTTPException(413, { message: `Chunks are at most ${CHUNK_SIZE} bytes` });
        },
      }),
      async (c) => {
        const { id, index } = c.req.valid("param");
        const row = await own(c.var.organisationId, c.var.userId, id);
        assertOpen(row);
        let expected: number;
        try {
          expected = chunkLength(row.byteSize, index);
        } catch {
          throw new HTTPException(400, { message: `This upload has no chunk ${index}` });
        }
        const body = new Uint8Array(await c.req.arrayBuffer());
        if (body.length !== expected) {
          throw new HTTPException(400, {
            message: `Chunk ${index} must be ${expected} bytes, not ${body.length}`,
          });
        }
        const digest = digestOf(c.req.header("content-digest"));
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
        return c.body(null, 204);
      },
    )

    .post("/:id/complete", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const { id } = c.req.valid("param");
      const row = await own(organisationId, c.var.userId, id);
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
            await audit.member(c.var.userId),
            {
              action: "file.upload",
              projectId: file.projectId,
              fileId: file.id,
              details: { name: file.name, size: file.byteSize, kind: file.kind },
            },
            requestInfo(c, trustProxy),
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
        }
      };

      if (row.status === "completed") {
        // Completing again (a retry after a lost response) returns the same file.
        const file = await fileOf();
        if (file) {
          await finalise(file);
          return c.json({ file }, 200);
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

      const parts = await received(db, organisationId, id);
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
                  uploadedBy: c.var.userId,
                  streamStatus: kind === "audio" || kind === "video" ? "pending" : "none",
                })
                .returning();
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
      await finalise(file);
      return c.json({ file }, 201);
    })

    .delete("/:id", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const row = await own(organisationId, c.var.userId, c.req.valid("param").id);
      if (row.status !== "open") {
        throw new HTTPException(409, { message: `This upload is ${row.status}` });
      }
      // Discard the stored parts first: if that fails, the upload stays open to try again.
      await storage.abortUpload(sessionOf(row));
      await db
        .update(uploads)
        .set({ status: "aborted" })
        .where(inOrg(uploads, organisationId, eq(uploads.id, row.id), eq(uploads.status, "open")));
      return c.body(null, 204);
    });
};
