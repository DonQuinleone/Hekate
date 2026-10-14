import { type Database, inOrg, schema } from "@hekate/db";
import {
  anchorProblem,
  createCommentInput,
  editCommentInput,
  resolveCommentInput,
} from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { actorOf, canOnFile } from "../access.ts";
import { type Audit, requestInfo } from "../audit.ts";
import { NotFound } from "../errors.ts";
import type { ViewerVariables } from "../guests.ts";
import type { TenantVariables } from "../tenancy.ts";

const { comments, files, users, guests } = schema;
const resolver = alias(users, "resolver");

const idParam = zValidator("param", z.object({ id: z.uuid() }));

/** A comment as clients see it: the author's and resolver's names rather than their rows. */
const commentColumns = {
  id: comments.id,
  fileId: comments.fileId,
  parentId: comments.parentId,
  anchor: comments.anchor,
  body: comments.body,
  authorId: comments.authorId,
  authorName: sql<string | null>`coalesce(${users.name}, ${guests.name})`,
  /** A guest reviewer wrote it; their label, if any, reads beside their name. */
  authorGuest: sql<boolean>`${comments.guestAuthorId} is not null`,
  authorLabel: guests.label,
  resolvedAt: comments.resolvedAt,
  resolvedByName: resolver.name,
  editedAt: comments.editedAt,
  createdAt: comments.createdAt,
};

function selectComments(db: Database, organisationId: string, where: ReturnType<typeof eq>) {
  return db
    .select(commentColumns)
    .from(comments)
    .leftJoin(users, eq(comments.authorId, users.id))
    .leftJoin(guests, eq(comments.guestAuthorId, guests.id))
    .leftJoin(resolver, eq(comments.resolvedById, resolver.id))
    .where(inOrg(comments, organisationId, where));
}

async function commentOf(db: Database, organisationId: string, id: string) {
  const [row] = await selectComments(db, organisationId, eq(comments.id, id));
  if (!row) throw new NotFound("Comment");
  return row;
}

/**
 * `/api/files/:id/comments`: a file's comment threads, and starting or replying to one.
 * Guest reviewers use these too, on the files of their reviews.
 */
export const fileCommentRoutes = (db: Database, audit: Audit, trustProxy: boolean) =>
  new Hono<{ Variables: ViewerVariables }>()
    .get("/:id/comments", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      await canOnFile(db, c.var.actor, "view", c.req.valid("param").id);
      const [file] = await db
        .select({ id: files.id })
        .from(files)
        .where(inOrg(files, organisationId, eq(files.id, c.req.valid("param").id)));
      if (!file) throw new NotFound("File");
      const rows = await selectComments(db, organisationId, eq(comments.fileId, file.id)).orderBy(
        asc(comments.createdAt),
        asc(comments.id),
      );
      return c.json({ comments: rows });
    })
    .post("/:id/comments", idParam, zValidator("json", createCommentInput), async (c) => {
      const organisationId = c.var.organisationId;
      const input = c.req.valid("json");
      const actor = c.var.actor;
      await canOnFile(db, actor, "comment", c.req.valid("param").id);
      const [file] = await db
        .select({
          id: files.id,
          kind: files.kind,
          mediaInfo: files.mediaInfo,
          projectId: files.projectId,
        })
        .from(files)
        .where(inOrg(files, organisationId, eq(files.id, c.req.valid("param").id)));
      if (!file) throw new NotFound("File");

      if (input.parentId) {
        // Threads are one level deep: a reply answers a top-level comment on this file.
        const [parent] = await db
          .select({ id: comments.id })
          .from(comments)
          .where(
            inOrg(
              comments,
              organisationId,
              eq(comments.id, input.parentId),
              eq(comments.fileId, file.id),
              isNull(comments.parentId),
            ),
          );
        if (!parent)
          throw new HTTPException(422, { message: "There is no such thread to reply to" });
      }
      if (input.anchor) {
        const problem = anchorProblem(input.anchor, {
          kind: file.kind,
          duration: file.mediaInfo?.duration,
        });
        if (problem) throw new HTTPException(422, { message: problem });
      }

      const [created] = await db
        .insert(comments)
        .values({
          organisationId,
          fileId: file.id,
          parentId: input.parentId ?? null,
          authorId: actor.kind === "guest" ? null : actor.userId,
          guestAuthorId: actor.kind === "guest" ? actor.guestId : null,
          anchor: input.anchor ?? null,
          body: input.body,
        })
        .returning({ id: comments.id });
      // Every guest comment is in the access log (docs/security.md).
      if (actor.kind === "guest") {
        await audit.record(
          organisationId,
          await audit.guest(actor.guestId),
          {
            action: "comment.create",
            projectId: file.projectId,
            fileId: file.id,
            details: { commentId: created?.id },
          },
          requestInfo(c, trustProxy),
        );
      }
      return c.json({ comment: await commentOf(db, organisationId, created?.id ?? "") }, 201);
    });

/**
 * `/api/comments/:id`: editing your own words, and resolving or reopening a thread (triage).
 * A comment on a file whose project the caller cannot see does not exist for them.
 */
export const commentRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
    .patch("/:id", idParam, zValidator("json", editCommentInput), async (c) => {
      const organisationId = c.var.organisationId;
      const { id } = c.req.valid("param");
      const existing = await commentOf(db, organisationId, id);
      // Still able to comment here: editing is writing.
      await canOnFile(db, actorOf(c.var), "comment", existing.fileId);
      if (existing.authorId !== c.var.userId) {
        throw new HTTPException(403, { message: "Only the author can edit a comment" });
      }
      await db
        .update(comments)
        .set({ body: c.req.valid("json").body, editedAt: new Date(), updatedAt: new Date() })
        .where(inOrg(comments, organisationId, eq(comments.id, id)));
      return c.json({ comment: await commentOf(db, organisationId, id) });
    })
    .post("/:id/resolve", idParam, zValidator("json", resolveCommentInput), async (c) => {
      const organisationId = c.var.organisationId;
      const { id } = c.req.valid("param");
      const { resolved } = c.req.valid("json");
      // Resolving and reopening is triage: the project role must allow it.
      const thread = await commentOf(db, organisationId, id);
      await canOnFile(db, actorOf(c.var), "triage", thread.fileId);
      // Threads resolve as a whole, through their first comment.
      const [updated] = await db
        .update(comments)
        .set(
          resolved
            ? { resolvedAt: new Date(), resolvedById: c.var.userId, updatedAt: new Date() }
            : { resolvedAt: null, resolvedById: null, updatedAt: new Date() },
        )
        .where(and(inOrg(comments, organisationId, eq(comments.id, id)), isNull(comments.parentId)))
        .returning({ id: comments.id });
      if (!updated) throw new NotFound("Thread");
      return c.json({ comment: await commentOf(db, organisationId, id) });
    });
