import { type Database, inOrg, schema } from "@hekate/db";
import {
  addVariationInput,
  createTrackInput,
  createVersionInput,
  updateTrackInput,
  withPrimary,
} from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { and, asc, eq, inArray, max, ne } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { NotFound } from "../errors.ts";
import type { TenantVariables } from "../tenancy.ts";

const { tracks, versions, variations, files, projects } = schema;

const idParam = zValidator("param", z.object({ id: z.uuid() }));

/** True when a statement failed on the named unique index. */
function violates(error: unknown, index: string): boolean {
  const cause = (error as { cause?: { code?: string; constraint_name?: string } }).cause;
  return cause?.code === "23505" && cause.constraint_name === index;
}

/** Every file id must belong to the project, in this organisation. */
async function assertProjectFiles(
  db: Database,
  organisationId: string,
  projectId: string,
  fileIds: string[],
) {
  if (fileIds.length === 0) return;
  const found = await db
    .select({ id: files.id })
    .from(files)
    .where(
      inOrg(files, organisationId, eq(files.projectId, projectId), inArray(files.id, fileIds)),
    );
  if (found.length !== new Set(fileIds).size) {
    throw new HTTPException(422, { message: "Files must come from the same project" });
  }
}

/** A project's tracks, each with its versions (oldest first) and their variations. */
async function tracksOf(db: Database, organisationId: string, projectId: string) {
  const trackRows = await db
    .select()
    .from(tracks)
    .where(inOrg(tracks, organisationId, eq(tracks.projectId, projectId)))
    .orderBy(asc(tracks.position), asc(tracks.createdAt));
  if (trackRows.length === 0) return [];
  const versionRows = await db
    .select()
    .from(versions)
    .where(
      inOrg(
        versions,
        organisationId,
        inArray(
          versions.trackId,
          trackRows.map((t) => t.id),
        ),
      ),
    )
    .orderBy(asc(versions.number));
  const variationRows =
    versionRows.length === 0
      ? []
      : await db
          .select({
            id: variations.id,
            versionId: variations.versionId,
            fileId: variations.fileId,
            name: variations.name,
            isPrimary: variations.isPrimary,
            position: variations.position,
            fileName: files.name,
            kind: files.kind,
            streamStatus: files.streamStatus,
          })
          .from(variations)
          .innerJoin(files, eq(files.id, variations.fileId))
          .where(
            inOrg(
              variations,
              organisationId,
              inArray(
                variations.versionId,
                versionRows.map((v) => v.id),
              ),
            ),
          )
          .orderBy(asc(variations.position));
  return trackRows.map((track) => ({
    ...track,
    versions: versionRows
      .filter((v) => v.trackId === track.id)
      .map((version) => ({
        ...version,
        variations: variationRows.filter((x) => x.versionId === version.id),
      })),
  }));
}

async function trackOf(db: Database, organisationId: string, id: string) {
  const [track] = await db
    .select()
    .from(tracks)
    .where(inOrg(tracks, organisationId, eq(tracks.id, id)));
  if (!track) throw new NotFound("Track");
  return track;
}

async function oneTrack(db: Database, organisationId: string, id: string) {
  const track = await trackOf(db, organisationId, id);
  const [withVersions] = (await tracksOf(db, organisationId, track.projectId)).filter(
    (t) => t.id === id,
  );
  return withVersions;
}

/** `/api/projects/:id/tracks`: a project's tracks, and adding one. */
export const projectTrackRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
    .get("/:id/tracks", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const [project] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(inOrg(projects, organisationId, eq(projects.id, c.req.valid("param").id)));
      if (!project) throw new NotFound("Project");
      return c.json({ tracks: await tracksOf(db, organisationId, project.id) });
    })
    .post("/:id/tracks", idParam, zValidator("json", createTrackInput), async (c) => {
      const organisationId = c.var.organisationId;
      const input = c.req.valid("json");
      const [project] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(inOrg(projects, organisationId, eq(projects.id, c.req.valid("param").id)));
      if (!project) throw new NotFound("Project");
      if (input.scoreFileId) {
        await assertProjectFiles(db, organisationId, project.id, [input.scoreFileId]);
      }
      const [last] = await db
        .select({ position: max(tracks.position) })
        .from(tracks)
        .where(inOrg(tracks, organisationId, eq(tracks.projectId, project.id)));
      const [created] = await db
        .insert(tracks)
        .values({
          organisationId,
          projectId: project.id,
          name: input.name,
          scoreFileId: input.scoreFileId ?? null,
          position: (last?.position ?? -1) + 1,
        })
        .returning({ id: tracks.id });
      return c.json({ track: await oneTrack(db, organisationId, created?.id ?? "") }, 201);
    });

/** `/api/tracks/:id`: one track; renaming, linking its score, reordering; new versions. */
export const trackRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
    .get("/:id", idParam, async (c) =>
      c.json({ track: await oneTrack(db, c.var.organisationId, c.req.valid("param").id) }),
    )
    .patch("/:id", idParam, zValidator("json", updateTrackInput), async (c) => {
      const organisationId = c.var.organisationId;
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const track = await trackOf(db, organisationId, id);
      if (input.scoreFileId) {
        await assertProjectFiles(db, organisationId, track.projectId, [input.scoreFileId]);
      }
      await db
        .update(tracks)
        .set({ ...input, updatedAt: new Date() })
        .where(inOrg(tracks, organisationId, eq(tracks.id, id)));
      return c.json({ track: await oneTrack(db, organisationId, id) });
    })
    .post("/:id/versions", idParam, zValidator("json", createVersionInput), async (c) => {
      const organisationId = c.var.organisationId;
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const track = await trackOf(db, organisationId, id);
      await assertProjectFiles(
        db,
        organisationId,
        track.projectId,
        input.variations.map((v) => v.fileId),
      );
      try {
        await db.transaction(async (tx) => {
          // Lock the track so concurrent new versions take consecutive numbers.
          await tx
            .select({ id: tracks.id })
            .from(tracks)
            .where(inOrg(tracks, organisationId, eq(tracks.id, id)))
            .for("update");
          const [last] = await tx
            .select({ number: max(versions.number) })
            .from(versions)
            .where(inOrg(versions, organisationId, eq(versions.trackId, id)));
          const [version] = await tx
            .insert(versions)
            .values({
              organisationId,
              trackId: id,
              number: (last?.number ?? 0) + 1,
              notes: input.notes || null,
              createdBy: c.var.userId,
            })
            .returning({ id: versions.id });
          await tx.insert(variations).values(
            withPrimary(input.variations).map((v) => ({
              organisationId,
              versionId: version?.id ?? "",
              fileId: v.fileId,
              name: v.name,
              isPrimary: v.isPrimary,
              position: v.position,
            })),
          );
        });
      } catch (error) {
        if (violates(error, "variations_file_idx")) {
          throw new HTTPException(409, { message: "A file is already a variation of a version" });
        }
        throw error;
      }
      return c.json({ track: await oneTrack(db, organisationId, id) }, 201);
    });

async function versionOf(db: Database, organisationId: string, id: string) {
  const [row] = await db
    .select({ id: versions.id, trackId: versions.trackId, projectId: tracks.projectId })
    .from(versions)
    .innerJoin(tracks, eq(tracks.id, versions.trackId))
    .where(inOrg(versions, organisationId, eq(versions.id, id)));
  if (!row) throw new NotFound("Version");
  return row;
}

/** `/api/versions/:id/variations`: another treatment of the same edit. */
export const versionRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>().post(
    "/:id/variations",
    idParam,
    zValidator("json", addVariationInput),
    async (c) => {
      const organisationId = c.var.organisationId;
      const input = c.req.valid("json");
      const version = await versionOf(db, organisationId, c.req.valid("param").id);
      await assertProjectFiles(db, organisationId, version.projectId, [input.fileId]);
      try {
        await db.transaction(async (tx) => {
          const [last] = await tx
            .select({ position: max(variations.position) })
            .from(variations)
            .where(inOrg(variations, organisationId, eq(variations.versionId, version.id)));
          if (input.primary) {
            await tx
              .update(variations)
              .set({ isPrimary: false, updatedAt: new Date() })
              .where(inOrg(variations, organisationId, eq(variations.versionId, version.id)));
          }
          await tx.insert(variations).values({
            organisationId,
            versionId: version.id,
            fileId: input.fileId,
            name: input.name,
            isPrimary: Boolean(input.primary),
            position: (last?.position ?? -1) + 1,
          });
        });
      } catch (error) {
        if (violates(error, "variations_file_idx")) {
          throw new HTTPException(409, {
            message: "That file is already a variation of a version",
          });
        }
        throw error;
      }
      return c.json({ track: await oneTrack(db, organisationId, version.trackId) }, 201);
    },
  );

/** `/api/variations/:id/primary`: make this the variation a version opens with. */
export const variationRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>().post("/:id/primary", idParam, async (c) => {
    const organisationId = c.var.organisationId;
    const { id } = c.req.valid("param");
    const [variation] = await db
      .select({ versionId: variations.versionId, trackId: versions.trackId })
      .from(variations)
      .innerJoin(versions, eq(versions.id, variations.versionId))
      .where(inOrg(variations, organisationId, eq(variations.id, id)));
    if (!variation) throw new NotFound("Variation");
    await db.transaction(async (tx) => {
      // Clear the old primary first: the partial unique index allows one at a time.
      await tx
        .update(variations)
        .set({ isPrimary: false, updatedAt: new Date() })
        .where(
          inOrg(
            variations,
            organisationId,
            and(eq(variations.versionId, variation.versionId), ne(variations.id, id)),
          ),
        );
      await tx
        .update(variations)
        .set({ isPrimary: true, updatedAt: new Date() })
        .where(inOrg(variations, organisationId, eq(variations.id, id)));
    });
    return c.json({ track: await oneTrack(db, organisationId, variation.trackId) });
  });
