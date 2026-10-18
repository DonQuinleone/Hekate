import { type Database, inOrg, schema } from "@hekate/db";
import {
  type SessionDetail,
  type SessionSummary,
  sessionChangeInput,
  sessionInput,
} from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { actorOf, can, lockLiveProject } from "../access.ts";
import { NotFound } from "../errors.ts";
import type { TenantVariables } from "../tenancy.ts";
import { takeRowsFor } from "./takes.ts";

const { files, sessions, sessionTracks, takes, tracks } = schema;

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
      const session: SessionDetail = {
        ...(summary as SessionSummary),
        takeRows: rows.map((t, i) => ({ ...t, track: recorded[i]?.track ?? { id: "", name: "" } })),
      };
      return c.json({ session });
    })
    .patch("/:id", idParam, zValidator("json", sessionChangeInput), async (c) => {
      const organisationId = c.var.organisationId;
      const row = await sessionOf(db, organisationId, c.req.valid("param").id);
      await can(db, actorOf(c.var), "edit_takes", row.projectId);
      const { trackIds, ...change } = c.req.valid("json");
      await db.transaction(async (tx) => {
        await lockLiveProject(tx, organisationId, row.projectId);
        await tx
          .update(sessions)
          .set({
            ...change,
            ...(change.venue !== undefined ? { venue: change.venue || null } : {}),
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
