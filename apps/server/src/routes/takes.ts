import { type Database, inOrg, schema } from "@hekate/db";
import {
  addTakesInput,
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
import { actorOf, can, lockLiveProject } from "../access.ts";
import { NotFound } from "../errors.ts";
import type { TenantVariables } from "../tenancy.ts";

const { files, takes, tracks, variations } = schema;

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
