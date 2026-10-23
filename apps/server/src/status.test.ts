import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, type Database, runMigrations, schema, withAuditPurge } from "@hekate/db";
import type { HealthChecks, Incident, StatusNow, StatusPage, SupportModule } from "@hekate/shared";
import { createBackends, storageConfigFromEnv } from "@hekate/storage";
import { asc, eq, like, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { createAudit } from "./audit.ts";
import { createAuth } from "./auth.ts";
import { createInstanceSettings } from "./instance-settings.ts";
import { createKeyring } from "./keyring.ts";
import { memoryMailer } from "./mail.ts";
import { playbackSecret } from "./playback.ts";
import { createStatus, listedServices, readStatusPage, recordServiceMinute } from "./status.ts";
import { createStorage } from "./storage.ts";

const url = process.env.DATABASE_URL;

describe.runIf(url)("status page and incidents (#183)", () => {
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
  const storageRoot = mkdtempSync(join(tmpdir(), "hekate-status-storage-"));
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
  const build = (support: "off" | "app", statusUrl: string | null = null) =>
    createApp({
      settings,
      db,
      auth,
      mailer,
      storage,
      audit,
      jobs: { send: async () => "job" },
      keyring,
      playbackSecret: playbackSecret("test-secret-test-secret-test-secret-0"),
      publicUrl: "http://localhost:3000",
      log: false,
      operatorSecurityKey: false,
      modules: {
        billing: "off",
        support,
        supportAddress: null,
        docsUrl: "https://docs.hekate.studio",
        statusUrl,
      },
    });
  // Tickets off: the status page and its incidents are every instance's.
  const app = build("off");
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
  const get = (path: string, cookie?: string, via = app) =>
    via.request(path, cookie ? { headers: { cookie } } : {});
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
  /** Another workspace's owner, who does not operate the instance. */
  const owner = async (operator: string) => {
    const res = await send(
      "/api/instance/workspaces",
      { name: "Saltmarsh Films", slug: "saltmarsh", ownerEmail: "ines@saltmarsh.example" },
      operator,
    );
    const { link } = (await res.json()) as { link: string };
    const accepted = await app.request(
      `/api/invitations/${link.split("/invite/")[1]}/accept`,
      json({ name: "Ines Arlow", password: "correct horse battery" }),
    );
    return cookieOf(accepted);
  };
  const incident = {
    title: "Uploads are failing",
    impact: "partial",
    services: ["storage", "worker"],
    body: "Some uploads stop at 99%. We are looking into it.",
  };
  const post = async (cookie: string, body: object = incident) => {
    const res = await send("/api/instance/incidents", body, cookie);
    return {
      res,
      body: (await res.json()) as { id: string; incidents: Incident[]; now: StatusNow },
    };
  };
  const page = async () => (await (await get("/api/status")).json()) as StatusPage;
  const events = (prefix: string) =>
    db
      .select({ action: schema.instanceEvents.action, target: schema.instanceEvents.target })
      .from(schema.instanceEvents)
      .where(like(schema.instanceEvents.action, `${prefix}%`))
      .orderBy(asc(schema.instanceEvents.createdAt));

  beforeAll(async () => {
    await runMigrations(url ?? "");
  });
  beforeEach(async () => {
    await withAuditPurge(db, (tx) =>
      tx.execute(sql`truncate ${schema.organisations}, ${schema.users} cascade`),
    );
    await db.execute(sql`truncate ${schema.requestLimits}`);
    await db.delete(schema.incidents);
    await db.delete(schema.serviceDays);
    await db.delete(schema.instanceEvents);
    await db.delete(schema.instanceSettings);
    settings.forget();
  });
  afterAll(async () => {
    await withAuditPurge(db, (tx) =>
      tx.execute(sql`truncate ${schema.organisations}, ${schema.users} cascade`),
    );
    await db.delete(schema.incidents);
    await db.delete(schema.serviceDays);
    await db.delete(schema.instanceSettings);
    await close();
    rmSync(storageRoot, { recursive: true, force: true });
  });

  it("reads signed out, naming services and nothing of any workspace", async () => {
    await setup();
    const res = await get("/api/status");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as StatusPage;
    expect(body.complete).toBe(true);
    expect(body.services.map((s) => s.name)).toEqual(
      expect.arrayContaining(["api", "database", "storage", "worker"]),
    );
    expect(body.services[0]?.days).toHaveLength(90);
    expect(body).toMatchObject({ open: [], past: [] });
    expect(JSON.stringify(body)).not.toMatch(/Endless Hall|alex@/);
    const now = (await (await get("/api/status/now")).json()) as StatusNow;
    expect(now).toMatchObject({ open: [], lastIncidentAt: null });
  });

  it("is posted by operators alone", async () => {
    const operator = await setup();
    const other = await owner(operator);
    expect((await post(other)).res.status).toBe(403);
    expect((await get("/api/instance/incidents", other)).status).toBe(403);
    expect((await app.request("/api/instance/incidents", json(incident))).status).toBe(401);
    expect(await db.select().from(schema.incidents)).toHaveLength(0);
  });

  it("posts an incident, shows it everywhere, and records it", async () => {
    const operator = await setup();
    const { res, body } = await post(operator);
    expect(res.status).toBe(201);
    expect(body.incidents[0]).toMatchObject({
      title: "Uploads are failing",
      impact: "partial",
      services: ["storage", "worker"],
      state: "investigating",
      resolvedAt: null,
      updates: [{ state: "investigating", author: "Alex Rivera" }],
    });
    expect(body.now.open.map((i) => i.title)).toEqual(["Uploads are failing"]);
    // The public page has it at once, with no operator's name.
    const shown = await page();
    expect(shown.open).toHaveLength(1);
    expect(shown.open[0]?.updates[0]).not.toHaveProperty("author");
    expect(shown.services.find((s) => s.name === "storage")?.state).toMatch(/partial|major/);
    expect(shown.services.find((s) => s.name === "storage")?.days.at(-1)?.incidents).toEqual([
      "Uploads are failing",
    ]);
    expect(JSON.stringify(shown)).not.toMatch(/Alex/);
    expect(await events("incident.")).toEqual([
      { action: "incident.posted", target: "Uploads are failing" },
    ]);
  });

  it("takes updates through to a resolution, and opens it again", async () => {
    const operator = await setup();
    const { body: posted } = await post(operator);
    const id = posted.id;
    const update = (body: object) => send(`/api/instance/incidents/${id}/updates`, body, operator);
    const monitoring = await update({
      state: "monitoring",
      body: "A fix is out; uploads are finishing again.",
      impact: "degraded",
    });
    expect(monitoring.status).toBe(201);
    const resolved = await update({ state: "resolved", body: "Every upload since 14:10 is in." });
    const after = ((await resolved.json()) as { incidents: Incident[] }).incidents[0];
    expect(after).toMatchObject({ state: "resolved", impact: "degraded" });
    expect(after?.resolvedAt).not.toBeNull();
    expect(after?.updates.map((u) => u.state)).toEqual(["resolved", "monitoring", "investigating"]);
    const shown = await page();
    expect(shown.open).toHaveLength(0);
    expect(shown.past.map((i) => i.title)).toEqual(["Uploads are failing"]);
    // An update to a resolved incident opens it again.
    await update({ state: "investigating", body: "Some uploads fail again." });
    expect((await page()).open).toHaveLength(1);
    expect((await events("incident.")).map((e) => e.action)).toEqual([
      "incident.posted",
      "incident.updated",
      "incident.resolved",
      "incident.updated",
    ]);
    expect(
      (
        await send(
          "/api/instance/incidents/0190a0a0-0000-7000-8000-000000000000/updates",
          {
            state: "resolved",
            body: "Gone",
          },
          operator,
        )
      ).status,
    ).toBe(404);
  });

  it("takes an outage after the fact, and counts it in the uptime", async () => {
    const operator = await setup();
    const began = new Date(Date.now() - 3 * 86_400_000);
    const ended = new Date(began.getTime() + 2 * 3_600_000);
    const { res } = await post(operator, {
      title: "The instance was down",
      impact: "major",
      services: ["api", "database"],
      state: "resolved",
      body: "The database host ran out of disk; it was restarted with more.",
      startedAt: began.toISOString(),
      resolvedAt: ended.toISOString(),
    });
    expect(res.status).toBe(201);
    const shown = await page();
    expect(shown.past[0]).toMatchObject({
      startedAt: began.toISOString(),
      resolvedAt: ended.toISOString(),
    });
    const api = shown.services.find((s) => s.name === "api");
    expect(api?.uptime).toBeLessThan(1);
    // Two hours, across midnight or not.
    expect(api?.days.reduce((n, d) => n + d.downMinutes, 0)).toBeGreaterThanOrEqual(119);
    // Never ahead of now, nor before the page's 90 days.
    const future = await post(operator, {
      ...incident,
      startedAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(future.res.status).toBe(422);
    const ancient = await post(operator, {
      ...incident,
      startedAt: new Date(Date.now() - 100 * 86_400_000).toISOString(),
    });
    expect(ancient.res.status).toBe(422);
    expect((await post(operator, { ...incident, services: [] })).res.status).toBe(400);
  });

  it("takes one posted by mistake off the page", async () => {
    const operator = await setup();
    const { body } = await post(operator);
    const res = await send(`/api/instance/incidents/${body.id}`, {}, operator, "DELETE");
    expect(res.status).toBe(200);
    expect((await page()).open).toHaveLength(0);
    expect(await db.select().from(schema.incidentUpdates)).toHaveLength(0);
    expect((await events("incident.")).map((e) => e.action)).toEqual([
      "incident.posted",
      "incident.removed",
    ]);
  });

  it("counts each minute once however many replicas check it", async () => {
    const checks: HealthChecks = { database: "ok", storage: "failed", worker: "ok", mail: "off" };
    expect(listedServices(checks)).toEqual(["api", "database", "storage", "worker"]);
    const at = new Date("2026-10-22T10:00:30Z");
    await recordServiceMinute(db, checks, at);
    // Another replica, the same minute.
    await recordServiceMinute(db, checks, new Date("2026-10-22T10:00:50Z"));
    await recordServiceMinute(db, { ...checks, storage: "ok" }, new Date("2026-10-22T10:01:10Z"));
    const rows = await db
      .select()
      .from(schema.serviceDays)
      .where(eq(schema.serviceDays.service, "storage"));
    expect(rows).toMatchObject([{ day: "2026-10-22", minutes: 2, down: 1 }]);
    expect(
      await db.select().from(schema.serviceDays).where(eq(schema.serviceDays.service, "mail")),
    ).toHaveLength(0);
    // Days past the page's 90 go.
    await recordServiceMinute(db, checks, new Date("2027-03-01T00:00:00Z"));
    expect(
      (await db.select({ day: schema.serviceDays.day }).from(schema.serviceDays)).map((r) => r.day),
    ).not.toContain("2026-10-22");
  });

  it("still says what is down when the database cannot be read", async () => {
    const broken = {
      select() {
        throw new Error("The database is not answering");
      },
    } as unknown as Database;
    const checks: HealthChecks = { database: "failed", storage: "ok", worker: "ok", mail: "off" };
    await expect(readStatusPage(broken, checks, new Date())).rejects.toThrow();
    const shown = await createStatus(broken, async () => checks).page();
    expect(shown).toMatchObject({ complete: false, state: "major", open: [], past: [] });
    expect(shown.services.find((s) => s.name === "database")?.state).toBe("major");
  });

  it("links the instance's own page unless another is set", async () => {
    const operator = await setup();
    const me = (await (await get("/api/me", operator)).json()) as { support: SupportModule };
    expect(me.support.statusUrl).toBe("http://localhost:3000/status");
    const elsewhere = build("off", "https://status.example");
    const set = (await (await get("/api/me", operator, elsewhere)).json()) as {
      support: SupportModule;
    };
    expect(set.support.statusUrl).toBe("https://status.example");
    // With tickets off, the desk still sets where the status page is; the tickets stay refused.
    expect((await get("/api/instance/support", operator)).status).toBe(409);
    expect(
      (
        await send(
          "/api/instance/support/desk",
          { statusUrl: "https://status.endlesshall.example", onCall: null },
          operator,
          "PUT",
        )
      ).status,
    ).toBe(200);
    const after = (await (await get("/api/me", operator)).json()) as { support: SupportModule };
    expect(after.support.statusUrl).toBe("https://status.endlesshall.example");
    // Only by operators.
    const other = await owner(operator);
    expect(
      (await send("/api/instance/support/desk", { statusUrl: null, onCall: null }, other, "PUT"))
        .status,
    ).toBe(403);
  });
});
