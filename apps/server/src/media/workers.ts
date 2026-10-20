import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { type Database, inOrg, schema, uuidv7 } from "@hekate/db";
import {
  encodeLoudness,
  encodePeaks,
  layoutsWithLfe,
  lfeChannels,
  type MediaInfo,
  type PrintedBar,
  type QaCheck,
  type QaFinding,
  usableAlignment,
} from "@hekate/shared";
import { wrapKey } from "@hekate/storage";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { remapCarries } from "../carry.ts";
import { type JobHandler, type Jobs, jobDefinitions } from "../jobs.ts";
import type { Keyring } from "../keyring.ts";
import { tellProcessingFailed } from "../notifications.ts";
import { rehomePending } from "../score-swap.ts";
import type { Storage } from "../storage.ts";
import { expireUploads } from "../uploads.ts";
import { hasObjects, renderAdm, renderedInfo } from "./adm-render.ts";
import { alignInThread } from "./align.ts";
import { analyseAudio, declaredLength } from "./analysis.ts";
import { InvalidMediaError, probe } from "./ffmpeg.ts";
import { pageSourceOf, printedBars, renderPages } from "./pages.ts";
import { analysePicture } from "./picture.ts";
import {
  type PackagedRendition,
  packageRendition,
  planRenditions,
  type VideoLadder,
} from "./proxy.ts";
import { spectrogramsInThread } from "./spectrogram.ts";
import { together } from "./together.ts";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

import { bandwidthOf } from "./bandwidth.ts";
import { FILMSTRIP_FRAMES, makeFilmstrip } from "./filmstrip.ts";
import { lfeOf } from "./lfe.ts";
import { sweepWorkspaces, withWorkspace } from "./workspace.ts";

const {
  alignments,
  filePages,
  files,
  blobs,
  renditions,
  renditionSegments,
  peakLevels,
  loudness,
  qaFindings,
  spectrograms,
  tracks,
} = schema;

export interface MediaWorkerDeps {
  db: Database;
  storage: Storage;
  keyring: Keyring;
  /** For chaining: a measured file queues its proxies. */
  jobs: Pick<Jobs, "send">;
  /** Scratch space for decrypted media while a job runs; a tmpfs is ideal. */
  workDir?: string;
  /** Where the EBU ADM Renderer is installed (ADM_RENDERER_PATH); without it, objects go unheard. */
  admRenderer?: string;
  /** What video is encoded into (#148); the defaults where the instance says nothing. */
  videoLadder?: VideoLadder;
}

/**
 * Remove blobs a failed job stored but never recorded. Any that cannot be removed now
 * (storage down) are logged and stay as unreferenced blobs, which reconciliation finds.
 */
async function discard(storage: Storage, organisationId: string, blobIds: string[], what: string) {
  const left: string[] = [];
  for (const blobId of blobIds) {
    await storage.remove(organisationId, blobId).catch(() => left.push(blobId));
  }
  if (left.length > 0) {
    console.warn(`Could not remove ${left.length} blobs (${what}): ${left.join(", ")}`);
  }
}

/**
 * A file has been measured, or cannot be: the workflow checks stages waiting on it look again
 * (#25). A send that fails is left to the hourly sweep rather than failing the job.
 */
/** A video's picture is checked (#42); an audio file's artwork is not. */
const pictureOf = (kind: string, info: MediaInfo | null | undefined) =>
  kind === "video" ? info?.video : undefined;

async function measured(deps: MediaWorkerDeps, organisationId: string, fileId: string) {
  await deps.jobs
    .send("workflow-checks", { organisationId, fileId })
    .catch((failure: unknown) =>
      console.warn(`Could not tell workflows file ${fileId} was measured: ${String(failure)}`),
    );
}

/** Decrypt a blob into the job's workspace and return the path. */
async function materialise(
  storage: Storage,
  organisationId: string,
  blobId: string,
  dir: string,
  signal: AbortSignal,
  name = "input",
) {
  const path = join(dir, name);
  const { stream } = await storage.open(organisationId, blobId);
  await pipeline(stream, createWriteStream(path, { mode: 0o600 }), { signal });
  return path;
}

export function probeHandler(deps: MediaWorkerDeps): JobHandler<"media-probe"> {
  return async ({ organisationId, fileId }, job) => {
    const [file] = await deps.db
      .select({ id: files.id, kind: files.kind, blobId: files.blobId })
      .from(files)
      .where(inOrg(files, organisationId, eq(files.id, fileId)));
    // Deleted since it was queued, or never media: nothing to measure.
    if (!file || (file.kind !== "audio" && file.kind !== "video")) return;

    let info: MediaInfo;
    try {
      info = await withWorkspace(deps.workDir, async (dir) => {
        const path = await materialise(deps.storage, organisationId, file.blobId, dir, job.signal);
        try {
          return await probe(path, { signal: job.signal });
        } catch (error) {
          // The tool ran and rejected the file: retrying will not help. Record that it was
          // examined and found nothing, and keep the reason in the log. Anything else
          // (ffprobe missing, a timeout, cancellation) is thrown, so the queue retries it.
          if (error instanceof InvalidMediaError) {
            console.warn(`Probe found no readable media in file ${fileId}: ${error.message}`);
            return {};
          }
          throw error;
        }
      });
    } catch (error) {
      // Out of retries: say so, rather than leave the file waiting to be prepared.
      if (job.retryCount >= jobDefinitions["media-probe"].options.retryLimit) {
        await deps.db
          .update(files)
          .set({ streamStatus: "failed" })
          .where(inOrg(files, organisationId, eq(files.id, fileId)));
        await tellProcessingFailed(deps.db, organisationId, fileId);
        await measured(deps, organisationId, fileId);
      }
      throw error;
    }

    const playable = Boolean(info.audio || info.video);
    const checked = Boolean(info.audio || pictureOf(file.kind, info));
    await deps.db
      .update(files)
      .set({
        mediaInfo: info,
        ...(playable ? {} : { streamStatus: "failed" as const }),
        ...(checked ? { analysisStatus: "pending" as const } : {}),
      })
      .where(inOrg(files, organisationId, eq(files.id, fileId)));
    if (!playable) await tellProcessingFailed(deps.db, organisationId, fileId);
    if (playable) {
      await deps.jobs.send("media-proxy", { organisationId, fileId }, { singletonKey: fileId });
    }
    if (checked) {
      await deps.jobs.send("media-analysis", { organisationId, fileId }, { singletonKey: fileId });
    } else {
      // Without sound or picture it is not checked, which a checks stage may have been waiting
      // to learn.
      await measured(deps, organisationId, fileId);
    }
  };
}

/**
 * Make a file playable: package HLS renditions, encrypt every segment under a fresh
 * content key per rendition, store the segments as blobs and record the renditions.
 * Idempotent: a file that already has renditions is left alone.
 */
export function proxyHandler(deps: MediaWorkerDeps): JobHandler<"media-proxy"> {
  const markFailed = async (organisationId: string, fileId: string) => {
    await deps.db
      .update(files)
      .set({ streamStatus: "failed" })
      .where(inOrg(files, organisationId, eq(files.id, fileId)));
    await tellProcessingFailed(deps.db, organisationId, fileId);
  };

  return async ({ organisationId, fileId }, job) => {
    const [file] = await deps.db
      .select()
      .from(files)
      .where(inOrg(files, organisationId, eq(files.id, fileId)));
    if (!file || (file.kind !== "audio" && file.kind !== "video") || !file.mediaInfo) return;
    const existing = await deps.db
      .select({ id: renditions.id })
      .from(renditions)
      .where(inOrg(renditions, organisationId, eq(renditions.fileId, fileId)))
      .limit(1);
    if (existing.length > 0) return;

    const plans = planRenditions(file.kind, file.mediaInfo, deps.videoLadder);
    if (plans.length === 0) {
      await markFailed(organisationId, fileId);
      return;
    }

    const stored: string[] = [];
    const store = async (bytes: Buffer, contentType: string) => {
      // Made from the file, so kept where its project keeps new files (#240).
      const blob = await deps.storage.put(organisationId, bytes, {
        contentType,
        projectId: file.projectId,
      });
      stored.push(blob.id);
      return blob.id;
    };
    try {
      const organisationKey = await deps.keyring.current(organisationId);
      const mediaInfo = file.mediaInfo;
      let rendered: string | undefined;
      const packaged = await withWorkspace(deps.workDir, async (dir) => {
        let input = await materialise(deps.storage, organisationId, file.blobId, dir, job.signal);
        let planned = plans;
        // An ADM master's objects are heard through a render of it onto its bed's layout, which
        // its streams carry (decision 140). Should the render fail, its bed is heard as before.
        if (file.kind === "audio" && deps.admRenderer && hasObjects(mediaInfo)) {
          try {
            const render = await renderAdm(input, dir, mediaInfo, deps.admRenderer, job.signal);
            input = render.path;
            planned = planRenditions("audio", renderedInfo(mediaInfo, render.target));
            rendered = render.target.layout;
          } catch (error) {
            if (job.signal?.aborted) throw error;
            console.warn(`Could not render the objects of file ${fileId}:`, error);
          }
        }
        const results: { id: string; wrappedKey: string; rendition: PackagedRendition }[] = [];
        for (const plan of planned) {
          const id = uuidv7();
          const contentKey = randomBytes(16);
          try {
            const wrappedKey = wrapKey(organisationKey.key, contentKey, `rendition:${id}`);
            const rendition = await packageRendition(
              input,
              dir,
              plan,
              contentKey,
              store,
              job.signal,
            );
            results.push({ id, wrappedKey, rendition });
          } finally {
            contentKey.fill(0);
          }
        }
        // A video's filmstrip (#16), from the same copy. Without one the video still plays.
        let filmstrip: string | null = null;
        if (file.kind === "video" && mediaInfo.video && (mediaInfo.duration ?? 0) > 0) {
          try {
            const picture = await makeFilmstrip(input, dir, mediaInfo.duration ?? 0, job.signal);
            filmstrip = await store(picture, "image/webp");
          } catch (error) {
            if (job.signal?.aborted) throw error;
            console.warn(`Could not make the filmstrip of file ${fileId}:`, error);
          }
        }
        return { results, filmstrip };
      });

      await deps.db.transaction(async (tx) => {
        for (const { id, wrappedKey, rendition } of packaged.results) {
          await tx.insert(renditions).values({
            id,
            organisationId,
            fileId,
            name: rendition.plan.name,
            codecs: rendition.plan.codecs,
            bandwidth: rendition.bandwidth,
            width: rendition.plan.width ?? null,
            height: rendition.plan.height ?? null,
            targetDuration: rendition.targetDuration,
            initBlobId: rendition.initBlobId,
            initIv: rendition.initIv,
            wrappedKey,
            keyVersion: organisationKey.version,
          });
          await tx.insert(renditionSegments).values(
            rendition.segments.map((segment, index) => ({
              organisationId,
              renditionId: id,
              index,
              duration: segment.duration,
              blobId: segment.blobId,
              iv: segment.iv,
            })),
          );
        }
        const metadata = mediaInfo.metadata;
        const adm = metadata?.adm;
        await tx
          .update(files)
          .set({
            streamStatus: "ready",
            ...(packaged.filmstrip
              ? { filmstripBlobId: packaged.filmstrip, filmstripFrames: FILMSTRIP_FRAMES }
              : {}),
            // What the streams carry, for the player to hear them as (decision 140); a retry
            // whose render failed carries the bed again, and says so.
            ...(metadata && adm
              ? {
                  mediaInfo: { ...mediaInfo, metadata: { ...metadata, adm: { ...adm, rendered } } },
                }
              : {}),
          })
          .where(inOrg(files, organisationId, eq(files.id, fileId)));
      });
    } catch (error) {
      // Nothing records these segments; remove them so a retry starts clean.
      await discard(deps.storage, organisationId, stored, `segments of file ${fileId}`);
      if (job.retryCount >= jobDefinitions["media-proxy"].options.retryLimit) {
        await markFailed(organisationId, fileId);
      }
      throw error;
    }
  };
}

/**
 * Analyse a file's audio, every channel as recorded: waveform peaks at each zoom level,
 * loudness and levels over time, and a spectrogram per channel (and the mid and side of
 * the front pair), each stored as an encrypted blob.
 * Idempotent: a file already analysed is left alone.
 */
export function analysisHandler(deps: MediaWorkerDeps): JobHandler<"media-analysis"> {
  return async ({ organisationId, fileId }, job) => {
    const [file] = await deps.db
      .select()
      .from(files)
      .where(inOrg(files, organisationId, eq(files.id, fileId)));
    const audio = file?.mediaInfo?.audio;
    const picture = file && pictureOf(file.kind, file.mediaInfo);
    if (!file || (!audio && !picture)) return;
    if (!audio && picture) {
      // A silent video: its picture alone.
      await analyseSilentPicture(deps, organisationId, file, picture, job);
      return;
    }
    if (!audio) return;
    const existing = await deps.db
      .select({ id: peakLevels.id })
      .from(peakLevels)
      .where(inOrg(peakLevels, organisationId, eq(peakLevels.fileId, fileId)))
      .limit(1);
    if (existing.length > 0) {
      // Analysed already. A file analysed before some of the signal checks existed lacks
      // their findings (every check records its pass), so measure those alone and keep the rest.
      await backfillFindings(deps, organisationId, file, audio, picture, job.signal);
      return;
    }

    const stored: string[] = [];
    const store = async (bytes: Uint8Array) => {
      const blob = await deps.storage.put(organisationId, Buffer.from(bytes), {
        contentType: "application/octet-stream",
        projectId: file.projectId,
      });
      stored.push(blob.id);
      return blob.id;
    };
    try {
      const [analysis, spectra, pictured] = await withWorkspace(deps.workDir, async (dir) => {
        const input = await materialise(deps.storage, organisationId, file.blobId, dir, job.signal);
        // The decodes side by side, the spectrograms on their own thread, and a video's
        // picture beside them (#42).
        return together(job.signal, [
          (signal) => analyseAudio(input, audio, dir, signal, declaredLength(file)),
          (signal) => spectrogramsInThread(input, audio, file.mediaInfo?.duration, signal),
          (signal) => (picture ? analysePicture(input, picture, signal) : Promise.resolve([])),
        ] as const);
      });
      const rows: (typeof peakLevels.$inferInsert)[] = [];
      for (const level of analysis.levels) {
        rows.push({
          organisationId,
          fileId,
          samplesPerPeak: level.samplesPerPeak,
          peakCount: level.count,
          channels: level.channels,
          sampleRate: level.sampleRate,
          blobId: await store(encodePeaks(level)),
        });
      }
      const { series, summary } = analysis.loudness;
      const seriesBlobId = await store(encodeLoudness(series));
      const spectrumRows: (typeof spectrograms.$inferInsert)[] = [];
      for (const spectrum of spectra) {
        spectrumRows.push({
          organisationId,
          fileId,
          channel: spectrum.channel,
          fftSize: spectrum.fftSize,
          sampleRate: audio.sampleRate,
          samplesPerColumn: spectrum.samplesPerColumn,
          columnCount: spectrum.columns,
          bandCount: spectrum.bands,
          blobId: await store(spectrum.bytes),
        });
      }
      await deps.db.transaction(async (tx) => {
        await tx.insert(peakLevels).values(rows);
        await tx.insert(loudness).values({
          organisationId,
          fileId,
          summary,
          channels: series.channels,
          sampleRate: series.sampleRate,
          samplesPerFrame: series.samplesPerFrame,
          frameCount: series.count,
          blobId: seriesBlobId,
        });
        await tx.insert(spectrograms).values(spectrumRows);
        // How high the content reaches (#41) and what the LFE carries (#74) come from the
        // spectrograms.
        const bandwidth = bandwidthOf(spectra);
        const findings = [
          ...analysis.findings,
          ...(bandwidth ? [bandwidth] : []),
          ...lfeOf(spectra, lfeChannels(file.mediaInfo)),
          ...pictured,
        ];
        if (findings.length > 0) {
          await tx
            .insert(qaFindings)
            .values(findings.map((f) => ({ organisationId, fileId, ...f })));
        }
        await tx
          .update(files)
          .set({ analysisStatus: "ready" })
          .where(inOrg(files, organisationId, eq(files.id, fileId)));
      });
    } catch (error) {
      await discard(deps.storage, organisationId, stored, `analysis of file ${fileId}`);
      if (job.retryCount >= jobDefinitions["media-analysis"].options.retryLimit) {
        await deps.db
          .update(files)
          .set({ analysisStatus: "failed" })
          .where(inOrg(files, organisationId, eq(files.id, fileId)));
        await tellProcessingFailed(deps.db, organisationId, fileId);
        await measured(deps, organisationId, fileId);
      }
      throw error;
    }
    await measured(deps, organisationId, fileId);
  };
}

/**
 * Draw a document or picture as pages (#29): each at review size and as a thumbnail,
 * stored encrypted. A file that is not what it claims to be is marked failed at once;
 * anything else (a tool missing, a timeout) is retried.
 */
export function renderHandler(deps: MediaWorkerDeps): JobHandler<"document-render"> {
  return async ({ organisationId, fileId }, job) => {
    const [file] = await deps.db
      .select({
        id: files.id,
        name: files.name,
        contentType: files.contentType,
        blobId: files.blobId,
        projectId: files.projectId,
      })
      .from(files)
      .where(inOrg(files, organisationId, eq(files.id, fileId)));
    if (!file) return;
    const source = pageSourceOf(file.name, file.contentType);
    const done = async (status: "ready" | "failed", pageCount: number | null = null) => {
      await deps.db
        .update(files)
        .set({ streamStatus: status, pageCount })
        .where(inOrg(files, organisationId, eq(files.id, fileId)));
      if (status === "failed") {
        await tellProcessingFailed(deps.db, organisationId, fileId);
        // Never drawn, so it has no bars to move marks to: they stay where they are (#52).
        await deps.db
          .update(tracks)
          .set({ rehomeFrom: null, rehomeById: null })
          .where(inOrg(tracks, organisationId, eq(tracks.scoreFileId, fileId)));
      }
    };
    if (!source) {
      await done("failed");
      return;
    }
    // Drawn already: a retry after the pages were recorded has nothing left to do.
    const [existing] = await deps.db
      .select({ id: filePages.id })
      .from(filePages)
      .where(inOrg(filePages, organisationId, eq(filePages.fileId, fileId)))
      .limit(1);
    if (existing) {
      // Drawn, but stopped before a track that took it moved its marks (#52).
      await rehomePending(deps.db, organisationId, fileId);
      return;
    }

    const stored: string[] = [];
    try {
      const rows: (typeof filePages.$inferInsert)[] = [];
      const drawn = await withWorkspace(deps.workDir, async (dir) => {
        const path = await materialise(deps.storage, organisationId, file.blobId, dir, job.signal);
        // Each page is stored as it is drawn; only its row is kept until the end.
        const result = await renderPages(path, source, dir, job.signal, async (page) => {
          const view = await deps.storage.put(organisationId, page.view, {
            projectId: file.projectId,
          });
          stored.push(view.id);
          const thumb = await deps.storage.put(organisationId, page.thumb, {
            projectId: file.projectId,
          });
          stored.push(thumb.id);
          rows.push({
            organisationId,
            fileId,
            page: page.page,
            width: page.width,
            height: page.height,
            blobId: view.id,
            thumbBlobId: thumb.id,
          });
        });
        // The bar numbers in a score's text, for going to a bar (#52). A PDF whose text cannot
        // be read is still drawn: it is gone to by page.
        let bars: PrintedBar[] | null = null;
        if (source === "pdf") {
          try {
            bars = await printedBars(path, result.drawn, job.signal);
          } catch (error) {
            if (job.signal.aborted) throw error;
            console.warn(`The text of file ${fileId} could not be read for its bar numbers`);
          }
        }
        return { ...result, bars };
      });
      await deps.db.transaction(async (tx) => {
        await tx.insert(filePages).values(rows);
        await tx
          .update(files)
          .set({ streamStatus: "ready", pageCount: drawn.total, printedBars: drawn.bars })
          .where(inOrg(files, organisationId, eq(files.id, fileId)));
      });
      // A track that took this score before it was drawn: its marks follow the bars now read.
      await rehomePending(deps.db, organisationId, fileId);
    } catch (error) {
      await discard(deps.storage, organisationId, stored, `pages of file ${fileId}`);
      if (error instanceof InvalidMediaError) {
        console.warn(`File ${fileId} could not be drawn: ${error.message}`);
        await done("failed");
        return;
      }
      if (job.retryCount >= jobDefinitions["document-render"].options.retryLimit) {
        await done("failed");
      }
      throw error;
    }
  };
}

/**
 * Align two files by their audio, then move the threads carried from one to the other to
 * where the same music is. A poor match is recorded with its quality and used by nobody.
 */
export function alignHandler(deps: MediaWorkerDeps): JobHandler<"media-align"> {
  return async ({ organisationId, alignmentId }, job) => {
    const [pair] = await deps.db
      .select({
        id: alignments.id,
        fromFileId: alignments.fromFileId,
        toFileId: alignments.toFileId,
        status: alignments.status,
      })
      .from(alignments)
      .where(inOrg(alignments, organisationId, eq(alignments.id, alignmentId)));
    if (!pair || pair.status === "ready") return;
    const both = await deps.db
      .select({ id: files.id, kind: files.kind, blobId: files.blobId })
      .from(files)
      .where(inOrg(files, organisationId, inArray(files.id, [pair.fromFileId, pair.toFileId])));
    const from = both.find((f) => f.id === pair.fromFileId);
    const to = both.find((f) => f.id === pair.toFileId);
    const playable = (f?: { kind: string }) => f?.kind === "audio" || f?.kind === "video";
    const fail = () =>
      deps.db
        .update(alignments)
        .set({ status: "failed", updatedAt: new Date() })
        .where(inOrg(alignments, organisationId, eq(alignments.id, pair.id)));
    if (!from || !to || !playable(from) || !playable(to)) {
      await fail();
      return;
    }
    try {
      const result = await withWorkspace(deps.workDir, async (dir) => {
        const a = await materialise(
          deps.storage,
          organisationId,
          from.blobId,
          dir,
          job.signal,
          "a",
        );
        const b = await materialise(deps.storage, organisationId, to.blobId, dir, job.signal, "b");
        // Off the main thread, so the API keeps answering while the music is matched.
        return alignInThread(a, b, job.signal);
      });
      await deps.db.transaction(async (tx) => {
        await tx
          .update(alignments)
          .set({
            status: "ready",
            points: result.points,
            quality: result.quality,
            updatedAt: new Date(),
          })
          .where(inOrg(alignments, organisationId, eq(alignments.id, pair.id)));
        if (usableAlignment(result.quality)) {
          await remapCarries(tx, organisationId, pair, result.points);
        }
      });
    } catch (error) {
      if (job.retryCount >= jobDefinitions["media-align"].options.retryLimit) await fail();
      throw error;
    }
  };
}

/**
 * Queue every alignment left pending for more than a few minutes. Housekeeping across
 * organisations, like expiring uploads: each job it queues names its own organisation.
 * The queue drops a duplicate of one already queued or running.
 */
export async function requeueAlignments(
  db: Database,
  jobs: Pick<Jobs, "send">,
  now = new Date(),
): Promise<number> {
  const waiting = await db
    .select({ id: alignments.id, organisationId: alignments.organisationId })
    .from(alignments)
    .where(
      and(
        eq(alignments.status, "pending"),
        lt(alignments.updatedAt, new Date(now.getTime() - 5 * 60_000)),
      ),
    )
    .limit(500);
  for (const a of waiting) {
    await jobs.send(
      "media-align",
      { organisationId: a.organisationId, alignmentId: a.id },
      { singletonKey: a.id },
    );
  }
  return waiting.length;
}

/** Hash a blob's content by reading it back through decryption, which also proves it is intact. */
export function checksumHandler(deps: MediaWorkerDeps): JobHandler<"blob-checksum"> {
  return async ({ organisationId, blobId }, job) => {
    const hash = createHash("sha256");
    const { stream } = await deps.storage.open(organisationId, blobId);
    for await (const chunk of stream) {
      if (job.signal.aborted) {
        stream.destroy();
        throw new Error("Checksum cancelled");
      }
      hash.update(chunk as Buffer);
    }
    await deps.db
      .update(blobs)
      .set({ sha256: hash.digest("hex") })
      .where(and(inOrg(blobs, organisationId, eq(blobs.id, blobId)), isNull(blobs.sha256)));
  };
}

/** Start every background worker in this process. */

/** The signal checks a file has findings for. */
const checksOf = async (db: Database | Tx, organisationId: string, fileId: string) =>
  new Set(
    (
      await db
        .selectDistinct({ check: qaFindings.check })
        .from(qaFindings)
        .where(inOrg(qaFindings, organisationId, eq(qaFindings.fileId, fileId)))
    ).map((f) => f.check as string),
  );

/** The spectrograms stored when a file was analysed, each channel's as encoded. */
async function storedSpectra(deps: MediaWorkerDeps, organisationId: string, fileId: string) {
  const rows = await deps.db
    .select({ channel: spectrograms.channel, blobId: spectrograms.blobId })
    .from(spectrograms)
    .where(inOrg(spectrograms, organisationId, eq(spectrograms.fileId, fileId)));
  const spectra = [];
  for (const row of rows) {
    const { stream } = await deps.storage.open(organisationId, row.blobId);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    spectra.push({ channel: row.channel, bytes: new Uint8Array(Buffer.concat(chunks)) });
  }
  return spectra;
}

/** Add the findings of the checks a file has none of yet, under a lock so a run at once adds them once. */
async function addMissing(tx: Tx, organisationId: string, fileId: string, findings: QaFinding[]) {
  await tx
    .select({ id: files.id })
    .from(files)
    .where(inOrg(files, organisationId, eq(files.id, fileId)))
    .for("update");
  const have = await checksOf(tx, organisationId, fileId);
  const missing = findings.filter((f) => !have.has(f.check));
  if (missing.length > 0) {
    await tx.insert(qaFindings).values(missing.map((f) => ({ organisationId, fileId, ...f })));
  }
}

/**
 * The signal checks for a file analysed before they existed (#41, #74, #42); nothing if it has
 * them. Integrity is recorded for every file analysed since, so its absence marks such a
 * file, the LFE check for every file with an LFE channel, and black frames for every video:
 * the file is decoded again only for what needs it, and how high it reaches and what its LFE
 * carries are read from its stored spectrograms. Only the checks it lacks are added.
 */
async function backfillFindings(
  deps: MediaWorkerDeps,
  organisationId: string,
  file: { id: string; blobId: string; kind: string; mediaInfo: MediaInfo | null },
  audio: NonNullable<MediaInfo["audio"]>,
  picture: MediaInfo["video"],
  signal: AbortSignal,
) {
  const had = await checksOf(deps.db, organisationId, file.id);
  const lfe = lfeChannels(file.mediaInfo);
  const decode = !had.has("integrity");
  const look = picture && !had.has("timecode") ? picture : undefined;
  if (!decode && !look && (lfe.length === 0 || had.has("lfe"))) return;
  const [analysis, pictured] =
    decode || look
      ? await withWorkspace(deps.workDir, async (dir) => {
          const input = await materialise(deps.storage, organisationId, file.blobId, dir, signal);
          return together(signal, [
            (s) =>
              decode
                ? analyseAudio(input, audio, dir, s, declaredLength(file))
                : Promise.resolve(null),
            (s) => (look ? analysePicture(input, look, s) : Promise.resolve([])),
          ] as const);
        })
      : [null, []];
  const spectra = await storedSpectra(deps, organisationId, file.id);
  const bandwidth = bandwidthOf(spectra);
  await deps.db.transaction((tx) =>
    addMissing(tx, organisationId, file.id, [
      ...(analysis?.findings ?? []),
      ...(bandwidth ? [bandwidth] : []),
      ...lfeOf(spectra, lfe),
      ...pictured,
    ]),
  );
}

/**
 * A silent video's checks (#42): its picture, measured once. Like a recording's analysis it
 * leaves the file ready, or failed once out of retries, and tells a checks stage either way.
 */
async function analyseSilentPicture(
  deps: MediaWorkerDeps,
  organisationId: string,
  file: { id: string; blobId: string },
  picture: NonNullable<MediaInfo["video"]>,
  job: { signal: AbortSignal; retryCount: number },
) {
  try {
    const had = await checksOf(deps.db, organisationId, file.id);
    const findings = had.has("timecode")
      ? []
      : await withWorkspace(deps.workDir, async (dir) => {
          const input = await materialise(
            deps.storage,
            organisationId,
            file.blobId,
            dir,
            job.signal,
          );
          return analysePicture(input, picture, job.signal);
        });
    await deps.db.transaction(async (tx) => {
      await addMissing(tx, organisationId, file.id, findings);
      await tx
        .update(files)
        .set({ analysisStatus: "ready" })
        .where(inOrg(files, organisationId, eq(files.id, file.id)));
    });
  } catch (error) {
    if (job.retryCount >= jobDefinitions["media-analysis"].options.retryLimit) {
      await deps.db
        .update(files)
        .set({ analysisStatus: "failed" })
        .where(inOrg(files, organisationId, eq(files.id, file.id)));
      await tellProcessingFailed(deps.db, organisationId, file.id);
      await measured(deps, organisationId, file.id);
    }
    throw error;
  }
  await measured(deps, organisationId, file.id);
}

/**
 * Queue analysis for files measured before the signal checks existed, or before some of them
 * (#41, #74, #42), so their QA view fills in after an upgrade. Instance-wide, a batch at a
 * time; each job reads only its file. Integrity is always recorded, the LFE check wherever
 * there is an LFE channel, and black frames for every video, so their absence is what marks
 * them.
 */
export async function requeueMissingFindings(db: Database, jobs: Pick<Jobs, "send">) {
  const lacks = (check: QaCheck) =>
    sql`not exists (select 1 from ${qaFindings} where ${qaFindings.fileId} = ${files.id}
        and ${qaFindings.organisationId} = ${files.organisationId}
        and ${qaFindings.check} = ${check})`;
  // Where the file's layout or its ADM bed has an LFE channel, as `lfeChannels` reads them.
  const layout = sql`${files.mediaInfo}->'audio'->>'channelLayout'`;
  const adm = sql`${files.mediaInfo}->'metadata'->'adm'`;
  const hasLfe = sql`(case when jsonb_typeof(${adm}) = 'object'
    then jsonb_array_length(${adm}->'lfe') > 0
    else (${layout} in (${sql.join(
      layoutsWithLfe.map((name) => sql`${name}`),
      sql`, `,
    )}) or ${layout} like '%LFE%') end)`;
  const waiting = await db
    .selectDistinct({ organisationId: peakLevels.organisationId, fileId: peakLevels.fileId })
    .from(peakLevels)
    .innerJoin(
      files,
      and(eq(files.id, peakLevels.fileId), eq(files.organisationId, peakLevels.organisationId)),
    )
    .where(or(lacks("integrity"), and(hasLfe, lacks("lfe"))))
    .limit(500);
  // Videos, silent ones included, whose picture was never looked at (#42), or looked at before
  // its timecode was: measured, or never measured for want of sound, and not failed or waiting.
  const pictures = await db
    .select({ organisationId: files.organisationId, fileId: files.id })
    .from(files)
    .where(
      and(
        eq(files.kind, "video"),
        sql`jsonb_typeof(${files.mediaInfo}->'video') = 'object'`,
        inArray(files.analysisStatus, ["none", "ready"]),
        lacks("timecode"),
      ),
    )
    .limit(500);
  const queued = new Set<string>();
  for (const { organisationId, fileId } of [...waiting, ...pictures]) {
    if (queued.has(fileId)) continue;
    queued.add(fileId);
    await jobs.send("media-analysis", { organisationId, fileId }, { singletonKey: fileId });
  }
  return queued.size;
}

export async function startWorkers(jobs: Jobs, deps: MediaWorkerDeps, concurrency: number) {
  // Plaintext left behind by a process that crashed mid-job is removed before any new work.
  const swept = await sweepWorkspaces(deps.workDir);
  if (swept > 0) console.log(`Removed ${swept} workspace(s) left by a stopped worker`);
  await jobs.work("media-probe", probeHandler(deps), { concurrency });
  await jobs.work("media-proxy", proxyHandler(deps), {
    concurrency: Math.max(1, Math.floor(concurrency / 2)),
  });
  await jobs.work("media-analysis", analysisHandler(deps), { concurrency });
  await jobs.work("blob-checksum", checksumHandler(deps), { concurrency });
  await jobs.work("document-render", renderHandler(deps), { concurrency });
  await jobs.work("media-align", alignHandler(deps), {
    concurrency: Math.max(1, Math.floor(concurrency / 2)),
  });
  await jobs.work("alignments-sweep", async () => {
    const queued = await requeueAlignments(deps.db, deps.jobs);
    if (queued > 0) console.log(`Queued ${queued} alignment(s) that were waiting`);
  });
  await jobs.work("uploads-expire", async () => {
    const aborted = await expireUploads(deps.db, deps.storage);
    if (aborted > 0) console.log(`Discarded ${aborted} expired upload(s)`);
  });
  const backfill = await requeueMissingFindings(deps.db, deps.jobs).catch((error: unknown) => {
    console.warn(`Could not queue the signal checks for older files: ${String(error)}`);
    return 0;
  });
  if (backfill > 0) console.log(`Queued the signal checks for ${backfill} older file(s)`);
}
