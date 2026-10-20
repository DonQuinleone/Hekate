import { createDb, runMigrations, schema } from "@hekate/db";
import { createBackends, storageConfigFromEnv } from "@hekate/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkReleases,
  HEKATE_VERSION,
  recordVersionRun,
  systemInformation,
} from "./system-info.ts";

const url = process.env.DATABASE_URL;

/** The releases feed as GitHub answers it, at versions around the one running. */
const feed = () => {
  const [major = 0, minor = 0] = HEKATE_VERSION.split(".").map(Number);
  const release = (version: string, prerelease = false) => ({
    tag_name: `v${version}`,
    name: `Release ${version}`,
    published_at: "2026-11-02T10:00:00Z",
    prerelease,
    draft: false,
    body: "Fixes and a new screen.",
    html_url: `https://github.com/DonQuinleone/Hekate/releases/tag/v${version}`,
  });
  return [
    release(`${major}.${minor + 1}.0`),
    release(`${major}.${minor + 2}.0-rc.1`, true),
    release(HEKATE_VERSION),
  ];
};
const answering =
  (body: unknown, status = 200): typeof fetch =>
  async () =>
    new Response(JSON.stringify(body), { status });

describe.runIf(url)("system information (#158)", () => {
  const { db, close } = createDb(url ?? "", { max: 2 });
  const backends = createBackends(
    storageConfigFromEnv({ STORAGE_LOCAL_PATH: "/tmp/hekate-system" }),
  );
  beforeAll(async () => {
    await runMigrations(url ?? "");
    await db.delete(schema.releaseChecks);
    await db.delete(schema.versionsRun);
  });
  afterAll(async () => {
    await db.delete(schema.releaseChecks);
    await close();
  });
  const info = (checkOn: boolean, channel: "stable" | "beta" = "stable") =>
    systemInformation(db, { backends, build: "4f2a1c", checkOn, channel });

  it("keeps what the feed says, and offers what is newer on the channel", async () => {
    await recordVersionRun(db);
    await recordVersionRun(db);
    const checked = await checkReleases(db, answering(feed()));
    expect(checked).toHaveLength(3);
    const stable = await info(true);
    expect(stable.version).toBe(HEKATE_VERSION);
    expect(stable.build).toBe("4f2a1c");
    expect(stable.check.failed).toBeNull();
    expect(stable.available.map((r) => r.prerelease)).toEqual([false]);
    expect((await info(true, "beta")).available).toHaveLength(2);
    // Off, nothing is offered, whatever was kept.
    expect((await info(false)).available).toEqual([]);
    expect(stable.history.map((h) => h.version)).toEqual([HEKATE_VERSION]);
    expect(stable.environment.map((e) => e.name)).toContain("PostgreSQL");
  });

  it("says why a check failed, keeping the releases the last one found", async () => {
    await expect(checkReleases(db, answering({ message: "rate limited" }, 403))).rejects.toThrow(
      "403",
    );
    const after = await info(true);
    expect(after.check.failed).toContain("403");
    expect(after.available).toHaveLength(1);
  });
});
