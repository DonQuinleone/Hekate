import { spawnSync } from "node:child_process";
import { createDecipheriv } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, runMigrations, schema } from "@hekate/db";
import { createBackends, storageConfigFromEnv, unwrapKey } from "@hekate/storage";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createJobs, type JobName, jobDefinitions } from "./jobs.ts";
import { createKeyring } from "./keyring.ts";
import { run } from "./media/ffmpeg.ts";
import { probeHandler, startWorkers } from "./media/workers.ts";
import { createStorage } from "./storage.ts";

const url = process.env.DATABASE_URL;
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

describe.runIf(url && (hasFfmpeg || process.env.CI))("media jobs", () => {
  const { db, close } = createDb(url ?? "", { max: 3 });
  const root = mkdtempSync(join(tmpdir(), "hekate-jobs-"));
  const backends = createBackends(
    storageConfigFromEnv({ STORAGE_LOCAL_PATH: join(root, "storage") }),
  );
  const keyring = createKeyring(db, { current: Buffer.alloc(32, 3), previous: [] });
  const storage = createStorage(db, backends, keyring);
  // A schema of its own, so tests never touch a development queue.
  const jobs = createJobs({ connectionString: url ?? "", schema: "pgboss_test" });
  let organisationId = "";
  let projectId = "";

  const addFile = async (bytes: Buffer, kind: "audio" | "video" | "document", name: string) => {
    const blob = await storage.put(organisationId, bytes);
    const [file] = await db
      .insert(schema.files)
      .values({
        organisationId,
        projectId,
        name,
        kind,
        blobId: blob.id,
        contentType: "application/octet-stream",
        byteSize: bytes.length,
      })
      .returning();
    return file?.id ?? "";
  };

  const settle = async (name: JobName, id: string | null) => {
    if (!id) throw new Error("The job was not queued");
    const deadline = Date.now() + 30_000;
    for (;;) {
      const state = await jobs.state(name, id);
      if (state === "completed" || state === "failed") return state;
      if (Date.now() > deadline) throw new Error(`Job ${id} still ${state} after 30 s`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  const mediaInfoOf = async (fileId: string) =>
    (
      await db
        .select({ info: schema.files.mediaInfo })
        .from(schema.files)
        .where(eq(schema.files.id, fileId))
    )[0]?.info;

  beforeAll(async () => {
    await runMigrations(url ?? "");
    const [organisation] = await db
      .insert(schema.organisations)
      .values({ name: "Jobs", slug: `jobs-${Date.now()}` })
      .returning();
    organisationId = organisation?.id ?? "";
    const [project] = await db
      .insert(schema.projects)
      .values({ organisationId, name: "Rags", profile: "music" })
      .returning();
    projectId = project?.id ?? "";
    await jobs.start();
    await startWorkers(jobs, { db, storage, keyring, jobs, workDir: join(root, "work") }, 2);
  });

  afterAll(async () => {
    await jobs.stop(5_000);
    await db.execute(sql`drop schema if exists pgboss_test cascade`);
    await db.execute(sql`delete from ${schema.organisations} where id = ${organisationId}`);
    await close();
    rmSync(root, { recursive: true, force: true });
  });

  it("probes an uploaded recording and records what it found", async () => {
    const wav = join(root, "take.wav");
    await run("ffmpeg", [
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=duration=1.5:sample_rate=48000",
      "-ac",
      "2",
      "-c:a",
      "pcm_s24le",
      wav,
    ]);
    const fileId = await addFile(readFileSync(wav), "audio", "Take 4.wav");
    expect(await mediaInfoOf(fileId)).toBeNull();

    const state = await settle(
      "media-probe",
      await jobs.send("media-probe", { organisationId, fileId }),
    );
    expect(state).toBe("completed");
    const info = await mediaInfoOf(fileId);
    expect(info).toMatchObject({
      format: "wav",
      audio: { codec: "pcm_s24le", channels: 2, sampleRate: 48000, bitDepth: 24 },
    });
    expect(info?.duration).toBeCloseTo(1.5, 1);

    // Probing queues the proxies: encrypted HLS, ready to stream.
    const deadline = Date.now() + 60_000;
    let status = "";
    while (Date.now() < deadline) {
      [{ status = "" } = {}] = await db
        .select({ status: schema.files.streamStatus })
        .from(schema.files)
        .where(eq(schema.files.id, fileId));
      if (status === "ready" || status === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(status).toBe("ready");
    const all = await db
      .select()
      .from(schema.renditions)
      .where(eq(schema.renditions.fileId, fileId))
      .orderBy(asc(schema.renditions.bandwidth));
    expect(all.map((r) => [r.name, r.codecs])).toEqual([
      ["aac-256", "mp4a.40.2"],
      ["flac", "fLaC"],
    ]);
    // Lossless keeps the source: 48 kHz, 2 channels, 24-bit.
    expect(all[1]?.bandwidth).toBe(48_000 * 2 * 24);
    const rendition = all[0];
    expect(rendition?.targetDuration).toBe(2);
    const segments = await db
      .select()
      .from(schema.renditionSegments)
      .where(eq(schema.renditionSegments.renditionId, rendition?.id ?? ""));
    expect(segments.length).toBeGreaterThanOrEqual(1);
    expect(new Set(segments.map((x) => x.iv)).size).toBe(segments.length);

    // Two layers: at rest, then AES-128 for delivery. Peeling both gives an MP4 init section.
    const { stream } = await storage.open(organisationId, rendition?.initBlobId ?? "");
    const delivered = Buffer.concat(await stream.toArray());
    expect(delivered.includes(Buffer.from("ftyp"))).toBe(false);
    const contentKey = unwrapKey(
      await keyring.version(organisationId, rendition?.keyVersion ?? 0),
      rendition?.wrappedKey ?? "",
      `rendition:${rendition?.id}`,
    );
    const decipher = createDecipheriv(
      "aes-128-cbc",
      contentKey,
      Buffer.from(rendition?.initIv ?? "", "hex"),
    );
    const init = Buffer.concat([decipher.update(delivered), decipher.final()]);
    expect(init.subarray(4, 8).toString()).toBe("ftyp");
  });

  it("records unreadable media once instead of retrying forever", async () => {
    const fileId = await addFile(Buffer.from("not really audio at all"), "audio", "broken.wav");
    expect(
      await settle("media-probe", await jobs.send("media-probe", { organisationId, fileId })),
    ).toBe("completed");
    expect(await mediaInfoOf(fileId)).toEqual({});
    const [row] = await db
      .select({ status: schema.files.streamStatus })
      .from(schema.files)
      .where(eq(schema.files.id, fileId));
    expect(row?.status).toBe("failed");
  });

  it("never touches a file through another organisation's job", async () => {
    const fileId = await addFile(Buffer.from("x"), "audio", "elsewhere.wav");
    const [other] = await db
      .insert(schema.organisations)
      .values({ name: "Other", slug: `other-${Date.now()}` })
      .returning();
    const id = await jobs.send("media-probe", { organisationId: other?.id ?? "", fileId });
    expect(await settle("media-probe", id)).toBe("completed");
    expect(await mediaInfoOf(fileId)).toBeNull();
    await db.execute(sql`delete from ${schema.organisations} where id = ${other?.id}`);
  });

  it("skips documents and refuses malformed job data", async () => {
    const fileId = await addFile(Buffer.from("%PDF-1.7"), "document", "score.pdf");
    expect(
      await settle("media-probe", await jobs.send("media-probe", { organisationId, fileId })),
    ).toBe("completed");
    expect(await mediaInfoOf(fileId)).toBeNull();
    await expect(jobs.send("media-probe", { organisationId: "nope", fileId })).rejects.toThrow();
  });

  it("gives up on a file it cannot reach after the last attempt, rather than leave it waiting", async () => {
    const fileId = await addFile(Buffer.from("RIFF"), "audio", "Unreachable.wav");
    await db
      .update(schema.files)
      .set({ streamStatus: "pending" })
      .where(eq(schema.files.id, fileId));
    const broken = {
      ...storage,
      open: async () => {
        throw new Error("Storage is unavailable");
      },
    };
    const handler = probeHandler({
      db,
      storage: broken,
      keyring,
      jobs,
      workDir: join(root, "work"),
    });
    const statusOf = async () =>
      (
        await db
          .select({ status: schema.files.streamStatus })
          .from(schema.files)
          .where(eq(schema.files.id, fileId))
      )[0]?.status;
    const attempt = (retryCount: number) =>
      handler(
        { organisationId, fileId },
        { id: "job", signal: new AbortController().signal, retryCount },
      );
    await expect(attempt(0)).rejects.toThrow(/unavailable/);
    expect(await statusOf()).toBe("pending");
    await expect(attempt(jobDefinitions["media-probe"].options.retryLimit)).rejects.toThrow(
      /unavailable/,
    );
    expect(await statusOf()).toBe("failed");
  });
});
