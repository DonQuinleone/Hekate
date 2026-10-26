// Run inside the app image (CI's image job): it starts as built, read-only and with every
// capability dropped, its media tools work (the ADM renderer too), its PDF fonts are there, it
// holds no program but those Hekate runs, and nothing in it can raise its privileges.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

const fail = (message) => {
  console.error(`image: ${message}`);
  process.exitCode = 1;
};

if (process.getuid?.() === 0) fail("runs as root");
for (const [tool, args] of [
  ["ffmpeg", ["-version"]],
  ["ffprobe", ["-version"]],
  ["pdftoppm", ["-v"]],
  ["pdfinfo", ["-v"]],
  ["pdftotext", ["-v"]],
]) {
  try {
    execFileSync(tool, args, { encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    // Some Poppler builds exit non-zero after printing their version; anything else that
    // stops a tool running (a missing library, denied execution, a crash) fails the image.
    const said = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    if (error.code === "ENOENT") fail(`${tool} is missing`);
    else if (!/version/i.test(said)) fail(`${tool} does not run: ${error.message}`);
  }
}
// The ADM renderer (decision 140) loads and runs with Alpine's Python alone.
try {
  execFileSync("python3", ["-W", "ignore", "-m", "ear.cmdline.render_file", "--help"], {
    encoding: "utf8",
    stdio: "pipe",
    env: { ...process.env, PYTHONPATH: process.env.ADM_RENDERER_PATH, PYTHONNOUSERSITE: "1" },
  });
} catch (error) {
  fail(`the ADM renderer does not run: ${error.stderr || error.message}`);
}
// The fonts the PDFs set text outside WinAnsi in (decision 238) are where the image says.
for (const name of ["PDF_FONT", "PDF_FONT_BOLD", "PDF_FONT_FALLBACK"]) {
  for (const font of (process.env[name] ?? "").split(",").filter(Boolean)) {
    if (!existsSync(font)) fail(`${name} names ${font}, which is missing`);
  }
  if (!process.env[name]) fail(`${name} is not set`);
}
for (const gone of [
  "/bin/sh",
  "/bin/ash",
  "/bin/busybox",
  "/sbin/apk",
  "/usr/local/bin/npm",
  "/usr/bin/pip3",
  "/usr/local/bin/pip3",
])
  if (existsSync(gone)) fail(`${gone} is still there`);
// Only the programs Hekate runs, and the links that name them (decision 243).
const programs = new Set(["node", "ffmpeg", "ffprobe", "pdfinfo", "pdftoppm", "pdftotext"]);
for (const dir of ["/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"]) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    continue; // Not in this image.
  }
  const other = names.filter((name) => !programs.has(name) && !/^python3(\.\d+)?$/.test(name));
  if (other.length) fail(`${dir} holds other programs: ${other.join(", ")}`);
}
// apk goes, but its records stay, so scanners still see every package.
if (!existsSync("/lib/apk/db/installed")) fail("the package records are gone");

const setuid = [];
const walk = (dir) => {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.isFile() && (lstatSync(path).mode & 0o6000) !== 0) setuid.push(path);
  }
};
for (const root of ["/usr", "/bin", "/sbin", "/lib", "/opt", "/app"]) walk(root);
if (setuid.length) fail(`setuid or setgid: ${setuid.join(", ")}`);

if (!process.exitCode) console.log("image: as built, unprivileged, no shell, no setuid binaries");
