import { type Database, inOrg, schema } from "@hekate/db";
import { createUploadInput } from "@hekate/shared";
import { CHUNK_SIZE, MAX_PARTS } from "@hekate/storage";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { actorOf, can, type MemberActor } from "../access.ts";
import { type Audit, requestInfo } from "../audit.ts";
import { NotFound } from "../errors.ts";
import type { Jobs } from "../jobs.ts";
import { zValidator } from "../openapi/validator.ts";
import type { Storage } from "../storage.ts";
import type { TenantVariables } from "../tenancy.ts";
import { uploadEngine, uploadView } from "../upload-engine.ts";

const { uploads, folders } = schema;

const idParam = zValidator("param", z.object({ id: z.uuid() }));
/** A chunk's number in its upload. */
export const chunkIndex = z.coerce
  .number()
  .int()
  .min(0)
  .max(MAX_PARTS - 1);
const chunkParam = zValidator("param", z.object({ id: z.uuid(), index: chunkIndex }));

/** A chunk's body: at most a chunk, refused before it is read in full. */
export const chunkBody = bodyLimit({
  maxSize: CHUNK_SIZE + 1024,
  onError: () => {
    throw new HTTPException(413, { message: `Chunks are at most ${CHUNK_SIZE} bytes` });
  },
});

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
  const engine = uploadEngine({ db, storage, jobs, audit });
  /**
   * The caller's own open-or-finished upload, or 404, while they may still upload to its
   * project: a role taken away mid-upload stops the upload.
   */
  const own = async (actor: MemberActor, id: string) => {
    const [row] = await db
      .select()
      .from(uploads)
      .where(
        inOrg(
          uploads,
          actor.organisationId,
          eq(uploads.id, id),
          eq(uploads.createdBy, actor.userId),
        ),
      );
    if (!row) throw new NotFound("Upload");
    await can(db, actor, "upload", row.projectId);
    return row;
  };

  return new Hono<{ Variables: TenantVariables }>()
    .post("/", zValidator("json", createUploadInput), async (c) => {
      const input = c.req.valid("json");
      const organisationId = c.var.organisationId;
      const { projectId } = await can(db, actorOf(c.var), "upload", input.projectId);
      if (input.folderId) {
        const [folder] = await db
          .select({ id: folders.id })
          .from(folders)
          .where(
            inOrg(
              folders,
              organisationId,
              eq(folders.id, input.folderId),
              eq(folders.projectId, projectId),
            ),
          );
        if (!folder) throw new NotFound("Folder");
      }
      const row = await engine.begin({
        organisationId,
        projectId,
        folderId: input.folderId ?? null,
        name: input.name,
        size: input.size,
        contentType: input.contentType,
        createdBy: c.var.userId,
      });
      return c.json({ upload: uploadView(row, []) }, 201);
    })

    .get("/:id", idParam, async (c) => {
      const row = await own(actorOf(c.var), c.req.valid("param").id);
      const chunks = await engine.received(row.organisationId, row.id);
      return c.json({
        upload: uploadView(
          row,
          chunks.map((p) => p.chunk),
        ),
      });
    })

    .put("/:id/chunks/:index", chunkParam, chunkBody, async (c) => {
      const { id, index } = c.req.valid("param");
      const row = await own(actorOf(c.var), id);
      const body = new Uint8Array(await c.req.arrayBuffer());
      await engine.putChunk(row, index, body, c.req.header("content-digest"));
      return c.body(null, 204);
    })

    .post("/:id/complete", idParam, async (c) => {
      const row = await own(actorOf(c.var), c.req.valid("param").id);
      const { file, created } = await engine.complete(row, {
        uploadedBy: c.var.userId,
        actor: () => audit.member(c.var.userId),
        request: requestInfo(c, trustProxy),
      });
      return c.json({ file }, created ? 201 : 200);
    })

    .delete("/:id", idParam, async (c) => {
      const row = await own(actorOf(c.var), c.req.valid("param").id);
      await engine.abort(row);
      return c.body(null, 204);
    });
};
