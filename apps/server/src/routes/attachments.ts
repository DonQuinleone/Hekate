import { createHash, randomBytes } from "node:crypto";
import { type Database, inOrg, schema } from "@hekate/db";
import {
  attachmentName,
  COMMENT_ATTACHMENT_MAX_BYTES,
  COMMENT_ATTACHMENTS_MAX,
  type CommentAttachment,
  DOWNLOAD_LINK_SECONDS,
} from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { count, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { type Actor, canOnFile } from "../access.ts";
import { type Audit, requestInfo } from "../audit.ts";
import { NotFound } from "../errors.ts";
import type { ViewerVariables } from "../guests.ts";
import { admit, tooMany } from "../rate-limit.ts";
import type { Storage } from "../storage.ts";
import { assertStorageRoom } from "../usage.ts";
import { attachment, threadsOn, wroteIt } from "./comments.ts";

const { comments, commentAttachments, downloadTickets } = schema;

export interface AttachmentDeps {
  db: Database;
  storage: Storage;
  audit: Audit;
  trustProxy: boolean;
}

/** A person may download this many attachments an hour, as with files. */
const PER_HOUR = 60;

const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

/** A type the browser is told the bytes are; anything else is plain bytes. */
const contentTypeOf = (header: string | undefined) => {
  const type = (header ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,127}$/.test(type)
    ? type
    : "application/octet-stream";
};

/** Whom a comment's attachments belong to: its author, member or guest. */
/**
 * An attachment, if the actor may see the comment it belongs to on this file: the comment is
 * among the threads the file shows them (their own, carried here, within a guest's scope).
 */
export async function attachmentSeen(
  db: Database,
  actor: Actor,
  organisationId: string,
  fileId: string,
  attachmentId: string,
) {
  const access = await canOnFile(db, actor, "read_comments", fileId);
  const [row] = await db
    .select()
    .from(commentAttachments)
    .where(inOrg(commentAttachments, organisationId, eq(commentAttachments.id, attachmentId)));
  if (!row) throw new NotFound("Attachment");
  const seen = await threadsOn(db, organisationId, actor, access, fileId);
  if (!seen.some((c) => c.id === row.commentId)) throw new NotFound("Attachment");
  return { row, projectId: access.projectId };
}

/** Refuses unless the actor wrote the comment and it has room for another attachment. */
async function mayAttach(
  db: Pick<Database, "select">,
  organisationId: string,
  actor: Actor,
  commentId: string,
  lock: boolean,
) {
  const query = db
    .select({ authorId: comments.authorId, guestAuthorId: comments.guestAuthorId })
    .from(comments)
    .where(inOrg(comments, organisationId, eq(comments.id, commentId)));
  const [comment] = lock ? await query.for("update") : await query;
  if (!comment) throw new NotFound("Comment");
  if (!wroteIt(actor, comment))
    throw new HTTPException(403, { message: "Only its author can attach to a comment" });
  const [held] = await db
    .select({ n: count() })
    .from(commentAttachments)
    .where(inOrg(commentAttachments, organisationId, eq(commentAttachments.commentId, commentId)));
  if ((held?.n ?? 0) >= COMMENT_ATTACHMENTS_MAX)
    throw new HTTPException(409, {
      message: `A comment can carry at most ${COMMENT_ATTACHMENTS_MAX} attachments`,
    });
}

const attachmentParam = zValidator("param", z.object({ id: z.uuid(), attachmentId: z.uuid() }));

/**
 * Files attached to comments (#133), under `/api/files/:id`, the file being viewed: adding
 * one to your own comment, removing it, and asking for a one-time download of one. Every
 * attachment is stored encrypted, and reaches a browser only through that download, which is
 * in the access log before the first byte leaves.
 */
export const attachmentRoutes = (deps: AttachmentDeps) =>
  new Hono<{ Variables: ViewerVariables }>()
    .post(
      "/:id/comments/:commentId/attachments",
      zValidator("param", z.object({ id: z.uuid(), commentId: z.uuid() })),
      async (c) => {
        const { db, storage, audit } = deps;
        const organisationId = c.var.organisationId;
        const actor = c.var.actor;
        const { id: fileId, commentId } = c.req.valid("param");
        const access = await canOnFile(db, actor, "comment", fileId);
        const seen = await threadsOn(db, organisationId, actor, access, fileId);
        if (!seen.some((x) => x.id === commentId)) throw new NotFound("Comment");
        const named = attachmentName.safeParse(
          decodeURIComponent(c.req.header("x-file-name") ?? ""),
        );
        if (!named.success)
          throw new HTTPException(400, { message: named.error.issues[0]?.message ?? "No name" });
        // Refused before the body is read, so a refusal never costs a store.
        await mayAttach(db, organisationId, actor, commentId, false);
        const bytes = Buffer.from(await c.req.arrayBuffer());
        if (bytes.length === 0) throw new HTTPException(400, { message: "The file is empty" });
        if (bytes.length > COMMENT_ATTACHMENT_MAX_BYTES)
          throw new HTTPException(413, { message: "An attachment can be at most 25 MB" });
        // The workspace's quota (#175): an attachment is at most 25 MB, so checked before it is
        // stored rather than under the lock its blob is written outside of.
        await db.transaction((tx) => assertStorageRoom(tx, organisationId, bytes.length));
        const contentType = contentTypeOf(c.req.header("content-type"));
        const blob = await storage.put(organisationId, bytes, {
          contentType,
          projectId: access.projectId,
        });
        try {
          const made = await db.transaction(async (tx) => {
            // Again under the comment's lock, so two at once cannot pass the limit together.
            await mayAttach(tx, organisationId, actor, commentId, true);
            const [row] = await tx
              .insert(commentAttachments)
              .values({
                organisationId,
                commentId,
                blobId: blob.id,
                name: named.data,
                contentType,
                byteSize: bytes.length,
              })
              .returning();
            await audit.record(
              organisationId,
              await audit.actor(actor),
              {
                action: "comment.attachment_add",
                projectId: access.projectId,
                fileId,
                details: { commentId, attachmentId: row?.id, name: named.data },
              },
              requestInfo(c, deps.trustProxy),
              tx,
            );
            return row;
          });
          const shown: CommentAttachment = {
            id: made?.id ?? "",
            name: named.data,
            contentType,
            byteSize: bytes.length,
          };
          return c.json({ attachment: shown }, 201);
        } catch (error) {
          // Nothing points at the bytes: take them back.
          await storage.remove(organisationId, blob.id).catch(() => undefined);
          throw error;
        }
      },
    )
    .delete("/:id/attachments/:attachmentId", attachmentParam, async (c) => {
      const { db, storage } = deps;
      const organisationId = c.var.organisationId;
      const actor = c.var.actor;
      const { id: fileId, attachmentId } = c.req.valid("param");
      await canOnFile(db, actor, "comment", fileId);
      const { row } = await attachmentSeen(db, actor, organisationId, fileId, attachmentId);
      const [comment] = await db
        .select({ authorId: comments.authorId, guestAuthorId: comments.guestAuthorId })
        .from(comments)
        .where(inOrg(comments, organisationId, eq(comments.id, row.commentId)));
      if (!comment || !wroteIt(actor, comment))
        throw new HTTPException(403, { message: "Only its author can remove an attachment" });
      await db
        .delete(commentAttachments)
        .where(inOrg(commentAttachments, organisationId, eq(commentAttachments.id, row.id)));
      // Bytes left behind if this fails are found and removed by storage reconciliation.
      await storage
        .remove(organisationId, row.blobId)
        .catch((error: unknown) =>
          console.warn(`Could not remove the bytes of attachment ${row.id}: ${String(error)}`),
        );
      return c.body(null, 204);
    })
    .post("/:id/attachments/:attachmentId/download", attachmentParam, async (c) => {
      const { db } = deps;
      const organisationId = c.var.organisationId;
      const actor = c.var.actor;
      const { id: fileId, attachmentId } = c.req.valid("param");
      await attachmentSeen(db, actor, organisationId, fileId, attachmentId);
      const who = actor.kind === "guest" ? `guest:${actor.guestId}` : `member:${actor.userId}`;
      const { allowed, retryAfter } = await admit(db, `attachment:${who}`, {
        max: PER_HOUR,
        windowMs: 60 * 60_000,
      });
      if (!allowed) return tooMany(c, retryAfter, "Too many downloads this hour; try again later");
      const token = randomBytes(32).toString("base64url");
      await db.insert(downloadTickets).values({
        organisationId,
        fileId,
        attachmentId,
        kind: "attachment",
        tokenHash: hashOf(token),
        sessionId: c.var.sessionId,
        userId: actor.kind === "guest" ? null : actor.userId,
        guestId: actor.kind === "guest" ? actor.guestId : null,
        expiresAt: new Date(Date.now() + DOWNLOAD_LINK_SECONDS * 1000),
      });
      return c.json({ url: `/api/downloads/${token}` }, 201);
    });

/**
 * The download a ticket for an attachment was made for: the comment is checked again, the
 * access log has it, then the bytes go, decrypted, as a download never shown in the page.
 */
export async function sendAttachment(
  deps: AttachmentDeps,
  c: Context<{ Variables: ViewerVariables }>,
  ticket: { fileId: string; attachmentId: string },
) {
  const organisationId = c.var.organisationId;
  const actor = c.var.actor;
  const { row, projectId } = await attachmentSeen(
    deps.db,
    actor,
    organisationId,
    ticket.fileId,
    ticket.attachmentId,
  );
  // No record, no download.
  await deps.audit.record(
    organisationId,
    await deps.audit.actor(actor),
    {
      action: "comment.attachment_download",
      projectId,
      fileId: ticket.fileId,
      details: { commentId: row.commentId, attachmentId: row.id, name: row.name },
    },
    requestInfo(c, deps.trustProxy),
  );
  const { stream } = await deps.storage.open(organisationId, row.blobId);
  return new Response(stream as unknown as ReadableStream, {
    headers: {
      "cache-control": "no-store, private",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
      "content-type": row.contentType,
      "content-length": String(row.byteSize),
      "content-disposition": attachment(row.name),
    },
  });
}
