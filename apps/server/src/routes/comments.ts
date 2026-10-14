import { type Database, inOrg, schema } from "@hekate/db";
import {
  type Anchor,
  anchorProblem,
  type CarryStatus,
  carrySettles,
  createCommentInput,
  editCommentInput,
  resolveCommentInput,
  updateCarryInput,
  visibleComments,
} from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { and, asc, eq, inArray, isNull, or, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { actorOf, canOnFile } from "../access.ts";
import { type Audit, requestInfo } from "../audit.ts";
import { hopsOf, lockTrackOfFile, versionNumbersOf } from "../carry.ts";
import { NotFound } from "../errors.ts";
import type { ViewerVariables } from "../guests.ts";
import type { TenantVariables } from "../tenancy.ts";

const { comments, commentCarries, files, users, guests } = schema;
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
  /** Read here to apply a guest reviewer's comment scope; never sent to clients. */
  guestAuthorId: comments.guestAuthorId,
  authorName: sql<string | null>`coalesce(${users.name}, ${guests.name})`,
  /** A guest reviewer wrote it; their label, if any, reads beside their name. */
  authorGuest: sql<boolean>`${comments.guestAuthorId} is not null`,
  authorLabel: guests.label,
  resolvedAt: comments.resolvedAt,
  resolvedByName: resolver.name,
  editedAt: comments.editedAt,
  createdAt: comments.createdAt,
};

function selectComments(db: Database, organisationId: string, where: SQL | undefined) {
  return db
    .select(commentColumns)
    .from(comments)
    .leftJoin(users, eq(comments.authorId, users.id))
    .leftJoin(guests, eq(comments.guestAuthorId, guests.id))
    .leftJoin(resolver, eq(comments.resolvedById, resolver.id))
    .where(inOrg(comments, organisationId, where));
}

/** A comment as it leaves the server: which guest wrote it stays inside. */
function publicComment<C extends { guestAuthorId: string | null }>({
  guestAuthorId: _,
  ...rest
}: C) {
  return rest;
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
      const access = await canOnFile(db, c.var.actor, "view", c.req.valid("param").id);
      const [file] = await db
        .select({ id: files.id })
        .from(files)
        .where(inOrg(files, organisationId, eq(files.id, c.req.valid("param").id)));
      if (!file) throw new NotFound("File");
      // Threads carried here from earlier versions; hidden ones only for those who triage.
      const triage = access.permissions.has("triage");
      const carriedHere = await db
        .select({
          id: commentCarries.id,
          commentId: commentCarries.commentId,
          anchor: commentCarries.anchor,
          visible: commentCarries.visible,
          status: commentCarries.status,
        })
        .from(commentCarries)
        .where(
          inOrg(
            commentCarries,
            organisationId,
            eq(commentCarries.fileId, file.id),
            triage ? undefined : eq(commentCarries.visible, true),
          ),
        );
      const carriedIds = carriedHere.map((k) => k.commentId);
      const all = await selectComments(
        db,
        organisationId,
        carriedIds.length > 0
          ? or(
              eq(comments.fileId, file.id),
              inArray(comments.id, carriedIds),
              inArray(comments.parentId, carriedIds),
            )
          : eq(comments.fileId, file.id),
      ).orderBy(asc(comments.createdAt), asc(comments.id));
      // A guest reviewer sees the comments their review lets them (docs/domain.md).
      const actor = c.var.actor;
      const rows =
        actor.kind === "guest" && access.grant
          ? visibleComments(
              all.map((r) => ({ ...r, author: r.guestAuthorId })),
              access.grant.comments,
              actor.guestId,
            ).map(({ author: _, ...r }) => r)
          : all;

      // Each thread's history: where it began and every version it was carried to.
      const roots = rows.filter((r) => !r.parentId);
      const hops = await hopsOf(
        db,
        organisationId,
        roots.map((r) => r.id),
      );
      const origins = await versionNumbersOf(db, organisationId, [
        ...new Set(roots.map((r) => r.fileId)),
      ]);
      const here = new Map(carriedHere.map((k) => [k.commentId, k]));
      return c.json({
        comments: rows.map((row) => {
          if (row.parentId) return { ...publicComment(row), carry: null, history: null };
          const carry = here.get(row.id);
          const history = {
            versionNumber: origins.get(row.fileId) ?? null,
            hops: hops
              .filter((h) => h.commentId === row.id)
              .map((h) => ({ fileId: h.fileId, versionNumber: h.versionNumber, status: h.status })),
          };
          if (!carry) return { ...publicComment(row), carry: null, history };
          // On this version the thread points where it was mapped; where it began stays known.
          return {
            ...publicComment(row),
            anchor: carry.anchor,
            carry: {
              id: carry.id,
              status: carry.status,
              visible: carry.visible,
              from: { fileId: row.fileId, anchor: row.anchor as Anchor | null },
            },
            history,
          };
        }),
      });
    })
    .post("/:id/comments", idParam, zValidator("json", createCommentInput), async (c) => {
      const organisationId = c.var.organisationId;
      const input = c.req.valid("json");
      const actor = c.var.actor;
      const access = await canOnFile(db, actor, "comment", c.req.valid("param").id);
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

      /** A reply joins its thread on the file the thread was raised on. */
      let threadFileId = file.id;
      if (input.parentId) {
        // Threads are one level deep: a reply answers a top-level comment on this file, or
        // one carried here from an earlier version and shown here.
        const [parent] = await db
          .select({
            id: comments.id,
            fileId: comments.fileId,
            guestAuthorId: comments.guestAuthorId,
          })
          .from(comments)
          .where(
            inOrg(
              comments,
              organisationId,
              eq(comments.id, input.parentId),
              isNull(comments.parentId),
            ),
          );
        // A guest who sees only their own threads can reply only to those.
        const seen =
          actor.kind !== "guest" ||
          access.grant?.comments === "all" ||
          parent?.guestAuthorId === actor.guestId;
        const reachable =
          parent &&
          seen &&
          (parent.fileId === file.id ||
            (
              await db
                .select({ id: commentCarries.id })
                .from(commentCarries)
                .where(
                  inOrg(
                    commentCarries,
                    organisationId,
                    eq(commentCarries.commentId, parent.id),
                    eq(commentCarries.fileId, file.id),
                    eq(commentCarries.visible, true),
                  ),
                )
            ).length > 0);
        if (!parent || !reachable)
          throw new HTTPException(422, { message: "There is no such thread to reply to" });
        threadFileId = parent.fileId;
      }
      if (input.anchor) {
        const problem = anchorProblem(input.anchor, {
          kind: file.kind,
          duration: file.mediaInfo?.duration,
        });
        if (problem) throw new HTTPException(422, { message: problem });
      }

      // Every guest comment is in the access log (docs/security.md), written with it.
      const who = actor.kind === "guest" ? await audit.guest(actor.guestId) : null;
      const created = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(comments)
          .values({
            organisationId,
            fileId: threadFileId,
            parentId: input.parentId ?? null,
            authorId: actor.kind === "guest" ? null : actor.userId,
            guestAuthorId: actor.kind === "guest" ? actor.guestId : null,
            anchor: input.anchor ?? null,
            body: input.body,
          })
          .returning({ id: comments.id });
        if (who) {
          await audit.record(
            organisationId,
            who,
            {
              action: "comment.create",
              projectId: file.projectId,
              fileId: file.id,
              details: { commentId: row?.id },
            },
            requestInfo(c, trustProxy),
            tx,
          );
        }
        return row;
      });
      return c.json(
        { comment: publicComment(await commentOf(db, organisationId, created?.id ?? "")) },
        201,
      );
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
      return c.json({ comment: publicComment(await commentOf(db, organisationId, id)) });
    })
    .post("/:id/resolve", idParam, zValidator("json", resolveCommentInput), async (c) => {
      const organisationId = c.var.organisationId;
      const { id } = c.req.valid("param");
      const { resolved } = c.req.valid("json");
      // Resolving and reopening is triage: the project role must allow it.
      const thread = await commentOf(db, organisationId, id);
      await canOnFile(db, actorOf(c.var), "triage", thread.fileId);
      // Threads resolve as a whole, through their first comment.
      const updated = await db.transaction(async (tx) => {
        // Not while a new version is deciding which threads to carry.
        await lockTrackOfFile(tx, organisationId, thread.fileId);
        const [row] = await tx
          .update(comments)
          .set(
            resolved
              ? { resolvedAt: new Date(), resolvedById: c.var.userId, updatedAt: new Date() }
              : { resolvedAt: null, resolvedById: null, updatedAt: new Date() },
          )
          .where(
            and(inOrg(comments, organisationId, eq(comments.id, id)), isNull(comments.parentId)),
          )
          .returning({ id: comments.id });
        return row;
      });
      if (!updated) throw new NotFound("Thread");
      return c.json({ comment: publicComment(await commentOf(db, organisationId, id)) });
    });

/**
 * `/api/comment-carries/:id`: triage on a thread carried to a later version: its status
 * there, whether it shows there, and a corrected mapping. Fixed and won't fix settle the
 * thread; open and not fixed reopen it, so it carries on to the next version.
 */
export const carryRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>().patch(
    "/:id",
    idParam,
    zValidator("json", updateCarryInput),
    async (c) => {
      const organisationId = c.var.organisationId;
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const [carry] = await db
        .select({
          id: commentCarries.id,
          commentId: commentCarries.commentId,
          fileId: commentCarries.fileId,
        })
        .from(commentCarries)
        .where(inOrg(commentCarries, organisationId, eq(commentCarries.id, id)));
      if (!carry) throw new NotFound("Carried thread");
      await canOnFile(db, actorOf(c.var), "triage", carry.fileId);
      if (input.anchor) {
        const [file] = await db
          .select({ kind: files.kind, mediaInfo: files.mediaInfo })
          .from(files)
          .where(inOrg(files, organisationId, eq(files.id, carry.fileId)));
        const problem =
          file &&
          anchorProblem(input.anchor, { kind: file.kind, duration: file.mediaInfo?.duration });
        if (problem) throw new HTTPException(422, { message: problem });
      }
      const now = new Date();
      const status: CarryStatus | undefined = input.status;
      await db.transaction(async (tx) => {
        // Not while a new version is deciding which threads to carry.
        await lockTrackOfFile(tx, organisationId, carry.fileId);
        if (status !== undefined) {
          // A thread's status is its latest version's; an earlier one is history.
          const hops = await hopsOf(tx, organisationId, [carry.commentId]);
          const here = hops.find((h) => h.id === carry.id)?.versionNumber ?? 0;
          if (hops.some((h) => h.versionNumber > here)) {
            throw new HTTPException(409, {
              message: "A later version carries this thread; settle it there",
            });
          }
        }
        await tx
          .update(commentCarries)
          .set({
            ...(status !== undefined && { status, statusById: c.var.userId }),
            ...(input.visible !== undefined && { visible: input.visible }),
            // Placed by hand: alignment leaves it where it was put.
            ...(input.anchor !== undefined && { anchor: input.anchor, anchorPlaced: true }),
            updatedAt: now,
          })
          .where(inOrg(commentCarries, organisationId, eq(commentCarries.id, carry.id)));
        if (status === undefined) return;
        await tx
          .update(comments)
          .set(
            carrySettles(status)
              ? { resolvedAt: now, resolvedById: c.var.userId, updatedAt: now }
              : { resolvedAt: null, resolvedById: null, updatedAt: now },
          )
          .where(inOrg(comments, organisationId, eq(comments.id, carry.commentId)));
      });
      return c.body(null, 204);
    },
  );
