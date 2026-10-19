import { type Database, inOrg, schema } from "@hekate/db";
import {
  nextTakeNumber,
  type SessionDetail,
  type SessionSummary,
  sessionChangeInput,
  sessionInput,
  slotProblem,
  startTakeInput,
  type TakeNumbering,
  takeImportInput,
} from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { and, asc, desc, eq, inArray, max, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { actorOf, can, lockLiveProject, lockTakeNumbers } from "../access.ts";
import { NotFound } from "../errors.ts";
import type { TenantVariables } from "../tenancy.ts";
import { takeRowsFor } from "./takes.ts";

const { files, sessions, sessionTracks, takes, tracks, variations } = schema;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const idParam = zValidator("param", z.object({ id: z.uuid() }));

/** Sessions as their list shows them: the tracks each recorded, and its takes counted. */
async function summariesOf(
  db: Database,
  organisationId: string,
  rows: (typeof sessions.$inferSelect)[],
): Promise<SessionSummary[]> {
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return [];
  const linked = await db
    .select({ sessionId: sessionTracks.sessionId, id: tracks.id, name: tracks.name })
    .from(sessionTracks)
    .innerJoin(
      tracks,
      and(eq(tracks.id, sessionTracks.trackId), eq(tracks.organisationId, organisationId)),
    )
    .where(inOrg(sessionTracks, organisationId, inArray(sessionTracks.sessionId, ids)))
    .orderBy(asc(tracks.position), asc(tracks.name));
  const recorded = await db
    .select({ id: takes.id, sessionId: takes.sessionId, starred: takes.starred })
    .from(takes)
    .where(inOrg(takes, organisationId, inArray(takes.sessionId, ids)));
  const mixes =
    recorded.length === 0
      ? []
      : await db
          .select({ takeId: files.takeId, mediaInfo: files.mediaInfo })
          .from(files)
          .where(
            inOrg(
              files,
              organisationId,
              eq(files.isTakeMix, true),
              inArray(
                files.takeId,
                recorded.map((t) => t.id),
              ),
            ),
          );
  return rows.map((r) => {
    const its = recorded.filter((t) => t.sessionId === r.id);
    return {
      id: r.id,
      projectId: r.projectId,
      name: r.name,
      recordedOn: r.recordedOn,
      venue: r.venue,
      numbering: r.numbering as TakeNumbering,
      slotStart: r.slotStart?.toISOString() ?? null,
      slotEnd: r.slotEnd?.toISOString() ?? null,
      tracks: linked.filter((l) => l.sessionId === r.id).map(({ id, name }) => ({ id, name })),
      takes: its.length,
      starred: its.filter((t) => t.starred).length,
      duration: its.reduce(
        (sum, t) => sum + (mixes.find((m) => m.takeId === t.id)?.mediaInfo?.duration ?? 0),
        0,
      ),
    };
  });
}

/** A moment as typed into a session, as the database keeps it; undefined leaves it be. */
const momentOf = (value: string | null | undefined) =>
  value === undefined ? undefined : value === null ? null : new Date(value);

/** A session's slot, refused where it ends before it starts. */
function checkSlot(start: string | null, end: string | null) {
  const problem = slotProblem(start, end);
  if (problem) throw new HTTPException(422, { message: problem });
}

/** The number the next take of each track would get, as a session numbering so would give it. */
async function nextNumbersOf(
  db: Database,
  organisationId: string,
  projectId: string,
  numbering: TakeNumbering,
  trackIds: string[],
): Promise<Record<string, number>> {
  if (trackIds.length === 0) return {};
  const perTrack = await db
    .select({ trackId: takes.trackId, n: max(takes.number) })
    .from(takes)
    .where(inOrg(takes, organisationId, inArray(takes.trackId, trackIds)))
    .groupBy(takes.trackId);
  const [ofProject] =
    numbering === "continuous"
      ? await db
          .select({ n: max(takes.number) })
          .from(takes)
          .innerJoin(
            tracks,
            and(eq(tracks.id, takes.trackId), eq(tracks.organisationId, organisationId)),
          )
          .where(inOrg(takes, organisationId, eq(tracks.projectId, projectId)))
      : [{ n: 0 }];
  return Object.fromEntries(
    trackIds.map((id) => [
      id,
      nextTakeNumber(numbering, {
        project: ofProject?.n ?? 0,
        track: perTrack.find((p) => p.trackId === id)?.n ?? 0,
      }),
    ]),
  );
}

/** A session of this workspace, with its project; not found otherwise. */
async function sessionOf(db: Database, organisationId: string, id: string) {
  const [row] = await db
    .select()
    .from(sessions)
    .where(inOrg(sessions, organisationId, eq(sessions.id, id)));
  if (!row) throw new NotFound("Session");
  return row;
}

/** The tracks a session recorded, in full: all of the project, or none of them is linked. */
async function linkTracks(
  tx: Tx,
  organisationId: string,
  projectId: string,
  sessionId: string,
  trackIds: string[],
) {
  const wanted = [...new Set(trackIds)];
  if (wanted.length > 0) {
    const found = await tx
      .select({ id: tracks.id })
      .from(tracks)
      .where(
        inOrg(tracks, organisationId, eq(tracks.projectId, projectId), inArray(tracks.id, wanted)),
      );
    if (found.length !== wanted.length) throw new NotFound("Track");
  }
  await tx
    .delete(sessionTracks)
    .where(inOrg(sessionTracks, organisationId, eq(sessionTracks.sessionId, sessionId)));
  if (wanted.length > 0)
    await tx
      .insert(sessionTracks)
      .values(wanted.map((trackId) => ({ organisationId, sessionId, trackId })));
}

/**
 * A project's recording sessions (#21, #45), under `/api/projects/:id/sessions`: listing them,
 * newest first, and making one. Seeing them needs `view_takes`; changing them, `edit_takes`,
 * as for takes.
 */
export const projectSessionRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
    .get("/:id/sessions", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const projectId = c.req.valid("param").id;
      await can(db, actorOf(c.var), "view_takes", projectId);
      const rows = await db
        .select()
        .from(sessions)
        .where(inOrg(sessions, organisationId, eq(sessions.projectId, projectId)))
        .orderBy(sql`${sessions.recordedOn} desc nulls last`, desc(sessions.createdAt));
      return c.json({ sessions: await summariesOf(db, organisationId, rows) });
    })
    .post("/:id/sessions", idParam, zValidator("json", sessionInput), async (c) => {
      const organisationId = c.var.organisationId;
      const projectId = c.req.valid("param").id;
      await can(db, actorOf(c.var), "edit_takes", projectId);
      const input = c.req.valid("json");
      checkSlot(input.slotStart ?? null, input.slotEnd ?? null);
      const id = await db.transaction(async (tx) => {
        await lockLiveProject(tx, organisationId, projectId);
        const [made] = await tx
          .insert(sessions)
          .values({
            organisationId,
            projectId,
            name: input.name,
            recordedOn: input.recordedOn ?? null,
            venue: input.venue || null,
            ...(input.numbering ? { numbering: input.numbering } : {}),
            slotStart: momentOf(input.slotStart) ?? null,
            slotEnd: momentOf(input.slotEnd) ?? null,
          })
          .returning();
        if (!made) throw new NotFound("Session");
        await linkTracks(tx, organisationId, projectId, made.id, input.trackIds ?? []);
        return made.id;
      });
      const [summary] = await summariesOf(db, organisationId, [
        await sessionOf(db, organisationId, id),
      ]);
      return c.json({ session: summary }, 201);
    })
    .post("/:id/takes/import", idParam, zValidator("json", takeImportInput), async (c) => {
      const organisationId = c.var.organisationId;
      const projectId = c.req.valid("param").id;
      await can(db, actorOf(c.var), "edit_takes", projectId);
      const wanted = c.req.valid("json").takes;
      const fileIds = [...new Set(wanted.map((t) => t.fileId))];
      if (fileIds.length !== wanted.length)
        throw new HTTPException(422, { message: "A file is one take" });
      const trackIds = [...new Set(wanted.map((t) => t.trackId))].sort();
      const sessionIds = [
        ...new Set(wanted.map((t) => t.sessionId).filter((s): s is string => s !== null)),
      ];
      const result = await db.transaction(async (tx) => {
        await lockLiveProject(tx, organisationId, projectId);
        await lockTakeNumbers(tx, projectId);
        // Under the tracks' locks, taken in one order, so imports at once number in turn.
        const found = await tx
          .select({ id: tracks.id })
          .from(tracks)
          .where(
            inOrg(
              tracks,
              organisationId,
              eq(tracks.projectId, projectId),
              inArray(tracks.id, trackIds),
            ),
          )
          .orderBy(asc(tracks.id))
          .for("update");
        if (found.length !== trackIds.length) throw new NotFound("Track");
        if (sessionIds.length > 0) {
          const known = await tx
            .select({ id: sessions.id })
            .from(sessions)
            .where(
              inOrg(
                sessions,
                organisationId,
                eq(sessions.projectId, projectId),
                inArray(sessions.id, sessionIds),
              ),
            );
          if (known.length !== sessionIds.length) throw new NotFound("Session");
        }
        const chosen = await tx
          .select({ id: files.id, kind: files.kind, takeId: files.takeId })
          .from(files)
          .where(
            inOrg(
              files,
              organisationId,
              eq(files.projectId, projectId),
              inArray(files.id, fileIds),
            ),
          )
          .for("update");
        if (chosen.length !== fileIds.length) throw new NotFound("File");
        if (chosen.some((f) => f.kind !== "audio" && f.kind !== "video"))
          throw new HTTPException(422, { message: "A take is a recording: audio or video" });
        const used = await tx
          .select({ id: variations.fileId })
          .from(variations)
          .where(inOrg(variations, organisationId, inArray(variations.fileId, fileIds)));
        if (used.length > 0)
          throw new HTTPException(409, { message: "A version's file cannot also be a take" });
        // A file that is a take already was imported before: carrying on, not doing it twice.
        const already = new Set(chosen.filter((f) => f.takeId).map((f) => f.id));
        const numbers = new Map(
          (
            await tx
              .select({ trackId: takes.trackId, n: max(takes.number) })
              .from(takes)
              .where(inOrg(takes, organisationId, inArray(takes.trackId, trackIds)))
              .groupBy(takes.trackId)
          ).map((r) => [r.trackId, r.n ?? 0]),
        );
        let imported = 0;
        for (const entry of wanted) {
          if (already.has(entry.fileId)) continue;
          const number = (numbers.get(entry.trackId) ?? 0) + 1;
          numbers.set(entry.trackId, number);
          const [take] = await tx
            .insert(takes)
            .values({
              organisationId,
              trackId: entry.trackId,
              sessionId: entry.sessionId,
              number,
              label: entry.label || null,
            })
            .returning({ id: takes.id });
          await tx
            .update(files)
            .set({ takeId: take?.id ?? null, isTakeMix: true, updatedAt: new Date() })
            .where(inOrg(files, organisationId, eq(files.id, entry.fileId)));
          imported += 1;
        }
        // Each session recorded the tracks of the takes it brings.
        const pairs = wanted.filter((t) => t.sessionId !== null && !already.has(t.fileId));
        if (pairs.length > 0)
          await tx
            .insert(sessionTracks)
            .values(
              pairs.map((t) => ({
                organisationId,
                sessionId: t.sessionId as string,
                trackId: t.trackId,
              })),
            )
            .onConflictDoNothing();
        return { imported, skipped: already.size };
      });
      return c.json(result, 201);
    });

/** `/api/sessions/:id`: one session with its takes, changing it, or removing it. */
export const sessionRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
    .get("/:id", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const row = await sessionOf(db, organisationId, c.req.valid("param").id);
      await can(db, actorOf(c.var), "view_takes", row.projectId);
      const [summary] = await summariesOf(db, organisationId, [row]);
      const recorded = await db
        .select({ take: takes, track: { id: tracks.id, name: tracks.name } })
        .from(takes)
        .innerJoin(
          tracks,
          and(eq(tracks.id, takes.trackId), eq(tracks.organisationId, organisationId)),
        )
        .where(inOrg(takes, organisationId, eq(takes.sessionId, row.id)))
        .orderBy(asc(tracks.position), asc(tracks.name), asc(takes.number));
      const rows = await takeRowsFor(db, organisationId, recorded);
      const base = summary as SessionSummary;
      const session: SessionDetail = {
        ...base,
        takeRows: rows.map((t, i) => ({ ...t, track: recorded[i]?.track ?? { id: "", name: "" } })),
        nextNumbers: await nextNumbersOf(
          db,
          organisationId,
          row.projectId,
          base.numbering,
          base.tracks.map((t) => t.id),
        ),
      };
      return c.json({ session });
    })
    .patch("/:id", idParam, zValidator("json", sessionChangeInput), async (c) => {
      const organisationId = c.var.organisationId;
      const row = await sessionOf(db, organisationId, c.req.valid("param").id);
      await can(db, actorOf(c.var), "edit_takes", row.projectId);
      const { trackIds, slotStart, slotEnd, ...change } = c.req.valid("json");
      checkSlot(
        slotStart === undefined ? (row.slotStart?.toISOString() ?? null) : slotStart,
        slotEnd === undefined ? (row.slotEnd?.toISOString() ?? null) : slotEnd,
      );
      await db.transaction(async (tx) => {
        await lockLiveProject(tx, organisationId, row.projectId);
        await tx
          .update(sessions)
          .set({
            ...change,
            ...(change.venue !== undefined ? { venue: change.venue || null } : {}),
            ...(slotStart !== undefined ? { slotStart: momentOf(slotStart) } : {}),
            ...(slotEnd !== undefined ? { slotEnd: momentOf(slotEnd) } : {}),
            updatedAt: new Date(),
          })
          .where(inOrg(sessions, organisationId, eq(sessions.id, row.id)));
        if (trackIds) await linkTracks(tx, organisationId, row.projectId, row.id, trackIds);
      });
      const [summary] = await summariesOf(db, organisationId, [
        await sessionOf(db, organisationId, row.id),
      ]);
      return c.json({ session: summary });
    })
    // The take log (#51): the next take, numbered as the session numbers them, rolling or armed.
    .post("/:id/takes", idParam, zValidator("json", startTakeInput), async (c) => {
      const organisationId = c.var.organisationId;
      const row = await sessionOf(db, organisationId, c.req.valid("param").id);
      await can(db, actorOf(c.var), "edit_takes", row.projectId);
      const input = c.req.valid("json");
      const numbering = row.numbering as TakeNumbering;
      const id = await db.transaction(async (tx) => {
        await lockLiveProject(tx, organisationId, row.projectId);
        // A track of the session's project, locked so two takes started at once number in turn.
        const [track] = await tx
          .select({ id: tracks.id })
          .from(tracks)
          .where(
            inOrg(
              tracks,
              organisationId,
              eq(tracks.id, input.trackId),
              eq(tracks.projectId, row.projectId),
            ),
          )
          .for("update");
        if (!track) throw new NotFound("Track");
        await lockTakeNumbers(tx, row.projectId);
        const [ofTrack] = await tx
          .select({ n: max(takes.number) })
          .from(takes)
          .where(inOrg(takes, organisationId, eq(takes.trackId, track.id)));
        const [ofProject] =
          numbering === "continuous"
            ? await tx
                .select({ n: max(takes.number) })
                .from(takes)
                .innerJoin(
                  tracks,
                  and(eq(tracks.id, takes.trackId), eq(tracks.organisationId, organisationId)),
                )
                .where(inOrg(takes, organisationId, eq(tracks.projectId, row.projectId)))
            : [{ n: 0 }];
        const number = nextTakeNumber(
          numbering,
          { project: ofProject?.n ?? 0, track: ofTrack?.n ?? 0 },
          input.number,
        );
        const rolling = input.lifecycle === "recording";
        const [made] = await tx
          .insert(takes)
          .values({
            organisationId,
            trackId: track.id,
            sessionId: row.id,
            number,
            lifecycle: input.lifecycle,
            timecodeIn: input.timecodeIn ?? null,
            wallIn: rolling ? new Date() : null,
          })
          .onConflictDoNothing()
          .returning({ id: takes.id });
        // Only a recorder's own number can already be taken.
        if (!made) throw new HTTPException(409, { message: `Take ${number} is already logged` });
        // The session recorded the track, if it did not say so.
        await tx
          .insert(sessionTracks)
          .values({ organisationId, sessionId: row.id, trackId: track.id })
          .onConflictDoNothing();
        return made.id;
      });
      const [take] = await db
        .select({ take: takes })
        .from(takes)
        .where(inOrg(takes, organisationId, eq(takes.id, id)));
      const [made] = await takeRowsFor(db, organisationId, take ? [take] : []);
      return c.json({ take: made }, 201);
    })
    .delete("/:id", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const row = await sessionOf(db, organisationId, c.req.valid("param").id);
      await can(db, actorOf(c.var), "edit_takes", row.projectId);
      // Its takes stay with their tracks; they no longer say when they were recorded.
      await db.transaction(async (tx) => {
        await lockLiveProject(tx, organisationId, row.projectId);
        await tx.delete(sessions).where(inOrg(sessions, organisationId, eq(sessions.id, row.id)));
      });
      return c.body(null, 204);
    });
