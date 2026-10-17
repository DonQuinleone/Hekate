import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { freemem, totalmem } from "node:os";
import { dirname, join } from "node:path";
import type { InstallCheck } from "@hekate/shared";

const gigabytes = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;

/** The first line a tool prints about its version, or null when it is not installed. */
function versionOf(command: string, args: string[], pattern: RegExp) {
  const run = spawnSync(command, args, { encoding: "utf8", timeout: 5000 });
  if (run.error || run.status !== 0) return null;
  const match = pattern.exec(`${run.stdout}\n${run.stderr}`);
  return match?.[1] ?? "installed";
}

/** Whether a check stops the installer: only what the server cannot run without. */
export const blocking = (checks: readonly InstallCheck[]) => checks.some((c) => c.state === "fail");

/**
 * What the server needs before anything is configured: a writable place for its settings, which
 * stops the installer when it is missing, and what is worth knowing (Node's version, the media
 * tools, room to work), which warns.
 */
export function checkRequirements(options: {
  settingsFile: string;
  nodeVersion?: string;
}): InstallCheck[] {
  const checks: InstallCheck[] = [];
  const node = options.nodeVersion ?? process.versions.node;
  const major = Number(node.split(".")[0]);
  // The server is already running on it, so an older Node is a warning, as PostgreSQL is.
  checks.push({
    name: "Node.js 26",
    state: major >= 26 ? "ok" : "warn",
    detail: major >= 26 ? node : `${node}: Hekate is built and tested on 26`,
  });

  const ffmpeg = versionOf("ffmpeg", ["-version"], /ffmpeg version (\S+)/);
  checks.push({
    name: "ffmpeg",
    state: ffmpeg ? "ok" : "warn",
    detail: ffmpeg ?? "not found: audio and video will not be processed",
  });
  const poppler = versionOf("pdftoppm", ["-v"], /pdftoppm version (\S+)/);
  checks.push({
    name: "Poppler",
    state: poppler ? "ok" : "warn",
    detail: poppler ?? "not found: documents and scores will not be rendered",
  });
  const fonts = (() => {
    try {
      return readdirSync("/usr/share/fonts").length > 0;
    } catch {
      return false;
    }
  })();
  checks.push({
    name: "Fonts",
    state: fonts ? "ok" : "warn",
    detail: fonts ? "installed" : "none found: watermarks and pages may render without text",
  });

  const directory = dirname(options.settingsFile);
  const writable = (() => {
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const probe = join(directory, `.probe-${process.pid}`);
      writeFileSync(probe, "");
      rmSync(probe);
      return true;
    } catch {
      return false;
    }
  })();
  checks.push({
    name: "Writable settings directory",
    state: writable ? "ok" : "fail",
    detail: writable ? directory : `${directory} cannot be written to`,
  });
  if (writable) {
    const disk = statfsSync(directory);
    const free = disk.bavail * disk.bsize;
    checks.push({
      name: "Disk",
      state: free >= 10 * 1024 ** 3 ? "ok" : "warn",
      detail: `${gigabytes(free)} free`,
    });
  }
  const free = freemem();
  checks.push({
    name: "Memory",
    state: free >= 1024 ** 3 ? "ok" : "warn",
    detail: `${gigabytes(free)} of ${gigabytes(totalmem())} free`,
  });
  return checks;
}
