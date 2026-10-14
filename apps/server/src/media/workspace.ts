import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A private scratch directory for one job. Media tools need seekable local files,
 * so decrypted media exists here, and only here, while a job runs. The directory
 * is readable by this process alone and removed when the job ends, whether it
 * succeeds or fails. If the process dies mid-job, the next worker to start on
 * this host removes what it left (`sweepWorkspaces`). The Compose file mounts
 * the default location as a tmpfs, so plaintext never reaches a disk there.
 */
const baseOf = (root: string | undefined) => root ?? join(tmpdir(), "hekate-work");

export async function withWorkspace<T>(
  root: string | undefined,
  task: (dir: string) => Promise<T>,
): Promise<T> {
  const base = baseOf(root);
  await mkdir(base, { recursive: true, mode: 0o700 });
  // The owning process id is in the name, so a sweep can tell abandoned workspaces from live ones.
  const dir = await mkdtemp(join(base, `job-${process.pid}-`));
  try {
    return await task(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else, so leave it alone.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Remove workspaces whose process is gone. Returns how many were removed. */
export async function sweepWorkspaces(root: string | undefined): Promise<number> {
  const base = baseOf(root);
  let entries: string[];
  try {
    entries = await readdir(base);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of entries) {
    const match = /^job-(\d+)-/.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid || isRunning(pid)) continue;
    await rm(join(base, name), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}
