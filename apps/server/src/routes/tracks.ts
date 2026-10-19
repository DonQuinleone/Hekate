import { type Database, inOrg, schema } from "@hekate/db";
import {
  addVariationInput,
  createTrackInput,
  createVersionInput,
  deliveryProfileChoice,
  effectiveProfile,
  type GivenEdl,
  isPdf,
  type ProjectPermission,
  parseCmx3600,
  replaceVariationInput,
  trackNormalisationInput,
  trackReferencesInput,
  updateTrackInput,
  updateVariationInput,
  versionEdlInput,
  versionRefusals,
  withPrimary,
  workspaceSettingsOf,
} from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { and, asc, eq, getTableColumns, inArray, max, ne, or } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { actorOf, can } from "../access.ts";
import { type Audit, requestInfo } from "../audit.ts";
import { carryPreview, carryThreads } from "../carry.ts";
import { assertProfileRef, customProfilesOf } from "../delivery-profiles.ts";
import { readEdlFile } from "../edl-file.ts";
import { CodedException, NotFound } from "../errors.ts";
import type { Jobs } from "../jobs.ts";
import type { Mailer } from "../mail.ts";
import { metrics } from "../metrics/index.ts";
import { follow, followersOf, notifyNow } from "../notifications.ts";
import type { Storage } from "../storage.ts";
import type { TenantVariables } from "../tenancy.ts";
import { trackStandings } from "../track-standing.ts";
import { type RunnerDeps, restartAt, runAfter, versionArrived } from "../workflow-runner.ts";
import { folderIn, lockProject } from "./folders.ts";

const {
  tracks,
  versions,
  variations,
  files,
  projects,
  loudness,
  users,
  comments,
  commentCarries,
  alignments,
} = schema;

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
    .select({ ...getTableColumns(versions), createdByName: users.name })
    .from(versions)
    .leftJoin(users, eq(users.id, versions.createdBy))
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
            subtitled: variations.subtitled,
            graded: variations.graded,
            fileName: files.name,
            kind: files.kind,
            streamStatus: files.streamStatus,
            mediaInfo: files.mediaInfo,
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
        variations: variationRows
          .filter((x) => x.versionId === version.id)
          // Of what was measured, the picture is all a rendition shows (#16).
          .map(({ mediaInfo, ...x }) => ({ ...x, video: mediaInfo?.video ?? null })),
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
  audit: Audit,
  trustProxy: boolean,
  storage: Storage,
  /** The workflows a new version moves on; without one, they run without asking for reviews. */
  runner: RunnerDeps = { db, jobs },
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
    // What this track's versions are measured against (#144), over the project's; for whoever
    // edits the project's workflow, as the project's own profile is.
    .put("/:id/delivery-profile", idParam, zValidator("json", deliveryProfileChoice), async (c) => {
      const organisationId = c.var.organisationId;
      const { id } = c.req.valid("param");
      const track = await trackOf(db, organisationId, id);
      await canSeeTrack(db, c.var, track.projectId, "edit_workflows");
      const { deliveryProfile } = c.req.valid("json");
      await db.transaction(async (tx) => {
        await assertProfileRef(tx, organisationId, deliveryProfile);
        await tx
          .update(tracks)
          .set({ deliveryProfile, updatedAt: new Date() })
          .where(inOrg(tracks, organisationId, eq(tracks.id, id)));
      });
      return c.json({ track: await oneTrack(db, organisationId, id) });
    })
    // The references its comments may name (#240), over the project's; for whoever edits the
    // project, as the project's own are.
    .put("/:id/references", idParam, zValidator("json", trackReferencesInput), async (c) => {
      const organisationId = c.var.organisationId;
      const { id } = c.req.valid("param");
      const track = await trackOf(db, organisationId, id);
      await canSeeTrack(db, c.var, track.projectId, "edit_project");
      const { references } = c.req.valid("json");
      await db
        .update(tracks)
        .set({ commentReferences: references, updatedAt: new Date() })
        .where(inOrg(tracks, organisationId, eq(tracks.id, id)));
      return c.json({ track: await oneTrack(db, organisationId, id) });
    })
    // How its recordings play normalised (#98), over the project's; for whoever edits the
    // project, as the project's own choice is.
    .put("/:id/normalisation", idParam, zValidator("json", trackNormalisationInput), async (c) => {
      const organisationId = c.var.organisationId;
      const { id } = c.req.valid("param");
      const track = await trackOf(db, organisationId, id);
      await canSeeTrack(db, c.var, track.projectId, "edit_project");
      const { normalisation } = c.req.valid("json");
      await db
        .update(tracks)
        .set({ normalisation, updatedAt: new Date() })
        .where(inOrg(tracks, organisationId, eq(tracks.id, id)));
      return c.json({ track: await oneTrack(db, organisationId, id) });
    })
    // What a new version would carry over, for whoever adds it to confirm or correct.
    .get("/:id/carry", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const track = await trackOf(db, organisationId, c.req.valid("param").id);
      await canSeeTrack(db, c.var, track.projectId, "upload");
      return c.json({ threads: await carryPreview(db, organisationId, track.id) });
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
      const [project] = await db
        .select({
          shown: projects.carriedCommentsShown,
          deliveryProfile: projects.deliveryProfile,
          checkTruePeak: projects.checkTruePeak,
          requireEdl: projects.requireEdl,
        })
        .from(projects)
        .where(inOrg(projects, organisationId, eq(projects.id, track.projectId)));
      if (input.edlFileId)
        await assertEdlFile(db, organisationId, track.projectId, input.edlFileId);
      const [customs, [org]] = await Promise.all([
        customProfilesOf(db, organisationId),
        db
          .select({ settings: schema.organisations.settings })
          .from(schema.organisations)
          .where(eq(schema.organisations.id, organisationId)),
      ]);
      const workspace = workspaceSettingsOf(org?.settings);
      // The project's checks run before the version lands (#131): a refusal says why, and
      // only someone who may edit workflows can let it through, on the record.
      const measured = await db
        .select({
          id: files.id,
          name: files.name,
          kind: files.kind,
          deliveryProfile: files.deliveryProfile,
          mediaInfo: files.mediaInfo,
          streamStatus: files.streamStatus,
          analysisStatus: files.analysisStatus,
          summary: loudness.summary,
        })
        .from(files)
        .leftJoin(
          loudness,
          and(eq(loudness.fileId, files.id), eq(loudness.organisationId, organisationId)),
        )
        .where(
          inOrg(
            files,
            organisationId,
            inArray(
              files.id,
              input.variations.map((v) => v.fileId),
            ),
          ),
        );
      // Where the project asks for a list, it is read as well (#56): how many edits it holds,
      // and where the last one ends, to set against the version's length.
      let given: GivenEdl | null = null;
      if (input.edlFileId) {
        const list = project?.requireEdl
          ? await readEdlFile(db, storage, organisationId, input.edlFileId)
          : null;
        const events = list ? parseCmx3600(list.text).events : [];
        given = {
          name: list?.name ?? "The edit decision list",
          edits: events.length,
          end: Math.max(0, ...events.map((e) => e.recordOut)),
        };
      }
      const refusals = versionRefusals(
        { truePeak: Boolean(project?.checkTruePeak), edl: Boolean(project?.requireEdl) },
        // Each file against its own profile, else this track's, the project's or the workspace's.
        (f) => {
          const file = measured.find((m) => m.id === f.id);
          return effectiveProfile(
            {
              file: file?.deliveryProfile ?? null,
              track: track.deliveryProfile,
              project: project?.deliveryProfile ?? null,
              workspace: workspace.deliveryProfile,
            },
            f.channels,
            customs,
            // An ADM master is measured against Atmos, as on its QA view (#74).
            Boolean(file?.mediaInfo?.metadata?.adm),
          ).profile;
        },
        measured.map((f) => ({
          id: f.id,
          name: f.name,
          // Audio and video are checked; until the worker has probed one, it is measuring.
          channels:
            f.kind !== "audio" && f.kind !== "video"
              ? null
              : f.mediaInfo
                ? (f.mediaInfo.audio?.channels ?? null)
                : f.streamStatus === "failed" || f.analysisStatus === "failed"
                  ? null
                  : undefined,
          // Not measured yet while analysis runs; a file that could not be measured is
          // left to the people reviewing it.
          truePeak: f.summary
            ? f.summary.truePeak
            : f.analysisStatus === "failed" || f.analysisStatus === "none"
              ? null
              : undefined,
          // Undefined until the worker has probed it, as for its channels.
          duration:
            f.kind !== "audio" && f.kind !== "video"
              ? null
              : f.mediaInfo
                ? (f.mediaInfo.duration ?? null)
                : f.streamStatus === "failed" || f.analysisStatus === "failed"
                  ? null
                  : undefined,
        })),
        given,
      );
      const letThrough = refusals.length > 0 && input.letThrough === true;
      if (refusals.length > 0 && !letThrough) {
        const waiting = refusals.every((r) => r.check === "measuring");
        // Still being measured is a wait, not a refusal.
        for (const r of refusals)
          if (r.check !== "measuring")
            metrics.uploadsRefused.inc({ workspace: c.var.organisationId, rule: r.check });
        throw new CodedException(
          waiting ? 409 : 422,
          waiting ? "version_measuring" : "version_refused",
          refusals
            .filter((r) => waiting || r.check !== "measuring")
            .map((r) => r.message)
            .join(" "),
        );
      }
      if (letThrough) await canSeeTrack(db, c.var, track.projectId, "edit_workflows");
      // Restarting a workflow from a stage (#25) is for those who edit workflows; the stage
      // is checked, and the restart made, in the version's own transaction (`restartAt`).
      const restartFrom = input.restartFrom ?? null;
      if (restartFrom) await canSeeTrack(db, c.var, track.projectId, "edit_workflows");
      let restarted: Awaited<ReturnType<typeof restartAt>> = [];
      const who = letThrough ? await audit.member(c.var.userId) : null;
      let aligning: string[] = [];
      let made = 0;
      let madeId = "";
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
              edlFileId: input.edlFileId ?? null,
              letThroughBy: letThrough ? c.var.userId : null,
              createdBy: c.var.userId,
            })
            .returning({ id: versions.id });
          madeId = version?.id ?? "";
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
          if (who) {
            await audit.record(
              organisationId,
              who,
              {
                action: "version.let_through",
                projectId: track.projectId,
                details: {
                  trackId: id,
                  version: number,
                  checks: [...new Set(refusals.map((r) => r.check))],
                },
              },
              requestInfo(c, trustProxy),
              tx,
            );
          }
          // The workflow chosen starts again at its stage with the version, or neither lands.
          if (restartFrom)
            restarted = await restartAt(tx, runner, {
              organisationId,
              projectId: track.projectId,
              trackId: id,
              versionId: madeId,
              userId: c.var.userId,
              ...restartFrom,
            });
          // The previous version's open threads come along, to be settled here, as whoever
          // added it chose.
          return carryThreads(
            tx,
            organisationId,
            { id: version?.id ?? "", trackId: id, number },
            project?.shown ?? true,
            input.carry ?? {},
            c.var.userId,
          );
        });
      } catch (error) {
        if (violates(error, "variations_file_idx")) {
          throw new HTTPException(409, { message: "A file is already a variation of a version" });
        }
        throw error;
      }
      await runAfter(restarted);
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
      // The project's workflows hear of it (#25): each starts, or carries on, for this track.
      await versionArrived(runner, {
        organisationId,
        projectId: track.projectId,
        trackId: id,
        versionId: madeId,
        userId: c.var.userId,
      });
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
/** An edit decision list for a version: an .edl file of the same project, or a 422. */
async function assertEdlFile(
  db: Database,
  organisationId: string,
  projectId: string,
  fileId: string,
) {
  const [edl] = await db
    .select({ name: files.name })
    .from(files)
    .where(inOrg(files, organisationId, eq(files.projectId, projectId), eq(files.id, fileId)));
  if (!edl) throw new HTTPException(422, { message: "Files must come from the same project" });
  if (!/\.edl$/i.test(edl.name)) {
    throw new HTTPException(422, { message: "An edit decision list is an .edl file" });
  }
}

export const versionRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
    // A version's edit decision list, given or changed after it was made (#56), or taken off.
    .put("/:id/edl", idParam, zValidator("json", versionEdlInput), async (c) => {
      const organisationId = c.var.organisationId;
      const { fileId } = c.req.valid("json");
      const version = await versionOf(db, organisationId, c.req.valid("param").id);
      await canSeeTrack(db, c.var, version.projectId, "organise");
      if (fileId) await assertEdlFile(db, organisationId, version.projectId, fileId);
      await db
        .update(versions)
        .set({ edlFileId: fileId, updatedAt: new Date() })
        .where(inOrg(versions, organisationId, eq(versions.id, version.id)));
      return c.json({ track: await oneTrack(db, organisationId, version.trackId) });
    })
    .post("/:id/variations", idParam, zValidator("json", addVariationInput), async (c) => {
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
    });

/** `/api/variations/:id/primary`: make this the variation a version opens with. */
export const variationRoutes = (
  db: Database,
  jobs: Pick<Jobs, "send">,
  audit: Audit,
  trustProxy: boolean,
) =>
  new Hono<{ Variables: TenantVariables }>()
    // A variation's name, and a rendition's treatment (#16), for those who organise the project.
    .patch("/:id", idParam, zValidator("json", updateVariationInput), async (c) => {
      const organisationId = c.var.organisationId;
      const { id } = c.req.valid("param");
      const [variation] = await db
        .select({
          trackId: versions.trackId,
          projectId: tracks.projectId,
          profile: projects.profile,
        })
        .from(variations)
        .innerJoin(versions, eq(versions.id, variations.versionId))
        .innerJoin(tracks, eq(tracks.id, versions.trackId))
        .innerJoin(projects, eq(projects.id, tracks.projectId))
        .where(inOrg(variations, organisationId, eq(variations.id, id)));
      if (!variation) throw new NotFound("Variation");
      await canSeeTrack(db, c.var, variation.projectId, "organise");
      const input = c.req.valid("json");
      // A treatment is a rendition's (decision 138): a music variation has only a name.
      if (
        variation.profile !== "video" &&
        (input.subtitled !== undefined || input.graded !== undefined)
      ) {
        throw new HTTPException(422, {
          message: "Only a video project's renditions are subtitled or graded",
        });
      }
      await db
        .update(variations)
        .set({ ...input, updatedAt: new Date() })
        .where(inOrg(variations, organisationId, eq(variations.id, id)));
      return c.json({ track: await oneTrack(db, organisationId, variation.trackId) });
    })
    .post("/:id/primary", idParam, async (c) => {
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
    })
    /**
     * Replace a variation's file with another of the same kind (a corrected export), for
     * those who organise the project. Its threads, carried threads and alignments move to
     * the new file, so the comments are kept; the old file stays in the project, loose.
     */
    .post("/:id/replace", idParam, zValidator("json", replaceVariationInput), async (c) => {
      const organisationId = c.var.organisationId;
      const { id } = c.req.valid("param");
      const { fileId } = c.req.valid("json");
      const [variation] = await db
        .select({
          versionId: variations.versionId,
          fileId: variations.fileId,
          trackId: versions.trackId,
          projectId: tracks.projectId,
          kind: files.kind,
        })
        .from(variations)
        .innerJoin(versions, eq(versions.id, variations.versionId))
        .innerJoin(tracks, eq(tracks.id, versions.trackId))
        .innerJoin(files, eq(files.id, variations.fileId))
        .where(inOrg(variations, organisationId, eq(variations.id, id)));
      if (!variation) throw new NotFound("Variation");
      await canSeeTrack(db, c.var, variation.projectId, "organise");
      if (fileId === variation.fileId) {
        throw new HTTPException(422, { message: "That is already this variation's file" });
      }
      const [replacement] = await db
        .select({ kind: files.kind })
        .from(files)
        .where(
          inOrg(
            files,
            organisationId,
            eq(files.projectId, variation.projectId),
            eq(files.id, fileId),
          ),
        );
      if (!replacement) {
        throw new HTTPException(422, { message: "Files must come from the same project" });
      }
      if (replacement.kind !== variation.kind) {
        throw new HTTPException(422, { message: "Replace it with a file of the same kind" });
      }
      const who = await audit.member(c.var.userId);
      let realign: string[] = [];
      try {
        realign = await db.transaction(async (tx) => {
          // As a new version does: settling threads waits while they move. The variation is
          // read again under the lock, so two replacements at once move from the file it has.
          await tx
            .select({ id: tracks.id })
            .from(tracks)
            .where(inOrg(tracks, organisationId, eq(tracks.id, variation.trackId)))
            .for("update");
          const [current] = await tx
            .select({ fileId: variations.fileId })
            .from(variations)
            .where(inOrg(variations, organisationId, eq(variations.id, id)))
            .for("update");
          if (!current) throw new NotFound("Variation");
          if (current.fileId === fileId) {
            throw new HTTPException(422, { message: "That is already this variation's file" });
          }
          const old = current.fileId;
          const now = new Date();
          await tx
            .update(variations)
            .set({ fileId, updatedAt: now })
            .where(inOrg(variations, organisationId, eq(variations.id, id)));
          await tx
            .update(comments)
            .set({ fileId, updatedAt: now })
            .where(inOrg(comments, organisationId, eq(comments.fileId, old)));
          await tx
            .update(commentCarries)
            .set({ fileId, updatedAt: now })
            .where(inOrg(commentCarries, organisationId, eq(commentCarries.fileId, old)));
          // Where the music moved is worked out again, against the new file.
          const moved = await tx
            .select({
              id: alignments.id,
              fromFileId: alignments.fromFileId,
              toFileId: alignments.toFileId,
            })
            .from(alignments)
            .where(
              inOrg(
                alignments,
                organisationId,
                or(eq(alignments.fromFileId, old), eq(alignments.toFileId, old)),
              ),
            );
          for (const a of moved) {
            await tx
              .update(alignments)
              .set({
                fromFileId: a.fromFileId === old ? fileId : a.fromFileId,
                toFileId: a.toFileId === old ? fileId : a.toFileId,
                status: "pending",
                points: null,
                quality: null,
                updatedAt: now,
              })
              .where(inOrg(alignments, organisationId, eq(alignments.id, a.id)));
          }
          await audit.record(
            organisationId,
            who,
            {
              action: "variation.replace",
              projectId: variation.projectId,
              fileId,
              details: { variationId: id, replaced: old },
            },
            requestInfo(c, trustProxy),
            tx,
          );
          return moved.map((a) => a.id);
        });
      } catch (error) {
        if (violates(error, "variations_file_idx")) {
          throw new HTTPException(409, {
            message: "That file is already a variation of a version",
          });
        }
        throw error;
      }
      for (const alignmentId of realign) {
        await jobs
          .send("media-align", { organisationId, alignmentId }, { singletonKey: alignmentId })
          .catch((error: unknown) =>
            console.warn(`Could not queue alignment ${alignmentId} now: ${String(error)}`),
          );
      }
      return c.json({ track: await oneTrack(db, organisationId, variation.trackId) });
    });
