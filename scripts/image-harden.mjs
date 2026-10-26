// The app image's last build step (decision 244), run by Node because it removes the shell:
// every program but the few Hekate runs goes, so the image holds no shell, no busybox applet
// and no package manager, and no file keeps a setuid or setgid bit. Package records stay in
// /lib/apk/db, so scanners still see every package.
import { chmodSync, lstatSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** What Hekate runs: Node, ffmpeg, Poppler's three tools, and Python for the ADM renderer. */
const programs = ["node", "ffmpeg", "ffprobe", "pdfinfo", "pdftoppm", "pdftotext", "python3"];
/** Where programs live, in the order PATH searches them. */
const bins = ["/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"];
/** apk's library (which nothing else links), its keys and its repositories. */
const alsoGone = [
  ...readdirSync("/usr/lib")
    .filter((name) => name.startsWith("libapk.so"))
    .map((name) => join("/usr/lib", name)),
  "/etc/apk",
];

const exists = (path) => {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
};

// Each program, and every link on the way to the file it names.
const keep = new Set();
for (const program of programs) {
  const found = bins.map((dir) => join(dir, program)).find((path) => exists(path));
  if (!found) throw new Error(`${program} is not installed`);
  let path = found;
  for (let hops = 0; hops < 8; hops++) {
    keep.add(path);
    const stat = lstatSync(path);
    if (!stat.isSymbolicLink()) break;
    path = resolve(dirname(path), readlinkSync(path));
  }
}

const removed = [];
for (const dir of bins) {
  const stat = exists(dir);
  // /bin and /sbin may be links to /usr's; their entries are then seen once, there.
  if (!stat?.isDirectory()) continue;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (keep.has(path)) continue;
    rmSync(path, { recursive: true, force: true });
    removed.push(path);
  }
}
for (const path of alsoGone) {
  rmSync(path, { recursive: true, force: true });
  if (exists(path)) throw new Error(`${path} is still there`);
}

// No file on the image's own filesystem may raise its privileges. Directories mounted from
// elsewhere for the build (/proc, /sys, /dev) are left alone.
const device = lstatSync("/").dev;
const unprivilege = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const stat = lstatSync(path);
    if (entry.isDirectory()) {
      if (stat.dev === device) unprivilege(path);
    } else if (entry.isFile() && (stat.mode & 0o6000) !== 0) {
      chmodSync(path, stat.mode & 0o1777);
    }
  }
};
unprivilege("/");

console.log(`kept ${[...keep].sort().join(", ")}; removed ${removed.length} other programs`);
