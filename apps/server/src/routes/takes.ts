import { type Database, inOrg, schema } from "@hekate/db";
import {
  addTakesInput,
  type SharedTake,
  shareTakesInput,
  type TakeRow,
  takeChangeInput,
  takeProblem,
  takesCovering,
} from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { and, asc, eq, inArray, max } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { actorOf, can, canOnFile, lockLiveProject } from "../access.ts";
import { type Audit, requestInfo } from "../audit.ts";
import { NotFound } from "../errors.ts";
import type { TenantVariables } from "../tenancy.ts";

const { comments, commentTakes, files, sessions, sessionTracks, takes, tracks, variations } =
  schema;

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
        await can(db, actorOf(c.var), "view_takes", track.projectId);
        const all = await takesOf(db, organisationId, track.id);
        const { bar } = c.req.valid("query");
        return c.json({ takes: bar === undefined ? all : takesCovering(all, bar) });
      },
    )
    .post("/:id/takes", idParam, zValidator("json", addTakesInput), async (c) => {
      const organisationId = c.var.organisationId;
      const track = await trackOf(db, organisationId, c.req.valid("param").id);
      await can(db, actorOf(c.var), "edit_takes", track.projectId);
      const fileIds = [...new Set(c.req.valid("json").fileIds)];
      await db.transaction(async (tx) => {
        await lockLiveProject(tx, organisationId, track.projectId);
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

/** `/api/takes/:id`: changing a take, or no longer counting its file as one. */
export const takeRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
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
      const next = { ...take.take, ...change };
      const problem = takeProblem({
        barFrom: next.barFrom ?? null,
        barTo: next.barTo ?? null,
        inPoint: next.inPoint ?? null,
        outPoint: next.outPoint ?? null,
      });
      if (problem) throw new HTTPException(422, { message: problem });
      await db.transaction(async (tx) => {
        // An archived project is read-only, even if it was archived a moment ago.
        await lockLiveProject(tx, organisationId, take.projectId);
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
        await tx
          .update(takes)
          .set({ ...change, updatedAt: new Date() })
          .where(inOrg(takes, organisationId, eq(takes.id, id)));
      });
      const [row] = (await takesOf(db, organisationId, take.take.trackId)).filter(
        (t) => t.id === id,
      );
      return c.json({ take: row });
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
