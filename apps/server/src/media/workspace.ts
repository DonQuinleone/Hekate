import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A private scratch directory for one job. Media tools need seekable local files,
 * so decrypted media exists here, and only here, while a job runs. The directory
 * is readable by this process alone and removed when the job ends, whether it
 * succeeds or fails. Point WORK_DIR at a tmpfs to keep it off disk entirely.
 */
export async function withWorkspace<T>(
  root: string | undefined,
  task: (dir: string) => Promise<T>,
): Promise<T> {
  const base = root ?? join(tmpdir(), "hekate-work");
  await mkdir(base, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(base, "job-"));
  try {
    return await task(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
