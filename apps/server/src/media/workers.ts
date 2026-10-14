import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { type Database, inOrg, schema } from "@hekate/db";
import { eq } from "drizzle-orm";
import type { JobHandler, Jobs } from "../jobs.ts";
import type { Storage } from "../storage.ts";
import { InvalidMediaError, probe } from "./ffmpeg.ts";
import { sweepWorkspaces, withWorkspace } from "./workspace.ts";

const { files } = schema;

export interface MediaWorkerDeps {
  db: Database;
  storage: Storage;
  /** Scratch space for decrypted media while a job runs; a tmpfs is ideal. */
  workDir?: string;
}

/** Decrypt a blob into the job's workspace and return the path. */
async function materialise(
  storage: Storage,
  organisationId: string,
  blobId: string,
  dir: string,
  signal: AbortSignal,
) {
  const path = join(dir, "input");
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

    const info = await withWorkspace(deps.workDir, async (dir) => {
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

    await deps.db
      .update(files)
      .set({ mediaInfo: info })
      .where(inOrg(files, organisationId, eq(files.id, fileId)));
  };
}

/** Start every media worker in this process. */
export async function startMediaWorkers(jobs: Jobs, deps: MediaWorkerDeps, concurrency: number) {
  // Plaintext left behind by a process that crashed mid-job is removed before any new work.
  const swept = await sweepWorkspaces(deps.workDir);
  if (swept > 0) console.log(`Removed ${swept} workspace(s) left by a stopped worker`);
  await jobs.work("media-probe", probeHandler(deps), { concurrency });
}
