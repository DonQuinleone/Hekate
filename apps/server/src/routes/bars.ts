import { type Database, inOrg, schema } from "@hekate/db";
import { type BarMap, type BarMapSource, profiles, saveBarMapInput } from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { canOnFile } from "../access.ts";
import { NotFound } from "../errors.ts";
import type { ViewerVariables } from "../guests.ts";

const { barMaps, files, projects, users, variations } = schema;
const sibling = alias(variations, "sibling");

const idParam = zValidator("param", z.object({ id: z.uuid() }));

/** A barline may sit a little past the end, where the last note rings out. */
const END_TOLERANCE = 1;

export interface BarMapView extends BarMap {
  /** The file the map was made on: this one, or another variation of its version. */
  fileId: string;
  source: BarMapSource;
  updatedAt: string;
  updatedByName: string | null;
}

/**
 * The bar map a file reads: its own, or else one made on another variation of the same
 * version, since a version's variations share their times.
 */
export async function barMapOf(
  db: Database,
  organisationId: string,
  fileId: string,
): Promise<BarMapView | null> {
  const columns = {
    fileId: barMaps.fileId,
    beatsPerBar: barMaps.beatsPerBar,
    points: barMaps.points,
    source: barMaps.source,
    updatedAt: barMaps.updatedAt,
    updatedByName: users.name,
  };
  const [own] = await db
    .select(columns)
    .from(barMaps)
    .leftJoin(users, eq(users.id, barMaps.updatedBy))
    .where(inOrg(barMaps, organisationId, eq(barMaps.fileId, fileId)));
  const [shared] = own
    ? [own]
    : await db
        .select(columns)
        .from(variations)
        .innerJoin(
          sibling,
          and(
            eq(sibling.versionId, variations.versionId),
            eq(sibling.organisationId, organisationId),
            ne(sibling.fileId, fileId),
          ),
        )
        .innerJoin(
          barMaps,
          and(eq(barMaps.fileId, sibling.fileId), eq(barMaps.organisationId, organisationId)),
        )
        .leftJoin(users, eq(users.id, barMaps.updatedBy))
        .where(inOrg(variations, organisationId, eq(variations.fileId, fileId)))
        // The primary variation's map first, then the newest.
        .orderBy(desc(sibling.isPrimary), desc(barMaps.updatedAt))
        .limit(1);
  if (!shared) return null;
  return { ...shared, updatedAt: shared.updatedAt.toISOString() };
}

/**
 * `/api/files/:id/bars`: where each bar begins in a recording (#13). Anyone who can see
 * the file reads it; making or clearing one takes the "organise" permission.
 */
export const fileBarRoutes = (db: Database) =>
  new Hono<{ Variables: ViewerVariables }>()
    .get("/:id/bars", idParam, async (c) => {
      const { id } = c.req.valid("param");
      await canOnFile(db, c.var.actor, "view", id);
      return c.json({ barMap: await barMapOf(db, c.var.organisationId, id) });
    })

    .put("/:id/bars", idParam, zValidator("json", saveBarMapInput), async (c) => {
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const actor = c.var.actor;
      await canOnFile(db, actor, "organise", id);
      const organisationId = c.var.organisationId;
      const [file] = await db
        .select({ kind: files.kind, mediaInfo: files.mediaInfo, profile: projects.profile })
        .from(files)
        .innerJoin(
          projects,
          and(eq(projects.id, files.projectId), eq(projects.organisationId, organisationId)),
        )
        .where(inOrg(files, organisationId, eq(files.id, id)));
      if (!file) throw new NotFound("File");
      if (!profiles[file.profile].tools.includes("bar-ruler")) {
        throw new HTTPException(422, { message: "Bars belong to music projects" });
      }
      if (file.kind !== "audio" && file.kind !== "video") {
        throw new HTTPException(422, { message: "Only recordings have bars in time" });
      }
      const duration = file.mediaInfo?.duration;
      const last = input.points.at(-1)?.[0] ?? 0;
      if (duration !== undefined && last > duration + END_TOLERANCE) {
        throw new HTTPException(422, { message: "A barline is past the end of the recording" });
      }
      const values = {
        beatsPerBar: input.beatsPerBar,
        points: input.points,
        source: input.source,
        updatedBy: actor.kind === "guest" ? null : actor.userId,
        updatedAt: new Date(),
      };
      await db
        .insert(barMaps)
        .values({ organisationId, fileId: id, ...values })
        .onConflictDoUpdate({ target: barMaps.fileId, set: values });
      return c.json({ barMap: await barMapOf(db, organisationId, id) });
    })

    .delete("/:id/bars", idParam, async (c) => {
      const { id } = c.req.valid("param");
      await canOnFile(db, c.var.actor, "organise", id);
      await db.delete(barMaps).where(inOrg(barMaps, c.var.organisationId, eq(barMaps.fileId, id)));
      return c.body(null, 204);
    });
