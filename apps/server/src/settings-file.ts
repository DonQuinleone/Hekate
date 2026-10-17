import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * The settings the installer writes (decision 061): `NAME=value` lines in one file, readable
 * by the server alone, read at every start. The environment wins over it, so whatever Compose
 * or `.env` sets is never overridden by the file.
 */

/** Where the file lives: `HEKATE_SETTINGS_FILE`, or `data/hekate.env` beside a development checkout. */
export const settingsPath = (env: Record<string, string | undefined>) =>
  resolve(env.HEKATE_SETTINGS_FILE || "data/hekate.env");

/** Written by the installer: the steps saved so far, and the mark that it has finished. */
export const PROGRESS = "HEKATE_INSTALL_PROGRESS";
export const INSTALLED = "HEKATE_INSTALLED";

const NAME = /^[A-Z][A-Z0-9_]*$/;

/** Reads `NAME=value` lines; blank lines and `#` comments are skipped, quoted values unescaped. */
export function parseSettings(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at <= 0) continue;
    const name = line.slice(0, at).trim();
    if (!NAME.test(name)) continue;
    const value = line.slice(at + 1).trim();
    values[name] =
      value.startsWith('"') && value.endsWith('"') && value.length >= 2
        ? (JSON.parse(value) as string)
        : value;
  }
  return values;
}

/** One `NAME=value` line per setting, in name order; values that need it are quoted as JSON strings. */
export function serialiseSettings(values: Record<string, string>): string {
  const lines = Object.keys(values)
    .filter((name) => NAME.test(name))
    .sort()
    .map((name) => {
      const value = values[name] ?? "";
      return `${name}=${/^[A-Za-z0-9_./:@+=,-]*$/.test(value) ? value : JSON.stringify(value)}`;
    });
  return `# Written by the Hekate installer. The environment wins over anything here.\n${lines.join("\n")}\n`;
}

/** The file's settings, or none when it does not exist yet. */
export function readSettingsFile(path: string): Record<string, string> | null {
  try {
    return parseSettings(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
}

/** Replaces the file whole, never half-written: a new file beside it, then a rename. */
export function writeSettingsFile(path: string, values: Record<string, string>) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temporary, serialiseSettings(values), { mode: 0o600 });
  renameSync(temporary, path);
}

/** The environment with the file's settings beneath it: a name set in either form wins. */
export function withSettings(
  env: Record<string, string | undefined>,
  file: Record<string, string> | null,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...env };
  for (const [name, value] of Object.entries(file ?? {})) {
    if (given(env, name)) continue;
    merged[name] = value;
  }
  return merged;
}

/** Whether the environment itself sets a setting, directly or as a `_FILE`. */
export const given = (env: Record<string, string | undefined>, name: string) =>
  !!env[name] || !!env[`${name}_FILE`];

/**
 * The server installs until its settings are complete: when it has no database or no master
 * key, or while the file the installer writes is not marked finished.
 */
export function needsInstall(
  env: Record<string, string | undefined>,
  file: Record<string, string> | null,
) {
  if (file && file[INSTALLED] !== "true") return true;
  const merged = withSettings(env, file);
  return !given(merged, "DATABASE_URL") || !given(merged, "MASTER_KEY");
}
