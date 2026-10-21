import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A private scratch directory for one job. Media tools need seekable local files,
 * so decrypted media exists here, and only here, while a job runs. The directory
 * is readable by this process alone and removed when the job ends, whether it
 * succeeds or fails. If the process dies mid-job, the next worker to start on
 * this host removes what it left (`sweepWorkspaces`). The Compose file mounts
 * the default location as a tmpfs, so plaintext never reaches a disk there.
 *
 * Each name carries the host that made it as well as the process (#188): replicas sharing
 * one directory each have their own process ids, the same numbers often, so a host judges by
 * process only its own workspaces. Another host's, or one named before hosts were, is left
 * until nothing in it has changed for longer than any job may run: by then its job is over,
 * whoever ran it, and a container that replaced its host under a new name finds it too.
 */
const baseOf = (root: string | undefined) => root ?? join(tmpdir(), "hekate-work");

/** This host, as a workspace's name carries it: short, and safe in a file name. */
export const hostTag = createHash("sha256").update(hostname()).digest("hex").slice(0, 8);

async function makeWorkspace(root: string | undefined) {
  const base = baseOf(root);
  await mkdir(base, { recursive: true, mode: 0o700 });
  // The owning host and process are in the name, so a sweep can tell abandoned workspaces
  // from live ones.
  return mkdtemp(join(base, `job-${hostTag}-${process.pid}-`));
}

export async function withWorkspace<T>(
  root: string | undefined,
  task: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await makeWorkspace(root);
  try {
    return await task(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * As `withWorkspace`, for work handed out piece by piece (a download streamed page by page):
 * the directory lasts until the last piece is taken, or the taker stops early.
 */
export async function* streamInWorkspace<T>(
  root: string | undefined,
  task: (dir: string) => AsyncGenerator<T>,
): AsyncGenerator<T> {
  const dir = await makeWorkspace(root);
  try {
    yield* task(dir);
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

/** When anything in a directory last changed, itself included. */
async function lastChange(dir: string): Promise<number> {
  let latest = (await stat(dir)).mtimeMs;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const changed = entry.isDirectory() ? await lastChange(path) : (await stat(path)).mtimeMs;
    latest = Math.max(latest, changed);
  }
  return latest;
}

/**
 * Remove workspaces whose job is over: this host's whose process is gone, and any other
 * untouched for `unclaimedAfterMs`. Returns how many were removed.
 */
export async function sweepWorkspaces(
  root: string | undefined,
  { unclaimedAfterMs, now = Date.now() }: { unclaimedAfterMs: number; now?: number },
): Promise<number> {
  const base = baseOf(root);
  let entries: string[];
  try {
    entries = await readdir(base);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of entries) {
    const match = /^job-(?:([0-9a-f]{8})-)?(\d+)-/.exec(name);
    if (!match) continue;
    const path = join(base, name);
    if (match[1] === hostTag) {
      const pid = Number(match[2]);
      if (pid === process.pid || isRunning(pid)) continue;
    } else {
      // Gone already (its own process removed it as this looked), or still in use.
      const changed = await lastChange(path).catch(() => now);
      if (now - changed < unclaimedAfterMs) continue;
    }
    await rm(path, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}
