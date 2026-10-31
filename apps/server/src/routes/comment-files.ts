import { type Database, inOrg, schema } from "@hekate/db";
import { type LinkedFile, linkFilesInput } from "@hekate/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { actorOf, canOnFile, lockLiveProject } from "../access.ts";
import { type Audit, requestInfo } from "../audit.ts";
import { NotFound } from "../errors.ts";
import { zValidator } from "../openapi/validator.ts";
import { listedFile } from "../take-files.ts";
import type { TenantVariables } from "../tenancy.ts";

const { comments, commentFiles, files } = schema;

/**
 * The project files linked to each of these comments (#527), in the order they were linked:
 * what each is, never a way to its bytes, which reach a browser only through the viewer.
 */
export async function linkedFilesOf(
  db: Pick<Database, "select">,
  organisationId: string,
  commentIds: string[],
): Promise<Map<string, LinkedFile[]>> {
  const linked = new Map<string, LinkedFile[]>();
  if (commentIds.length === 0) return linked;
  const rows = await db
    .select({
      commentId: commentFiles.commentId,
      id: files.id,
      name: files.name,
      kind: files.kind,
      mediaInfo: files.mediaInfo,
      pageCount: files.pageCount,
    })
    .from(commentFiles)
    .innerJoin(
      files,
      and(eq(files.id, commentFiles.fileId), eq(files.organisationId, organisationId)),
    )
    .where(inOrg(commentFiles, organisationId, inArray(commentFiles.commentId, commentIds)))
    .orderBy(asc(commentFiles.createdAt), asc(commentFiles.id));
  for (const { commentId, mediaInfo, ...file } of rows) {
    const list = linked.get(commentId) ?? [];
    list.push({
      ...file,
      kind: file.kind as LinkedFile["kind"],
      duration: mediaInfo?.duration ?? null,
    });
    linked.set(commentId, list);
  }
  return linked;
}

/** A comment, with the file its thread is on (a reply's is its thread's) and its author. */
async function commentOf(db: Database, organisationId: string, id: string) {
  const [comment] = await db
    .select({ fileId: comments.fileId, authorId: comments.authorId })
    .from(comments)
    .where(inOrg(comments, organisationId, eq(comments.id, id)));
  if (!comment) throw new NotFound("Comment");
  return comment;
}

/**
 * Linking files already in the project to a comment (#527, decision 294), under
 * `/api/comments/:id/files`: by the comment's author, who must still be able to comment on its
 * thread's file, and only files of that file's own project that they can see (never a take's,
 * which is shared from the track's takes, and never another project's or workspace's). Members
 * only: a guest sees no project to pick from. Whoever sees the comment then opens each in the
 * viewer as their own access allows; every link and unlink is in the access log.
 */
export const commentFileRoutes = (deps: { db: Database; audit: Audit; trustProxy: boolean }) =>
  new Hono<{ Variables: TenantVariables }>()
    .post(
      "/:id/files",
      zValidator("param", z.object({ id: z.uuid() })),
      zValidator("json", linkFilesInput),
      async (c) => {
        const { db, audit } = deps;
        const organisationId = c.var.organisationId;
        const { id } = c.req.valid("param");
        const fileIds = [...new Set(c.req.valid("json").fileIds)];
        const comment = await commentOf(db, organisationId, id);
        const actor = actorOf(c.var);
        // Commenting on the thread's file, and seeing its project, as their role has it now.
        const access = await canOnFile(db, actor, "comment", comment.fileId);
        if (comment.authorId !== actor.userId)
          throw new HTTPException(403, { message: "Only its author can attach to a comment" });
        await db.transaction(async (tx) => {
          await lockLiveProject(tx, organisationId, access.projectId);
          const found = await tx
            .select({ id: files.id })
            .from(files)
            .where(
              inOrg(
                files,
                organisationId,
                inArray(files.id, fileIds),
                eq(files.projectId, access.projectId),
                listedFile,
              ),
            );
          if (found.length !== fileIds.length) throw new NotFound("File");
          const added = await tx
            .insert(commentFiles)
            .values(
              fileIds.map((fileId) => ({
                organisationId,
                commentId: id,
                fileId,
                linkedById: actor.userId,
              })),
            )
            .onConflictDoNothing()
            .returning({ fileId: commentFiles.fileId });
          // Only what was linked now: a file already on the comment changes nothing.
          if (added.length === 0) return;
          await audit.record(
            organisationId,
            await audit.actor(actor),
            {
              action: "comment.files_link",
              projectId: access.projectId,
              fileId: comment.fileId,
              details: { commentId: id, fileIds: added.map((a) => a.fileId) },
            },
            requestInfo(c, deps.trustProxy),
            tx,
          );
        });
        const linked = await linkedFilesOf(db, organisationId, [id]);
        return c.json({ files: linked.get(id) ?? [] }, 201);
      },
    )
    .delete(
      "/:id/files/:fileId",
      zValidator("param", z.object({ id: z.uuid(), fileId: z.uuid() })),
      async (c) => {
        const { db, audit } = deps;
        const organisationId = c.var.organisationId;
        const { id, fileId } = c.req.valid("param");
        const comment = await commentOf(db, organisationId, id);
        const actor = actorOf(c.var);
        const access = await canOnFile(db, actor, "read_comments", comment.fileId);
        // Its author, while they may comment, or whoever triages the thread's file.
        const own = comment.authorId === actor.userId && access.permissions.has("comment");
        if (!own && !access.permissions.has("triage"))
          throw new HTTPException(403, {
            message: "Only its author, or whoever triages, can take a file off a comment",
          });
        await db.transaction(async (tx) => {
          await lockLiveProject(tx, organisationId, access.projectId);
          const gone = await tx
            .delete(commentFiles)
            .where(
              inOrg(
                commentFiles,
                organisationId,
                eq(commentFiles.commentId, id),
                eq(commentFiles.fileId, fileId),
              ),
            )
            .returning({ id: commentFiles.id });
          if (gone.length === 0) throw new NotFound("File");
          await audit.record(
            organisationId,
            await audit.actor(actor),
            {
              action: "comment.files_unlink",
              projectId: access.projectId,
              fileId: comment.fileId,
              details: { commentId: id, linkedFileId: fileId },
            },
            requestInfo(c, deps.trustProxy),
            tx,
          );
        });
        return c.body(null, 204);
      },
    );
