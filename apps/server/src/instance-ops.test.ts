import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, runMigrations, schema, withAuditPurge } from "@hekate/db";
import type {
  InstanceOperations,
  QueueJobDetail,
  QueueRetryResult,
  QueuesView,
} from "@hekate/shared";
import { queueHints, rateLimits } from "@hekate/shared";
import { createBackends, storageConfigFromEnv } from "@hekate/storage";
import { asc, eq, like, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { createAudit } from "./audit.ts";
import { createAuth } from "./auth.ts";
import { createInstanceSettings } from "./instance-settings.ts";
import { createJobs, jobDefinitions } from "./jobs.ts";
import { createKeyring } from "./keyring.ts";
import { memoryMailer } from "./mail.ts";
import { playbackSecret } from "./playback.ts";
import { createStorage } from "./storage.ts";

const url = process.env.DATABASE_URL;

describe("queue hints", () => {
  it("say what every queue the server defines does", () => {
    for (const name of Object.keys(jobDefinitions)) expect(queueHints[name], name).toBeTruthy();
  });
});

describe.runIf(url)("the instance's queues and operations (decisions 250 and 251)", () => {
  const { db, close } = createDb(url ?? "", { max: 3 });
  const mailer = memoryMailer();
  const audit = createAudit(db);
  const keyring = createKeyring(db, { current: Buffer.alloc(32, 7), previous: [] });
  const auth = createAuth({
    db,
    secret: "test-secret-test-secret-test-secret-0",
    baseURL: "http://localhost:3000",
    testing: true,
    mailer,
    audit,
    keyring,
  });
  const storageRoot = mkdtempSync(join(tmpdir(), "hekate-ops-storage-"));
  const storage = createStorage(
    db,
    createBackends(
      storageConfigFromEnv({
        STORAGE_BACKENDS: "local",
        STORAGE_LOCAL_PATH: join(storageRoot, "local"),
      }),
    ),
    keyring,
  );
  const settings = createInstanceSettings(db);
  // A schema of its own, so the tests never touch a development queue.
  const jobs = createJobs({ connectionString: url ?? "", schema: "pgboss_ops_test" });
  const app = createApp({
    settings,
    db,
    auth,
    mailer,
    storage,
    audit,
    jobs,
    queues: jobs,
    keyring,
    playbackSecret: playbackSecret("test-secret-test-secret-test-secret-0"),
    publicUrl: "http://localhost:3000",
    log: false,
    operatorSecurityKey: false,
  });
  const json = (body: unknown, cookie?: string, method = "POST") => ({
    method,
    headers: {
      "content-type": "application/json",
      origin: "http://localhost:3000",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  const cookieOf = (res: Response) =>
    res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  const send = (path: string, body: unknown, cookie: string, method = "POST") =>
    app.request(path, json(body, cookie, method));
  const get = (path: string, cookie: string) => app.request(path, { headers: { cookie } });
  const accept = async (link: string, name: string) =>
    cookieOf(
      await app.request(
        `/api/invitations/${link.split("/invite/")[1]}/accept`,
        json({ name, password: "correct horse battery" }),
      ),
    );
  /** The installer's owner, and the first operator. */
  const setup = async () =>
    cookieOf(
      await app.request(
        "/api/setup",
        json({
          name: "Alex Rivera",
          email: "alex@endlesshall.example",
          password: "correct horse battery",
          organisation: "Endless Hall Records",
        }),
      ),
    );
  /** A member of the first workspace, and another workspace's owner: neither operates. */
  const others = async (operator: string) => {
    const invited = await send(
      "/api/organisation/invitations",
      { email: "tomas@endlesshall.example", role: "member" },
      operator,
    );
    const member = await accept(((await invited.json()) as { link: string }).link, "Tomas Varga");
    const made = await send(
      "/api/instance/workspaces",
      { name: "Saltmarsh Films", slug: "saltmarsh", ownerEmail: "ines@saltmarsh.example" },
      operator,
    );
    const owner = await accept(((await made.json()) as { link: string }).link, "Ines Arlow");
    return { member, owner };
  };
  const workspace = async () => {
    const [org] = await db
      .select({ id: schema.organisations.id })
      .from(schema.organisations)
      .where(eq(schema.organisations.name, "Endless Hall Records"));
    return org?.id ?? "";
  };
  /** A file in the first workspace, at the stage of preparation given. */
  const addFile = async (
    organisationId: string,
    name: string,
    status: "pending" | "ready" | "failed",
  ) => {
    const [project] = await db
      .insert(schema.projects)
      .values({ organisationId, name: "Joplin Rags", profile: "music" })
      .returning();
    const blob = await storage.put(organisationId, Buffer.from("not really audio"));
    const [file] = await db
      .insert(schema.files)
      .values({
        organisationId,
        projectId: project?.id ?? "",
        name,
        kind: "audio",
        blobId: blob.id,
        contentType: "audio/wav",
        byteSize: 16,
        streamStatus: status,
        mediaInfo: {
          duration: 1,
          container: "wav",
          audio: { codec: "pcm_s24le", channels: 2, sampleRate: 48000 },
          video: null,
        } as never,
      })
      .returning();
    return file?.id ?? "";
  };
  const failJob = (id: string | null) =>
    db.execute(sql`update pgboss_ops_test.job
      set state = 'failed', completed_on = now(), output = '{"message":"It broke"}'
      where id = ${id}::uuid`);
  const stateOf = async (id: string | null) =>
    (
      await db.execute<{ state: string }>(
        sql`select state::text as state from pgboss_ops_test.job where id = ${id}::uuid`,
      )
    )[0]?.state;
  const queues = async (cookie: string) =>
    (await (await get("/api/instance/queues", cookie)).json()) as QueuesView;
  const events = (prefix: string) =>
    db
      .select({ action: schema.instanceEvents.action, target: schema.instanceEvents.target })
      .from(schema.instanceEvents)
      .where(like(schema.instanceEvents.action, `${prefix}%`))
      .orderBy(asc(schema.instanceEvents.createdAt));

  beforeAll(async () => {
    await runMigrations(url ?? "");
    await jobs.start();
  });
  beforeEach(async () => {
    await withAuditPurge(db, (tx) =>
      tx.execute(sql`truncate ${schema.organisations}, ${schema.users} cascade`),
    );
    await db.execute(sql`truncate ${schema.requestLimits}`);
    await db.execute(sql`delete from pgboss_ops_test.job`);
    await db.delete(schema.instanceEvents);
    await db.delete(schema.instanceSettings);
    settings.forget();
  });
  afterAll(async () => {
    await jobs.stop(1000);
    await db.execute(sql`drop schema if exists pgboss_ops_test cascade`);
    await withAuditPurge(db, (tx) =>
      tx.execute(sql`truncate ${schema.organisations}, ${schema.users} cascade`),
    );
    await db.delete(schema.instanceSettings);
    await close();
    rmSync(storageRoot, { recursive: true, force: true });
  });

  it("lists every queue with what waits and failed, and the jobs that ran last", async () => {
    const operator = await setup();
    const org = await workspace();
    const fileId = await addFile(org, "Maple Leaf Rag - V3 dry.wav", "failed");
    await jobs.send("release-check", {});
    const failed = await jobs.send("media-proxy", { organisationId: org, fileId });
    await failJob(failed);
    const view = await queues(operator);
    expect(view.queues.map((q) => q.name)).toEqual(Object.keys(jobDefinitions));
    expect(view.queues.find((q) => q.name === "release-check")).toMatchObject({
      waiting: 1,
      active: 0,
      failed: 0,
      scheduled: true,
      paused: false,
      lane: "system",
    });
    expect(view.queues.find((q) => q.name === "media-proxy")).toMatchObject({
      waiting: 0,
      failed: 1,
      hint: "Streaming renditions",
    });
    // Scheduled sweeps are left out of the recent jobs unless they failed; file work is named.
    expect(view.recent).toEqual([
      expect.objectContaining({
        id: failed,
        queue: "media-proxy",
        state: "failed",
        what: "Maple Leaf Rag - V3 dry.wav",
        workspace: { id: org, name: "Endless Hall Records" },
      }),
    ]);
    const detail = (await (
      await get(`/api/instance/queues/media-proxy/jobs/${failed}`, operator)
    ).json()) as QueueJobDetail;
    expect(detail).toMatchObject({
      data: { organisationId: org, fileId },
      error: "It broke",
      state: "failed",
      attempts: 1,
    });
    expect((await get(`/api/instance/queues/no-such-queue/jobs/${failed}`, operator)).status).toBe(
      404,
    );
  });

  it("runs failures again: a file's by its retry plan, another job with its own id", async () => {
    const operator = await setup();
    const org = await workspace();
    const failedFile = await addFile(org, "Solace - Take 4.wav", "failed");
    const readyFile = await addFile(org, "Solace - Take 5.wav", "ready");
    const proxy = await jobs.send("media-proxy", { organisationId: org, fileId: failedFile });
    const stale = await jobs.send("media-proxy", { organisationId: org, fileId: readyFile });
    const check = await jobs.send("release-check", {});
    for (const id of [proxy, stale, check]) await failJob(id);

    // One job.
    const one = await send(`/api/instance/queues/release-check/jobs/${check}/retry`, {}, operator);
    expect(await one.json()).toEqual({ retried: 1, cleared: 0 } satisfies QueueRetryResult);
    expect(await stateOf(check)).toBe("retry");
    // Not failed any more: nothing to run again.
    expect(
      (await send(`/api/instance/queues/release-check/jobs/${check}/retry`, {}, operator)).status,
    ).toBe(409);

    // Every failure: the failed file waits again under new jobs, the ready one's is cleared.
    const all = await send("/api/instance/queues/retry", {}, operator);
    expect(await all.json()).toEqual({ retried: 1, cleared: 1 });
    expect(await stateOf(proxy)).toBeUndefined();
    expect(await stateOf(stale)).toBeUndefined();
    const [file] = await db
      .select({ status: schema.files.streamStatus })
      .from(schema.files)
      .where(eq(schema.files.id, failedFile));
    expect(file?.status).toBe("pending");
    expect((await queues(operator)).queues.find((q) => q.name === "media-proxy")?.waiting).toBe(1);
    expect(await events("queue")).toEqual([
      { action: "queue.job_retried", target: "release-check" },
      { action: "queues.retried", target: "Every queue" },
    ]);
  });

  it("pauses a queue in the settings, so every worker leaves it until resumed", async () => {
    const operator = await setup();
    const paused = await send(
      "/api/instance/queues/release-check/pause",
      { paused: true },
      operator,
    );
    expect(paused.status).toBe(200);
    expect(
      ((await paused.json()) as QueuesView).queues.find((q) => q.name === "release-check")?.paused,
    ).toBe(true);
    settings.forget();
    expect((await settings.get()).queues.paused).toEqual(["release-check"]);
    // A save from Settings, loaded before the pause, leaves it as it is.
    const { settings: current } = (await (
      await get("/api/instance/settings", operator)
    ).json()) as {
      settings: Record<string, unknown>;
    };
    expect(
      (
        await send(
          "/api/instance/settings",
          { ...current, queues: { paused: [] } },
          operator,
          "PUT",
        )
      ).status,
    ).toBe(200);
    settings.forget();
    expect((await settings.get()).queues.paused).toEqual(["release-check"]);

    // A worker held this way takes nothing from the paused queue, and takes it up once resumed.
    let ran = 0;
    await jobs.work("release-check", async () => {
      ran += 1;
    });
    await jobs.hold(false, new Set((await settings.get()).queues.paused));
    const id = await jobs.send("release-check", {});
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(ran).toBe(0);
    expect(await stateOf(id)).toBe("created");
    await send("/api/instance/queues/pause", { paused: false }, operator);
    settings.forget();
    await jobs.hold(false, new Set((await settings.get()).queues.paused));
    const deadline = Date.now() + 15_000;
    while (ran === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    expect(ran).toBe(1);

    await send("/api/instance/queues/pause", { paused: true }, operator);
    settings.forget();
    expect((await settings.get()).queues.paused).toEqual(Object.keys(jobDefinitions));
    expect(await events("queue")).toEqual([
      { action: "queue.paused", target: "release-check" },
      { action: "queues.resumed", target: "Every queue" },
      { action: "queues.paused", target: "Every queue" },
    ]);
    await jobs.hold(false, new Set());
  });

  it("drains a queue, marking failed the files whose preparation waited there", async () => {
    const operator = await setup();
    const org = await workspace();
    const fileId = await addFile(org, "Opening titles - Cut 3.wav", "pending");
    await jobs.send("media-proxy", { organisationId: org, fileId });
    const drained = await send("/api/instance/queues/media-proxy/drain", {}, operator);
    expect(await drained.json()).toEqual({ drained: 1 });
    const [file] = await db
      .select({ status: schema.files.streamStatus })
      .from(schema.files)
      .where(eq(schema.files.id, fileId));
    expect(file?.status).toBe("failed");
    expect(await events("queue")).toEqual([{ action: "queue.drained", target: "media-proxy" }]);
  });

  it("refuses everyone but operators", async () => {
    const operator = await setup();
    const { member, owner } = await others(operator);
    for (const cookie of [member, owner]) {
      expect((await get("/api/instance/queues", cookie)).status).toBe(403);
      expect((await send("/api/instance/queues/retry", {}, cookie)).status).toBe(403);
      expect(
        (await send("/api/instance/queues/media-proxy/pause", { paused: true }, cookie)).status,
      ).toBe(403);
      expect((await send("/api/instance/queues/media-proxy/drain", {}, cookie)).status).toBe(403);
    }
    expect((await send("/api/instance/queues/nothing/drain", {}, operator)).status).toBe(404);
    expect(await events("queue")).toEqual([]);
  });

  it("shows capacity as the environment and the code set it, to operators alone", async () => {
    const operator = await setup();
    const { member, owner } = await others(operator);
    const res = await get("/api/instance/operations", operator);
    expect(res.status).toBe(200);
    const body = (await res.json()) as InstanceOperations;
    expect(body.capacity).toMatchObject({
      process: { role: "all", lanes: null, concurrency: 2 },
      uploadLimitBytes: 8 * 1024 * 1024 * 10_000,
      lanes: { replicas: 1 },
    });
    // The very rules the routes enforce.
    expect(body.capacity.rateLimits).toContainEqual({
      name: "contentKeys",
      rule: rateLimits.contentKeys,
    });
    for (const cookie of [member, owner])
      expect((await get("/api/instance/operations", cookie)).status).toBe(403);
  });

  /** A failure in a document's pages, as the worker reports one. */
  const report = async (organisationId: string) => {
    await db.insert(schema.errorReports).values({
      reference: "HK-7F3A-2C",
      source: "worker",
      location: "document-render",
      message: "Could not render page 7 of Solace - Score.pdf: damaged cross-reference table.",
      stack:
        "PdfError: xref entry 41 points outside Solace - Score.pdf\n    at parseXref (pages/pdf.ts:188:11)\n    at Worker.run (worker/index.ts:140:17)\nfor alex@endlesshall.example",
      jobId: "0199e3a6-8f1c-7a02-8e44-2b7d0c9f3a15",
      context: { organisationId, fileId: "0199e3a1-7c2f-7b40-9a51-4f2d8c1e09aa" },
      organisationId,
    });
  };

  it("bundles the machine for support, with nothing of its content or its people", async () => {
    const operator = await setup();
    const { member, owner } = await others(operator);
    const org = await workspace();
    await report(org);
    await addFile(org, "Maple Leaf Rag - V3 dry.wav", "ready");
    const res = await get("/api/instance/support-bundle", operator);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="hekate-support-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    const bundle = JSON.parse(text) as {
      kind: string;
      counts: { workspaces: number; files: number };
      errors: { reference: string; kind: string; frames: string[] }[];
      queues: { name: string }[] | null;
    };
    expect(bundle.kind).toBe("hekate-support-bundle");
    expect(bundle.counts).toMatchObject({ workspaces: 2, files: 1 });
    expect(bundle.errors).toEqual([
      expect.objectContaining({
        reference: "HK-7F3A-2C",
        kind: "PdfError",
        frames: ["at parseXref (pages/pdf.ts:188:11)", "at Worker.run (worker/index.ts:140:17)"],
      }),
    ]);
    expect(bundle.queues?.length).toBe(Object.keys(jobDefinitions).length);
    // No name, address, workspace, file or path; no secret.
    for (const leak of [
      "Solace",
      "Maple Leaf",
      "Alex Rivera",
      "alex@",
      "ines@",
      "Endless Hall",
      "Saltmarsh",
      storageRoot,
      "test-secret",
      org,
    ])
      expect(text, leak).not.toContain(leak);
    expect(await events("debug.support")).toEqual([
      { action: "debug.support_bundle", target: "The support bundle" },
    ]);
    for (const cookie of [member, owner])
      expect((await get("/api/instance/support-bundle", cookie)).status).toBe(403);
  });

  it("marks an error known, and not known after all, as operators alone may", async () => {
    const operator = await setup();
    const { member, owner } = await others(operator);
    await report(await workspace());
    for (const cookie of [member, owner])
      expect(
        (await send("/api/instance/errors/HK-7F3A-2C/known", { known: true }, cookie)).status,
      ).toBe(403);
    expect(
      (await send("/api/instance/errors/HK-7F3A-2C/known", { known: true }, operator)).status,
    ).toBe(204);
    const found = (await (await get("/api/instance/errors/HK-7F3A-2C", operator)).json()) as {
      knownAt: string | null;
      knownBy: string | null;
    };
    expect(found.knownBy).toBe("Alex Rivera");
    expect(found.knownAt).not.toBeNull();
    const listed = (await (await get("/api/instance/errors", operator)).json()) as {
      errors: { reference: string; knownAt: string | null }[];
    };
    expect(listed.errors[0]?.knownAt).toBe(found.knownAt);
    await send("/api/instance/errors/hk7f3a2c/known", { known: false }, operator);
    expect(
      (
        (await (await get("/api/instance/errors/HK-7F3A-2C", operator)).json()) as {
          knownAt: string | null;
        }
      ).knownAt,
    ).toBeNull();
    expect(
      (await send("/api/instance/errors/HK-0000-00/known", { known: true }, operator)).status,
    ).toBe(404);
    expect(await events("debug.error")).toEqual([
      { action: "debug.error_known", target: "HK-7F3A-2C" },
      { action: "debug.error_unknown", target: "HK-7F3A-2C" },
    ]);
  });

  it("inspects a workflow run by its id or its track's, for operators alone", async () => {
    const operator = await setup();
    const { owner } = await others(operator);
    const org = await workspace();
    const [project] = await db
      .insert(schema.projects)
      .values({ organisationId: org, name: "Joplin Rags", profile: "music" })
      .returning();
    const [track] = await db
      .insert(schema.tracks)
      .values({ organisationId: org, projectId: project?.id ?? "", name: "Maple Leaf Rag" })
      .returning();
    const [run] = await db
      .insert(schema.workflowRuns)
      .values({
        organisationId: org,
        projectId: project?.id ?? "",
        trackId: track?.id ?? "",
        workflowName: "Mix and master",
        workflowVersion: 2,
        definition: {
          nodes: [{ id: "approve", type: "approval", name: "Mix approval", config: {} }],
          connectors: [],
        } as never,
        state: "running",
        engine: {
          state: "running",
          active: ["approve"],
          joining: [],
          taken: {},
          status: "Mixing",
        },
      })
      .returning();
    await db.insert(schema.workflowSteps).values({
      organisationId: org,
      runId: run?.id ?? "",
      nodeId: null,
      outcome: null,
      effects: [{ kind: "start", nodeId: "approve", type: "approval" as never, config: {} }],
    });
    for (const id of [run?.id, track?.id]) {
      const res = await get(`/api/instance/inspect/run/${id}`, operator);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        id: run?.id,
        workflowName: "Mix and master",
        track: { id: track?.id, name: "Maple Leaf Rag" },
        workspace: { id: org, name: "Endless Hall Records" },
        status: "Mixing",
        waiting: [{ nodeId: "approve", name: "Mix approval", type: "approval" }],
        steps: [{ node: null, effects: ["started Mix approval (approval)"] }],
        others: [],
      });
    }
    expect((await get(`/api/instance/inspect/run/${project?.id}`, operator)).status).toBe(404);
    expect((await get(`/api/instance/inspect/run/${run?.id}`, owner)).status).toBe(403);
    expect(await events("debug.inspected")).toHaveLength(2);
  });

  it("makes a workspace's renditions again, queueing each recording, for operators alone", async () => {
    const operator = await setup();
    const { owner } = await others(operator);
    const org = await workspace();
    const fileId = await addFile(org, "Maple Leaf Rag - V3 dry.wav", "ready");
    const init = await storage.put(org, Buffer.from("init"));
    const values = {
      organisationId: org,
      fileId,
      codecs: "mp4a.40.2",
      bandwidth: 256_000,
      targetDuration: 2,
      initBlobId: init.id,
      initIv: "00".repeat(16),
      wrappedKey: "wrapped",
      keyVersion: 1,
    };
    await db.insert(schema.renditions).values([
      { ...values, name: "aac-256" },
      { ...values, name: "flac" },
    ]);
    const path = `/api/instance/workspaces/${org}/renditions/rebuild`;
    expect((await send(path, {}, owner)).status).toBe(403);
    const res = await send(path, {}, operator);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ files: 1, queued: 1 });
    const queued = await db.execute<{ data: { fileId: string } }>(
      sql`select data from pgboss_ops_test.job where name = 'media-reproxy'`,
    );
    expect(queued.map((j) => j.data.fileId)).toEqual([fileId]);
    // Twice an hour at most; the file's original was never touched.
    expect((await send(path, {}, operator)).status).toBe(202);
    expect((await send(path, {}, operator)).status).toBe(429);
    const [file] = await db
      .select({ blobId: schema.files.blobId, status: schema.files.streamStatus })
      .from(schema.files)
      .where(eq(schema.files.id, fileId));
    expect(file?.status).toBe("ready");
    expect(await events("storage.renditions")).toHaveLength(2);
  });
});
