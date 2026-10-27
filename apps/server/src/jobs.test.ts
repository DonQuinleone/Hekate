import { spawnSync } from "node:child_process";
import { createDecipheriv } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, runMigrations, schema } from "@hekate/db";
import { decodePeaks, mapTime } from "@hekate/shared";
import { createBackends, storageConfigFromEnv, unwrapKey } from "@hekate/storage";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createJobs, type JobName, jobDefinitions } from "./jobs.ts";
import { createKeyring } from "./keyring.ts";
import { run } from "./media/ffmpeg.ts";
import { webpComplete } from "./media/pages.ts";
import { samplePdf } from "./media/sample-pdf.ts";
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

    // Probing also queues the waveform: peaks per channel, stored encrypted.
    const peaksDeadline = Date.now() + 60_000;
    let analysisStatus = "";
    while (Date.now() < peaksDeadline) {
      [{ analysisStatus = "" } = {}] = await db
        .select({ analysisStatus: schema.files.analysisStatus })
        .from(schema.files)
        .where(eq(schema.files.id, fileId));
      if (analysisStatus === "ready" || analysisStatus === "failed") break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    expect(analysisStatus).toBe("ready");
    const levels = await db
      .select()
      .from(schema.peakLevels)
      .where(eq(schema.peakLevels.fileId, fileId))
      .orderBy(asc(schema.peakLevels.samplesPerPeak));
    // 1.5 s at 48 kHz is short enough for one level.
    expect(levels.map((l) => [l.samplesPerPeak, l.peakCount, l.channels])).toEqual([
      [256, Math.ceil((1.5 * 48000) / 256), 2],
    ]);
    const peaks = await storage.open(organisationId, levels[0]?.blobId ?? "");
    const decoded = decodePeaks(new Uint8Array(Buffer.concat(await peaks.stream.toArray())));
    expect(decoded.channels).toBe(2);
    expect(Math.max(...decoded.data)).toBeGreaterThan(10);

    // The rendition cache cleared (decision 255): new renditions from the original take the old
    // ones' place, whose segments are removed; the original is untouched.
    const before = all.map((r) => r.id);
    const oldBlobs = [...all.map((r) => r.initBlobId), ...segments.map((s) => s.blobId)];
    const [original] = await db
      .select({ blobId: schema.files.blobId })
      .from(schema.files)
      .where(eq(schema.files.id, fileId));
    expect(
      await settle("media-reproxy", await jobs.send("media-reproxy", { organisationId, fileId })),
    ).toBe("completed");
    const after = await db
      .select({ id: schema.renditions.id, name: schema.renditions.name })
      .from(schema.renditions)
      .where(eq(schema.renditions.fileId, fileId))
      .orderBy(asc(schema.renditions.bandwidth));
    expect(after.map((r) => r.name)).toEqual(["aac-256", "flac"]);
    expect(after.some((r) => before.includes(r.id))).toBe(false);
    const left = await db
      .select({ id: schema.blobs.id })
      .from(schema.blobs)
      .where(inArray(schema.blobs.id, [...oldBlobs, original?.blobId ?? ""]));
    expect(left.map((b) => b.id)).toEqual([original?.blobId]);
    const [still] = await db
      .select({ status: schema.files.streamStatus, blobId: schema.files.blobId })
      .from(schema.files)
      .where(eq(schema.files.id, fileId));
    expect(still).toEqual({ status: "ready", blobId: original?.blobId });
  }, 60_000);

  it("aligns two versions and moves carried comments to where the music went", async () => {
    // Version 1: a tone that steps up every two seconds. Version 2: the same, 1.5 s later.
    const v1 = join(root, "v1.wav");
    const v2 = join(root, "v2.wav");
    const tone = "aevalsrc=0.4*sin(2*PI*(220+55*floor(t/2))*t):d=12:s=22050";
    for (const [path, filter] of [
      [v1, "anull"],
      [v2, "adelay=1500,volume=0.5"],
    ] as const) {
      await run("ffmpeg", [
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        tone,
        "-af",
        filter,
        "-c:a",
        "pcm_s16le",
        path,
      ]);
    }
    const from = await addFile(readFileSync(v1), "audio", "Mix v1.wav");
    const to = await addFile(readFileSync(v2), "audio", "Mix v2.wav");
    const [thread] = await db
      .insert(schema.comments)
      .values({
        organisationId,
        fileId: from,
        body: "Click at the change",
        anchor: { kind: "time", start: 6, end: 6.5 },
      })
      .returning();
    const [placed] = await db
      .insert(schema.comments)
      .values({
        organisationId,
        fileId: from,
        body: "Placed",
        anchor: { kind: "time", start: 2, end: 2 },
      })
      .returning();
    const [bars] = await db
      .insert(schema.comments)
      .values({
        organisationId,
        fileId: from,
        body: "Rushed",
        anchor: { kind: "bar", from: { bar: 9, beat: 1 }, to: { bar: 12 }, at: 4 },
      })
      .returning();
    await db.insert(schema.commentCarries).values([
      { organisationId, commentId: thread?.id ?? "", fileId: to, anchor: thread?.anchor ?? null },
      { organisationId, commentId: bars?.id ?? "", fileId: to, anchor: bars?.anchor ?? null },
      {
        organisationId,
        commentId: placed?.id ?? "",
        fileId: to,
        anchor: { kind: "time", start: 9, end: 9 },
        anchorPlaced: true,
      },
    ]);
    const [pair] = await db
      .insert(schema.alignments)
      .values({ organisationId, fromFileId: from, toFileId: to })
      .returning();
    const state = await settle(
      "media-align",
      await jobs.send("media-align", { organisationId, alignmentId: pair?.id ?? "" }),
    );
    expect(state).toBe("completed");
    const [aligned] = await db
      .select()
      .from(schema.alignments)
      .where(eq(schema.alignments.id, pair?.id ?? ""));
    expect(aligned?.status).toBe("ready");
    expect(aligned?.quality).toBeGreaterThan(0.7);
    expect(mapTime(aligned?.points ?? [], 6)).toBeCloseTo(7.5, 0);

    const carries = await db
      .select({ commentId: schema.commentCarries.commentId, anchor: schema.commentCarries.anchor })
      .from(schema.commentCarries)
      .where(eq(schema.commentCarries.fileId, to));
    const moved = carries.find((c) => c.commentId === thread?.id)?.anchor;
    expect(moved?.kind === "time" && moved.start).toBeGreaterThan(7.2);
    expect(moved?.kind === "time" && moved.start).toBeLessThan(7.8);
    // Bars keep their numbers; the moment they were named at moves with the music.
    const movedBars = carries.find((c) => c.commentId === bars?.id)?.anchor;
    expect(movedBars).toMatchObject({ kind: "bar", from: { bar: 9 }, to: { bar: 12 } });
    expect(movedBars?.kind === "bar" && movedBars.at).toBeGreaterThan(5.2);
    expect(movedBars?.kind === "bar" && movedBars.at).toBeLessThan(5.8);
    // Placed by hand: left where it was put.
    expect(carries.find((c) => c.commentId === placed?.id)?.anchor).toEqual({
      kind: "time",
      start: 9,
      end: 9,
    });
  });

  it("draws a PDF as encrypted pages, and fails a fake one at once", async () => {
    const fileId = await addFile(samplePdf(3, { bars: true }), "document", "Score.pdf");
    expect(
      await settle(
        "document-render",
        await jobs.send("document-render", { organisationId, fileId }),
      ),
    ).toBe("completed");
    const [file] = await db
      .select({
        status: schema.files.streamStatus,
        pageCount: schema.files.pageCount,
        bars: schema.files.printedBars,
      })
      .from(schema.files)
      .where(eq(schema.files.id, fileId));
    expect(file).toMatchObject({ status: "ready", pageCount: 3 });
    // The bar numbers the score prints, for going to a bar (#52).
    expect(file?.bars?.map((b) => [b.page, b.bar])).toEqual([
      [1, 5],
      [1, 9],
      [1, 13],
      [2, 17],
      [2, 21],
      [2, 25],
      [2, 29],
      [3, 33],
      [3, 37],
      [3, 41],
      [3, 45],
    ]);
    const pages = await db
      .select()
      .from(schema.filePages)
      .where(eq(schema.filePages.fileId, fileId))
      .orderBy(asc(schema.filePages.page));
    expect(pages.map((p) => p.page)).toEqual([1, 2, 3]);
    // Stored encrypted: only through storage does a page read as WebP.
    const { stream } = await storage.open(organisationId, pages[0]?.blobId ?? "");
    const view = Buffer.concat(await stream.toArray());
    expect(webpComplete(view)).toBe(true);

    const fake = await addFile(Buffer.from("not a pdf"), "document", "Fake.pdf");
    expect(
      await settle(
        "document-render",
        await jobs.send("document-render", { organisationId, fileId: fake }),
      ),
    ).toBe("completed");
    const [failed] = await db
      .select({ status: schema.files.streamStatus })
      .from(schema.files)
      .where(eq(schema.files.id, fake));
    expect(failed?.status).toBe("failed");
  }, 30_000); // drawing and encoding six images takes seconds on a busy runner

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

describe.runIf(url)("holding jobs (maintenance mode)", () => {
  // A schema of its own, so this never takes another test's jobs.
  const jobs = createJobs({ connectionString: url ?? "", schema: "pgboss_hold_test" });
  const { db, close } = createDb(url ?? "", { max: 1 });
  afterAll(async () => {
    await jobs.stop(5_000);
    await db.execute(sql`drop schema if exists pgboss_hold_test cascade`);
    await close();
  });

  it("keeps queued jobs while held, and works them once let go", async () => {
    await jobs.start();
    let worked = 0;
    await jobs.work("sign-in-attempts-purge", async () => {
      worked += 1;
    });
    await jobs.hold(true);
    const id = await jobs.send("sign-in-attempts-purge", {});
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(worked).toBe(0);
    expect(await jobs.state("sign-in-attempts-purge", id ?? "")).toBe("created");
    await jobs.hold(false);
    const deadline = Date.now() + 20_000;
    while (worked === 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    expect(worked).toBe(1);
  }, 40_000);
});

describe.runIf(url)("a replica stopped mid-job (#193)", () => {
  // Two replicas' queues, in a schema of their own.
  const one = createJobs({ connectionString: url ?? "", schema: "pgboss_stop_test" });
  const two = createJobs({ connectionString: url ?? "", schema: "pgboss_stop_test" });
  const { db, close } = createDb(url ?? "", { max: 1 });

  beforeAll(async () => {
    await one.start();
    await two.start();
  });

  afterAll(async () => {
    await two.stop(2_000);
    await db.execute(sql`drop schema if exists pgboss_stop_test cascade`);
    await close();
  });

  it("gives the job back to the queue past its grace, and another replica finishes it", async () => {
    let started = false;
    let aborted = false;
    // A job that outlasts the grace, as a long transcode would.
    await one.work("logs-retention", async (_data, job) => {
      started = true;
      await new Promise<void>((resolve) => job.signal.addEventListener("abort", () => resolve()));
      aborted = true;
      throw new Error("stopped mid-job");
    });
    const id = await one.send("logs-retention", {});
    if (!id) throw new Error("The job was not queued");
    await vi.waitFor(() => expect(started).toBe(true), { timeout: 10_000 });

    await one.stop(1_000);
    expect(aborted).toBe(true);
    expect(await two.state("logs-retention", id)).toBe("retry");

    let finished = 0;
    await two.work("logs-retention", async () => {
      finished += 1;
    });
    await vi.waitFor(async () => expect(await two.state("logs-retention", id)).toBe("completed"), {
      timeout: 20_000,
      interval: 200,
    });
    expect(finished).toBe(1);
  }, 40_000);
});
