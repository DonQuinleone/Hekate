import { type Database, schema } from "@hekate/db";
import {
  newerReleases,
  type Release,
  releasesOfFeed,
  type SystemInformation,
  type UpdateChannel,
} from "@hekate/shared";
import type { Backends } from "@hekate/storage";
import { desc, sql } from "drizzle-orm";
import { run } from "./media/ffmpeg.ts";
import { version } from "./version.ts";

/** The release running, as Release Please writes it into the server's package. */
export const HEKATE_VERSION: string = version;

/** The project's public releases. Asking it sends nothing about the instance. */
export const RELEASES_FEED = "https://api.github.com/repos/DonQuinleone/Hekate/releases";

/**
 * Reads the releases feed and keeps what it says (#158). A failure is kept beside the releases
 * the last good check found, so the page says why it is behind rather than losing them.
 */
export async function checkReleases(
  db: Database,
  fetcher: typeof fetch = fetch,
  feed = RELEASES_FEED,
): Promise<Release[]> {
  const now = new Date();
  try {
    const res = await fetcher(feed, {
      headers: { accept: "application/vnd.github+json", "user-agent": "Hekate" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`The releases feed answered ${res.status}`);
    const releases = releasesOfFeed(await res.json());
    const row = { checkedAt: now, releases, failed: null };
    await db
      .insert(schema.releaseChecks)
      .values({ id: "instance", ...row })
      .onConflictDoUpdate({ target: schema.releaseChecks.id, set: row });
    return releases;
  } catch (error) {
    const failed = error instanceof Error ? error.message : String(error);
    await db
      .insert(schema.releaseChecks)
      .values({ id: "instance", checkedAt: now, releases: [], failed })
      .onConflictDoUpdate({
        target: schema.releaseChecks.id,
        set: { checkedAt: now, failed },
      });
    throw error;
  }
}

/** Notes the release this process runs, the first time the instance starts it. */
export async function recordVersionRun(db: Database, version = HEKATE_VERSION) {
  await db.insert(schema.versionsRun).values({ version }).onConflictDoNothing();
}

/** A tool's version from its first line of output, or "not installed". */
async function toolVersion(command: string, args: string[], pattern: RegExp): Promise<string> {
  try {
    const { stdout, stderr } = await run(command, args, { timeoutMs: 5_000 });
    return pattern.exec(`${stdout}\n${stderr}`)?.[1] ?? "unknown";
  } catch {
    return "not installed";
  }
}

let tools: Promise<{ ffmpeg: string; poppler: string }> | null = null;

/** What the instance runs on: read once for the tools, as they do not change while it runs. */
async function environmentOf(db: Database, backends: Backends) {
  tools ??= Promise.all([
    toolVersion("ffmpeg", ["-version"], /ffmpeg version (\S+)/),
    toolVersion("pdftoppm", ["-v"], /pdftoppm version (\S+)/),
  ]).then(([ffmpeg, poppler]) => ({ ffmpeg, poppler }));
  const [{ ffmpeg, poppler }, [pg]] = await Promise.all([
    tools,
    db.execute<{ server_version: string }>(sql`show server_version`),
  ]);
  return [
    { name: "Node.js", value: process.versions.node },
    { name: "PostgreSQL", value: pg?.server_version.split(" ")[0] ?? "unknown" },
    { name: "ffmpeg", value: ffmpeg },
    { name: "Poppler", value: poppler },
    {
      name: "Storage",
      value: backends
        .names()
        .map((n) => (n === backends.defaultBackend ? `${n} (new objects)` : n))
        .join(", "),
    },
    { name: "Licence", value: "AGPL-3.0" },
  ];
}

/** System information (#158), as the instance's page shows it. */
export async function systemInformation(
  db: Database,
  options: { backends: Backends; build: string; checkOn: boolean; channel: UpdateChannel },
): Promise<SystemInformation> {
  const [[checked], history, environment] = await Promise.all([
    db.select().from(schema.releaseChecks),
    db.select().from(schema.versionsRun).orderBy(desc(schema.versionsRun.firstStartedAt)),
    environmentOf(db, options.backends),
  ]);
  return {
    version: HEKATE_VERSION,
    build: options.build,
    channel: options.channel,
    check: {
      on: options.checkOn,
      checkedAt: checked?.checkedAt.toISOString() ?? null,
      failed: checked?.failed ?? null,
    },
    available: options.checkOn
      ? newerReleases(HEKATE_VERSION, checked?.releases ?? [], options.channel)
      : [],
    history: history.map((h) => ({
      version: h.version,
      firstStartedAt: h.firstStartedAt.toISOString(),
    })),
    environment,
  };
}
