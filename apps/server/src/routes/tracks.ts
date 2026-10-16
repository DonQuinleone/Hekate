import { type Database, inOrg, schema } from "@hekate/db";
import {
  addVariationInput,
  createTrackInput,
  createVersionInput,
  isPdf,
  type ProjectPermission,
  updateTrackInput,
  withPrimary,
} from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { and, asc, eq, inArray, max, ne } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { actorOf, can } from "../access.ts";
import { carryThreads } from "../carry.ts";
import { NotFound } from "../errors.ts";
import type { Jobs } from "../jobs.ts";
import type { Mailer } from "../mail.ts";
import { follow, followersOf, notifyNow } from "../notifications.ts";
import type { TenantVariables } from "../tenancy.ts";
import { trackStandings } from "../track-standing.ts";
import { folderIn, lockProject } from "./folders.ts";

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

/** A track's score: a document of the same project, whose pages show beside its recordings. */
async function assertScore(
  db: Database,
  organisationId: string,
  projectId: string,
  fileId: string,
) {
  const [file] = await db
    .select({ name: files.name, contentType: files.contentType })
    .from(files)
    .where(inOrg(files, organisationId, eq(files.projectId, projectId), eq(files.id, fileId)));
  if (!file) throw new HTTPException(422, { message: "Files must come from the same project" });
  // Only a PDF's pages are drawn, so only a PDF can show beside the recordings.
  if (!isPdf(file.name, file.contentType)) {
    throw new HTTPException(422, { message: "A score is a PDF" });
  }
}

/** A project's tracks, each with its versions (oldest first) and their variations. */
async function tracksOf(db: Database, organisationId: string, projectId: string) {
  const trackRows = await db
    .select()
    .from(tracks)
    .where(inOrg(tracks, organisationId, eq(tracks.projectId, projectId)))
    .orderBy(asc(tracks.position), asc(tracks.createdAt), asc(tracks.id));
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
          .orderBy(asc(variations.position), asc(variations.id));
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

/**
 * The project check for anything under a track. A track in a project the caller cannot see
 * is not found, like the project itself.
 */
async function canSeeTrack(
  db: Database,
  vars: TenantVariables,
  projectId: string,
  permission: ProjectPermission,
) {
  try {
    return await can(db, actorOf(vars), permission, projectId);
  } catch (error) {
    if (error instanceof NotFound) throw new NotFound("Track");
    throw error;
  }
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
      const { projectId } = await can(db, actorOf(c.var), "view", c.req.valid("param").id);
      const [list, standing] = await Promise.all([
        tracksOf(db, c.var.organisationId, projectId),
        trackStandings(db, c.var.organisationId, projectId),
      ]);
      // Where each stands, and who it waits on, for the file browser's status column.
      const by = new Map(standing.tracks.map((t) => [t.id, t]));
      return c.json({
        tracks: list.map((t) => ({
          ...t,
          state: by.get(t.id)?.state ?? ("no_version" as const),
          waitingOn: by.get(t.id)?.waitingOn ?? [],
        })),
      });
    })
    .post("/:id/tracks", idParam, zValidator("json", createTrackInput), async (c) => {
      const organisationId = c.var.organisationId;
      const input = c.req.valid("json");
      const { projectId } = await can(db, actorOf(c.var), "organise", c.req.valid("param").id);
      const project = { id: projectId };
      if (input.scoreFileId) await assertScore(db, organisationId, project.id, input.scoreFileId);
      const created = await db.transaction(async (tx) => {
        // Lock the project so tracks added at the same moment take consecutive positions,
        // and so the folder it goes in cannot be deleted meanwhile.
        await lockProject(tx, organisationId, project.id);
        if (input.folderId) await folderIn(tx, organisationId, project.id, input.folderId);
        const [last] = await tx
          .select({ position: max(tracks.position) })
          .from(tracks)
          .where(inOrg(tracks, organisationId, eq(tracks.projectId, project.id)));
        const [row] = await tx
          .insert(tracks)
          .values({
            organisationId,
            projectId: project.id,
            name: input.name,
            scoreFileId: input.scoreFileId ?? null,
            folderId: input.folderId ?? null,
            position: (last?.position ?? -1) + 1,
          })
          .returning({ id: tracks.id });
        // Whoever makes a track hears about its new versions.
        if (row) await follow(tx, organisationId, c.var.userId, { trackId: row.id });
        return row;
      });
      return c.json({ track: await oneTrack(db, organisationId, created?.id ?? "") }, 201);
    });

/** `/api/tracks/:id`: one track; renaming, linking its score, reordering; new versions. */
export const trackRoutes = (
  db: Database,
  jobs: Pick<Jobs, "send">,
  mail: { mailer: Mailer; publicUrl: string },
) =>
  new Hono<{ Variables: TenantVariables }>()
    .get("/:id", idParam, async (c) => {
      const track = await trackOf(db, c.var.organisationId, c.req.valid("param").id);
      await canSeeTrack(db, c.var, track.projectId, "view");
      return c.json({ track: await oneTrack(db, c.var.organisationId, track.id) });
    })
    .patch("/:id", idParam, zValidator("json", updateTrackInput), async (c) => {
      const organisationId = c.var.organisationId;
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const track = await trackOf(db, organisationId, id);
      await canSeeTrack(db, c.var, track.projectId, "organise");
      if (input.scoreFileId) {
        await assertScore(db, organisationId, track.projectId, input.scoreFileId);
      }
      await db.transaction(async (tx) => {
        if (input.folderId !== undefined) {
          await lockProject(tx, organisationId, track.projectId);
          if (input.folderId) await folderIn(tx, organisationId, track.projectId, input.folderId);
        }
        await tx
          .update(tracks)
          .set({ ...input, updatedAt: new Date() })
          .where(inOrg(tracks, organisationId, eq(tracks.id, id)));
      });
      return c.json({ track: await oneTrack(db, organisationId, id) });
    })
    .post("/:id/versions", idParam, zValidator("json", createVersionInput), async (c) => {
      const organisationId = c.var.organisationId;
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const track = await trackOf(db, organisationId, id);
      await canSeeTrack(db, c.var, track.projectId, "upload");
      await assertProjectFiles(
        db,
        organisationId,
        track.projectId,
        input.variations.map((v) => v.fileId),
      );
      let aligning: string[] = [];
      let made = 0;
      try {
        aligning = await db.transaction(async (tx) => {
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
          const number = (last?.number ?? 0) + 1;
          made = number;
          // Whoever adds a version follows the track from then on.
          await follow(tx, organisationId, c.var.userId, { trackId: id });
          const [version] = await tx
            .insert(versions)
            .values({
              organisationId,
              trackId: id,
              number,
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
          // The previous version's open threads come along, to be settled here.
          const [project] = await tx
            .select({ shown: projects.carriedCommentsShown })
            .from(projects)
            .where(inOrg(projects, organisationId, eq(projects.id, track.projectId)));
          return carryThreads(
            tx,
            organisationId,
            { id: version?.id ?? "", trackId: id, number },
            project?.shown ?? true,
          );
        });
      } catch (error) {
        if (violates(error, "variations_file_idx")) {
          throw new HTTPException(409, { message: "A file is already a variation of a version" });
        }
        throw error;
      }
      // Where the music moved between this version and the last, worked out from the audio.
      // The version is made either way: what the queue misses now, the sweep queues later.
      for (const alignmentId of aligning) {
        await jobs
          .send("media-align", { organisationId, alignmentId }, { singletonKey: alignmentId })
          .catch((error: unknown) =>
            console.warn(`Could not queue alignment ${alignmentId} now: ${String(error)}`),
          );
      }
      await notifyNow(
        { db, ...mail },
        {
          organisationId,
          kind: "version",
          recipients: await followersOf(db, organisationId, { trackId: id }),
          actor: { userId: c.var.userId },
          projectId: track.projectId,
          trackId: id,
          text: `added version ${made} of ${track.name}`,
          detail: input.notes || null,
          link: `/tracks/${id}`,
        },
      ).catch((error: unknown) =>
        console.warn(`Could not tell followers about a new version: ${String(error)}`),
      );
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
      await canSeeTrack(db, c.var, version.projectId, "upload");
      await assertProjectFiles(db, organisationId, version.projectId, [input.fileId]);
      try {
        await db.transaction(async (tx) => {
          // Lock the version: concurrent additions then take consecutive positions, and a
          // new primary never races another for the one-primary index.
          await tx
            .select({ id: versions.id })
            .from(versions)
            .where(inOrg(versions, organisationId, eq(versions.id, version.id)))
            .for("update");
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
      .select({
        versionId: variations.versionId,
        trackId: versions.trackId,
        projectId: tracks.projectId,
      })
      .from(variations)
      .innerJoin(versions, eq(versions.id, variations.versionId))
      .innerJoin(tracks, eq(tracks.id, versions.trackId))
      .where(inOrg(variations, organisationId, eq(variations.id, id)));
    if (!variation) throw new NotFound("Variation");
    await canSeeTrack(db, c.var, variation.projectId, "organise");
    await db.transaction(async (tx) => {
      // One switch at a time per version, so two never lock its variations in opposite orders.
      await tx
        .select({ id: versions.id })
        .from(versions)
        .where(inOrg(versions, organisationId, eq(versions.id, variation.versionId)))
        .for("update");
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
