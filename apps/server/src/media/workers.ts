import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { type Database, inOrg, schema, uuidv7 } from "@hekate/db";
import { encodeLoudness, encodePeaks, type MediaInfo, usableAlignment } from "@hekate/shared";
import { wrapKey } from "@hekate/storage";
import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { remapCarries } from "../carry.ts";
import { type JobHandler, type Jobs, jobDefinitions } from "../jobs.ts";
import type { Keyring } from "../keyring.ts";
import { tellProcessingFailed } from "../notifications.ts";
import type { Storage } from "../storage.ts";
import { expireUploads } from "../uploads.ts";
import { alignInThread } from "./align.ts";
import { analyseAudio, declaredLength } from "./analysis.ts";
import { InvalidMediaError, probe } from "./ffmpeg.ts";
import { pageSourceOf, renderPages } from "./pages.ts";
import { type PackagedRendition, packageRendition, planRenditions } from "./proxy.ts";
import { spectrogramsInThread } from "./spectrogram.ts";
import { together } from "./together.ts";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

import { bandwidthOf } from "./bandwidth.ts";
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
} = schema;

export interface MediaWorkerDeps {
  db: Database;
  storage: Storage;
  keyring: Keyring;
  /** For chaining: a measured file queues its proxies. */
  jobs: Pick<Jobs, "send">;
  /** Scratch space for decrypted media while a job runs; a tmpfs is ideal. */
  workDir?: string;
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
      }
      throw error;
    }

    const playable = Boolean(info.audio || info.video);
    await deps.db
      .update(files)
      .set({
        mediaInfo: info,
        ...(playable ? {} : { streamStatus: "failed" as const }),
        ...(info.audio ? { analysisStatus: "pending" as const } : {}),
      })
      .where(inOrg(files, organisationId, eq(files.id, fileId)));
    if (!playable) await tellProcessingFailed(deps.db, organisationId, fileId);
    if (playable) {
      await deps.jobs.send("media-proxy", { organisationId, fileId }, { singletonKey: fileId });
    }
    if (info.audio) {
      await deps.jobs.send("media-analysis", { organisationId, fileId }, { singletonKey: fileId });
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

    const plans = planRenditions(file.kind, file.mediaInfo);
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
      const packaged = await withWorkspace(deps.workDir, async (dir) => {
        const input = await materialise(deps.storage, organisationId, file.blobId, dir, job.signal);
        const results: { id: string; wrappedKey: string; rendition: PackagedRendition }[] = [];
        for (const plan of plans) {
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
        return results;
      });

      await deps.db.transaction(async (tx) => {
        for (const { id, wrappedKey, rendition } of packaged) {
          await tx.insert(renditions).values({
            id,
            organisationId,
            fileId,
            name: rendition.plan.name,
            codecs: rendition.plan.codecs,
            bandwidth: rendition.plan.bandwidth,
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
        await tx
          .update(files)
          .set({ streamStatus: "ready" })
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
    if (!file || !audio) return;
    const existing = await deps.db
      .select({ id: peakLevels.id })
      .from(peakLevels)
      .where(inOrg(peakLevels, organisationId, eq(peakLevels.fileId, fileId)))
      .limit(1);
    if (existing.length > 0) {
      // Analysed already. A file analysed before some of the signal checks existed lacks
      // their findings (every check records its pass), so measure those alone and keep the rest.
      await backfillFindings(deps, organisationId, file, audio, job.signal);
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
      const [analysis, spectra] = await withWorkspace(deps.workDir, async (dir) => {
        const input = await materialise(deps.storage, organisationId, file.blobId, dir, job.signal);
        // Two decodes side by side, the spectrograms on their own thread.
        return together(job.signal, [
          (signal) => analyseAudio(input, audio, dir, signal, declaredLength(file)),
          (signal) => spectrogramsInThread(input, audio, file.mediaInfo?.duration, signal),
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
        // How high the content reaches comes from the spectrograms (#41).
        const bandwidth = bandwidthOf(spectra);
        const findings = bandwidth ? [...analysis.findings, bandwidth] : analysis.findings;
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
      }
      throw error;
    }
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
      if (status === "failed") await tellProcessingFailed(deps.db, organisationId, fileId);
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
    if (existing) return;

    const stored: string[] = [];
    try {
      const rows: (typeof filePages.$inferInsert)[] = [];
      const drawn = await withWorkspace(deps.workDir, async (dir) => {
        const path = await materialise(deps.storage, organisationId, file.blobId, dir, job.signal);
        // Each page is stored as it is drawn; only its row is kept until the end.
        return renderPages(path, source, dir, job.signal, async (page) => {
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
      });
      await deps.db.transaction(async (tx) => {
        await tx.insert(filePages).values(rows);
        await tx
          .update(files)
          .set({ streamStatus: "ready", pageCount: drawn.total })
          .where(inOrg(files, organisationId, eq(files.id, fileId)));
      });
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

/** How high a file's content reaches, from the spectrograms stored when it was analysed. */
async function storedBandwidth(deps: MediaWorkerDeps, organisationId: string, fileId: string) {
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
  return bandwidthOf(spectra);
}

/**
 * The signal checks for a file analysed before they existed (#41); nothing if it has them.
 * Integrity is recorded for every file analysed since, so its absence marks such a file:
 * the file is decoded again for what that needs, and how high it reaches is read from its
 * stored spectrograms. Only the checks it lacks are added.
 */
async function backfillFindings(
  deps: MediaWorkerDeps,
  organisationId: string,
  file: { id: string; blobId: string; kind: string; mediaInfo: MediaInfo | null },
  audio: NonNullable<MediaInfo["audio"]>,
  signal: AbortSignal,
) {
  if ((await checksOf(deps.db, organisationId, file.id)).has("integrity")) return;
  const analysis = await withWorkspace(deps.workDir, async (dir) => {
    const input = await materialise(deps.storage, organisationId, file.blobId, dir, signal);
    return analyseAudio(input, audio, dir, signal, declaredLength(file));
  });
  const bandwidth = await storedBandwidth(deps, organisationId, file.id);
  await deps.db.transaction(async (tx) => {
    // Locked, so two runs at once write the findings only once.
    await tx
      .select({ id: files.id })
      .from(files)
      .where(inOrg(files, organisationId, eq(files.id, file.id)))
      .for("update");
    const have = await checksOf(tx, organisationId, file.id);
    if (have.has("integrity")) return;
    const missing = [...analysis.findings, ...(bandwidth ? [bandwidth] : [])].filter(
      (f) => !have.has(f.check),
    );
    if (missing.length > 0) {
      await tx
        .insert(qaFindings)
        .values(missing.map((f) => ({ organisationId, fileId: file.id, ...f })));
    }
  });
}

/**
 * Queue analysis for files measured before the signal checks existed, or before some of them
 * (#41), so their QA view fills in after an upgrade. Instance-wide, a batch at a time; each
 * job reads only its file. Integrity is always recorded, so its absence is what marks them.
 */
export async function requeueMissingFindings(db: Database, jobs: Pick<Jobs, "send">) {
  const waiting = await db
    .selectDistinct({ organisationId: peakLevels.organisationId, fileId: peakLevels.fileId })
    .from(peakLevels)
    .where(
      sql`not exists (select 1 from ${qaFindings} where ${qaFindings.fileId} = ${peakLevels.fileId}
        and ${qaFindings.organisationId} = ${peakLevels.organisationId}
        and ${qaFindings.check} = 'integrity')`,
    )
    .limit(500);
  for (const { organisationId, fileId } of waiting) {
    await jobs.send("media-analysis", { organisationId, fileId }, { singletonKey: fileId });
  }
  return waiting.length;
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
