import { type Database, inOrg, schema } from "@hekate/db";
import {
  type Anchor,
  anchorProblem,
  type CarryStatus,
  type CategoryHandling,
  type CommentAttachment,
  type CommentMention,
  carriedChannel,
  carrySettles,
  commentExportQuery,
  commentSheetQuery,
  commentTodoInput,
  createCommentInput,
  deferralAfter,
  editCommentInput,
  exportComments,
  importMarkersInput,
  mentionedIn,
  mentionRanges,
  resolveCommentInput,
  sendListInput,
  speakersOf,
  threadsForExport,
  triageInput,
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
import { commentSheet } from "../comment-sheet.ts";
import { CodedException, NotFound } from "../errors.ts";
import type { ViewerVariables } from "../guests.ts";
import type { Mailer } from "../mail.ts";
import { type NotificationActor, notifyNow, projectPeople } from "../notifications.ts";
import { referencesOfFile } from "../references.ts";
import { requesterOf } from "../requester.ts";
import type { TenantVariables } from "../tenancy.ts";
import { sharedTakesOf } from "./takes.ts";

const {
  comments,
  commentAttachments,
  commentCarries,
  commentCategories,
  files,
  organisations,
  projects,
  users,
  guests,
  variations,
  versions,
} = schema;
const resolver = alias(users, "resolver");
const assignee = alias(users, "assignee");
const doneBy = alias(users, "done_by");
const importer = alias(users, "importer");

const idParam = zValidator("param", z.object({ id: z.uuid() }));

/** A file's name and project, for telling people about it; 404 when it is not here. */
async function fileOf(db: Database, organisationId: string, fileId: string) {
  const [file] = await db
    .select({ name: files.name, projectId: files.projectId })
    .from(files)
    .where(inOrg(files, organisationId, eq(files.id, fileId)));
  if (!file) throw new NotFound("File");
  return file;
}

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
  /** Triage (#36): its kind, the stage it waits for, and who is to act on it. */
  categoryId: comments.categoryId,
  deferredTo: comments.deferredTo,
  assigneeId: comments.assigneeId,
  assigneeName: assignee.name,
  /** Who it mentions (#133), and whether it is a task and done. */
  mentions: comments.mentions,
  todo: comments.todo,
  todoDoneAt: comments.todoDoneAt,
  todoDoneByName: doneBy.name,
  /** The channel it is about (#74); null is all of them. */
  channel: comments.channel,
  /** The marker list it came from (#134), and who imported it. */
  importedFrom: comments.importedFrom,
  importedByName: importer.name,
};

function selectComments(db: Database, organisationId: string, where: SQL | undefined) {
  return db
    .select(commentColumns)
    .from(comments)
    .leftJoin(users, eq(comments.authorId, users.id))
    .leftJoin(guests, eq(comments.guestAuthorId, guests.id))
    .leftJoin(resolver, eq(comments.resolvedById, resolver.id))
    .leftJoin(assignee, eq(comments.assigneeId, assignee.id))
    .leftJoin(doneBy, eq(comments.todoDoneById, doneBy.id))
    .leftJoin(importer, eq(comments.importedById, importer.id))
    .where(inOrg(comments, organisationId, where));
}

/** Whether the actor wrote a comment, as a member or as a guest. */
export const wroteIt = (
  actor: ViewerVariables["actor"],
  c: { authorId: string | null; guestAuthorId: string | null },
) => (actor.kind === "guest" ? c.guestAuthorId === actor.guestId : c.authorId === actor.userId);

/**
 * A comment as it leaves the server: which guest wrote it stays inside, and whether it is the
 * viewer's own is said instead, since a guest cannot tell from its author.
 */
function publicComment<C extends { authorId: string | null; guestAuthorId: string | null }>(
  row: C,
  actor: ViewerVariables["actor"],
) {
  const { guestAuthorId: _, ...rest } = row;
  return { ...rest, mine: wroteIt(actor, row) };
}

/**
 * The people a comment may mention: members who can see its project (#133). Anyone else,
 * and any mention by a guest, who is not shown the project's people, is refused.
 */
async function mentionsFor(
  db: Database,
  organisationId: string,
  projectId: string,
  actor: ViewerVariables["actor"],
  ids: string[] | undefined,
): Promise<CommentMention[]> {
  if (!ids || ids.length === 0) return [];
  if (actor.kind === "guest")
    throw new CodedException(422, "mention_refused", "Guests cannot mention people");
  const people = await projectPeople(db, organisationId, projectId);
  const chosen = [...new Set(ids)].map((id) => people.find((p) => p.id === id));
  if (chosen.some((p) => !p))
    throw new CodedException(
      422,
      "mention_outside",
      "Only people in this project can be mentioned",
    );
  return chosen.flatMap((p) => (p ? [{ id: p.id, name: p.name }] : []));
}

async function commentOf(db: Database, organisationId: string, id: string) {
  const [row] = await selectComments(db, organisationId, eq(comments.id, id));
  if (!row) throw new NotFound("Comment");
  return row;
}

/**
 * A file's threads as its comments column shows them: its own and those carried to it from
 * earlier versions (pointing where they were mapped), with their replies, oldest first.
 * Hidden carries reach only those who triage; a guest sees what their review lets them.
 */
export async function threadsOn(
  db: Database,
  organisationId: string,
  actor: ViewerVariables["actor"],
  access: Awaited<ReturnType<typeof canOnFile>>,
  fileId: string,
) {
  const [file] = await db
    .select({ id: files.id, mediaInfo: files.mediaInfo })
    .from(files)
    .where(inOrg(files, organisationId, eq(files.id, fileId)));
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
  // A carried thread about one channel is about the same speaker here, where there is one (#74).
  const channelFiles = [
    ...new Set(roots.filter((r) => here.has(r.id) && r.channel !== null).map((r) => r.fileId)),
  ];
  const channelsOf = new Map(
    channelFiles.length === 0
      ? []
      : (
          await db
            .select({ id: files.id, mediaInfo: files.mediaInfo })
            .from(files)
            .where(inOrg(files, organisationId, inArray(files.id, channelFiles)))
        ).map((f) => [f.id, f.mediaInfo?.audio]),
  );
  // What each comment carries (#133): names and sizes; the bytes only by a download.
  const attached =
    rows.length === 0
      ? []
      : await db
          .select({
            id: commentAttachments.id,
            commentId: commentAttachments.commentId,
            name: commentAttachments.name,
            contentType: commentAttachments.contentType,
            byteSize: commentAttachments.byteSize,
          })
          .from(commentAttachments)
          .where(
            inOrg(
              commentAttachments,
              organisationId,
              inArray(
                commentAttachments.commentId,
                rows.map((r) => r.id),
              ),
            ),
          )
          .orderBy(asc(commentAttachments.createdAt), asc(commentAttachments.id));
  const attachmentsOf = (id: string): CommentAttachment[] =>
    attached.filter((a) => a.commentId === id).map(({ commentId: _, ...a }) => a);
  // Takes shared on each thread (#133), heard by everyone who sees it.
  const shared = await sharedTakesOf(
    db,
    organisationId,
    rows.filter((r) => !r.parentId).map((r) => r.id),
  );
  // Who is to act on a thread, and whether it is a task, is the team's business, not a guest
  // reviewer's.
  const shown =
    actor.kind === "guest"
      ? rows.map((r) => ({
          ...r,
          assigneeId: null,
          assigneeName: null,
          todo: false,
          todoDoneAt: null,
          todoDoneByName: null,
          importedByName: null,
        }))
      : rows;
  return shown.map((row) => {
    const attachments = attachmentsOf(row.id);
    if (row.parentId)
      return {
        ...publicComment(row, actor),
        attachments,
        takes: [],
        carry: null,
        history: null,
      };
    const takes = shared.get(row.id) ?? [];
    const carry = here.get(row.id);
    const history = {
      versionNumber: origins.get(row.fileId) ?? null,
      hops: hops
        .filter((h) => h.commentId === row.id)
        .map((h) => ({
          fileId: h.fileId,
          versionNumber: h.versionNumber,
          status: h.status,
          moved: h.anchorPlaced,
        })),
    };
    if (!carry) return { ...publicComment(row, actor), attachments, takes, carry: null, history };
    // On this version the thread points where it was mapped; where it began stays known.
    return {
      ...publicComment(row, actor),
      attachments,
      takes,
      anchor: carry.anchor,
      channel: carriedChannel(row.channel, channelsOf.get(row.fileId), file.mediaInfo?.audio),
      carry: {
        id: carry.id,
        status: carry.status,
        visible: carry.visible,
        from: { fileId: row.fileId, anchor: row.anchor as Anchor | null },
      },
      history,
    };
  });
}

/**
 * The threads triage may act on from this file, with where each is deferred to now: its own
 * top-level comments and those carried to it.
 */
async function triageable(
  db: Database,
  organisationId: string,
  fileId: string,
  ids: string[],
): Promise<Map<string, string | null>> {
  const carried = await db
    .select({ commentId: commentCarries.commentId })
    .from(commentCarries)
    .where(
      inOrg(
        commentCarries,
        organisationId,
        eq(commentCarries.fileId, fileId),
        inArray(commentCarries.commentId, ids),
      ),
    );
  const carriedIds = carried.map((k) => k.commentId);
  const rows = await db
    .select({ id: comments.id, deferredTo: comments.deferredTo })
    .from(comments)
    .where(
      inOrg(
        comments,
        organisationId,
        inArray(comments.id, ids),
        isNull(comments.parentId),
        carriedIds.length > 0
          ? or(eq(comments.fileId, fileId), inArray(comments.id, carriedIds))
          : eq(comments.fileId, fileId),
      ),
    );
  return new Map(rows.map((r) => [r.id, r.deferredTo]));
}

/** A download's name for Content-Disposition: plain ASCII, and the real name in UTF-8. */
export function attachment(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * `/api/files/:id/comments`: a file's comment threads, and starting or replying to one.
 * Guest reviewers use these too, on the files of their reviews.
 */
export const fileCommentRoutes = (
  db: Database,
  audit: Audit,
  trustProxy: boolean,
  mail: { mailer: Mailer; publicUrl: string },
) =>
  new Hono<{ Variables: ViewerVariables }>()
    // Whom a member may mention here (#133): the project's people, by name. Guests mention nobody.
    .get("/:id/mentionable", idParam, async (c) => {
      const actor = c.var.actor;
      if (actor.kind === "guest") return c.json({ people: [] });
      const fileId = c.req.valid("param").id;
      await canOnFile(db, actor, "comment", fileId);
      const file = await fileOf(db, c.var.organisationId, fileId);
      const people = await projectPeople(db, c.var.organisationId, file.projectId);
      return c.json({
        people: people
          .map((p) => ({ id: p.id, name: p.name }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      });
    })
    .get("/:id/comments", idParam, async (c) => {
      const fileId = c.req.valid("param").id;
      const access = await canOnFile(db, c.var.actor, "read_comments", fileId);
      return c.json({
        comments: await threadsOn(db, c.var.organisationId, c.var.actor, access, fileId),
      });
    })
    /**
     * Triage on one thread or a selection (#36, #132): a category, deferral to a stage or
     * back, who is to act on it, resolved or not. Every thread must be this file's own or
     * carried to it; a deferring category sets its stage unless the request says otherwise.
     */
    .post("/:id/comments/triage", idParam, zValidator("json", triageInput), async (c) => {
      const organisationId = c.var.organisationId;
      const fileId = c.req.valid("param").id;
      const access = await canOnFile(db, c.var.actor, "triage", fileId);
      const by = c.var.actor.kind === "member" ? c.var.actor.userId : null;
      const input = c.req.valid("json");
      const ids = [...new Set(input.commentIds)];
      const here = await triageable(db, organisationId, fileId, ids);
      if (here.size !== ids.length) {
        throw new HTTPException(422, { message: "Those comments are not threads on this file" });
      }
      const [category] = input.categoryId
        ? await db
            .select({ handling: commentCategories.handling, stage: commentCategories.stage })
            .from(commentCategories)
            .where(
              inOrg(
                commentCategories,
                organisationId,
                eq(commentCategories.id, input.categoryId),
                eq(commentCategories.projectId, access.projectId),
              ),
            )
        : [];
      if (input.categoryId && !category) {
        throw new HTTPException(422, { message: "Categories must come from this project" });
      }
      if (input.assigneeId) {
        const people = await projectPeople(db, organisationId, access.projectId);
        if (!people.some((p) => p.id === input.assigneeId)) {
          throw new HTTPException(422, { message: "Assign it to someone in this project" });
        }
      }
      await db.transaction(async (tx) => {
        // Not while a new version is deciding which threads to carry. Each thread's deferral is
        // read again under the locks, so a triage that waited here keeps what the first one set.
        await lockTrackOfFile(tx, organisationId, fileId);
        const locked = await tx
          .select({ id: comments.id, deferredTo: comments.deferredTo })
          .from(comments)
          .where(inOrg(comments, organisationId, inArray(comments.id, ids)))
          .for("update");
        const deferral = new Map(locked.map((r) => [r.id, r.deferredTo]));
        const now = new Date();
        for (const id of ids) {
          const current = deferral.get(id) ?? null;
          await tx
            .update(comments)
            .set({
              ...(input.categoryId !== undefined && { categoryId: input.categoryId }),
              deferredTo: deferralAfter(current, input, category ?? null),
              ...(input.assigneeId !== undefined && { assigneeId: input.assigneeId }),
              ...(input.resolved !== undefined &&
                (input.resolved
                  ? { resolvedAt: now, resolvedById: by }
                  : { resolvedAt: null, resolvedById: null })),
              updatedAt: now,
            })
            .where(inOrg(comments, organisationId, eq(comments.id, id)));
        }
      });
      return c.json({
        comments: await threadsOn(db, organisationId, c.var.actor, access, fileId),
      });
    })
    /**
     * Send someone the threads on this file assigned to them and still open, as one
     * notification and mail: the list an engineer works through after triage (#132).
     */
    .post("/:id/comments/send-list", idParam, zValidator("json", sendListInput), async (c) => {
      const organisationId = c.var.organisationId;
      const fileId = c.req.valid("param").id;
      const access = await canOnFile(db, c.var.actor, "triage", fileId);
      if (c.var.actor.kind !== "member") throw new HTTPException(403);
      const { userId } = c.req.valid("json");
      // Notifications never go to whoever caused them, so a list sent to yourself would vanish.
      if (userId === c.var.actor.userId) {
        throw new HTTPException(422, {
          message: "These are yours already; there is no one to send them to",
        });
      }
      const people = await projectPeople(db, organisationId, access.projectId);
      if (!people.some((p) => p.id === userId)) {
        throw new HTTPException(422, { message: "They are not in this project" });
      }
      const threads = (await threadsOn(db, organisationId, c.var.actor, access, fileId)).filter(
        (t) => !t.parentId && !t.resolvedAt && t.assigneeId === userId,
      );
      if (threads.length === 0) {
        throw new HTTPException(422, { message: "Nothing on this file is assigned to them" });
      }
      const [file] = await db
        .select({ name: files.name })
        .from(files)
        .where(inOrg(files, organisationId, eq(files.id, fileId)));
      const count = threads.length;
      await notifyNow(
        { db, ...mail },
        {
          organisationId,
          kind: "assigned",
          recipients: [userId],
          actor: { userId: c.var.actor.userId },
          projectId: access.projectId,
          fileId,
          text: `sent you ${count} ${count === 1 ? "comment" : "comments"} to act on, on ${file?.name ?? "a file"}`,
          detail: threads.map((t) => `- ${t.body}`).join("\n"),
          link: `/files/${fileId}`,
        },
      );
      return c.json({ sent: count });
    })
    /**
     * The threads as a marker list for another application (#99), for those who triage:
     * the people who carry feedback into an edit. Each export is in the access log.
     */
    .get("/:id/comments/export", idParam, zValidator("query", commentExportQuery), async (c) => {
      const organisationId = c.var.organisationId;
      const fileId = c.req.valid("param").id;
      const actor = c.var.actor;
      const access = await canOnFile(db, actor, "triage", fileId);
      const [file] = await db
        .select({
          name: files.name,
          kind: files.kind,
          mediaInfo: files.mediaInfo,
          projectId: files.projectId,
        })
        .from(files)
        .where(inOrg(files, organisationId, eq(files.id, fileId)));
      if (!file) throw new NotFound("File");
      const options = c.req.valid("query");
      const out = exportComments(
        threadsForExport(
          await threadsOn(db, organisationId, actor, access, fileId),
          (file.mediaInfo?.audio?.channels ?? 0) >= 2 && file.mediaInfo?.audio
            ? speakersOf(file.mediaInfo.audio)
            : [],
        ),
        {
          name: file.name,
          duration: file.mediaInfo?.duration ?? null,
          sampleRate: file.mediaInfo?.audio?.sampleRate ?? null,
          fps: file.mediaInfo?.video?.fps ?? null,
          video: file.kind === "video",
        },
        options,
      );
      await audit.record(
        organisationId,
        await audit.actor(
          actor.kind === "guest"
            ? { kind: "guest", guestId: actor.guestId }
            : { userId: actor.userId },
        ),
        {
          action: "comment.export",
          projectId: file.projectId,
          fileId,
          details: { target: options.target, threads: out.written },
        },
        requestInfo(c, trustProxy),
      );
      return c.body(out.bytes as Uint8Array<ArrayBuffer>, 200, {
        "content-type": out.contentType,
        "content-disposition": attachment(out.filename),
        "cache-control": "no-store",
      });
    })
    /**
     * The same threads as a sheet to print (#134): a PDF made here, stamped with the
     * workspace, the project, who asked and when. Exporting by another name, so it is
     * triage's, and in the access log as an export.
     */
    .get("/:id/comments/sheet", idParam, zValidator("query", commentSheetQuery), async (c) => {
      const organisationId = c.var.organisationId;
      const fileId = c.req.valid("param").id;
      const actor = c.var.actor;
      const access = await canOnFile(db, actor, "triage", fileId);
      const [file] = await db
        .select({
          name: files.name,
          kind: files.kind,
          mediaInfo: files.mediaInfo,
          projectId: files.projectId,
          project: projects.name,
          workspace: organisations.name,
        })
        .from(files)
        .innerJoin(
          projects,
          and(eq(projects.id, files.projectId), eq(projects.organisationId, organisationId)),
        )
        .innerJoin(organisations, eq(organisations.id, files.organisationId))
        .where(inOrg(files, organisationId, eq(files.id, fileId)));
      if (!file) throw new NotFound("File");
      const [variation] = await db
        .select({ number: versions.number, name: variations.name })
        .from(variations)
        .innerJoin(
          versions,
          and(eq(versions.id, variations.versionId), eq(versions.organisationId, organisationId)),
        )
        .where(inOrg(variations, organisationId, eq(variations.fileId, fileId)));
      const options = c.req.valid("query");
      const threads = threadsForExport(
        await threadsOn(db, organisationId, actor, access, fileId),
        (file.mediaInfo?.audio?.channels ?? 0) >= 2 && file.mediaInfo?.audio
          ? speakersOf(file.mediaInfo.audio)
          : [],
      ).map((t) => (options.replies ? t : { ...t, replies: [] }));
      const out = commentSheet({
        file: {
          name: file.name,
          version: variation ? `V${variation.number} · ${variation.name}` : null,
        },
        workspace: file.workspace,
        project: file.project,
        requestedBy: await requesterOf(db, actor, file.projectId),
        generatedAt: new Date(),
        scope: options.threads,
        threads,
        fps: file.kind === "video" ? (file.mediaInfo?.video?.fps ?? null) : null,
      });
      await audit.record(
        organisationId,
        await audit.actor(
          actor.kind === "guest"
            ? { kind: "guest", guestId: actor.guestId }
            : { userId: actor.userId },
        ),
        {
          action: "comment.export",
          projectId: file.projectId,
          fileId,
          details: {
            target: "sheet",
            threads: threads.filter((t) => options.threads === "all" || !t.resolved).length,
          },
        },
        requestInfo(c, trustProxy),
      );
      return c.body(new Uint8Array(out.body), 200, {
        "content-type": "application/pdf",
        "content-disposition": attachment(out.filename),
        "cache-control": "no-store",
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
          name: files.name,
          kind: files.kind,
          mediaInfo: files.mediaInfo,
          pageCount: files.pageCount,
          projectId: files.projectId,
          profile: projects.profile,
          references: projects.commentReferences,
        })
        .from(files)
        .innerJoin(
          projects,
          and(eq(projects.id, files.projectId), eq(projects.organisationId, organisationId)),
        )
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
          pages: file.pageCount,
          profile: file.profile,
          references: await referencesOfFile(db, organisationId, file.id, {
            profile: file.profile,
            commentReferences: file.references,
          }),
        });
        if (problem) throw new HTTPException(422, { message: problem });
      }
      // A channel only of a recording of two or more that has it (#74).
      const channels = file.mediaInfo?.audio?.channels ?? 0;
      if (input.channel != null && (channels < 2 || input.channel >= channels)) {
        throw new HTTPException(422, { message: "That file has no such channel" });
      }
      const mentions = await mentionsFor(db, organisationId, file.projectId, actor, input.mentions);
      // A category from the start is triage (#43): only for those who triage, from this project.
      let category: { id: string; handling: CategoryHandling; stage: string | null } | null = null;
      if (input.categoryId) {
        await canOnFile(db, actor, "triage", file.id);
        [category = null] = await db
          .select({
            id: commentCategories.id,
            handling: commentCategories.handling,
            stage: commentCategories.stage,
          })
          .from(commentCategories)
          .where(
            inOrg(
              commentCategories,
              organisationId,
              eq(commentCategories.id, input.categoryId),
              eq(commentCategories.projectId, file.projectId),
            ),
          );
        if (!category) {
          throw new HTTPException(422, { message: "Categories must come from this project" });
        }
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
            mentions,
            channel: input.channel ?? null,
            ...(category && {
              categoryId: category.id,
              deferredTo: deferralAfter(null, { categoryId: category.id }, category),
            }),
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
      await tellAboutComment(
        { db, ...mail },
        {
          organisationId,
          projectId: file.projectId,
          fileId: threadFileId,
          fileName: file.name,
          commentId: created?.id ?? "",
          parentId: input.parentId ?? null,
          body: input.body,
          mentions,
          actor: actor.kind === "guest" ? { guestId: actor.guestId } : { userId: actor.userId },
        },
      ).catch((error: unknown) =>
        console.warn(`Could not tell people about a comment: ${String(error)}`),
      );
      return c.json(
        {
          comment: publicComment(
            await commentOf(db, organisationId, created?.id ?? ""),
            c.var.actor,
          ),
        },
        201,
      );
    })
    /**
     * A marker list from another application, as comments (#134): the markers the browser
     * read from it and chose, each checked as a comment's anchor would be, written together.
     * Triage's to do, as it may say whose markers they were and give them categories; each
     * comment keeps the list's name and who imported it, and the import is in the access log.
     * Nobody is notified of each: a list can bring hundreds.
     */
    .post("/:id/comments/import", idParam, zValidator("json", importMarkersInput), async (c) => {
      const organisationId = c.var.organisationId;
      const input = c.req.valid("json");
      const actor = c.var.actor;
      const fileId = c.req.valid("param").id;
      await canOnFile(db, actor, "comment", fileId);
      await canOnFile(db, actor, "triage", fileId);
      if (actor.kind === "guest") throw new HTTPException(403);
      const [file] = await db
        .select({
          id: files.id,
          kind: files.kind,
          mediaInfo: files.mediaInfo,
          pageCount: files.pageCount,
          projectId: files.projectId,
          profile: projects.profile,
          references: projects.commentReferences,
        })
        .from(files)
        .innerJoin(
          projects,
          and(eq(projects.id, files.projectId), eq(projects.organisationId, organisationId)),
        )
        .where(inOrg(files, organisationId, eq(files.id, fileId)));
      if (!file) throw new NotFound("File");

      // Whose markers they were: someone in the project, as a mention would be.
      const authorId = input.authorId ?? actor.userId;
      if (authorId !== actor.userId) {
        const people = await projectPeople(db, organisationId, file.projectId);
        if (!people.some((p) => p.id === authorId))
          throw new CodedException(
            422,
            "author_outside",
            "Markers can be imported only as someone in this project's",
          );
      }
      const categoryIds = [
        ...new Set(input.markers.flatMap((m) => (m.categoryId ? [m.categoryId] : []))),
      ];
      const categories =
        categoryIds.length === 0
          ? []
          : await db
              .select({
                id: commentCategories.id,
                handling: commentCategories.handling,
                stage: commentCategories.stage,
              })
              .from(commentCategories)
              .where(
                inOrg(
                  commentCategories,
                  organisationId,
                  inArray(commentCategories.id, categoryIds),
                  eq(commentCategories.projectId, file.projectId),
                ),
              );
      if (categories.length !== categoryIds.length)
        throw new HTTPException(422, { message: "Categories must come from this project" });

      const context = {
        kind: file.kind,
        duration: file.mediaInfo?.duration,
        pages: file.pageCount,
        profile: file.profile,
        references: await referencesOfFile(db, organisationId, file.id, {
          profile: file.profile,
          commentReferences: file.references,
        }),
      };
      const rows = input.markers.map((marker, i) => {
        const anchor =
          marker.start === null
            ? null
            : ({ kind: "time", start: marker.start, end: marker.end ?? marker.start } as const);
        const problem = anchor ? anchorProblem(anchor, context) : null;
        if (problem) throw new HTTPException(422, { message: `Marker ${i + 1}: ${problem}` });
        const category = categories.find((k) => k.id === marker.categoryId) ?? null;
        return {
          organisationId,
          fileId: file.id,
          authorId,
          anchor,
          body: marker.body,
          importedFrom: input.listName,
          importedById: actor.userId,
          ...(category && {
            categoryId: category.id,
            deferredTo: deferralAfter(null, { categoryId: category.id }, category),
          }),
        };
      });
      await db.transaction(async (tx) => {
        await tx.insert(comments).values(rows);
        await audit.record(
          organisationId,
          await audit.actor({ userId: actor.userId }),
          {
            action: "comment.import",
            projectId: file.projectId,
            fileId: file.id,
            details: { list: input.listName, comments: rows.length },
          },
          requestInfo(c, trustProxy),
          tx,
        );
      });
      return c.json({ imported: rows.length }, 201);
    });

/**
 * Tell the people a new comment concerns: those it mentions, and, for a reply, whoever
 * started the thread and the others who replied in it. A mention wins over a reply.
 */
async function tellAboutComment(
  deps: { db: Database; mailer: Mailer; publicUrl: string },
  c: {
    organisationId: string;
    projectId: string;
    fileId: string;
    fileName: string;
    commentId: string;
    parentId: string | null;
    body: string;
    /** Chosen in the picker, over those read from the rest of the text. */
    mentions: CommentMention[];
    /** Only these, for an edit: the mentions it added. */
    onlyMentions?: boolean;
    actor: NotificationActor;
  },
) {
  const common = {
    organisationId: c.organisationId,
    actor: c.actor,
    projectId: c.projectId,
    fileId: c.fileId,
    commentId: c.commentId,
    detail: c.body,
    link: `/files/${c.fileId}`,
  };
  const chosen = c.mentions.map((m) => m.id);
  // Names the picker chose are settled; only the rest of the text is read for names typed by
  // hand, so someone who shares a chosen person's name is not told as well.
  let typed = c.body;
  for (const r of mentionRanges(c.body, c.mentions))
    typed = `${typed.slice(0, r.start)}${" ".repeat(r.end - r.start)}${typed.slice(r.end)}`;
  const mentioned = c.onlyMentions
    ? chosen
    : [
        ...new Set([
          ...chosen,
          ...mentionedIn(typed, await projectPeople(deps.db, c.organisationId, c.projectId)).map(
            (p) => p.id,
          ),
        ]),
      ];
  if (mentioned.length > 0) {
    await notifyNow(deps, {
      ...common,
      kind: "mention",
      recipients: mentioned,
      text: `mentioned you on ${c.fileName}`,
    });
  }
  if (!c.parentId || c.onlyMentions) return;
  const thread = await deps.db
    .select({ id: comments.id, authorId: comments.authorId, parentId: comments.parentId })
    .from(comments)
    .where(
      inOrg(
        comments,
        c.organisationId,
        or(eq(comments.id, c.parentId), eq(comments.parentId, c.parentId)),
      ),
    );
  const starter = thread.find((t) => t.id === c.parentId)?.authorId ?? null;
  const others = thread.flatMap((t) =>
    t.parentId && t.authorId && t.authorId !== starter ? [t.authorId] : [],
  );
  const skip = new Set(mentioned);
  if (starter && !skip.has(starter)) {
    await notifyNow(deps, {
      ...common,
      kind: "reply",
      recipients: [starter],
      text: `replied to your comment on ${c.fileName}`,
    });
  }
  const rest = [...new Set(others)].filter((id) => !skip.has(id) && id !== starter);
  if (rest.length > 0) {
    await notifyNow(deps, {
      ...common,
      kind: "reply",
      recipients: rest,
      text: `replied in a thread on ${c.fileName}`,
    });
  }
}

/**
 * `/api/comments/:id`: editing your own words, and resolving or reopening a thread (triage).
 * A comment on a file whose project the caller cannot see does not exist for them.
 */
export const commentRoutes = (db: Database, mail: { mailer: Mailer; publicUrl: string }) =>
  new Hono<{ Variables: TenantVariables }>()
    .patch("/:id", idParam, zValidator("json", editCommentInput), async (c) => {
      const organisationId = c.var.organisationId;
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const existing = await commentOf(db, organisationId, id);
      // Still able to comment here: editing is writing.
      const actor = actorOf(c.var);
      await canOnFile(db, actor, "comment", existing.fileId);
      if (existing.authorId !== c.var.userId) {
        throw new HTTPException(403, { message: "Only the author can edit a comment" });
      }
      const file = await fileOf(db, organisationId, existing.fileId);
      // The mentions it keeps, or those chosen again; whoever is new to it is told.
      const mentions =
        input.mentions === undefined
          ? existing.mentions
          : await mentionsFor(db, organisationId, file.projectId, actor, input.mentions);
      await db
        .update(comments)
        .set({ body: input.body, mentions, editedAt: new Date(), updatedAt: new Date() })
        .where(inOrg(comments, organisationId, eq(comments.id, id)));
      const added = mentions.filter((m) => !existing.mentions.some((e) => e.id === m.id));
      if (added.length > 0)
        await tellAboutComment(
          { db, ...mail },
          {
            organisationId,
            projectId: file.projectId,
            fileId: existing.fileId,
            fileName: file.name,
            commentId: id,
            parentId: existing.parentId,
            body: input.body,
            mentions: added,
            onlyMentions: true,
            actor: { userId: c.var.userId },
          },
        ).catch((error: unknown) =>
          console.warn(`Could not tell people about a mention: ${String(error)}`),
        );
      return c.json({
        comment: publicComment(await commentOf(db, organisationId, id), actorOf(c.var)),
      });
    })
    // A thread as a task (#133): triage makes it one; triage, or whoever it is for, marks it done.
    .post("/:id/todo", idParam, zValidator("json", commentTodoInput), async (c) => {
      const organisationId = c.var.organisationId;
      const { id } = c.req.valid("param");
      const { todo, done } = c.req.valid("json");
      const thread = await commentOf(db, organisationId, id);
      if (thread.parentId) throw new NotFound("Thread");
      const actor = actorOf(c.var);
      const changesTask = todo !== thread.todo;
      const mayTriage = await canOnFile(db, actor, "triage", thread.fileId).then(
        () => true,
        (error: unknown) => {
          if (error instanceof HTTPException && error.status === 403) return false;
          throw error;
        },
      );
      // Without triage, whoever it is for may mark it done or not done, and nothing more; and
      // only where they may still write, so never in an archived project.
      if (!mayTriage) {
        if (changesTask || !todo || thread.assigneeId !== c.var.userId)
          throw new HTTPException(403, { message: "Only those who triage can change this task" });
        await canOnFile(db, actor, "comment", thread.fileId);
      }
      const [changed] = await db
        .update(comments)
        .set({
          todo,
          // Done once: a second "done" keeps who did it first, and when.
          todoDoneAt: todo && done ? sql`coalesce(${comments.todoDoneAt}, now())` : null,
          todoDoneById:
            todo && done ? sql`coalesce(${comments.todoDoneById}, ${c.var.userId})` : null,
          updatedAt: new Date(),
        })
        .where(
          inOrg(
            comments,
            organisationId,
            eq(comments.id, id),
            // Checked as it is written: reassigned meanwhile, it is no longer theirs to mark.
            mayTriage ? undefined : eq(comments.assigneeId, c.var.userId),
          ),
        )
        .returning({ id: comments.id });
      if (!changed)
        throw new HTTPException(409, { message: "This task has been given to someone else" });
      return c.json({
        comment: publicComment(await commentOf(db, organisationId, id), actorOf(c.var)),
      });
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
      return c.json({
        comment: publicComment(await commentOf(db, organisationId, id), actorOf(c.var)),
      });
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
          .select({
            kind: files.kind,
            mediaInfo: files.mediaInfo,
            pageCount: files.pageCount,
            profile: projects.profile,
            references: projects.commentReferences,
          })
          .from(files)
          .innerJoin(
            projects,
            and(eq(projects.id, files.projectId), eq(projects.organisationId, organisationId)),
          )
          .where(inOrg(files, organisationId, eq(files.id, carry.fileId)));
        const problem =
          file &&
          anchorProblem(input.anchor, {
            kind: file.kind,
            duration: file.mediaInfo?.duration,
            pages: file.pageCount,
            profile: file.profile,
            references: await referencesOfFile(db, organisationId, carry.fileId, {
              profile: file.profile,
              commentReferences: file.references,
            }),
          });
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
