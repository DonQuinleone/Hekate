import { type Database, inOrg, schema } from "@hekate/db";
import {
  type ScheduleDay,
  scheduleDayInput,
  scheduleDoneInput,
  scheduleMoveInput,
  scheduleRowInput,
  tracksFinished,
} from "@hekate/shared";
import { asc, eq, inArray, max, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { actorOf, can, lockLiveProject } from "../access.ts";
import { workspaceDateFormats } from "../dates.ts";
import { NotFound } from "../errors.ts";
import { textPdfOf } from "../media/pdf.ts";
import { zValidator } from "../openapi/validator.ts";
import {
  SCHEDULE_PAGE,
  type ScheduleExport,
  schedulePages,
  scheduleSheets,
} from "../schedule-pdf.ts";
import type { TenantVariables } from "../tenancy.ts";
import { type RunnerDeps, trackRecorded } from "../workflow-runner.ts";
import { xlsxOf } from "../xlsx.ts";
import { attachment } from "./comments.ts";
import { personnelOf } from "./personnel.ts";
import { venuesOf, worksOf } from "./repertoire.ts";

const { projects, scheduleDays, scheduleRows, scheduleSlotItems, tracks, venues, works } = schema;

/** An export is for whoever asked: nothing between them and it keeps a copy. */
const PRIVATE = { "cache-control": "no-store, private", "x-content-type-options": "nosniff" };

const idParam = zValidator("param", z.object({ id: z.uuid() }));

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Reader = Pick<Database, "select">;
type RowInput = z.infer<typeof scheduleRowInput>;

/** A project's days in order, each with its rows in order and what each slot covers. */
export async function daysOf(
  db: Reader,
  organisationId: string,
  projectId: string,
): Promise<ScheduleDay[]> {
  const days = await db
    .select({
      id: scheduleDays.id,
      label: scheduleDays.label,
      date: scheduleDays.date,
      venueId: scheduleDays.venueId,
      start: scheduleDays.start,
    })
    .from(scheduleDays)
    .where(inOrg(scheduleDays, organisationId, eq(scheduleDays.projectId, projectId)))
    .orderBy(asc(scheduleDays.position), asc(scheduleDays.createdAt));
  if (days.length === 0) return [];
  const rows = await db
    .select({
      id: scheduleRows.id,
      dayId: scheduleRows.dayId,
      kind: scheduleRows.kind,
      start: scheduleRows.start,
      minutes: scheduleRows.minutes,
      label: scheduleRows.label,
      allRepertoire: scheduleRows.allRepertoire,
      personnel: scheduleRows.personnel,
      notes: scheduleRows.notes,
      done: scheduleRows.done,
    })
    .from(scheduleRows)
    .where(
      inOrg(
        scheduleRows,
        organisationId,
        inArray(
          scheduleRows.dayId,
          days.map((d) => d.id),
        ),
      ),
    )
    .orderBy(asc(scheduleRows.position), asc(scheduleRows.createdAt));
  const items =
    rows.length === 0
      ? []
      : await db
          .select({
            rowId: scheduleSlotItems.rowId,
            workId: scheduleSlotItems.workId,
            trackId: scheduleSlotItems.trackId,
          })
          .from(scheduleSlotItems)
          .where(
            inOrg(
              scheduleSlotItems,
              organisationId,
              inArray(
                scheduleSlotItems.rowId,
                rows.map((r) => r.id),
              ),
            ),
          )
          .orderBy(asc(scheduleSlotItems.position));
  return days.map((day) => ({
    ...day,
    rows: rows
      .filter((r) => r.dayId === day.id)
      .map(({ dayId: _d, ...r }) => {
        const held = items.filter((i) => i.rowId === r.id);
        return {
          ...r,
          workIds: held.flatMap((i) => (i.workId ? [i.workId] : [])),
          trackIds: held.flatMap((i) => (i.trackId ? [i.trackId] : [])),
        };
      }),
  }));
}

/** A venue, if given, of this project's. */
async function assertVenue(
  db: Reader,
  organisationId: string,
  projectId: string,
  venueId: string | null,
) {
  if (!venueId) return;
  const [found] = await db
    .select({ id: venues.id })
    .from(venues)
    .where(inOrg(venues, organisationId, eq(venues.projectId, projectId), eq(venues.id, venueId)));
  if (!found) throw new HTTPException(400, { message: "That venue is not in this project" });
}

/** The works and tracks of a slot, each of this project's. */
async function assertRepertoire(
  db: Reader,
  organisationId: string,
  projectId: string,
  row: Pick<RowInput, "workIds" | "trackIds">,
) {
  const workIds = [...new Set(row.workIds)];
  const trackIds = [...new Set(row.trackIds)];
  if (workIds.length > 0) {
    const found = await db
      .select({ id: works.id })
      .from(works)
      .where(
        inOrg(works, organisationId, eq(works.projectId, projectId), inArray(works.id, workIds)),
      );
    if (found.length !== workIds.length)
      throw new HTTPException(400, { message: "A work in it is not in this project" });
  }
  if (trackIds.length > 0) {
    const found = await db
      .select({ id: tracks.id })
      .from(tracks)
      .where(
        inOrg(
          tracks,
          organisationId,
          eq(tracks.projectId, projectId),
          inArray(tracks.id, trackIds),
        ),
      );
    if (found.length !== trackIds.length)
      throw new HTTPException(400, { message: "A track in it is not in this project" });
  }
}

/** A slot's works and tracks as given, in place of those it had. */
async function writeItems(
  tx: Tx,
  organisationId: string,
  rowId: string,
  row: Pick<RowInput, "workIds" | "trackIds">,
) {
  await tx
    .delete(scheduleSlotItems)
    .where(inOrg(scheduleSlotItems, organisationId, eq(scheduleSlotItems.rowId, rowId)));
  const values = [
    ...[...new Set(row.workIds)].map((workId) => ({ workId, trackId: null })),
    ...[...new Set(row.trackIds)].map((trackId) => ({ workId: null, trackId })),
  ];
  if (values.length > 0)
    await tx
      .insert(scheduleSlotItems)
      .values(values.map((v, position) => ({ organisationId, rowId, position, ...v })));
}

/** A day's rows in order, ids only. */
async function rowOrder(tx: Tx, organisationId: string, dayId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: scheduleRows.id })
    .from(scheduleRows)
    .where(inOrg(scheduleRows, organisationId, eq(scheduleRows.dayId, dayId)))
    .orderBy(asc(scheduleRows.position), asc(scheduleRows.createdAt));
  return rows.map((r) => r.id);
}

/** Positions written as given: the first row 0, the next 1. */
async function writeOrder(tx: Tx, organisationId: string, ids: string[]) {
  for (const [position, id] of ids.entries())
    await tx
      .update(scheduleRows)
      .set({ position })
      .where(inOrg(scheduleRows, organisationId, eq(scheduleRows.id, id)));
}

/**
 * `/api/projects/:id/schedule` and `/schedule-days` (#50): the days with their rows, and the
 * works, tracks and venues they refer to, for those who see the production tools; adding a day,
 * for those who use them.
 */
export const projectScheduleRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
    .get("/:id/schedule", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const { projectId } = await can(
        db,
        actorOf(c.var),
        "view_production",
        c.req.valid("param").id,
      );
      return c.json({
        days: await daysOf(db, organisationId, projectId),
        works: (await worksOf(db, organisationId, projectId)).map((w) => ({
          id: w.id,
          title: w.title,
          abbreviation: w.abbreviation,
          trackIds: w.tracks.map((t) => t.trackId),
        })),
        tracks: await db
          .select({ id: tracks.id, name: tracks.name })
          .from(tracks)
          .where(inOrg(tracks, organisationId, eq(tracks.projectId, projectId)))
          .orderBy(asc(tracks.name)),
        venues: (await venuesOf(db, organisationId, projectId)).map(({ id, name }) => ({
          id,
          name,
        })),
      });
    })
    /** As a PDF to send out, with a front page and the ensemble breakdown, or a workbook. */
    .get("/:id/schedule/:format{pdf|xlsx}", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const { projectId } = await can(
        db,
        actorOf(c.var),
        "view_production",
        c.req.valid("param").id,
      );
      const [project] = await db
        .select({ name: projects.name })
        .from(projects)
        .where(inOrg(projects, organisationId, eq(projects.id, projectId)));
      const input: ScheduleExport = {
        project: project?.name ?? "Project",
        days: await daysOf(db, organisationId, projectId),
        works: (await worksOf(db, organisationId, projectId)).map((w) => ({
          id: w.id,
          title: w.title,
          composer: w.composer,
          forces: w.forces,
          abbreviation: w.abbreviation,
          trackIds: w.tracks.map((t) => t.trackId),
        })),
        tracks: await db
          .select({ id: tracks.id, name: tracks.name })
          .from(tracks)
          .where(inOrg(tracks, organisationId, eq(tracks.projectId, projectId)))
          .orderBy(asc(tracks.name)),
        venues: await venuesOf(db, organisationId, projectId),
        personnel: await personnelOf(db, organisationId, projectId),
        // Its dates as the workspace reads them (#481).
        dateFormat: (await workspaceDateFormats(db, organisationId)).dateFormat,
      };
      const name = `${input.project} schedule`;
      if (c.req.param("format") === "xlsx")
        return c.body(new Uint8Array(xlsxOf(scheduleSheets(input))), 200, {
          ...PRIVATE,
          "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "content-disposition": attachment(`${name}.xlsx`),
        });
      const pdf = textPdfOf(
        schedulePages(input).map((content) => ({ points: SCHEDULE_PAGE, content })),
      );
      return c.body(new Uint8Array(pdf), 200, {
        ...PRIVATE,
        "content-type": "application/pdf",
        "content-disposition": attachment(`${name}.pdf`),
      });
    })
    .post("/:id/schedule-days", idParam, zValidator("json", scheduleDayInput), async (c) => {
      const organisationId = c.var.organisationId;
      const { projectId } = await can(
        db,
        actorOf(c.var),
        "edit_production",
        c.req.valid("param").id,
      );
      const input = c.req.valid("json");
      await assertVenue(db, organisationId, projectId, input.venueId);
      const id = await db.transaction(async (tx) => {
        await lockLiveProject(tx, organisationId, projectId);
        const [last] = await tx
          .select({ position: max(scheduleDays.position) })
          .from(scheduleDays)
          .where(inOrg(scheduleDays, organisationId, eq(scheduleDays.projectId, projectId)));
        const [made] = await tx
          .insert(scheduleDays)
          .values({ organisationId, projectId, ...input, position: (last?.position ?? -1) + 1 })
          .returning({ id: scheduleDays.id });
        if (!made) throw new Error("The day was not written");
        return made.id;
      });
      const [day] = (await daysOf(db, organisationId, projectId)).filter((d) => d.id === id);
      return c.json({ day }, 201);
    });

/** One of a project's days, and its project, for someone who may change it. */
async function dayFor(db: Database, vars: TenantVariables, id: string) {
  const [day] = await db
    .select({ id: scheduleDays.id, projectId: scheduleDays.projectId })
    .from(scheduleDays)
    .where(inOrg(scheduleDays, vars.organisationId, eq(scheduleDays.id, id)));
  if (!day) throw new NotFound("Day");
  await can(db, actorOf(vars), "edit_production", day.projectId);
  return day;
}

/** One row, with its day and project, for someone who may change it. */
async function rowFor(db: Database, vars: TenantVariables, id: string) {
  const [row] = await db
    .select({ id: scheduleRows.id, dayId: scheduleRows.dayId, projectId: scheduleDays.projectId })
    .from(scheduleRows)
    // Both tables in the workspace.
    .innerJoin(scheduleDays, eq(scheduleDays.id, scheduleRows.dayId))
    .where(
      inOrg(
        scheduleRows,
        vars.organisationId,
        eq(scheduleDays.organisationId, vars.organisationId),
        eq(scheduleRows.id, id),
      ),
    );
  if (!row) throw new NotFound("Row");
  await can(db, actorOf(vars), "edit_production", row.projectId);
  return row;
}

/** A day held for the rest of the transaction, so it cannot go while it is acted on. */
async function holdDay(tx: Tx, organisationId: string, id: string) {
  const [held] = await tx
    .select({ id: scheduleDays.id })
    .from(scheduleDays)
    .where(inOrg(scheduleDays, organisationId, eq(scheduleDays.id, id)))
    .for("update");
  if (!held) throw new NotFound("Day");
}

/** A row held for the rest of the transaction, so it cannot go while it is acted on. */
async function holdRow(tx: Tx, organisationId: string, id: string) {
  const [held] = await tx
    .select({ id: scheduleRows.id })
    .from(scheduleRows)
    .where(inOrg(scheduleRows, organisationId, eq(scheduleRows.id, id)))
    .for("update");
  if (!held) throw new NotFound("Row");
}

/** `/api/schedule-days/:id`: changing a day, removing it, and adding a row to it. */
export const scheduleDayRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
    .put("/:id", idParam, zValidator("json", scheduleDayInput), async (c) => {
      const organisationId = c.var.organisationId;
      const day = await dayFor(db, c.var, c.req.valid("param").id);
      const input = c.req.valid("json");
      await assertVenue(db, organisationId, day.projectId, input.venueId);
      await db.transaction(async (tx) => {
        await lockLiveProject(tx, organisationId, day.projectId);
        await holdDay(tx, organisationId, day.id);
        await tx
          .update(scheduleDays)
          .set({ ...input, updatedAt: new Date() })
          .where(inOrg(scheduleDays, organisationId, eq(scheduleDays.id, day.id)));
      });
      const [changed] = (await daysOf(db, organisationId, day.projectId)).filter(
        (d) => d.id === day.id,
      );
      return c.json({ day: changed });
    })
    .delete("/:id", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const day = await dayFor(db, c.var, c.req.valid("param").id);
      await db.transaction(async (tx) => {
        await lockLiveProject(tx, organisationId, day.projectId);
        await holdDay(tx, organisationId, day.id);
        await tx
          .delete(scheduleDays)
          .where(inOrg(scheduleDays, organisationId, eq(scheduleDays.id, day.id)));
      });
      return c.body(null, 204);
    })
    /** A row at the end of the day, or straight after the row named by `after`. */
    .post(
      "/:id/rows",
      idParam,
      zValidator("query", z.object({ after: z.uuid().optional() })),
      zValidator("json", scheduleRowInput),
      async (c) => {
        const organisationId = c.var.organisationId;
        const day = await dayFor(db, c.var, c.req.valid("param").id);
        const { workIds, trackIds, ...row } = c.req.valid("json");
        const { after } = c.req.valid("query");
        await assertRepertoire(db, organisationId, day.projectId, { workIds, trackIds });
        const id = await db.transaction(async (tx) => {
          await lockLiveProject(tx, organisationId, day.projectId);
          await holdDay(tx, organisationId, day.id);
          const order = await rowOrder(tx, organisationId, day.id);
          const at = after === undefined ? order.length : order.indexOf(after) + 1;
          if (at === 0 && after !== undefined)
            throw new HTTPException(400, { message: "That row is not in this day" });
          const [made] = await tx
            .insert(scheduleRows)
            .values({ organisationId, dayId: day.id, ...row, position: at })
            .returning({ id: scheduleRows.id });
          if (!made) throw new Error("The row was not written");
          await writeItems(tx, organisationId, made.id, { workIds, trackIds });
          order.splice(at, 0, made.id);
          await writeOrder(tx, organisationId, order);
          return made.id;
        });
        const [listed] = (await daysOf(db, organisationId, day.projectId))
          .flatMap((d) => d.rows)
          .filter((r) => r.id === id);
        return c.json({ row: listed }, 201);
      },
    );

/** `/api/schedule-rows/:id`: changing a row, ticking it off, moving it, or removing it. */
export const scheduleRowRoutes = (db: Database, runner: RunnerDeps) =>
  new Hono<{ Variables: TenantVariables }>()
    .put("/:id", idParam, zValidator("json", scheduleRowInput), async (c) => {
      const organisationId = c.var.organisationId;
      const row = await rowFor(db, c.var, c.req.valid("param").id);
      const { workIds, trackIds, ...fields } = c.req.valid("json");
      await assertRepertoire(db, organisationId, row.projectId, { workIds, trackIds });
      await db.transaction(async (tx) => {
        await lockLiveProject(tx, organisationId, row.projectId);
        await holdRow(tx, organisationId, row.id);
        await tx
          .update(scheduleRows)
          .set({ ...fields, updatedAt: new Date() })
          .where(inOrg(scheduleRows, organisationId, eq(scheduleRows.id, row.id)));
        await writeItems(tx, organisationId, row.id, { workIds, trackIds });
      });
      const [listed] = (await daysOf(db, organisationId, row.projectId))
        .flatMap((d) => d.rows)
        .filter((r) => r.id === row.id);
      return c.json({ row: listed });
    })
    .patch("/:id/done", idParam, zValidator("json", scheduleDoneInput), async (c) => {
      const organisationId = c.var.organisationId;
      const row = await rowFor(db, c.var, c.req.valid("param").id);
      const { done } = c.req.valid("json");
      // Ticks on one project's schedule take turns, and each works out inside its turn which
      // tracks it finished: two people ticking a track's last two slots at once record it once.
      const finished = await db.transaction(async (tx) => {
        await lockLiveProject(tx, organisationId, row.projectId);
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`schedule:${row.projectId}`}, 0))`,
        );
        await holdRow(tx, organisationId, row.id);
        const changed = await tx
          .update(scheduleRows)
          .set({ done, updatedAt: new Date() })
          .where(
            inOrg(
              scheduleRows,
              organisationId,
              eq(scheduleRows.id, row.id),
              eq(scheduleRows.done, !done),
            ),
          )
          .returning({ id: scheduleRows.id });
        if (!done || changed.length === 0) return [];
        const works = (await worksOf(tx, organisationId, row.projectId)).map((w) => ({
          id: w.id,
          trackIds: w.tracks.map((t) => t.trackId),
        }));
        const all = await tx
          .select({ id: tracks.id })
          .from(tracks)
          .where(inOrg(tracks, organisationId, eq(tracks.projectId, row.projectId)));
        return tracksFinished(
          row.id,
          await daysOf(tx, organisationId, row.projectId),
          works,
          all.map((t) => t.id),
        );
      });
      // Ticked off just now: a track with no slot left is recorded, for its workflows.
      for (const trackId of finished)
        await trackRecorded(runner, {
          organisationId,
          projectId: row.projectId,
          trackId,
          userId: c.var.userId,
        });
      return c.json({ done });
    })
    .post("/:id/move", idParam, zValidator("json", scheduleMoveInput), async (c) => {
      const organisationId = c.var.organisationId;
      const row = await rowFor(db, c.var, c.req.valid("param").id);
      const { direction } = c.req.valid("json");
      await db.transaction(async (tx) => {
        await lockLiveProject(tx, organisationId, row.projectId);
        // The day too, as adding a row rewrites the same order.
        await holdDay(tx, organisationId, row.dayId);
        await holdRow(tx, organisationId, row.id);
        const order = await rowOrder(tx, organisationId, row.dayId);
        const from = order.indexOf(row.id);
        const to = direction === "up" ? from - 1 : from + 1;
        if (from < 0 || to < 0 || to >= order.length) return;
        [order[from], order[to]] = [order[to] as string, row.id];
        await writeOrder(tx, organisationId, order);
      });
      return c.body(null, 204);
    })
    .delete("/:id", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const row = await rowFor(db, c.var, c.req.valid("param").id);
      await db.transaction(async (tx) => {
        await lockLiveProject(tx, organisationId, row.projectId);
        await holdRow(tx, organisationId, row.id);
        await tx
          .delete(scheduleRows)
          .where(inOrg(scheduleRows, organisationId, eq(scheduleRows.id, row.id)));
      });
      return c.body(null, 204);
    });
