import { type Database, inOrg, schema } from "@hekate/db";
import {
  isPdf,
  scheduleOrder,
  type Venue,
  venueInput,
  type Work,
  workInput,
  workTrackNumberInput,
} from "@hekate/shared";
import { asc, eq, inArray, max } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { actorOf, can, lockLiveProject } from "../access.ts";
import { NotFound } from "../errors.ts";
import { zValidator } from "../openapi/validator.ts";
import { swapScore } from "../score-swap.ts";
import type { TenantVariables } from "../tenancy.ts";
import { daysOf } from "./schedule.ts";
import { assertScore } from "./tracks.ts";

const { files, tracks, venues, workTracks, works } = schema;

const idParam = zValidator("param", z.object({ id: z.uuid() }));

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Reader = Pick<Database, "select">;

function violates(error: unknown, index: string): boolean {
  const cause = (error as { cause?: { code?: string; constraint_name?: string } }).cause;
  return cause?.code === "23505" && cause.constraint_name === index;
}

const trackTaken = () =>
  new HTTPException(409, { message: "A track in it is already in another work" });
const venueTaken = () =>
  new HTTPException(409, { message: "Another venue in this project has that name" });

const venueShape = {
  id: venues.id,
  name: venues.name,
  address: venues.address,
  notes: venues.notes,
};

/** A project's works in the order they were added, each with its tracks in order. */
export async function worksOf(
  db: Reader,
  organisationId: string,
  projectId: string,
): Promise<Work[]> {
  const listed = await db
    .select({
      id: works.id,
      title: works.title,
      composer: works.composer,
      forces: works.forces,
      abbreviation: works.abbreviation,
      notes: works.notes,
      scoreFileId: works.scoreFileId,
      pageOffset: works.pageOffset,
    })
    .from(works)
    .where(inOrg(works, organisationId, eq(works.projectId, projectId)))
    .orderBy(asc(works.position), asc(works.createdAt));
  if (listed.length === 0) return [];
  const entries = await db
    .select({
      workId: workTracks.workId,
      trackId: workTracks.trackId,
      number: workTracks.number,
      pageFrom: workTracks.pageFrom,
      pageTo: workTracks.pageTo,
      name: tracks.name,
    })
    .from(workTracks)
    // Both tables in the workspace.
    .innerJoin(tracks, eq(tracks.id, workTracks.trackId))
    .where(
      inOrg(
        workTracks,
        organisationId,
        eq(tracks.organisationId, organisationId),
        inArray(
          workTracks.workId,
          listed.map((w) => w.id),
        ),
      ),
    )
    .orderBy(asc(workTracks.position));
  return listed.map((w) => ({
    ...w,
    tracks: entries.filter((e) => e.workId === w.id).map(({ workId: _w, ...t }) => t),
  }));
}

/** A project's venues in the order they were added. */
export async function venuesOf(
  db: Reader,
  organisationId: string,
  projectId: string,
): Promise<Venue[]> {
  return db
    .select(venueShape)
    .from(venues)
    .where(inOrg(venues, organisationId, eq(venues.projectId, projectId)))
    .orderBy(asc(venues.position), asc(venues.createdAt));
}

/** A work's tracks as given, in place of those it had: each one of this project's tracks. */
async function writeTracks(
  tx: Tx,
  organisationId: string,
  projectId: string,
  workId: string,
  given: z.infer<typeof workInput>["tracks"],
) {
  if (given.length > 0) {
    const found = await tx
      .select({ id: tracks.id })
      .from(tracks)
      .where(
        inOrg(
          tracks,
          organisationId,
          eq(tracks.projectId, projectId),
          inArray(
            tracks.id,
            given.map((t) => t.trackId),
          ),
        ),
      );
    if (found.length !== given.length)
      throw new HTTPException(400, { message: "A track in it is not in this project" });
  }
  await tx
    .delete(workTracks)
    .where(inOrg(workTracks, organisationId, eq(workTracks.workId, workId)));
  if (given.length > 0)
    await tx
      .insert(workTracks)
      .values(given.map((t, position) => ({ organisationId, workId, position, ...t })));
}

/**
 * A work's score on each of its tracks (#48): the tracks follow the work's one PDF, and what
 * was marked on a track's old edition follows its bars, as any swap of a score does (#52).
 */
async function scoreTracks(
  tx: Tx,
  organisationId: string,
  scoreFileId: string | null,
  trackIds: string[],
  by: string | null,
) {
  if (!scoreFileId || trackIds.length === 0) return;
  const held = await tx
    .select({ id: tracks.id, scoreFileId: tracks.scoreFileId })
    .from(tracks)
    .where(inOrg(tracks, organisationId, inArray(tracks.id, trackIds)));
  for (const t of held) {
    if (t.scoreFileId === scoreFileId) continue;
    await swapScore(tx, organisationId, t.id, scoreFileId, by);
    await tx
      .update(tracks)
      .set({ scoreFileId, updatedAt: new Date() })
      .where(inOrg(tracks, organisationId, eq(tracks.id, t.id)));
  }
}

/**
 * `/api/projects/:id/repertoire`, `/works` and `/venues` (#48): the works and venues, with the
 * project's tracks a work may hold, for those who see the production tools; adding one, for
 * those who use them.
 */
export const projectRepertoireRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
    .get("/:id/repertoire", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const { projectId } = await can(
        db,
        actorOf(c.var),
        "view_production",
        c.req.valid("param").id,
      );
      return c.json({
        // In the order the schedule first reaches them; the page may sort them by title.
        works: scheduleOrder(
          await worksOf(db, organisationId, projectId),
          await daysOf(db, organisationId, projectId),
        ),
        venues: await venuesOf(db, organisationId, projectId),
        tracks: await db
          .select({ id: tracks.id, name: tracks.name })
          .from(tracks)
          .where(inOrg(tracks, organisationId, eq(tracks.projectId, projectId)))
          .orderBy(asc(tracks.name)),
        // The project's PDFs, a work's score among them: names only.
        scores: (
          await db
            .select({ id: files.id, name: files.name, contentType: files.contentType })
            .from(files)
            .where(
              inOrg(
                files,
                organisationId,
                eq(files.projectId, projectId),
                eq(files.kind, "document"),
              ),
            )
            .orderBy(asc(files.name))
        )
          .filter((f) => isPdf(f.name, f.contentType))
          .map(({ id, name }) => ({ id, name })),
      });
    })
    .post("/:id/works", idParam, zValidator("json", workInput), async (c) => {
      const organisationId = c.var.organisationId;
      const { projectId } = await can(
        db,
        actorOf(c.var),
        "edit_production",
        c.req.valid("param").id,
      );
      const { tracks: given, ...work } = c.req.valid("json");
      if (work.scoreFileId) await assertScore(db, organisationId, projectId, work.scoreFileId);
      try {
        const id = await db.transaction(async (tx) => {
          await lockLiveProject(tx, organisationId, projectId);
          const [last] = await tx
            .select({ position: max(works.position) })
            .from(works)
            .where(inOrg(works, organisationId, eq(works.projectId, projectId)));
          const [made] = await tx
            .insert(works)
            .values({ organisationId, projectId, ...work, position: (last?.position ?? -1) + 1 })
            .returning({ id: works.id });
          if (!made) throw new Error("The work was not written");
          await writeTracks(tx, organisationId, projectId, made.id, given);
          await scoreTracks(
            tx,
            organisationId,
            work.scoreFileId,
            given.map((t) => t.trackId),
            c.var.userId,
          );
          return made.id;
        });
        const [listed] = (await worksOf(db, organisationId, projectId)).filter((w) => w.id === id);
        return c.json({ work: listed }, 201);
      } catch (error) {
        if (violates(error, "work_tracks_track_idx")) throw trackTaken();
        throw error;
      }
    })
    .post("/:id/venues", idParam, zValidator("json", venueInput), async (c) => {
      const organisationId = c.var.organisationId;
      const { projectId } = await can(
        db,
        actorOf(c.var),
        "edit_production",
        c.req.valid("param").id,
      );
      try {
        const venue = await db.transaction(async (tx) => {
          await lockLiveProject(tx, organisationId, projectId);
          const [last] = await tx
            .select({ position: max(venues.position) })
            .from(venues)
            .where(inOrg(venues, organisationId, eq(venues.projectId, projectId)));
          const [made] = await tx
            .insert(venues)
            .values({
              organisationId,
              projectId,
              ...c.req.valid("json"),
              position: (last?.position ?? -1) + 1,
            })
            .returning(venueShape);
          return made;
        });
        return c.json({ venue }, 201);
      } catch (error) {
        if (violates(error, "venues_name_idx")) throw venueTaken();
        throw error;
      }
    });

/** One of a project's works or venues, and its project, for someone who may change them. */
async function ownedBy(
  db: Database,
  vars: TenantVariables,
  table: typeof works | typeof venues,
  id: string,
  what: string,
) {
  const [row] = await db
    .select({ id: table.id, projectId: table.projectId })
    .from(table)
    .where(inOrg(table, vars.organisationId, eq(table.id, id)));
  if (!row) throw new NotFound(what);
  await can(db, actorOf(vars), "edit_production", row.projectId);
  return row;
}

/** `/api/works/:id`: changing a work (its tracks with it), or removing it. */
export const workRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
    .put("/:id", idParam, zValidator("json", workInput), async (c) => {
      const organisationId = c.var.organisationId;
      const work = await ownedBy(db, c.var, works, c.req.valid("param").id, "Work");
      const { tracks: given, ...fields } = c.req.valid("json");
      if (fields.scoreFileId)
        await assertScore(db, organisationId, work.projectId, fields.scoreFileId);
      try {
        await db.transaction(async (tx) => {
          await lockLiveProject(tx, organisationId, work.projectId);
          await tx
            .update(works)
            .set({ ...fields, updatedAt: new Date() })
            .where(inOrg(works, organisationId, eq(works.id, work.id)));
          await writeTracks(tx, organisationId, work.projectId, work.id, given);
          await scoreTracks(
            tx,
            organisationId,
            fields.scoreFileId,
            given.map((t) => t.trackId),
            c.var.userId,
          );
        });
      } catch (error) {
        if (violates(error, "work_tracks_track_idx")) throw trackTaken();
        throw error;
      }
      const [listed] = (await worksOf(db, organisationId, work.projectId)).filter(
        (w) => w.id === work.id,
      );
      return c.json({ work: listed });
    })
    /** One track's number alone, as typed in place in the list. */
    .patch(
      "/:id/tracks/:trackId",
      zValidator("param", z.object({ id: z.uuid(), trackId: z.uuid() })),
      zValidator("json", workTrackNumberInput),
      async (c) => {
        const organisationId = c.var.organisationId;
        const { id, trackId } = c.req.valid("param");
        const work = await ownedBy(db, c.var, works, id, "Work");
        const changed = await db.transaction(async (tx) => {
          await lockLiveProject(tx, organisationId, work.projectId);
          return tx
            .update(workTracks)
            .set({ number: c.req.valid("json").number })
            .where(
              inOrg(
                workTracks,
                organisationId,
                eq(workTracks.workId, work.id),
                eq(workTracks.trackId, trackId),
              ),
            )
            .returning({ number: workTracks.number });
        });
        if (changed.length === 0) throw new NotFound("Track in this work");
        return c.json({ number: changed[0]?.number ?? "" });
      },
    )
    .delete("/:id", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const work = await ownedBy(db, c.var, works, c.req.valid("param").id, "Work");
      await db.transaction(async (tx) => {
        await lockLiveProject(tx, organisationId, work.projectId);
        await tx.delete(works).where(inOrg(works, organisationId, eq(works.id, work.id)));
      });
      return c.body(null, 204);
    });

/** `/api/venues/:id`: changing a venue, or removing it. */
export const venueRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
    .put("/:id", idParam, zValidator("json", venueInput), async (c) => {
      const organisationId = c.var.organisationId;
      const venue = await ownedBy(db, c.var, venues, c.req.valid("param").id, "Venue");
      try {
        const changed = await db.transaction(async (tx) => {
          await lockLiveProject(tx, organisationId, venue.projectId);
          const [updated] = await tx
            .update(venues)
            .set({ ...c.req.valid("json"), updatedAt: new Date() })
            .where(inOrg(venues, organisationId, eq(venues.id, venue.id)))
            .returning(venueShape);
          return updated;
        });
        return c.json({ venue: changed });
      } catch (error) {
        if (violates(error, "venues_name_idx")) throw venueTaken();
        throw error;
      }
    })
    .delete("/:id", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const venue = await ownedBy(db, c.var, venues, c.req.valid("param").id, "Venue");
      await db.transaction(async (tx) => {
        await lockLiveProject(tx, organisationId, venue.projectId);
        await tx.delete(venues).where(inOrg(venues, organisationId, eq(venues.id, venue.id)));
      });
      return c.body(null, 204);
    });
