import { type Database, inOrg, schema } from "@hekate/db";
import {
  analysisKey,
  defaultAnalysis,
  effectiveNormalisation,
  isDefaultAnalysis,
  isFollowingPart,
  marks,
  type PlayerTool,
  rateLimits,
  spectrumAnalysisSchema,
  watermarkOf,
} from "@hekate/shared";
import { unwrapKey } from "@hekate/storage";
import { and, asc, count, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  type Actor,
  canOnFile,
  fileAccess,
  guestFileReviews,
  guestReach,
  mayUseTool,
  toolRefused,
} from "../access.ts";
import { alignmentsFrom } from "../alignment-graph.ts";
import { type Audit, requestInfo } from "../audit.ts";
import { CodedException, NotFound } from "../errors.ts";
import { chainOf } from "../file-chains.ts";
import type { PlaySessionVariables, ViewerVariables } from "../guests.ts";
import type { Jobs } from "../jobs.ts";
import type { Keyring } from "../keyring.ts";
import { watermark } from "../media/watermark.ts";
import { normalisationOf } from "../normalisation.ts";
import { zValidator } from "../openapi/validator.ts";
import {
  PLAYBACK_LIFETIME_SECONDS,
  type PlaybackClaims,
  signPlayback,
  verifyPlayback,
} from "../playback.ts";
import { admit, tooMany } from "../rate-limit.ts";
import { referencesOfFile } from "../references.ts";
import type { Storage } from "../storage.ts";
import {
  assertOpen,
  assertSecondFactor,
  assertSessionAllowed,
  assertSignedInThrough,
  membershipOf,
  type SecondFactorRule,
} from "../tenancy.ts";
import { bothNames } from "../variants.ts";
import { viewerMark } from "../viewer-mark.ts";
import { noteOpened } from "./reviews.ts";

const {
  accessEvents,
  filePages,
  files,
  renditions,
  renditionSegments,
  users,
  peakLevels,
  loudness,
  spectrograms,
  spectrogramVariantFailures,
  spectrogramVariants,
  variants,
  versions,
  tracks,
  takes,
  projects,
} = schema;

export interface PlaybackDeps {
  db: Database;
  storage: Storage;
  keyring: Keyring;
  audit: Audit;
  secret: Buffer;
  trustProxy: boolean;
  /** What the instance asks of every account's sign-in. */
  secondFactor: SecondFactorRule;
  /** Scratch space for marking pages (WORK_DIR). */
  workDir?: string;
  /** For spectrograms with a viewer's own analysis settings, drawn when first asked for (#34). */
  jobs: Pick<Jobs, "send">;
}

/** The analysis a spectrogram is asked for with (#34); anything left out is the default. */
const analysisQuery = zValidator("query", spectrumAnalysisSchema.partial());

/** Nothing about playback may be cached or shared: every response is per viewer, per session. */
const PRIVATE = {
  "cache-control": "no-store, private",
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
} as const;

const fileParam = zValidator("param", z.object({ id: z.uuid() }));

/** `/api/files/:id`: one file's details, and `POST /api/files/:id/playback` to start watching or listening. */
/**
 * Every `/api/files/:id…` route here reads a file: its project must let the caller view it.
 * A file in a project they cannot see does not exist for them (404).
 */
const viewFile = (db: Database) =>
  createMiddleware<{ Variables: ViewerVariables }>(async (c, next) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) throw new NotFound("File");
    await canOnFile(db, c.var.actor, "view", id.data);
    await next();
  });

/**
 * As `viewFile`, for an engineer's tool: a guest whose review leaves the tool out, or a member
 * whose role has it off (#240), is refused it here, not only hidden in the interface.
 */
/**
 * The files a guest may open, to keep what a file is compared with to those; null for a
 * member, who sees the whole project.
 */
async function reachable(db: Database, actor: Actor): Promise<Set<string> | null> {
  if (actor.kind !== "guest") return null;
  return new Set(
    [...(await guestReach(db, actor))]
      // A take shared on a thread is theirs to hear, not to compare.
      .filter(([, through]) => through.some((t) => !t.shared))
      .map(([fileId]) => fileId),
  );
}

/** A file's version chain (#149), oldest first, without the files a guest cannot open. */
async function shownChain(db: Database, actor: Actor, fileId: string) {
  const chain = await chainOf(db, actor.organisationId, fileId);
  const reached = await reachable(db, actor);
  const shown = reached ? chain.filter((f) => reached.has(f.id)) : chain;
  return shown.length > 1 ? shown : [];
}

/** A variant as the file page shows it; the track's settings stay on the server. */
const shownVariant = <V extends { trackNormalisation: unknown }>({
  trackNormalisation: _,
  ...shown
}: V) => shown;

const toolFile = (db: Database, tool: PlayerTool) =>
  createMiddleware<{ Variables: ViewerVariables }>(async (c, next) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) throw new NotFound("File");
    const access = await canOnFile(db, c.var.actor, "view", id.data);
    if (!mayUseTool(access, tool)) throw toolRefused(access);
    await next();
  });

export const fileRoutes = (deps: PlaybackDeps) =>
  new Hono<{ Variables: ViewerVariables }>()
    .use("/:id", viewFile(deps.db))
    .use("/:id/peaks/*", viewFile(deps.db))
    .use("/:id/peaks", viewFile(deps.db))
    .use("/:id/loudness/*", toolFile(deps.db, "meters"))
    .use("/:id/loudness", toolFile(deps.db, "meters"))
    .use("/:id/spectrograms/*", toolFile(deps.db, "spectrogram"))
    .use("/:id/spectrograms", toolFile(deps.db, "spectrogram"))
    .use("/:id/playback", viewFile(deps.db))
    .use("/:id/view", viewFile(deps.db))
    .use("/:id/alignments", toolFile(deps.db, "compare"))
    .use("/:id/compare", toolFile(deps.db, "compare"))
    .get("/:id", fileParam, async (c) => {
      // Metadata only: contents leave Hekate solely through protected delivery.
      const [file] = await deps.db
        .select({
          id: files.id,
          projectId: files.projectId,
          folderId: files.folderId,
          name: files.name,
          kind: files.kind,
          contentType: files.contentType,
          byteSize: files.byteSize,
          mediaInfo: files.mediaInfo,
          streamStatus: files.streamStatus,
          analysisStatus: files.analysisStatus,
          pageCount: files.pageCount,
          /** A take's file has its place in the take; a loose file can have versions (#149). */
          takeId: files.takeId,
          uploadedBy: users.name,
          createdAt: files.createdAt,
          /** The project's profile decides which tools the file page offers. */
          profile: projects.profile,
          commentReferences: projects.commentReferences,
          normalisation: projects.normalisation,
          watermark: projects.watermark,
        })
        .from(files)
        .innerJoin(
          projects,
          and(eq(projects.id, files.projectId), eq(projects.organisationId, c.var.organisationId)),
        )
        .leftJoin(users, eq(files.uploadedBy, users.id))
        .where(inOrg(files, c.var.organisationId, eq(files.id, c.req.valid("param").id)));
      if (!file) throw new NotFound("File");
      // Where the file sits in the music model, if it is a variant of a track's version.
      const [variant] = await deps.db
        .select({
          id: variants.id,
          name: variants.name,
          isPrimary: variants.isPrimary,
          versionId: versions.id,
          versionNumber: versions.number,
          trackId: tracks.id,
          trackName: tracks.name,
          /** The score linked to the track, shown beside the recording. */
          scoreFileId: tracks.scoreFileId,
          /** How the track plays normalised, over the project's (#98). */
          trackNormalisation: tracks.normalisation,
        })
        .from(variants)
        .innerJoin(
          versions,
          and(
            eq(versions.id, variants.versionId),
            eq(versions.organisationId, c.var.organisationId),
          ),
        )
        .innerJoin(
          tracks,
          and(eq(tracks.id, versions.trackId), eq(tracks.organisationId, c.var.organisationId)),
        )
        .where(inOrg(variants, c.var.organisationId, eq(variants.fileId, file.id)));
      // A take plays as its track does (#98).
      const [take] = variant
        ? []
        : await deps.db
            .select({ trackNormalisation: tracks.normalisation })
            .from(files)
            .innerJoin(
              takes,
              and(eq(takes.id, files.takeId), eq(takes.organisationId, c.var.organisationId)),
            )
            .innerJoin(
              tracks,
              and(eq(tracks.id, takes.trackId), eq(tracks.organisationId, c.var.organisationId)),
            )
            .where(inOrg(files, c.var.organisationId, eq(files.id, file.id)));
      // A guest's review decides which tools and actions they have; members have their role.
      const access = await fileAccess(deps.db, c.var.actor, file.id);
      const { commentReferences, normalisation, watermark: marking, ...shownFile } = file;
      // A video's mark is laid over it in the player (#31); pages and pictures carry theirs
      // burned in, so the player has nothing to add for them.
      const style = watermarkOf(marking);
      const viewer = c.var.actor.kind === "guest" ? "guest" : "member";
      const markText =
        file.kind === "video" && marks(style, viewer)
          ? await viewerMark(deps.db, c.var.actor)
          : null;
      // Opening a file a review asks someone about counts as opening that item.
      await noteOpened(deps.db, c.var.actor, file.id);
      return c.json({
        file: {
          ...shownFile,
          // What reviewers may type beside a comment (#240).
          references: await referencesOfFile(deps.db, c.var.organisationId, file.id, {
            profile: file.profile,
            commentReferences,
          }),
          variant: variant ? shownVariant(variant) : null,
          // Its simple version chain (#149), as far as this person may open it.
          chain: await shownChain(deps.db, c.var.actor, file.id),
          grant: access?.grant ?? null,
          watermark: markText
            ? { text: markText, position: style.position, opacity: style.opacity }
            : null,
          // Normalised playback (#240): the volume only, for those it applies to.
          normalisation: await normalisationOf(
            deps.db,
            c.var.organisationId,
            file,
            // The track's own choice, where it has one (#98).
            effectiveNormalisation(
              variant?.trackNormalisation ?? take?.trackNormalisation,
              normalisation,
            ),
            access ? mayUseTool(access, "normalise") : false,
          ),
          // A member's player tools, from their role (#240); a guest's come with their grant.
          tools: access && "tools" in access ? [...access.tools] : null,
        },
      });
    })
    // Where the same music sits in this file and the others it was aligned with, read from
    // this file's side. Members compare versions; guests only the files their reviews give.
    .get("/:id/alignments", fileParam, async (c) => {
      const all = await alignmentsFrom(deps.db, c.var.organisationId, c.req.valid("param").id);
      const reached = await reachable(deps.db, c.var.actor);
      return c.json({ alignments: reached ? all.filter((a) => reached.has(a.fileId)) : all });
    })
    // What a file can be compared with (#44): its track's versions and their variants, as far
    // as the person may open them. A loose file has none.
    .get("/:id/compare", fileParam, async (c) => {
      const org = c.var.organisationId;
      const fileId = c.req.valid("param").id;
      const [mine] = await deps.db
        .select({ trackId: versions.trackId })
        .from(variants)
        .innerJoin(
          versions,
          and(eq(versions.id, variants.versionId), eq(versions.organisationId, org)),
        )
        .where(inOrg(variants, org, eq(variants.fileId, fileId)));
      if (!mine) return c.json({ versions: [] });
      const rows = await deps.db
        .select({
          versionId: versions.id,
          number: versions.number,
          fileId: variants.fileId,
          name: variants.name,
          isPrimary: variants.isPrimary,
          position: variants.position,
          streamStatus: files.streamStatus,
        })
        .from(variants)
        .innerJoin(
          versions,
          and(eq(versions.id, variants.versionId), eq(versions.organisationId, org)),
        )
        .innerJoin(files, and(eq(files.id, variants.fileId), eq(files.organisationId, org)))
        .where(inOrg(variants, org, eq(versions.trackId, mine.trackId)))
        .orderBy(asc(versions.number), asc(variants.position));
      const reached = await reachable(deps.db, c.var.actor);
      const shown = reached ? rows.filter((r) => reached.has(r.fileId)) : rows;
      const byVersion = new Map<
        string,
        {
          id: string;
          number: number;
          variants: Omit<(typeof shown)[number], "versionId" | "number">[];
        }
      >();
      for (const r of shown) {
        const version = byVersion.get(r.versionId) ?? {
          id: r.versionId,
          number: r.number,
          variants: [],
        };
        version.variants.push({
          fileId: r.fileId,
          name: r.name,
          isPrimary: r.isPrimary,
          position: r.position,
          streamStatus: r.streamStatus,
        });
        byVersion.set(r.versionId, version);
      }
      return c.json({
        versions: [...byVersion.values()].map((v) => ({ ...v, ...bothNames(v.variants) })),
      });
    })
    // Waveform peaks: an 8-bit envelope per channel, from which no audio can be rebuilt, so
    // members fetch them directly rather than through playback tokens.
    .get("/:id/peaks", fileParam, async (c) => {
      const organisationId = c.var.organisationId;
      const [file] = await deps.db
        .select({ id: files.id, analysisStatus: files.analysisStatus })
        .from(files)
        .where(inOrg(files, organisationId, eq(files.id, c.req.valid("param").id)));
      if (!file) throw new NotFound("File");
      const levels = await deps.db
        .select({
          id: peakLevels.id,
          samplesPerPeak: peakLevels.samplesPerPeak,
          count: peakLevels.peakCount,
          channels: peakLevels.channels,
          sampleRate: peakLevels.sampleRate,
        })
        .from(peakLevels)
        .where(inOrg(peakLevels, organisationId, eq(peakLevels.fileId, file.id)))
        .orderBy(asc(peakLevels.samplesPerPeak));
      return c.json({ status: file.analysisStatus, levels }, 200, { "cache-control": "no-store" });
    })
    .get(
      "/:id/peaks/:levelId",
      zValidator("param", z.object({ id: z.uuid(), levelId: z.uuid() })),
      async (c) => {
        const { id, levelId } = c.req.valid("param");
        const organisationId = c.var.organisationId;
        const [level] = await deps.db
          .select({ blobId: peakLevels.blobId })
          .from(peakLevels)
          .where(
            inOrg(
              peakLevels,
              organisationId,
              eq(peakLevels.id, levelId),
              eq(peakLevels.fileId, id),
            ),
          );
        if (!level) throw new NotFound("Peaks");
        const { blob, stream } = await deps.storage.open(organisationId, level.blobId);
        return new Response(stream as unknown as ReadableStream, {
          headers: {
            ...PRIVATE,
            "content-type": "application/octet-stream",
            "content-length": String(blob.byteSize),
          },
        });
      },
    )
    // Loudness and levels: numbers about the audio, like peaks, so members fetch them directly.
    .get("/:id/loudness", fileParam, async (c) => {
      const organisationId = c.var.organisationId;
      const [file] = await deps.db
        .select({ id: files.id, analysisStatus: files.analysisStatus })
        .from(files)
        .where(inOrg(files, organisationId, eq(files.id, c.req.valid("param").id)));
      if (!file) throw new NotFound("File");
      const [row] = await deps.db
        .select({
          summary: loudness.summary,
          channels: loudness.channels,
          sampleRate: loudness.sampleRate,
          samplesPerFrame: loudness.samplesPerFrame,
          count: loudness.frameCount,
        })
        .from(loudness)
        .where(inOrg(loudness, organisationId, eq(loudness.fileId, file.id)));
      const { summary = null, ...series } = row ?? {};
      return c.json({ status: file.analysisStatus, summary, series: row ? series : null }, 200, {
        "cache-control": "no-store",
      });
    })
    .get("/:id/loudness/series", fileParam, async (c) => {
      const organisationId = c.var.organisationId;
      const [row] = await deps.db
        .select({ blobId: loudness.blobId })
        .from(loudness)
        .where(inOrg(loudness, organisationId, eq(loudness.fileId, c.req.valid("param").id)));
      if (!row) throw new NotFound("Loudness");
      const { blob, stream } = await deps.storage.open(organisationId, row.blobId);
      return new Response(stream as unknown as ReadableStream, {
        headers: {
          ...PRIVATE,
          "content-type": "application/octet-stream",
          "content-length": String(blob.byteSize),
        },
      });
    })
    // Spectrograms: band levels over time, from which no audio can be rebuilt (like peaks).
    // With a viewer's own analysis settings (#34), the first ask queues them, and the
    // answer is pending until they are drawn.
    .get("/:id/spectrograms", fileParam, analysisQuery, async (c) => {
      const organisationId = c.var.organisationId;
      const [file] = await deps.db
        .select({ id: files.id, analysisStatus: files.analysisStatus })
        .from(files)
        .where(inOrg(files, organisationId, eq(files.id, c.req.valid("param").id)));
      if (!file) throw new NotFound("File");
      const analysis = { ...defaultAnalysis, ...c.req.valid("query") };
      const noStore = { "cache-control": "no-store" };
      if (isDefaultAnalysis(analysis)) {
        const rows = await deps.db
          .select({
            id: spectrograms.id,
            channel: spectrograms.channel,
            fftSize: spectrograms.fftSize,
            sampleRate: spectrograms.sampleRate,
            samplesPerColumn: spectrograms.samplesPerColumn,
            columns: spectrograms.columnCount,
            bands: spectrograms.bandCount,
          })
          .from(spectrograms)
          .where(inOrg(spectrograms, organisationId, eq(spectrograms.fileId, file.id)));
        return c.json({ status: file.analysisStatus, spectrograms: rows }, 200, noStore);
      }
      // Drawn from the analysed file, so not before it is analysed, and never for one that failed.
      if (file.analysisStatus !== "ready")
        return c.json({ status: file.analysisStatus, spectrograms: [] }, 200, noStore);
      const key = analysisKey(analysis);
      const ofThis = inOrg(
        spectrogramVariants,
        organisationId,
        eq(spectrogramVariants.fileId, file.id),
        eq(spectrogramVariants.analysis, key),
      );
      const rows = await deps.db
        .update(spectrogramVariants)
        .set({ usedAt: new Date() })
        .where(ofThis)
        .returning({
          id: spectrogramVariants.id,
          channel: spectrogramVariants.channel,
          fftSize: spectrogramVariants.fftSize,
          sampleRate: spectrogramVariants.sampleRate,
          samplesPerColumn: spectrogramVariants.samplesPerColumn,
          columns: spectrogramVariants.columnCount,
          bands: spectrogramVariants.bandCount,
        });
      if (rows.length > 0) return c.json({ status: "ready", spectrograms: rows }, 200, noStore);
      // Tried to the last and failed: said so, and drawn again only when asked (below).
      const [failed] = await deps.db
        .select({ id: spectrogramVariantFailures.id })
        .from(spectrogramVariantFailures)
        .where(
          inOrg(
            spectrogramVariantFailures,
            organisationId,
            eq(spectrogramVariantFailures.fileId, file.id),
            eq(spectrogramVariantFailures.analysis, key),
          ),
        );
      if (failed) return c.json({ status: "failed", spectrograms: [] }, 200, noStore);
      await deps.jobs.send(
        "spectrogram-variant",
        { organisationId, fileId: file.id, analysis: key },
        { singletonKey: `${file.id}:${key}` },
      );
      return c.json({ status: "pending", spectrograms: [] }, 200, noStore);
    })
    // Settings that could not be drawn, tried again on request (#34).
    .post(
      "/:id/spectrograms/retry",
      fileParam,
      zValidator("json", spectrumAnalysisSchema),
      async (c) => {
        const organisationId = c.var.organisationId;
        const fileId = c.req.valid("param").id;
        const key = analysisKey(c.req.valid("json"));
        const gone = await deps.db
          .delete(spectrogramVariantFailures)
          .where(
            inOrg(
              spectrogramVariantFailures,
              organisationId,
              eq(spectrogramVariantFailures.fileId, fileId),
              eq(spectrogramVariantFailures.analysis, key),
            ),
          )
          .returning({ id: spectrogramVariantFailures.id });
        if (gone.length === 0) throw new NotFound("Failed spectrogram");
        await deps.jobs.send(
          "spectrogram-variant",
          { organisationId, fileId, analysis: key },
          { singletonKey: `${fileId}:${key}` },
        );
        return c.body(null, 202);
      },
    )
    .get(
      "/:id/spectrograms/:spectrogramId",
      zValidator("param", z.object({ id: z.uuid(), spectrogramId: z.uuid() })),
      async (c) => {
        const { id, spectrogramId } = c.req.valid("param");
        const organisationId = c.var.organisationId;
        // The file's own spectrograms, or one drawn with a viewer's settings (#34).
        const [row] = await deps.db
          .select({ blobId: spectrograms.blobId })
          .from(spectrograms)
          .where(
            inOrg(
              spectrograms,
              organisationId,
              eq(spectrograms.id, spectrogramId),
              eq(spectrograms.fileId, id),
            ),
          )
          .union(
            deps.db
              .select({ blobId: spectrogramVariants.blobId })
              .from(spectrogramVariants)
              .where(
                inOrg(
                  spectrogramVariants,
                  organisationId,
                  eq(spectrogramVariants.id, spectrogramId),
                  eq(spectrogramVariants.fileId, id),
                ),
              ),
          );
        if (!row) throw new NotFound("Spectrogram");
        const { blob, stream } = await deps.storage.open(organisationId, row.blobId);
        return new Response(stream as unknown as ReadableStream, {
          headers: {
            ...PRIVATE,
            "content-type": "application/octet-stream",
            "content-length": String(blob.byteSize),
          },
        });
      },
    )
    // Pages of a document or picture (#29): a session-bound link to each page the server
    // drew, never the file. Each page is logged as it is served.
    .post("/:id/view", fileParam, async (c) => {
      const { id } = c.req.valid("param");
      const organisationId = c.var.organisationId;
      const [file] = await deps.db
        .select({
          id: files.id,
          streamStatus: files.streamStatus,
          pageCount: files.pageCount,
          printedBars: files.printedBars,
          kind: files.kind,
        })
        .from(files)
        .where(inOrg(files, organisationId, eq(files.id, id)));
      if (!file) throw new NotFound("File");
      if ((file.kind !== "document" && file.kind !== "image") || file.streamStatus !== "ready") {
        throw new HTTPException(409, {
          message:
            file.streamStatus === "pending"
              ? "This file is still being prepared"
              : "This file has no pages to show",
        });
      }
      const pages = await deps.db
        .select({ page: filePages.page, width: filePages.width, height: filePages.height })
        .from(filePages)
        .where(inOrg(filePages, organisationId, eq(filePages.fileId, file.id)))
        .orderBy(asc(filePages.page));
      const actor = c.var.actor;
      const reviewId =
        actor.kind === "guest"
          ? (await guestFileReviews(deps.db, actor)).get(file.id)?.[0]
          : undefined;
      if (actor.kind === "guest" && !reviewId) throw new NotFound("File");
      const expiresAt = Math.floor(Date.now() / 1000) + PLAYBACK_LIFETIME_SECONDS;
      const token = signPlayback(deps.secret, {
        sessionId: c.var.sessionId,
        organisationId,
        fileId: file.id,
        ...(reviewId ? { reviewId } : {}),
        expiresAt,
      });
      return c.json(
        {
          expiresAt: new Date(expiresAt * 1000),
          pageCount: file.pageCount ?? pages.length,
          // The bar numbers a score prints, on the pages drawn, for going to a bar (#52).
          bars: (file.printedBars ?? []).filter((b) => b.page <= pages.length),
          pages: pages.map((p) => ({
            ...p,
            url: `/api/play/${token}/pages/${p.page}/view`,
            thumbUrl: `/api/play/${token}/pages/${p.page}/thumb`,
          })),
        },
        201,
      );
    })
    .post("/:id/playback", fileParam, async (c) => {
      const { id } = c.req.valid("param");
      const organisationId = c.var.organisationId;
      const [file] = await deps.db
        .select({
          id: files.id,
          kind: files.kind,
          projectId: files.projectId,
          streamStatus: files.streamStatus,
          filmstripFrames: files.filmstripFrames,
        })
        .from(files)
        .where(inOrg(files, organisationId, eq(files.id, id)));
      if (!file) throw new NotFound("File");
      // Documents and pictures are viewed as pages, never played (and never logged as played).
      if (file.kind !== "audio" && file.kind !== "video") {
        throw new HTTPException(409, { message: "Only recordings play; this file is viewed" });
      }
      if (file.streamStatus !== "ready") {
        throw new HTTPException(409, {
          message:
            file.streamStatus === "pending"
              ? "This file is still being prepared"
              : "This file cannot be played",
        });
      }
      const available = await deps.db
        .select({
          id: renditions.id,
          name: renditions.name,
          codecs: renditions.codecs,
          bandwidth: renditions.bandwidth,
          width: renditions.width,
          height: renditions.height,
        })
        .from(renditions)
        .where(inOrg(renditions, organisationId, eq(renditions.fileId, file.id)))
        .orderBy(asc(renditions.bandwidth));
      const expiresAt = Math.floor(Date.now() / 1000) + PLAYBACK_LIFETIME_SECONDS;
      // A guest plays a file through a review: the newest open one that includes it.
      const actor = c.var.actor;
      const reviewId =
        actor.kind === "guest"
          ? (await guestFileReviews(deps.db, actor)).get(file.id)?.[0]
          : undefined;
      if (actor.kind === "guest" && !reviewId) throw new NotFound("File");
      const token = signPlayback(deps.secret, {
        sessionId: c.var.sessionId,
        organisationId,
        fileId: file.id,
        ...(reviewId ? { reviewId } : {}),
        expiresAt,
      });
      const event = {
        action: "stream.session" as const,
        projectId: file.projectId,
        fileId: file.id,
        ...(reviewId ? { reviewId } : {}),
      };
      const who = await deps.audit.actor(actor);
      const request = requestInfo(c, deps.trustProxy);
      // A review may limit how often a guest plays each file (#55): every start is a play,
      // counted and recorded together, one start at a time per guest and file. The limit and
      // the count are the review's this play goes through, so a new review starts afresh.
      const limit =
        actor.kind === "guest"
          ? ((await guestReach(deps.db, actor)).get(file.id)?.find((r) => r.reviewId === reviewId)
              ?.permissions.maxPlays ?? null)
          : null;
      if (actor.kind === "guest" && limit !== null) {
        const allowed = await deps.db.transaction(async (tx) => {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtext(${`plays:${actor.guestId}:${file.id}:${reviewId}`}))`,
          );
          const [played] = await tx
            .select({ n: count() })
            .from(accessEvents)
            .where(
              inOrg(
                accessEvents,
                organisationId,
                eq(accessEvents.guestId, actor.guestId),
                eq(accessEvents.fileId, file.id),
                eq(accessEvents.action, "stream.session"),
                reviewId ? eq(accessEvents.reviewId, reviewId) : undefined,
              ),
            );
          if ((played?.n ?? 0) >= limit) return false;
          await deps.audit.record(organisationId, who, event, request, tx);
          return true;
        });
        if (!allowed)
          throw new CodedException(
            403,
            "plays_used",
            // Said of a review and a share alike (#138): whoever sent it can allow more.
            `You have played this file ${limit === 1 ? "the one time" : `all ${limit} times`} you were given. Whoever sent it can give you more.`,
          );
      } else await deps.audit.record(organisationId, who, event, request);
      return c.json(
        {
          url: `/api/play/${token}/master.m3u8`,
          expiresAt: new Date(expiresAt * 1000),
          // So the player can name what it offers; the playlists carry the same ids.
          renditions: available,
          // A video's frames along it (#16), through this link like its streams.
          filmstrip: file.filmstripFrames
            ? { url: `/api/play/${token}/filmstrip`, frames: file.filmstripFrames }
            : null,
        },
        201,
      );
    });

type PlayVariables = PlaySessionVariables & { playback: PlaybackClaims; actor: Actor };

/**
 * `/api/play/:token/...`: playlists, the initialisation section, segments and the key.
 * Every request needs a valid token, the session cookie it was issued to, and current
 * membership of the file's organisation. Segments are AES-128 ciphertext; the key
 * comes only from the key route, which is rate-limited and logged.
 */
export const playRoutes = (deps: PlaybackDeps) => {
  const authorise = createMiddleware<{ Variables: PlayVariables }>(async (c, next) => {
    const claims = verifyPlayback(deps.secret, c.req.param("token") ?? "");
    // One answer for forged, expired and someone else's tokens: nothing to learn from it.
    if (!claims || claims.sessionId !== c.var.sessionId) {
      throw new HTTPException(403, { message: "This playback link is not valid for you" });
    }
    // Still in the organisation, and still allowed to view the file: a role taken away, or a
    // guest's review closed, ends playback at once.
    const who = c.var.who;
    let actor: Actor;
    if (who.kind === "guest") {
      // Still in the review the link was issued through, and that review still open.
      const through = (await guestFileReviews(deps.db, who)).get(claims.fileId) ?? [];
      if (
        who.organisationId !== claims.organisationId ||
        !claims.reviewId ||
        !through.includes(claims.reviewId)
      ) {
        throw new HTTPException(403, { message: "This playback link is not valid for you" });
      }
      actor = who;
    } else {
      const membership = await membershipOf(deps.db, who.userId, claims.organisationId);
      if (!membership) {
        throw new HTTPException(403, { message: "This playback link is not valid for you" });
      }
      // A workspace suspended, or that has come to ask for a second factor or for single
      // sign-on, ends playback at once too.
      await assertOpen(deps.db, claims.organisationId);
      // So does a session the workspace has since ended, or no longer lets in.
      await assertSessionAllowed(deps.db, claims.sessionId, {
        organisationId: claims.organisationId,
        role: membership.role,
      });
      await assertSignedInThrough(deps.db, claims.sessionId, {
        organisationId: claims.organisationId,
        role: membership.role,
      });
      await assertSecondFactor(
        deps.db,
        claims.sessionId,
        { organisationId: claims.organisationId, role: membership.role },
        deps.secondFactor,
      );
      actor = {
        kind: "member",
        userId: who.userId,
        organisationId: claims.organisationId,
        organisationRole: membership.role,
      };
    }
    if (!(await fileAccess(deps.db, actor, claims.fileId))) {
      throw new HTTPException(403, { message: "This playback link is not valid for you" });
    }
    c.set("actor", actor);
    c.set("playback", claims);
    await next();
  });

  const renditionsOf = (claims: PlaybackClaims) =>
    deps.db
      .select()
      .from(renditions)
      .where(inOrg(renditions, claims.organisationId, eq(renditions.fileId, claims.fileId)))
      .orderBy(asc(renditions.bandwidth));

  const renditionOf = async (claims: PlaybackClaims, renditionId: string) => {
    const [row] = await deps.db
      .select()
      .from(renditions)
      .where(
        inOrg(
          renditions,
          claims.organisationId,
          eq(renditions.id, renditionId),
          eq(renditions.fileId, claims.fileId),
        ),
      );
    if (!row) throw new NotFound("Rendition");
    return row;
  };

  const ridParam = zValidator("param", z.object({ token: z.string(), rid: z.uuid() }));

  const sendBlob = async (organisationId: string, blobId: string, contentType: string) => {
    const { blob, stream } = await deps.storage.open(organisationId, blobId);
    return new Response(stream as unknown as ReadableStream, {
      headers: { ...PRIVATE, "content-type": contentType, "content-length": String(blob.byteSize) },
    });
  };

  return new Hono<{ Variables: PlayVariables }>()
    .use("/:token/*", authorise)

    .get("/:token/master.m3u8", async (c) => {
      const rows = await renditionsOf(c.var.playback);
      if (rows.length === 0) throw new NotFound("Rendition");
      const lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"];
      // A part carrying a wide layout's later channels is no alternative to the rest: it plays
      // beside the first part, from its own playlist, never chosen in place of it (#74).
      for (const r of rows.filter((x) => !isFollowingPart(x.name))) {
        const resolution = r.width && r.height ? `,RESOLUTION=${r.width}x${r.height}` : "";
        lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${r.bandwidth},CODECS="${r.codecs}"${resolution}`);
        lines.push(`r/${r.id}/index.m3u8`);
      }
      return c.body(`${lines.join("\n")}\n`, 200, {
        ...PRIVATE,
        "content-type": "application/vnd.apple.mpegurl",
      });
    })

    .get("/:token/r/:rid/index.m3u8", ridParam, async (c) => {
      const claims = c.var.playback;
      const rendition = await renditionOf(claims, c.req.valid("param").rid);
      const segments = await deps.db
        .select({
          index: renditionSegments.index,
          duration: renditionSegments.duration,
          iv: renditionSegments.iv,
        })
        .from(renditionSegments)
        .where(
          inOrg(
            renditionSegments,
            claims.organisationId,
            eq(renditionSegments.renditionId, rendition.id),
          ),
        )
        .orderBy(asc(renditionSegments.index));
      const lines = [
        "#EXTM3U",
        "#EXT-X-VERSION:7",
        `#EXT-X-TARGETDURATION:${rendition.targetDuration}`,
        "#EXT-X-PLAYLIST-TYPE:VOD",
        "#EXT-X-INDEPENDENT-SEGMENTS",
        // The initialisation section is encrypted too, so its key tag must carry an IV (RFC 8216).
        `#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0x${rendition.initIv}`,
        '#EXT-X-MAP:URI="init.mp4"',
      ];
      for (const s of segments) {
        lines.push(`#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0x${s.iv}`);
        lines.push(`#EXTINF:${s.duration.toFixed(6)},`);
        lines.push(`seg/${s.index}.m4s`);
      }
      lines.push("#EXT-X-ENDLIST");
      return c.body(`${lines.join("\n")}\n`, 200, {
        ...PRIVATE,
        "content-type": "application/vnd.apple.mpegurl",
      });
    })

    .get("/:token/r/:rid/init.mp4", ridParam, async (c) => {
      const rendition = await renditionOf(c.var.playback, c.req.valid("param").rid);
      return sendBlob(
        rendition.organisationId,
        rendition.initBlobId,
        rendition.height ? "video/mp4" : "audio/mp4",
      );
    })

    .get(
      "/:token/r/:rid/seg/:segment",
      zValidator(
        "param",
        z.object({ token: z.string(), rid: z.uuid(), segment: z.string().regex(/^\d{1,6}\.m4s$/) }),
      ),
      async (c) => {
        const claims = c.var.playback;
        const { rid, segment } = c.req.valid("param");
        const rendition = await renditionOf(claims, rid);
        const index = Number.parseInt(segment, 10);
        const [row] = await deps.db
          .select({ blobId: renditionSegments.blobId, projectId: files.projectId })
          .from(renditionSegments)
          .innerJoin(files, inOrg(files, claims.organisationId, eq(files.id, claims.fileId)))
          .where(
            inOrg(
              renditionSegments,
              claims.organisationId,
              eq(renditionSegments.renditionId, rendition.id),
              eq(renditionSegments.index, index),
            ),
          );
        if (!row) throw new NotFound("Segment");
        // Logged before it is sent, like keys: which parts of a file reached whom.
        await deps.audit.record(
          claims.organisationId,
          await deps.audit.actor(c.var.actor),
          {
            action: "stream.segment",
            projectId: row.projectId,
            fileId: claims.fileId,
            ...(claims.reviewId ? { reviewId: claims.reviewId } : {}),
            details: { rendition: rendition.name, segment: index },
          },
          requestInfo(c, deps.trustProxy),
        );
        return sendBlob(
          rendition.organisationId,
          row.blobId,
          rendition.height ? "video/mp4" : "audio/mp4",
        );
      },
    )

    .get(
      "/:token/pages/:page/:size",
      zValidator(
        "param",
        z.object({
          token: z.string(),
          page: z.coerce.number().int().positive().max(10_000),
          size: z.enum(["view", "thumb"]),
        }),
      ),
      async (c) => {
        const claims = c.var.playback;
        const { page, size } = c.req.valid("param");
        const [row] = await deps.db
          .select({
            blobId: filePages.blobId,
            thumbBlobId: filePages.thumbBlobId,
            projectId: files.projectId,
            watermark: projects.watermark,
          })
          .from(filePages)
          .innerJoin(files, inOrg(files, claims.organisationId, eq(files.id, claims.fileId)))
          .innerJoin(
            projects,
            and(
              eq(projects.id, files.projectId),
              eq(projects.organisationId, claims.organisationId),
            ),
          )
          .where(
            inOrg(
              filePages,
              claims.organisationId,
              eq(filePages.fileId, claims.fileId),
              eq(filePages.page, page),
            ),
          );
        if (!row) throw new NotFound("Page");
        // A page at review size is logged before it is sent: what was seen, by whom.
        if (size === "view") {
          await deps.audit.record(
            claims.organisationId,
            await deps.audit.actor(c.var.actor),
            {
              action: "page.render",
              projectId: row.projectId,
              fileId: claims.fileId,
              ...(claims.reviewId ? { reviewId: claims.reviewId } : {}),
              details: { page },
            },
            requestInfo(c, deps.trustProxy),
          );
        }
        const blobId = size === "view" ? row.blobId : row.thumbBlobId;
        const actor = c.var.actor;
        // The page carries the viewer's name, burned in here, where the project marks them
        // (#31, docs/security.md): guests unless it marks no one, members when it marks everyone.
        const style = watermarkOf(row.watermark);
        if (!marks(style, actor.kind === "guest" ? "guest" : "member"))
          return sendBlob(claims.organisationId, blobId, "image/webp");
        const text = await viewerMark(deps.db, actor);
        if (!text) throw new NotFound("Page");
        const { stream } = await deps.storage.open(claims.organisationId, blobId);
        const stored = Buffer.concat(await stream.toArray());
        const marked = await watermark(
          stored,
          text,
          size,
          c.req.raw.signal,
          style,
          "webp",
          deps.workDir,
        );
        return c.body(new Uint8Array(marked), 200, {
          ...PRIVATE,
          "content-type": "image/webp",
          "content-length": String(marked.length),
        });
      },
    )

    .get("/:token/filmstrip", async (c) => {
      const claims = c.var.playback;
      const [row] = await deps.db
        .select({
          blobId: files.filmstripBlobId,
          frames: files.filmstripFrames,
          watermark: projects.watermark,
        })
        .from(files)
        .innerJoin(
          projects,
          and(eq(projects.id, files.projectId), eq(projects.organisationId, claims.organisationId)),
        )
        .where(inOrg(files, claims.organisationId, eq(files.id, claims.fileId)));
      if (!row?.blobId) throw new NotFound("Filmstrip");
      // Small frames to find a place by, as a page's thumbnails are: each frame marked where the
      // project marks this viewer, and, like thumbnails, not logged apart from its stream.
      const actor = c.var.actor;
      const style = watermarkOf(row.watermark);
      if (!marks(style, actor.kind === "guest" ? "guest" : "member"))
        return sendBlob(claims.organisationId, row.blobId, "image/webp");
      const text = await viewerMark(deps.db, actor);
      if (!text) throw new NotFound("Filmstrip");
      const { stream } = await deps.storage.open(claims.organisationId, row.blobId);
      const stored = Buffer.concat(await stream.toArray());
      const marked = await watermark(
        stored,
        text,
        "frame",
        c.req.raw.signal,
        style,
        "webp",
        deps.workDir,
        row.frames ?? undefined,
      );
      return c.body(new Uint8Array(marked), 200, {
        ...PRIVATE,
        "content-type": "image/webp",
        "content-length": String(marked.length),
      });
    })

    .get("/:token/r/:rid/key", ridParam, async (c) => {
      const claims = c.var.playback;
      // Thirty a minute per session, counted where every replica sees it.
      const { allowed, retryAfter } = await admit(
        deps.db,
        `key:${c.var.sessionId}`,
        rateLimits.contentKeys,
      );
      if (!allowed) return tooMany(c, retryAfter, "Too many key requests; wait a minute");
      const rendition = await renditionOf(claims, c.req.valid("param").rid);
      const [file] = await deps.db
        .select({ projectId: files.projectId })
        .from(files)
        .where(inOrg(files, claims.organisationId, eq(files.id, claims.fileId)));
      // Logged before the key leaves: no record, no key.
      await deps.audit.record(
        claims.organisationId,
        await deps.audit.actor(c.var.actor),
        {
          action: "stream.key",
          fileId: claims.fileId,
          ...(claims.reviewId ? { reviewId: claims.reviewId } : {}),
          ...(file ? { projectId: file.projectId } : {}),
          details: { rendition: rendition.name },
        },
        requestInfo(c, deps.trustProxy),
      );
      const organisationKey = await deps.keyring.version(
        claims.organisationId,
        rendition.keyVersion,
      );
      const key = unwrapKey(organisationKey, rendition.wrappedKey, `rendition:${rendition.id}`);
      return c.body(new Uint8Array(key), 200, {
        ...PRIVATE,
        "content-type": "application/octet-stream",
      });
    });
};
