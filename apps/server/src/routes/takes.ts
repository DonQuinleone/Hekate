import { type Database, inOrg, schema } from "@hekate/db";
import {
  addTakesInput,
  canMoveTake,
  fieldChanges,
  marksAtBar,
  type ScoreMarkKind,
  type SharedTake,
  shareTakesInput,
  type TakeDetail,
  type TakeHistoryEntry,
  type TakeHistoryField,
  type TakeLifecycle,
  type TakeRow,
  takeChangeInput,
  takeLifecycleNames,
  takeProblem,
  takesCovering,
  takesForBar,
} from "@hekate/shared";
import { and, asc, eq, inArray, isNull, max } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { actorOf, can, canOnFile, lockLiveProject, lockTakeNumbers } from "../access.ts";
import { type Audit, requestInfo } from "../audit.ts";
import { NotFound } from "../errors.ts";
import { zValidator } from "../openapi/validator.ts";
import type { TenantVariables } from "../tenancy.ts";

const {
  comments,
  commentTakes,
  files,
  sessions,
  sessionTracks,
  takeChanges,
  takes,
  tracks,
  users,
  variations,
} = schema;

const idParam = zValidator("param", z.object({ id: z.uuid() }));

async function trackOf(db: Database, organisationId: string, trackId: string) {
  const [track] = await db
    .select({ id: tracks.id, projectId: tracks.projectId })
    .from(tracks)
    .where(inOrg(tracks, organisationId, eq(tracks.id, trackId)));
  if (!track) throw new NotFound("Track");
  return track;
}

/** A track's takes, in order, each with its scratch mix. */
async function takesOf(db: Database, organisationId: string, trackId: string): Promise<TakeRow[]> {
  const rows = await db
    .select({ take: takes })
    .from(takes)
    .where(inOrg(takes, organisationId, eq(takes.trackId, trackId)))
    .orderBy(asc(takes.number));
  return takeRowsFor(db, organisationId, rows);
}

/** Takes as their lists show them, each with its scratch mix, in the order given. */
export async function takeRowsFor(
  db: Database,
  organisationId: string,
  rows: { take: typeof takes.$inferSelect }[],
): Promise<TakeRow[]> {
  const mixes =
    rows.length === 0
      ? []
      : await db
          .select({
            takeId: files.takeId,
            id: files.id,
            name: files.name,
            mediaInfo: files.mediaInfo,
            streamStatus: files.streamStatus,
          })
          .from(files)
          .where(
            inOrg(
              files,
              organisationId,
              inArray(
                files.takeId,
                rows.map((r) => r.take.id),
              ),
            ),
          )
          .orderBy(asc(files.createdAt));
  return rows.map(({ take: t }) => {
    const mix = mixes.find((m) => m.takeId === t.id);
    return {
      id: t.id,
      number: t.number,
      label: t.label,
      notes: t.notes,
      rating: t.rating,
      starred: t.starred,
      page: t.page,
      sessionId: t.sessionId,
      lifecycle: t.lifecycle as TakeLifecycle,
      falseStarts: t.falseStarts,
      timecodeIn: t.timecodeIn,
      timecodeOut: t.timecodeOut,
      wallIn: t.wallIn?.toISOString() ?? null,
      wallOut: t.wallOut?.toISOString() ?? null,
      pageTo: t.pageTo,
      barFrom: t.barFrom,
      barTo: t.barTo,
      inPoint: t.inPoint,
      outPoint: t.outPoint,
      file: mix
        ? {
            id: mix.id,
            name: mix.name,
            duration: mix.mediaInfo?.duration ?? null,
            streamStatus: mix.streamStatus,
          }
        : null,
      createdAt: t.createdAt.toISOString(),
    };
  });
}

/**
 * A track's takes (#21, #46), under `/api/tracks/:id/takes`: listing them, or those covering a
 * bar ("any other options for bar 72?"), and making files already in the project into takes.
 * Seeing them needs `view_takes`; changing them, `edit_takes`.
 */
export const trackTakeRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
    .get(
      "/:id/takes",
      idParam,
      zValidator(
        "query",
        z.object({ bar: z.coerce.number().int().min(0).max(100_000).optional() }),
      ),
      async (c) => {
        const organisationId = c.var.organisationId;
        const track = await trackOf(db, organisationId, c.req.valid("param").id);
        const access = await can(db, actorOf(c.var), "view_takes", track.projectId);
        const all = await takesOf(db, organisationId, track.id);
        const { bar } = c.req.valid("query");
        if (bar === undefined) return c.json({ takes: all });
        // The score marks (#52) add the takes that fixed the bar, for those who may see them;
        // without them, the takes whose bars cover it.
        if (!access.permissions.has("view_production")) {
          return c.json({ takes: takesCovering(all, bar) });
        }
        const rows = await db
          .select()
          .from(schema.scoreMarks)
          .where(inOrg(schema.scoreMarks, organisationId, eq(schema.scoreMarks.trackId, track.id)));
        const marks = rows.map((m) => ({ ...m, kind: m.kind as ScoreMarkKind }));
        return c.json({ takes: takesForBar(all, bar, marksAtBar(marks, bar)) });
      },
    )
    .post("/:id/takes", idParam, zValidator("json", addTakesInput), async (c) => {
      const organisationId = c.var.organisationId;
      const track = await trackOf(db, organisationId, c.req.valid("param").id);
      await can(db, actorOf(c.var), "edit_takes", track.projectId);
      const fileIds = [...new Set(c.req.valid("json").fileIds)];
      await db.transaction(async (tx) => {
        await lockLiveProject(tx, organisationId, track.projectId);
        await lockTakeNumbers(tx, track.projectId);
        // Under the track's lock, so two at once number their takes one after the other.
        await tx
          .select({ id: tracks.id })
          .from(tracks)
          .where(inOrg(tracks, organisationId, eq(tracks.id, track.id)))
          .for("update");
        const found = await tx
          .select({ id: files.id, kind: files.kind, takeId: files.takeId })
          .from(files)
          .where(
            inOrg(
              files,
              organisationId,
              eq(files.projectId, track.projectId),
              inArray(files.id, fileIds),
            ),
          )
          .for("update");
        if (found.length !== fileIds.length) throw new NotFound("File");
        if (found.some((f) => f.kind !== "audio" && f.kind !== "video"))
          throw new HTTPException(422, { message: "A take is a recording: audio or video" });
        if (found.some((f) => f.takeId))
          throw new HTTPException(409, { message: "That file is already a take" });
        const used = await tx
          .select({ id: variations.fileId })
          .from(variations)
          .where(inOrg(variations, organisationId, inArray(variations.fileId, fileIds)));
        if (used.length > 0)
          throw new HTTPException(409, { message: "A version's file cannot also be a take" });
        const [last] = await tx
          .select({ n: max(takes.number) })
          .from(takes)
          .where(inOrg(takes, organisationId, eq(takes.trackId, track.id)));
        let number = last?.n ?? 0;
        for (const fileId of fileIds) {
          number += 1;
          const [take] = await tx
            .insert(takes)
            .values({ organisationId, trackId: track.id, number })
            .returning({ id: takes.id });
          await tx
            .update(files)
            .set({ takeId: take?.id ?? null, isTakeMix: true, updatedAt: new Date() })
            .where(inOrg(files, organisationId, eq(files.id, fileId)));
        }
      });
      return c.json({ takes: await takesOf(db, organisationId, track.id) }, 201);
    });

/** `/api/takes/:id`: one take for its page, changing it, or no longer counting its file as one. */
export const takeRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
    // The take page: the take with its track, session and the session's other takes of the
    // track. Seen by those whose role shows takes, as the track's takes are.
    .get("/:id", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const { id } = c.req.valid("param");
      const [row] = await db
        .select({
          take: takes,
          track: {
            id: tracks.id,
            name: tracks.name,
            projectId: tracks.projectId,
            scoreFileId: tracks.scoreFileId,
          },
        })
        .from(takes)
        .innerJoin(
          tracks,
          and(eq(tracks.id, takes.trackId), eq(tracks.organisationId, organisationId)),
        )
        .where(inOrg(takes, organisationId, eq(takes.id, id)));
      if (!row) throw new NotFound("Take");
      await can(db, actorOf(c.var), "view_takes", row.track.projectId);
      const sessionId = row.take.sessionId;
      const [session] = sessionId
        ? await db
            .select({ id: sessions.id, name: sessions.name })
            .from(sessions)
            .where(inOrg(sessions, organisationId, eq(sessions.id, sessionId)))
        : [];
      const siblings = await db
        .select({ id: takes.id, number: takes.number, starred: takes.starred })
        .from(takes)
        .where(
          inOrg(
            takes,
            organisationId,
            eq(takes.trackId, row.track.id),
            sessionId ? eq(takes.sessionId, sessionId) : isNull(takes.sessionId),
          ),
        )
        .orderBy(asc(takes.number));
      const [take] = await takeRowsFor(db, organisationId, [{ take: row.take }]);
      if (!take) throw new NotFound("Take");
      const detail: TakeDetail = { ...take, track: row.track, session: session ?? null, siblings };
      return c.json({ take: detail });
    })
    .patch("/:id", idParam, zValidator("json", takeChangeInput), async (c) => {
      const organisationId = c.var.organisationId;
      const { id } = c.req.valid("param");
      const change = c.req.valid("json");
      const [take] = await db
        .select({ take: takes, projectId: tracks.projectId })
        .from(takes)
        .innerJoin(
          tracks,
          and(eq(tracks.id, takes.trackId), eq(tracks.organisationId, organisationId)),
        )
        .where(inOrg(takes, organisationId, eq(takes.id, id)));
      if (!take) throw new NotFound("Take");
      await can(db, actorOf(c.var), "edit_takes", take.projectId);
      const from = take.take.lifecycle as TakeLifecycle;
      if (change.lifecycle && !canMoveTake(from, change.lifecycle))
        throw new HTTPException(409, {
          message: `A take ${takeLifecycleNames[from].toLowerCase()} cannot be ${takeLifecycleNames[change.lifecycle].toLowerCase()}`,
        });
      const { wallIn, wallOut, base, at, ...rest } = change;
      // Rolling and stopping are timed by the server's clock unless the log says otherwise.
      const now = new Date();
      // A change written offline keeps the moment it was written; never one still to come.
      const writtenAt = at ? new Date(Math.min(Date.parse(at), now.getTime())) : now;
      const moved = change.lifecycle !== undefined && change.lifecycle !== from;
      const times = {
        ...(wallIn !== undefined
          ? { wallIn: wallIn === null ? null : new Date(wallIn) }
          : moved && change.lifecycle === "recording" && !take.take.wallIn
            ? { wallIn: now }
            : {}),
        ...(wallOut !== undefined
          ? { wallOut: wallOut === null ? null : new Date(wallOut) }
          : moved &&
              (change.lifecycle === "recorded" || change.lifecycle === "aborted") &&
              !take.take.wallOut
            ? { wallOut: now }
            : {}),
      };
      const next = { ...take.take, ...rest };
      const problem = takeProblem({
        page: next.page ?? null,
        pageTo: next.pageTo ?? null,
        barFrom: next.barFrom ?? null,
        barTo: next.barTo ?? null,
        inPoint: next.inPoint ?? null,
        outPoint: next.outPoint ?? null,
      });
      if (problem) throw new HTTPException(422, { message: problem });
      await db.transaction(async (tx) => {
        // An archived project is read-only, even if it was archived a moment ago.
        await lockLiveProject(tx, organisationId, take.projectId);
        // The take as it stands, held until this change is written.
        const [current] = await tx
          .select()
          .from(takes)
          .where(inOrg(takes, organisationId, eq(takes.id, id)))
          .for("update");
        if (!current) throw new NotFound("Take");
        if (change.sessionId) {
          // A session of the same project; it recorded the take's track, if it did not say so.
          const [session] = await tx
            .select({ id: sessions.id })
            .from(sessions)
            .where(
              inOrg(
                sessions,
                organisationId,
                eq(sessions.id, change.sessionId),
                eq(sessions.projectId, take.projectId),
              ),
            );
          if (!session) throw new NotFound("Session");
          await tx
            .insert(sessionTracks)
            .values({ organisationId, sessionId: session.id, trackId: take.take.trackId })
            .onConflictDoNothing();
        }
        // The move is checked against the state it was read in: someone else's stop between the
        // two is not overwritten.
        const [changed] = await tx
          .update(takes)
          .set({ ...rest, ...times, updatedAt: now })
          .where(
            inOrg(
              takes,
              organisationId,
              eq(takes.id, id),
              ...(moved ? [eq(takes.lifecycle, from)] : []),
            ),
          )
          .returning({ id: takes.id });
        if (!changed)
          throw new HTTPException(409, { message: "The take changed meanwhile; look again" });
        // Each field it changed, with the value it replaced, for the take's history: read from
        // the take as locked above, so two changes at once each record what they replaced.
        const history = fieldChanges(current, { ...rest, ...times }, base);
        if (history.length > 0)
          await tx.insert(takeChanges).values(
            history.map((h) => ({
              organisationId,
              takeId: id,
              field: h.field,
              before: h.before,
              after: h.after,
              changedById: c.var.userId,
              writtenAt,
              overwrote: h.overwrote,
            })),
          );
      });
      const [row] = (await takesOf(db, organisationId, take.take.trackId)).filter(
        (t) => t.id === id,
      );
      return c.json({ take: row });
    })
    // What changed on the take, a field at a time, oldest first (#51).
    .get("/:id/history", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const { id } = c.req.valid("param");
      const [take] = await db
        .select({ id: takes.id, projectId: tracks.projectId })
        .from(takes)
        .innerJoin(
          tracks,
          and(eq(tracks.id, takes.trackId), eq(tracks.organisationId, organisationId)),
        )
        .where(inOrg(takes, organisationId, eq(takes.id, id)));
      if (!take) throw new NotFound("Take");
      // As the takes themselves: its notes, ratings and who wrote them are the takes' to show.
      await can(db, actorOf(c.var), "view_takes", take.projectId);
      const rows = await db
        .select({ change: takeChanges, name: users.name })
        .from(takeChanges)
        .leftJoin(users, eq(users.id, takeChanges.changedById))
        .where(inOrg(takeChanges, organisationId, eq(takeChanges.takeId, id)))
        .orderBy(asc(takeChanges.createdAt), asc(takeChanges.id));
      const history: TakeHistoryEntry[] = rows.map(({ change, name }) => ({
        id: change.id,
        field: change.field as TakeHistoryField,
        before: change.before,
        after: change.after,
        by: change.changedById ? { id: change.changedById, name: name ?? "" } : null,
        writtenAt: change.writtenAt.toISOString(),
        savedAt: change.createdAt.toISOString(),
        overwrote: change.overwrote,
      }));
      return c.json({ history });
    })
    .delete("/:id", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const { id } = c.req.valid("param");
      const [take] = await db
        .select({ id: takes.id, projectId: tracks.projectId })
        .from(takes)
        .innerJoin(
          tracks,
          and(eq(tracks.id, takes.trackId), eq(tracks.organisationId, organisationId)),
        )
        .where(inOrg(takes, organisationId, eq(takes.id, id)));
      if (!take) throw new NotFound("Take");
      await can(db, actorOf(c.var), "edit_takes", take.projectId);
      // The file stays in the project; it is simply no longer a take.
      await db.transaction(async (tx) => {
        await lockLiveProject(tx, organisationId, take.projectId);
        await tx
          .update(files)
          .set({ takeId: null, isTakeMix: false, updatedAt: new Date() })
          .where(inOrg(files, organisationId, eq(files.takeId, id)));
        await tx.delete(takes).where(inOrg(takes, organisationId, eq(takes.id, id)));
      });
      return c.body(null, 204);
    });

/** The takes shared on each of these threads (#133), in take order. */
export async function sharedTakesOf(
  db: Database,
  organisationId: string,
  commentIds: string[],
): Promise<Map<string, SharedTake[]>> {
  const shared = new Map<string, SharedTake[]>();
  if (commentIds.length === 0) return shared;
  const rows = await db
    .select({ commentId: commentTakes.commentId, take: takes })
    .from(commentTakes)
    .innerJoin(
      takes,
      and(eq(takes.id, commentTakes.takeId), eq(takes.organisationId, organisationId)),
    )
    .where(inOrg(commentTakes, organisationId, inArray(commentTakes.commentId, commentIds)))
    .orderBy(asc(takes.number));
  if (rows.length === 0) return shared;
  const heard = await db
    .select({
      takeId: files.takeId,
      id: files.id,
      name: files.name,
      mediaInfo: files.mediaInfo,
      streamStatus: files.streamStatus,
    })
    .from(files)
    .where(
      inOrg(
        files,
        organisationId,
        inArray(
          files.takeId,
          rows.map((r) => r.take.id),
        ),
      ),
    );
  for (const { commentId, take: t } of rows) {
    const file = heard.find((f) => f.takeId === t.id);
    const list = shared.get(commentId) ?? [];
    list.push({
      id: t.id,
      number: t.number,
      label: t.label,
      notes: t.notes,
      rating: t.rating,
      starred: t.starred,
      barFrom: t.barFrom,
      barTo: t.barTo,
      inPoint: t.inPoint,
      outPoint: t.outPoint,
      file: file
        ? {
            id: file.id,
            name: file.name,
            duration: file.mediaInfo?.duration ?? null,
            streamStatus: file.streamStatus,
          }
        : null,
    });
    shared.set(commentId, list);
  }
  return shared;
}

/**
 * Sharing takes on a thread (#133), under `/api/comments/:id/takes`: by those who triage the
 * thread's file and may see takes, from takes of the same project. Everyone who sees the
 * thread then hears them, a guest reviewer included; each share is in the access log.
 */
export const sharedTakeRoutes = (deps: { db: Database; audit: Audit; trustProxy: boolean }) =>
  new Hono<{ Variables: TenantVariables }>()
    .post("/:id/takes", idParam, zValidator("json", shareTakesInput), async (c) => {
      const { db, audit } = deps;
      const organisationId = c.var.organisationId;
      const { id } = c.req.valid("param");
      const takeIds = [...new Set(c.req.valid("json").takeIds)];
      const thread = await threadOf(db, organisationId, id);
      const actor = actorOf(c.var);
      const access = await mayShare(db, actor, thread.fileId);
      await db.transaction(async (tx) => {
        await lockLiveProject(tx, organisationId, access.projectId);
        const found = await tx
          .select({ id: takes.id })
          .from(takes)
          .innerJoin(
            tracks,
            and(eq(tracks.id, takes.trackId), eq(tracks.organisationId, organisationId)),
          )
          .where(
            inOrg(
              takes,
              organisationId,
              inArray(takes.id, takeIds),
              eq(tracks.projectId, access.projectId),
            ),
          );
        if (found.length !== takeIds.length) throw new NotFound("Take");
        const added = await tx
          .insert(commentTakes)
          .values(
            takeIds.map((takeId) => ({
              organisationId,
              commentId: id,
              takeId,
              sharedById: c.var.userId,
            })),
          )
          .onConflictDoNothing()
          .returning({ takeId: commentTakes.takeId });
        // Only what was shared now: a take already on the thread changes nothing.
        if (added.length === 0) return;
        await audit.record(
          organisationId,
          await audit.actor(actor),
          {
            action: "comment.takes_share",
            projectId: access.projectId,
            fileId: thread.fileId,
            details: { commentId: id, takeIds: added.map((a) => a.takeId) },
          },
          requestInfo(c, deps.trustProxy),
          tx,
        );
      });
      const shared = await sharedTakesOf(db, organisationId, [id]);
      return c.json({ takes: shared.get(id) ?? [] }, 201);
    })
    .delete(
      "/:id/takes/:takeId",
      zValidator("param", z.object({ id: z.uuid(), takeId: z.uuid() })),
      async (c) => {
        const { db, audit } = deps;
        const organisationId = c.var.organisationId;
        const { id, takeId } = c.req.valid("param");
        const thread = await threadOf(db, organisationId, id);
        const actor = actorOf(c.var);
        const access = await mayShare(db, actor, thread.fileId);
        await db.transaction(async (tx) => {
          await lockLiveProject(tx, organisationId, access.projectId);
          const gone = await tx
            .delete(commentTakes)
            .where(
              inOrg(
                commentTakes,
                organisationId,
                eq(commentTakes.commentId, id),
                eq(commentTakes.takeId, takeId),
              ),
            )
            .returning({ id: commentTakes.id });
          if (gone.length === 0) throw new NotFound("Take");
          await audit.record(
            organisationId,
            await audit.actor(actor),
            {
              action: "comment.takes_unshare",
              projectId: access.projectId,
              fileId: thread.fileId,
              details: { commentId: id, takeId },
            },
            requestInfo(c, deps.trustProxy),
            tx,
          );
        });
        return c.body(null, 204);
      },
    );

/** A thread: a comment that is no one's reply. */
async function threadOf(db: Database, organisationId: string, id: string) {
  const [thread] = await db
    .select({ fileId: comments.fileId, parentId: comments.parentId })
    .from(comments)
    .where(inOrg(comments, organisationId, eq(comments.id, id)));
  if (!thread || thread.parentId) throw new NotFound("Thread");
  return thread;
}

/** Sharing takes needs both triage on the thread's file and sight of the project's takes. */
async function mayShare(db: Database, actor: ReturnType<typeof actorOf>, fileId: string) {
  const access = await canOnFile(db, actor, "triage", fileId);
  if (!access.permissions.has("view_takes"))
    throw new HTTPException(403, { message: "Your role in this project does not show takes" });
  return access;
}
