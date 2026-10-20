import { spawnSync } from "node:child_process";
import { createDecipheriv, createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buffer } from "node:stream/consumers";
import { createDb, runMigrations, schema, uuidv7, withAuditPurge } from "@hekate/db";
import {
  decodeLoudness,
  decodePeaks,
  decodeSpectrogram,
  defaultPlayerViewSettings,
  defaultProjectRoles,
  type LoudnessSummary,
  levelsOf,
  lookingPermissions,
  mapTime,
} from "@hekate/shared";
import { CHUNK_SIZE, createBackends, encryptedSize, storageConfigFromEnv } from "@hekate/storage";
import { and, count, desc, eq, inArray, isNotNull, like, ne, sql } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, MAX_BODY_BYTES } from "./app.ts";
import { createAudit, csvCell } from "./audit.ts";
import { createAuth } from "./auth.ts";
import { describeReport, verifyBackup } from "./backup-verify.ts";
import { createClient } from "./client.ts";
import { loadConfig } from "./config.ts";
import { failureOfJob, purgeErrorReports, recordFailure } from "./error-reports.ts";
import { errorHandler, requestId } from "./errors.ts";
import { createFlags } from "./flags.ts";
import { issueGuestLink } from "./guests.ts";
import { type JobFailure, runJob } from "./jobs.ts";
import { createKeyring } from "./keyring.ts";
import { memoryMailer } from "./mail.ts";
import { probe, run } from "./media/ffmpeg.ts";
import { webpComplete, webpSize } from "./media/pages.ts";
import { jpegSize } from "./media/pdf.ts";
import { samplePdf } from "./media/sample-pdf.ts";
import {
  analysisHandler,
  checksumHandler,
  probeHandler,
  proxyHandler,
  requeueAlignments,
  requeueMissingFindings,
} from "./media/workers.ts";
import { collectFromDatabase, collectQueues } from "./metrics/index.ts";
import { deliverDigests, deliverInstant, tellProcessingFailed } from "./notifications.ts";
import { playbackSecret, signPlayback } from "./playback.ts";
import { purgeDueProjects } from "./project-purge.ts";
import { moveProject } from "./project-transfer.ts";
import { admit } from "./rate-limit.ts";
import { reconcileStorage } from "./reconcile.ts";
import { remindDue } from "./reminders.ts";
import { rehomePending } from "./score-swap.ts";
import { createSetupGate, SETUP_CODE_HEADER } from "./setup-code.ts";
import { createStorage } from "./storage.ts";
import { remindTasksDue } from "./tasks.ts";
import { expireUploads } from "./uploads.ts";
import { clockElapsed, fileMeasured, sweepRuns, workflowsFor } from "./workflow-runner.ts";
import { rewrapBehind, rewrapOrganisation } from "./workspace-keys.ts";
import { purgeDueWorkspaces } from "./workspace-purge.ts";

const url = process.env.DATABASE_URL;

describe("config", () => {
  it("refuses a work directory that media tools could not be given safely", () => {
    expect(() => loadConfig({ WORK_DIR: "/mnt/scratch space" })).toThrow(/WORK_DIR/);
    expect(() => loadConfig({ WORK_DIR: "relative/work" })).toThrow(/WORK_DIR/);
  });
});

describe.runIf(url)("api", () => {
  const { db, close } = createDb(url ?? "", { max: 3 });
  const mailer = memoryMailer();
  const audit = createAudit(db);
  const masterKey = Buffer.alloc(32, 7);
  const keyring = createKeyring(db, { current: masterKey, previous: [] });
  const auth = createAuth({
    db,
    secret: "test-secret-test-secret-test-secret-0",
    baseURL: "http://localhost:3000",
    testing: true,
    mailer,
    audit,
    keyring,
    ssoTrustedOrigins: process.env.KEYCLOAK_URL ? [process.env.KEYCLOAK_URL] : [],
  });
  const storageRoot = mkdtempSync(join(tmpdir(), "hekate-api-storage-"));
  const backends = createBackends(
    storageConfigFromEnv({
      STORAGE_BACKENDS: "local,spare",
      STORAGE_LOCAL_PATH: join(storageRoot, "local"),
      STORAGE_SPARE_DRIVER: "local",
      STORAGE_SPARE_PATH: join(storageRoot, "spare"),
    }),
  );
  const storage = createStorage(db, backends, keyring);
  const sent: { name: string; data: unknown }[] = [];
  /** Set to make the next queue call fail, as if the queue were down. */
  let failNextSend = false;
  const jobs = {
    send: async (name: string, data: unknown) => {
      if (failNextSend) {
        failNextSend = false;
        throw new Error("queue unavailable");
      }
      sent.push({ name, data });
      return `job-${sent.length}`;
    },
  };
  const app = createApp({
    db,
    auth,
    mailer,
    storage,
    audit,
    jobs,
    keyring,
    playbackSecret: playbackSecret("test-secret-test-secret-test-secret-0"),
    trustProxy: true,
    publicUrl: "http://localhost:3000",
    log: false,
    ssoTrustedOrigins: process.env.KEYCLOAK_URL ? [process.env.KEYCLOAK_URL] : [],
  });
  const owner = {
    name: "Producer",
    email: "producer@example.test",
    password: "correct horse battery",
  };

  const json = (body: unknown, cookie?: string) => ({
    method: "POST",
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
  const setup = () => app.request("/api/setup", json({ ...owner, organisation: "Studio" }));

  /**
   * Give someone a role in a project, through the API, as `granter` (who must be allowed to
   * manage its roles). A project made directly in the database has no roles yet: the named
   * default is created first.
   */
  const grantRole = async (granter: string, projectId: string, holder: string, name: string) => {
    const me = (await (await app.request("/api/me", { headers: { cookie: holder } })).json()) as {
      user: { id: string };
    };
    const listed = (await (
      await app.request(`/api/projects/${projectId}/roles`, { headers: { cookie: granter } })
    ).json()) as { roles: { id: string; name: string }[] };
    let role = listed.roles.find((r) => r.name === name);
    if (!role) {
      const permissions = defaultProjectRoles.find((r) => r.name === name)?.permissions ?? [];
      const created = await app.request(
        `/api/projects/${projectId}/roles`,
        json({ name, permissions }, granter),
      );
      role = ((await created.json()) as { role: { id: string; name: string } }).role;
    }
    const res = await app.request(`/api/projects/${projectId}/members/${me.user.id}`, {
      ...json({ roleId: role.id }, granter),
      method: "PUT",
    });
    expect(res.status).toBe(204);
  };
  const projectOfFile = async (fileId: string) =>
    (
      await db
        .select({ projectId: schema.files.projectId })
        .from(schema.files)
        .where(eq(schema.files.id, fileId))
    )[0]?.projectId ?? "";

  beforeAll(async () => {
    await runMigrations(url ?? "");
  });
  beforeEach(async () => {
    await withAuditPurge(db, (tx) =>
      tx.execute(sql`truncate ${schema.organisations}, ${schema.users} cascade`),
    );
    // Rate limit counts belong to no workspace; each test starts with none.
    await db.execute(sql`truncate ${schema.requestLimits}`);
  });
  afterAll(async () => {
    await withAuditPurge(db, (tx) =>
      tx.execute(sql`truncate ${schema.organisations}, ${schema.users} cascade`),
    );
    await close();
    rmSync(storageRoot, { recursive: true, force: true });
  });

  it("reports health without signing in", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", database: "ok" });
  });

  it("tells Prometheus how it is doing, only with the token (#70)", async () => {
    const token = "metrics-token-metrics-token-metrics-0";
    const scraped = createApp({
      db,
      auth,
      mailer,
      storage,
      audit,
      jobs,
      keyring,
      playbackSecret: playbackSecret("test-secret-test-secret-test-secret-0"),
      publicUrl: "http://localhost:3000",
      log: false,
      metricsToken: token,
    });
    collectFromDatabase(db);
    collectQueues(db, ["media-probe", "media-proxy"]);
    const scrape = (headers: Record<string, string> = {}) =>
      scraped.request("/metrics", { headers });

    // Without a token configured there is nothing there; with one, only its bearer reads it.
    expect((await app.request("/metrics")).status).toBe(404);
    const anonymous = await scrape();
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toContain("Bearer");
    expect((await scrape({ authorization: "Bearer not-the-token" })).status).toBe(401);
    expect((await scrape({ authorization: token })).status).toBe(401);

    // Requests are counted by the route that answered them, never by their path.
    await scraped.request("/api/health");
    await scraped.request("/api/files/0190a6f0-0000-7000-8000-0000000000ff");
    await scraped.request("/api/no-such-thing");
    const res = await scrape({ authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain; version=0.0.4");
    const text = await res.text();
    expect(text).toMatch(/^hekate_build_info\{version="[^"]+"\} 1$/m);
    expect(text).toMatch(
      /^hekate_http_requests_total\{route="\/api\/health",method="GET",status="200"\} \d+$/m,
    );
    expect(text).toMatch(
      /^hekate_http_requests_total\{route="\/api\/files\/:id",method="GET",status="401"\} \d+$/m,
    );
    expect(text).toMatch(
      /^hekate_http_requests_total\{route="unmatched",method="GET",status="404"\} \d+$/m,
    );
    expect(text).toContain(
      'hekate_http_request_duration_seconds_bucket{route="/api/health",le="+Inf"}',
    );
    expect(text).not.toContain("0190a6f0-0000-7000-8000-0000000000ff");
    expect(text).toMatch(/^hekate_database_up 1$/m);
    // An idle queue reads zero, not nothing.
    expect(text).toMatch(/^hekate_jobs_waiting\{queue="media-proxy"\} 0$/m);
    expect(text).toMatch(/^hekate_jobs_active\{queue="media-probe"\} 0$/m);
    // The scrape itself is not an API request.
    expect(text).not.toContain('route="/metrics"');
  });

  it("runs first-run setup once and signs the owner in", async () => {
    expect(await (await app.request("/api/setup")).json()).toEqual({ needed: true });
    const res = await setup();
    expect(res.status).toBe(201);
    const me = await app.request("/api/me", { headers: { cookie: cookieOf(res) } });
    expect(me.status).toBe(200);
    const body = (await me.json()) as {
      user: { email: string };
      organisations: { role: string }[];
    };
    expect(body.user.email).toBe(owner.email);
    expect(body.organisations).toEqual([
      expect.objectContaining({ name: "Studio", role: "owner" }),
    ]);

    expect(await (await app.request("/api/setup")).json()).toEqual({ needed: false });
    const again = await app.request(
      "/api/setup",
      json({ ...owner, email: "second@example.test", organisation: "Other" }),
    );
    expect(again.status).toBe(409);
  });

  it("asks for the setup code from the log before the first owner is made", async () => {
    const gate = createSetupGate({ code: "7KQ2-M9XD-4HPW" });
    const gated = createApp({
      db,
      auth,
      mailer,
      storage,
      audit,
      jobs,
      keyring,
      playbackSecret: playbackSecret("test-secret-test-secret-test-secret-0"),
      publicUrl: "http://localhost:3000",
      log: false,
      setupGate: gate,
    });
    const body = { ...owner, organisation: "Studio" };
    const withCode = (code: string) => {
      const request = json(body);
      return { ...request, headers: { ...request.headers, [SETUP_CODE_HEADER]: code } };
    };
    expect((await gated.request("/api/setup", json(body))).status).toBe(403);
    expect((await gated.request("/api/setup", withCode("AAAA-AAAA-AAAA"))).status).toBe(403);
    const right = withCode("7kq2m9xd4hpw");
    expect((await gated.request("/api/setup", right)).status).toBe(201);
    // Once it is set up, the installer has nothing left to do.
    expect(await (await gated.request("/api/install")).json()).toEqual({ installing: false });
    expect((await gated.request("/api/install/finish", { method: "POST" })).status).toBe(409);
  });

  it("adopts an organisation left by an install that predates authentication", async () => {
    const [legacy] = await db
      .insert(schema.organisations)
      .values({ name: "Studio", slug: "studio" })
      .returning();
    const res = await setup();
    expect(((await res.json()) as { organisation: { id: string } }).organisation.id).toBe(
      legacy?.id,
    );
  });

  it("keeps a member's profile, and lets them sign out their other sessions", async () => {
    const first = cookieOf(await setup());
    const me = async (cookie: string) => app.request("/api/me", { headers: { cookie } });
    const patch = (cookie: string, body: unknown) =>
      app.request("/api/me", { ...json(body, cookie), method: "PATCH" });
    expect(
      (await patch(first, { name: " Alex Rivera ", locale: "en-GB", timeZone: "Europe/London" }))
        .status,
    ).toBe(200);
    expect(((await (await me(first)).json()) as { user: unknown }).user).toMatchObject({
      name: "Alex Rivera",
      locale: "en-GB",
      timeZone: "Europe/London",
    });
    expect((await patch(first, { timeZone: "Mars/Olympus" })).status).toBe(400);
    expect((await patch(first, { locale: "xx-XX" })).status).toBe(400);
    expect((await patch(first, { email: "elsewhere@example.test" })).status).toBe(400);

    // Preferences: the defaults, then a change to some that keeps the rest.
    const prefs = async () =>
      ((await (await me(first)).json()) as { user: { preferences: Record<string, unknown> } }).user
        .preferences;
    expect(await prefs()).toMatchObject({ skipSeconds: 5, preRoll: 1, showSpectrogram: true });
    const setPrefs = (body: unknown) =>
      app.request("/api/me/preferences", { ...json(body, first), method: "PATCH" });
    expect((await setPrefs({ skipSeconds: 10 })).status).toBe(200);
    expect((await setPrefs({ showSpectrogram: false })).status).toBe(200);
    expect(await prefs()).toMatchObject({ skipSeconds: 10, showSpectrogram: false, preRoll: 1 });
    expect((await setPrefs({ skipSeconds: 3 })).status).toBe(400);
    // The player's view and its presets go with the account (#135), within their ranges.
    expect(await prefs()).toMatchObject({ playerView: null, viewPresets: [] });
    const view = { ...defaultPlayerViewSettings, spectrogram: "behind" };
    expect((await setPrefs({ playerView: view })).status).toBe(200);
    expect((await setPrefs({ viewPresets: [{ name: "Noise hunt", view }] })).status).toBe(200);
    expect(await prefs()).toMatchObject({
      playerView: view,
      viewPresets: [{ name: "Noise hunt", view }],
      skipSeconds: 10,
    });
    const faint = { ...view, wave: { ...view.wave, opacity: 0 } };
    expect((await setPrefs({ playerView: faint })).status).toBe(400);
    const twice = [
      { name: "Edit", view },
      { name: "edit", view },
    ];
    expect((await setPrefs({ viewPresets: twice })).status).toBe(400);

    // A second device, then signing it out from the first.
    const second = cookieOf(
      await app.request(
        "/api/auth/sign-in/email",
        json({ email: owner.email, password: owner.password }),
      ),
    );
    type Listed = { sessions: { id: string; current: boolean; userAgent: string | null }[] };
    const listed = (await (
      await app.request("/api/me/sessions", { headers: { cookie: first } })
    ).json()) as Listed;
    expect(listed.sessions).toHaveLength(2);
    const mine = listed.sessions.find((x) => x.current);
    const other = listed.sessions.find((x) => !x.current);
    expect(JSON.stringify(listed)).not.toContain("token");
    const remove = (cookie: string, id: string) =>
      app.request(`/api/me/sessions/${id}`, { method: "DELETE", headers: { cookie } });
    expect((await remove(first, mine?.id ?? "")).status).toBe(409);
    expect((await remove(first, "not-a-session")).status).toBe(404);
    expect((await remove(first, other?.id ?? "")).status).toBe(204);
    expect((await me(second)).status).toBe(401);
    expect((await me(first)).status).toBe(200);

    // Every other session at once.
    const third = cookieOf(
      await app.request(
        "/api/auth/sign-in/email",
        json({ email: owner.email, password: owner.password }),
      ),
    );
    const all = await app.request("/api/me/sessions", {
      method: "DELETE",
      headers: { cookie: first },
    });
    expect(await all.json()).toEqual({ signedOut: 1 });
    expect((await me(third)).status).toBe(401);
  });

  it("changes the address only once the new one is confirmed, and the password", async () => {
    const cookie = cookieOf(await setup());
    mailer.sent.length = 0;
    const asked = await app.request(
      "/api/auth/change-email",
      json({ newEmail: "alex@example.test", callbackURL: "/account" }, cookie),
    );
    expect(asked.status).toBe(200);
    const email = (
      (await (await app.request("/api/me", { headers: { cookie } })).json()) as {
        user: { email: string };
      }
    ).user.email;
    expect(email).toBe(owner.email);
    const message = mailer.sent.find((m) => m.to === "alex@example.test");
    const link = message?.text.match(/https?:\/\/\S+verify-email\S+/)?.[0] ?? "";
    expect(link).toContain("/api/auth/verify-email?token=");
    await app.request(link.replace("http://localhost:3000", ""), { headers: { cookie } });
    const changed = (
      (await (await app.request("/api/me", { headers: { cookie } })).json()) as {
        user: { email: string };
      }
    ).user.email;
    expect(changed).toBe("alex@example.test");

    const changedPassword = await app.request(
      "/api/auth/change-password",
      json({ currentPassword: owner.password, newPassword: "a brand new long password" }, cookie),
    );
    expect(changedPassword.status).toBe(200);
    const signIn = await app.request(
      "/api/auth/sign-in/email",
      json({ email: "alex@example.test", password: "a brand new long password" }),
    );
    expect(signIn.status).toBe(200);
  });

  it("closes public sign-up", async () => {
    const res = await app.request(
      "/api/auth/sign-up/email",
      json({ name: "x", email: "x@example.test", password: "a long enough password" }),
    );
    expect(res.status).toBe(403);
  });

  it("signs in with email and password and rejects a wrong password", async () => {
    await setup();
    const ok = await app.request(
      "/api/auth/sign-in/email",
      json({ email: owner.email, password: owner.password }),
    );
    expect(ok.status).toBe(200);
    expect(cookieOf(ok)).toContain("hekate.session_token=");
    const bad = await app.request(
      "/api/auth/sign-in/email",
      json({ email: owner.email, password: "wrong password here" }),
    );
    expect(bad.status).toBe(401);
  });

  it("slows repeated guesses at a password, then locks the account for a while", async () => {
    await setup();
    const signIn = (password: string) =>
      app.request("/api/auth/sign-in/email", json({ email: owner.email, password }));
    // The first few wrong passwords cost nothing.
    for (let i = 0; i < 4; i++) expect((await signIn("wrong password here")).status).toBe(401);
    // Then the next try must wait, even with the right password.
    const waiting = await signIn(owner.password);
    expect(waiting.status).toBe(429);
    expect(waiting.headers.get("retry-after")).toBe("1");
    expect(((await waiting.json()) as { message: string }).message).toMatch(/Wait 1 second/);

    // Ten failures in a quarter of an hour lock it, and the workspace hears of it.
    const key = (await import("./sign-in.ts")).attemptKey(owner.email);
    await db
      .update(schema.signInAttempts)
      .set({ failures: 9, lastFailureAt: new Date(Date.now() - 120_000) })
      .where(eq(schema.signInAttempts.key, key));
    expect((await signIn("wrong password again")).status).toBe(401);
    const locked = await signIn(owner.password);
    expect(locked.status).toBe(429);
    expect(((await locked.json()) as { message: string }).message).toMatch(/locked for 15 minutes/);
    const events = await db
      .select({ action: schema.accessEvents.action })
      .from(schema.accessEvents)
      .where(eq(schema.accessEvents.action, "account.lockout"));
    expect(events).toHaveLength(1);

    // Once the lock runs out, the right password works and the count starts again.
    await db
      .update(schema.signInAttempts)
      .set({ lockedUntil: new Date(Date.now() - 1000) })
      .where(eq(schema.signInAttempts.key, key));
    expect((await signIn(owner.password)).status).toBe(200);
    expect(
      await db.select().from(schema.signInAttempts).where(eq(schema.signInAttempts.key, key)),
    ).toEqual([]);
    // Another address is never slowed by this one's failures.
    expect(
      (
        await app.request(
          "/api/auth/sign-in/email",
          json({ email: "nobody@example.test", password: "wrong password here" }),
        )
      ).status,
    ).toBe(401);
  });

  it("lets a burst of guesses through only as the policy would one at a time", async () => {
    await setup();
    const tries = await Promise.all(
      Array.from({ length: 8 }, () =>
        app.request(
          "/api/auth/sign-in/email",
          json({ email: owner.email, password: "wrong password here" }),
        ),
      ),
    );
    const statuses = tries.map((r) => r.status).sort();
    // The four free tries are heard; the rest, sent at the same moment, wait.
    expect(statuses).toEqual([401, 401, 401, 401, 429, 429, 429, 429]);
  });

  it("forgets attempts a day old that hold no lock", async () => {
    const { purgeAttempts } = await import("./sign-in.ts");
    const now = new Date();
    const old = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    await db.delete(schema.signInAttempts);
    await db.insert(schema.signInAttempts).values([
      { key: "stale", failures: 1, updatedAt: old },
      { key: "recent", failures: 1, updatedAt: now },
      {
        key: "locked",
        failures: 10,
        updatedAt: old,
        lockedUntil: new Date(now.getTime() + 60_000),
      },
    ]);
    await purgeAttempts(db, now);
    const left = await db.select({ key: schema.signInAttempts.key }).from(schema.signInAttempts);
    expect(left.map((r) => r.key).sort()).toEqual(["locked", "recent"]);
  });

  it("sets a new password with an emailed code, ending every session", async () => {
    const cookie = cookieOf(await setup());
    mailer.sent.length = 0;
    const ask = await app.request(
      "/api/auth/email-otp/request-password-reset",
      json({ email: owner.email }),
    );
    expect(ask.status).toBe(200);
    const mail = mailer.sent.find((m) => m.to === owner.email);
    const code = mail?.subject.match(/^(\d{6}) /)?.[1] ?? "";
    expect(code).toMatch(/^\d{6}$/);
    // The link carries the address and the code to the reset page.
    expect(mail?.text).toContain(
      `/sign-in?view=reset&email=${encodeURIComponent(owner.email)}&code=${code}`,
    );
    // An unknown address is answered the same, and sent nothing.
    mailer.sent.length = 0;
    expect(
      (
        await app.request(
          "/api/auth/email-otp/request-password-reset",
          json({ email: "nobody@example.test" }),
        )
      ).status,
    ).toBe(200);
    expect(mailer.sent).toEqual([]);

    const reset = (otp: string, password: string) =>
      app.request(
        "/api/auth/email-otp/reset-password",
        json({ email: owner.email, otp, password }),
      );
    // Twelve characters at least.
    expect((await reset(code, "too short")).status).toBe(400);
    expect((await reset(code, "a fresh and long password")).status).toBe(200);
    // The code worked once; every session ended; the new password signs in.
    expect((await reset(code, "another long password here")).status).toBe(400);
    expect((await app.request("/api/me", { headers: { cookie } })).status).toBe(401);
    expect(
      (
        await app.request(
          "/api/auth/sign-in/email",
          json({ email: owner.email, password: "a fresh and long password" }),
        )
      ).status,
    ).toBe(200);
    const events = await db
      .select({ action: schema.accessEvents.action })
      .from(schema.accessEvents)
      .where(eq(schema.accessEvents.action, "account.password_reset"));
    expect(events).toHaveLength(1);
  });

  it("never signs a member in by an emailed code", async () => {
    await setup();
    const asked = await app.request(
      "/api/auth/email-otp/send-verification-otp",
      json({ email: owner.email, type: "sign-in" }),
    );
    expect(asked.status).toBe(403);
    const tried = await app.request(
      "/api/auth/sign-in/email-otp",
      json({ email: owner.email, otp: "123456" }),
    );
    expect(tried.status).toBe(403);
  });

  it("requires a session for tenant routes", async () => {
    const res = await app.request("/api/projects");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "unauthenticated", message: "Sign in to continue" },
    });
  });

  it("scopes projects to the member's organisation", async () => {
    const cookie = cookieOf(await setup());
    const created = await app.request(
      "/api/projects",
      json({ name: "Joplin Rags", profile: "music" }, cookie),
    );
    expect(created.status).toBe(201);
    const { project } = (await created.json()) as { project: { id: string } };

    // A second organisation's project is invisible to this member.
    const [other] = await db
      .insert(schema.organisations)
      .values({ name: "Elsewhere", slug: "elsewhere" })
      .returning();
    const [foreign] = await db
      .insert(schema.projects)
      .values({ organisationId: other?.id ?? "", name: "Not yours", profile: "video" })
      .returning();
    expect(
      (await app.request(`/api/projects/${foreign?.id}`, { headers: { cookie } })).status,
    ).toBe(404);
    expect((await app.request(`/api/projects/${project.id}`, { headers: { cookie } })).status).toBe(
      200,
    );

    // Switching to an organisation the user does not belong to is refused.
    const sw = await app.request("/api/me/organisation", {
      ...json({ organisationId: other?.id }, cookie),
      method: "PUT",
    });
    expect(sw.status).toBe(403);
  });

  it("rejects invalid project input with a 400", async () => {
    const cookie = cookieOf(await setup());
    const res = await app.request("/api/projects", json({ name: "", profile: "podcast" }, cookie));
    expect(res.status).toBe(400);
  });

  it("works through the typed client", async () => {
    const cookie = cookieOf(await setup());
    const client = createClient("http://test/api", {
      fetch: (input: string | URL | Request, init?: RequestInit) => app.request(input, init),
      headers: { cookie },
    });
    await client.projects.$post({ json: { name: "Crossing", profile: "video" } });
    const res = await client.projects.$get({ query: {} });
    const body = await res.json();
    expect("projects" in body && body.projects[0]?.name).toBe("Crossing");
  });

  describe("members and invitations", () => {
    const tokenFrom = (link: string) => link.split("/invite/")[1] ?? "";
    const invite = async (cookie: string, email: string, role = "member") => {
      const res = await app.request("/api/organisation/invitations", json({ email, role }, cookie));
      return { res, body: (await res.json()) as { link: string; invitation: { id: string } } };
    };

    describe("the instance side", () => {
      const asOperator = createApp({
        db,
        auth,
        mailer,
        storage,
        audit,
        jobs,
        keyring,
        playbackSecret: playbackSecret("test-secret-test-secret-test-secret-0"),
        publicUrl: "http://localhost:3000",
        log: false,
        operatorSecurityKey: false,
      });
      const join = async (owner: string, email: string, role = "member") => {
        const { body } = await invite(owner, email, role);
        const res = await app.request(
          `/api/invitations/${tokenFrom(body.link)}/accept`,
          json({ name: email.split("@")[0], password: "correct horse battery" }),
        );
        expect(res.status).toBe(201);
        return cookieOf(res);
      };
      const get = (path: string, cookie: string, via = asOperator) =>
        via.request(path, { headers: { cookie } });
      const send = (method: string, path: string, body: unknown, cookie: string) =>
        asOperator.request(path, { ...json(body, cookie), method });

      it("makes setup's owner the first operator, who needs a security key to act", async () => {
        const first = cookieOf(await setup());
        // Signed in with a password, the operator is known but may not act yet.
        const me = await (await get("/api/instance/me", first, app)).json();
        expect(me).toMatchObject({ operator: true, keyNeeded: true });
        const refused = await get("/api/instance/overview", first, app);
        expect(refused.status).toBe(403);
        expect(await refused.json()).toMatchObject({ error: { code: "security_key_required" } });
        // Where keys are not required (testing), the same session acts.
        const overview = await get("/api/instance/overview", first);
        expect(overview.status).toBe(200);
        expect(await overview.json()).toMatchObject({
          workspaces: 1,
          people: 1,
          recent: [{ action: "operator.added", target: owner.email, actor: null }],
        });
      });

      it("refuses members, and shows an owner only their own workspace", async () => {
        const operator = cookieOf(await setup());
        const member = await join(operator, "member@example.test");
        const refused = await get("/api/instance/me", member);
        expect(refused.status).toBe(403);
        expect(await refused.json()).toMatchObject({ error: { code: "not_instance" } });

        // Someone who owns a workspace of their own, but does not operate the instance.
        const owner = await join(operator, "label@example.test", "admin");
        const [user] = await db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.email, "label@example.test"));
        const [label] = await db
          .insert(schema.organisations)
          .values({ name: "Saltmarsh Films", slug: "saltmarsh" })
          .returning();
        await db
          .insert(schema.members)
          .values({ organisationId: label?.id ?? "", userId: user?.id ?? "", role: "owner" });
        expect(await (await get("/api/instance/me", owner)).json()).toMatchObject({
          operator: false,
          owned: [{ name: "Saltmarsh Films" }],
        });
        const theirs = (await (await get("/api/instance/workspaces", owner)).json()) as {
          workspaces: { name: string }[];
        };
        expect(theirs.workspaces.map((w) => w.name)).toEqual(["Saltmarsh Films"]);
        expect((await get("/api/instance/overview", owner)).status).toBe(403);
        expect((await get("/api/instance/operators", owner)).status).toBe(403);
        expect(
          (await send("POST", "/api/instance/operators", { email: "label@example.test" }, owner))
            .status,
        ).toBe(403);

        // The operator sees every workspace.
        const all = (await (await get("/api/instance/workspaces", operator)).json()) as {
          workspaces: { name: string; members: number }[];
        };
        expect(all.workspaces.map((w) => w.name)).toEqual(["Saltmarsh Films", "Studio"]);
      });

      it("adds and removes operators, but never the last", async () => {
        const first = cookieOf(await setup());
        await join(first, "ops@example.test");
        const unknown = await send(
          "POST",
          "/api/instance/operators",
          { email: "nobody@example.test" },
          first,
        );
        expect(unknown.status).toBe(422);
        const added = await send(
          "POST",
          "/api/instance/operators",
          { email: "OPS@example.test" },
          first,
        );
        expect(added.status).toBe(201);
        const { added: opsId } = (await added.json()) as { added: string };
        expect(
          (await send("POST", "/api/instance/operators", { email: "ops@example.test" }, first))
            .status,
        ).toBe(409);

        const { operators } = (await (await get("/api/instance/operators", first)).json()) as {
          operators: { userId: string; email: string; addedBy: string | null }[];
        };
        expect(operators.map((o) => o.email)).toEqual([owner.email, "ops@example.test"]);
        expect(operators[1]?.addedBy).toBe(owner.name);

        const ended = await send(
          "POST",
          `/api/instance/operators/${opsId}/sessions/revoke`,
          {},
          first,
        );
        expect(await ended.json()).toEqual({ ended: 1 });

        expect((await send("DELETE", `/api/instance/operators/${opsId}`, {}, first)).status).toBe(
          204,
        );
        const [me] = operators;
        const last = await send("DELETE", `/api/instance/operators/${me?.userId}`, {}, first);
        expect(last.status).toBe(409);
        expect(await last.json()).toMatchObject({ error: { code: "last_operator" } });
      });

      it("keeps an operator when one deletes their account, and forgets their address", async () => {
        const first = cookieOf(await setup());
        const ops = await join(first, "ops@example.test");
        expect(
          (await send("POST", "/api/instance/operators", { email: "ops@example.test" }, first))
            .status,
        ).toBe(201);
        const [me] = await db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.email, owner.email));
        expect((await send("DELETE", `/api/instance/operators/${me?.id}`, {}, first)).status).toBe(
          204,
        );
        expect(
          (await send("DELETE", `/api/instance/operators/${"x".repeat(65)}`, {}, ops)).status,
        ).toBe(400);
        const leave = () =>
          app.request("/api/me", {
            ...json({ email: "ops@example.test", password: "correct horse battery" }, ops),
            method: "DELETE",
          });
        // The only operator cannot leave by deleting their account.
        const refused = await leave();
        expect(refused.status).toBe(409);
        expect(await refused.json()).toMatchObject({ error: { code: "last_operator" } });
        expect(
          (await send("POST", "/api/instance/operators", { email: owner.email }, ops)).status,
        ).toBe(201);
        expect((await leave()).status).toBe(204);
        const operators = await db.select().from(schema.instanceOperators);
        expect(operators.map((o) => o.userId)).toEqual([me?.id]);
        const named = await db
          .select({ target: schema.instanceEvents.target })
          .from(schema.instanceEvents)
          .where(eq(schema.instanceEvents.target, "ops@example.test"));
        expect(named).toEqual([]);
      });

      it("gives every failure a reference that an operator looks up (#159)", async () => {
        const operator = cookieOf(await setup());
        const [user] = await db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.email, owner.email));
        const [studio] = await db
          .select({ id: schema.organisations.id })
          .from(schema.organisations)
          .where(eq(schema.organisations.slug, "studio"));
        // A request that fails after the session is known, as a route's own bug would.
        const failing = new Hono<{ Variables: { userId: string; organisationId: string } }>()
          .use("*", requestId)
          .use("*", async (c, next) => {
            c.set("userId", user?.id ?? "");
            c.set("organisationId", studio?.id ?? "");
            await next();
          })
          .get("/api/files/:id", () => {
            throw new Error("xref entry 41 points outside the file");
          })
          .onError(errorHandler(db));
        const failedFile = "0199f000-0000-7000-8000-0000000000f1";
        const failed = await failing.request(`/api/files/${failedFile}`);
        expect(failed.status).toBe(500);
        const body = (await failed.json()) as {
          error: { code: string; message: string; reference: string };
        };
        expect(body.error).toMatchObject({ code: "internal", message: "Something went wrong" });
        expect(body.error.reference).toMatch(/^HK-[0-9A-F]{4}-[0-9A-F]{2}$/);

        // A job that fails on its last attempt is recorded too; earlier attempts are not.
        const boom = async () => {
          throw new Error("damaged cross-reference table");
        };
        const reported: string[] = [];
        const onFailure = async (failure: JobFailure) => {
          const reference = await recordFailure(db, failureOfJob(failure));
          if (reference) reported.push(reference);
        };
        const job = {
          id: "j-8f1c",
          data: {
            organisationId: studio?.id ?? "",
            fileId: "0199f000-0000-7000-8000-000000000001",
          },
          signal: new AbortController().signal,
        };
        await expect(
          runJob("document-render", { ...job, retryCount: 0 }, boom, onFailure),
        ).rejects.toThrow("damaged");
        expect(reported).toEqual([]);
        await expect(
          runJob("document-render", { ...job, retryCount: 3 }, boom, onFailure),
        ).rejects.toThrow("damaged");
        expect(reported).toHaveLength(1);

        // The lookup resolves it, however the reference was pasted.
        const pasted = ` ${body.error.reference.toLowerCase()} `;
        const found = await get(`/api/instance/errors/${encodeURIComponent(pasted)}`, operator);
        expect(found.status).toBe(200);
        const report = (await found.json()) as Record<string, unknown>;
        expect(report).toMatchObject({
          reference: body.error.reference,
          source: "api",
          location: "GET /api/files/:id",
          message: "xref entry 41 points outside the file",
          status: 500,
          requestId: failed.headers.get("x-request-id"),
          workspace: "Studio",
          workspaceId: studio?.id,
          who: { name: owner.name, email: owner.email },
          // What the request was about, so the file's inspector finds it.
          context: { fileId: failedFile },
        });
        expect(report.stack).toContain("Error: xref entry 41");
        // Nothing personal beyond the name and the address.
        expect(Object.keys(report.who as object).sort()).toEqual(["email", "name"]);
        const worker = (await (
          await get(`/api/instance/errors/${reported[0]}`, operator)
        ).json()) as Record<string, unknown>;
        expect(worker).toMatchObject({
          source: "worker",
          location: "document-render",
          jobId: "j-8f1c",
          workspace: "Studio",
          who: null,
          context: job.data,
        });

        // Both are among today's, newest first.
        const today = (await (await get("/api/instance/errors", operator)).json()) as {
          errors: { reference: string }[];
        };
        expect(today.errors.map((e) => e.reference)).toEqual([reported[0], body.error.reference]);
        const later = new Date(Date.now() + 60_000).toISOString();
        const none = (await (
          await get(`/api/instance/errors?since=${encodeURIComponent(later)}`, operator)
        ).json()) as { errors: unknown[] };
        expect(none.errors).toEqual([]);
        expect((await get("/api/instance/errors?since=yesterday", operator)).status).toBe(400);

        // An unknown reference, and something that is not one.
        expect((await get("/api/instance/errors/HK-0000-00", operator)).status).toBe(404);
        expect((await get("/api/instance/errors/req_01HX", operator)).status).toBe(400);

        // Only operators: a workspace owner who is not one, and a member, are refused.
        const member = await join(operator, "member@example.test");
        expect((await get("/api/instance/errors", member)).status).toBe(403);
        const theirOwner = await join(operator, "label@example.test", "owner");
        expect((await get("/api/instance/errors", theirOwner)).status).toBe(403);
        expect((await get(`/api/instance/errors/${body.error.reference}`, theirOwner)).status).toBe(
          403,
        );

        // Kept for thirty days, then forgotten.
        expect(await purgeErrorReports(db, new Date(Date.now() + 29 * 86_400_000))).toBe(0);
        expect(await purgeErrorReports(db, new Date(Date.now() + 31 * 86_400_000))).toBe(2);
      });

      it("inspects a file, a review and a session, and records each look (#159)", async () => {
        const operator = cookieOf(await setup());
        const [user] = await db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.email, owner.email));
        const userId = user?.id ?? "";
        const [studio] = await db
          .select({ id: schema.organisations.id })
          .from(schema.organisations)
          .where(eq(schema.organisations.slug, "studio"));
        const org = studio?.id ?? "";
        const [project] = await db
          .insert(schema.projects)
          .values({ organisationId: org, name: "Joplin Rags", profile: "music" })
          .returning();
        const blob = await storage.put(org, Buffer.from("the score"));
        const [file] = await db
          .insert(schema.files)
          .values({
            organisationId: org,
            projectId: project?.id ?? "",
            name: "Solace - Score.pdf",
            kind: "document",
            blobId: blob.id,
            contentType: "application/pdf",
            byteSize: blob.byteSize,
            uploadedBy: userId,
            streamStatus: "failed",
            pageCount: 7,
          })
          .returning();
        const fileId = file?.id ?? "";
        const [review] = await db
          .insert(schema.reviews)
          .values({
            organisationId: org,
            projectId: project?.id ?? "",
            kind: "approval",
            title: "Score proofs",
            createdBy: userId,
          })
          .returning();
        const reviewId = review?.id ?? "";
        const [item] = await db
          .insert(schema.reviewItems)
          .values({ organisationId: org, reviewId, fileId })
          .returning();
        const [guest] = await db
          .insert(schema.guests)
          .values({ organisationId: org, name: "Ines Arlow", email: "ines@example.test" })
          .returning();
        const [asked] = await db
          .insert(schema.reviewReviewers)
          .values([
            { organisationId: org, reviewId, userId, position: 0 },
            { organisationId: org, reviewId, guestId: guest?.id ?? "", position: 0 },
          ])
          .returning();
        await db.insert(schema.reviewItemOpens).values({
          organisationId: org,
          reviewerId: asked?.id ?? "",
          itemId: item?.id ?? "",
        });
        const [guestSession] = await db
          .insert(schema.guestSessions)
          .values({
            organisationId: org,
            guestId: guest?.id ?? "",
            tokenHash: "not-a-real-hash",
            expiresAt: new Date(Date.now() + 86_400_000),
            lastSeenAt: new Date(),
          })
          .returning();
        const member = await audit.member(userId);
        await audit.record(org, member, { action: "page.render", fileId, reviewId });
        await audit.record(org, member, { action: "page.render", fileId, reviewId });
        await recordFailure(db, {
          source: "worker",
          location: "document-render",
          error: new Error("damaged cross-reference table"),
          organisationId: org,
          context: { organisationId: org, fileId },
        });

        const inspect = async (kind: string, id: string) => {
          const res = await get(
            `/api/instance/inspect/${kind}/${encodeURIComponent(id)}`,
            operator,
          );
          expect(res.status).toBe(200);
          return (await res.json()) as Record<string, unknown>;
        };
        expect(await inspect("file", fileId)).toMatchObject({
          name: "Solace - Score.pdf",
          workspace: { id: org, name: "Studio" },
          project: { name: "Joplin Rags" },
          uploadedBy: owner.name,
          streamStatus: "failed",
          pageCount: 7,
          pagesDrawn: 0,
          blob: { id: blob.id, backend: blob.backend, keyVersion: 1 },
          renditions: [],
          errors: [{ location: "document-render", message: "damaged cross-reference table" }],
          access: [{ action: "page.render", count: 2 }],
        });
        expect(await inspect("review", reviewId)).toMatchObject({
          title: "Score proofs",
          items: [{ name: "Solace - Score.pdf" }],
          reviewers: [
            { name: owner.name, guest: false, opened: 1, sessions: null },
            { name: "Ines Arlow", guest: true, opened: 0, sessions: { count: 1 } },
          ],
          access: [{ action: "page.render", count: 2 }],
        });
        const [signIn] = await db
          .select({ id: schema.authSessions.id })
          .from(schema.authSessions)
          .where(eq(schema.authSessions.userId, userId));
        expect(await inspect("session", signIn?.id ?? "")).toMatchObject({
          kind: "member",
          who: { name: owner.name, email: owner.email },
          workspace: { id: org, name: "Studio" },
          ended: false,
          access: [{ action: "page.render", count: 2 }],
        });
        expect(await inspect("session", guestSession?.id ?? "")).toMatchObject({
          kind: "guest",
          who: { name: "Ines Arlow", email: "ines@example.test" },
          workspace: { name: "Studio" },
          ended: false,
        });

        // Each look is the operator's, on the record.
        const looks = await db
          .select({ target: schema.instanceEvents.target, details: schema.instanceEvents.details })
          .from(schema.instanceEvents)
          .where(eq(schema.instanceEvents.action, "debug.inspected"));
        expect(looks).toHaveLength(4);
        expect(looks[0]).toEqual({
          target: "Studio",
          details: { kind: "file", id: fileId, organisationId: org },
        });

        // Unknown, malformed, and not an operator's.
        const missing = "0199f000-0000-7000-8000-000000000001";
        for (const kind of ["file", "review", "session"])
          expect((await get(`/api/instance/inspect/${kind}/${missing}`, operator)).status).toBe(
            404,
          );
        expect((await get("/api/instance/inspect/file/not-an-id", operator)).status).toBe(400);
        expect((await get("/api/instance/inspect/session/a%2Fb", operator)).status).toBe(400);
        const theirOwner = await join(operator, "label@example.test", "owner");
        const memberCookie = await join(operator, "member@example.test");
        for (const cookie of [theirOwner, memberCookie])
          expect((await get(`/api/instance/inspect/file/${fileId}`, cookie)).status).toBe(403);
      });

      it("runs a failed job again from its report (#159)", async () => {
        const operator = cookieOf(await setup());
        const [studio] = await db
          .select({ id: schema.organisations.id })
          .from(schema.organisations)
          .where(eq(schema.organisations.slug, "studio"));
        const org = studio?.id ?? "";
        const [project] = await db
          .insert(schema.projects)
          .values({ organisationId: org, name: "Joplin Rags", profile: "music" })
          .returning();
        const blob = await storage.put(org, Buffer.from("not really a pdf"));
        const [file] = await db
          .insert(schema.files)
          .values({
            organisationId: org,
            projectId: project?.id ?? "",
            name: "Solace - Score.pdf",
            kind: "document",
            blobId: blob.id,
            contentType: "application/pdf",
            byteSize: blob.byteSize,
            streamStatus: "failed",
          })
          .returning();
        const report = (location: string, context: Record<string, unknown> | undefined) =>
          recordFailure(db, {
            source: "worker",
            location,
            error: new Error("damaged cross-reference table"),
            organisationId: org,
            ...(context ? { context } : {}),
          });
        const retry = (reference: string | null, cookie = operator) =>
          asOperator.request(`/api/instance/errors/${reference}/retry`, json({}, cookie));

        // A file's preparation runs again by its plan, and waits meanwhile.
        sent.length = 0;
        const rendered = await report("document-render", { organisationId: org, fileId: file?.id });
        const again = await retry(rendered);
        expect(again.status).toBe(202);
        expect(await again.json()).toEqual({ jobs: ["document-render"] });
        expect(sent).toEqual([
          { name: "document-render", data: { organisationId: org, fileId: file?.id } },
        ]);
        const [waiting] = await db
          .select({ status: schema.files.streamStatus })
          .from(schema.files)
          .where(eq(schema.files.id, file?.id ?? ""));
        expect(waiting?.status).toBe("pending");
        // Nothing failed now: nothing to run.
        expect((await retry(rendered)).status).toBe(409);

        // Any other job runs with the data it had; one whose data no longer fits does not.
        sent.length = 0;
        expect((await retry(await report("workspaces-purge", undefined))).status).toBe(202);
        expect(sent).toEqual([{ name: "workspaces-purge", data: {} }]);
        expect(
          (await retry(await report("organisation-rewrap", { organisationId: 7 }))).status,
        ).toBe(409);
        const [event] = await db
          .select({ target: schema.instanceEvents.target, details: schema.instanceEvents.details })
          .from(schema.instanceEvents)
          .where(eq(schema.instanceEvents.action, "debug.job_retried"));
        expect(event).toEqual({
          target: rendered,
          details: { jobs: ["document-render"], organisationId: org },
        });

        // A request's failure is no job, and only operators may run one.
        const asked = await recordFailure(db, {
          source: "api",
          location: "GET /api/files/:id",
          error: new Error("boom"),
        });
        expect((await retry(asked)).status).toBe(409);
        const theirOwner = await join(operator, "label@example.test", "owner");
        expect((await retry(rendered, theirOwner)).status).toBe(403);
      });

      it("turns a flag on for its time, read again as the server runs (#159)", async () => {
        const operator = cookieOf(await setup());
        type Listed = { flags: { key: string; on: boolean; until: string | null }[] };
        const listed = async () =>
          ((await (await get("/api/instance/flags", operator)).json()) as Listed).flags;
        expect(await listed()).toEqual([
          expect.objectContaining({ key: "worker.verbose", on: false, until: null }),
        ]);
        const turn = (on: boolean, cookie = operator, key = "worker.verbose") =>
          asOperator.request(`/api/instance/flags/${key}`, {
            ...json({ on }, cookie),
            method: "PUT",
          });
        expect((await turn(true)).status).toBe(200);
        const [verbose] = await listed();
        expect(verbose?.on).toBe(true);
        const minutes = (Date.parse(verbose?.until ?? "") - Date.now()) / 60_000;
        expect(Math.round(minutes)).toBe(60);
        // Another process reads it within moments; after its hour it is off by itself.
        expect(await createFlags(db).isOn("worker.verbose")).toBe(true);
        const later = new Date(Date.now() + 61 * 60_000);
        expect(await createFlags(db, () => later).isOn("worker.verbose")).toBe(false);
        expect((await turn(false)).status).toBe(200);
        expect(await createFlags(db).isOn("worker.verbose")).toBe(false);
        const events = await db
          .select({ action: schema.instanceEvents.action, target: schema.instanceEvents.target })
          .from(schema.instanceEvents)
          .where(like(schema.instanceEvents.action, "flag.%"));
        expect(events).toEqual([
          { action: "flag.on", target: "Verbose logging for the worker" },
          { action: "flag.off", target: "Verbose logging for the worker" },
        ]);
        // Only its own flags, and only for operators.
        expect((await turn(true, operator, "everything.on")).status).toBe(400);
        const theirOwner = await join(operator, "label@example.test", "owner");
        expect((await turn(true, theirOwner)).status).toBe(403);
        expect((await get("/api/instance/flags", theirOwner)).status).toBe(403);
      });

      it("keeps a report when the workspace it names does not exist", async () => {
        const reference = await recordFailure(db, {
          source: "worker",
          location: "media-probe",
          error: "not an Error",
          organisationId: "0199f000-0000-7000-8000-00000000dead",
        });
        expect(reference).toMatch(/^HK-/);
        const [row] = await db
          .select()
          .from(schema.errorReports)
          .where(eq(schema.errorReports.reference, reference ?? ""));
        expect(row).toMatchObject({ organisationId: null, message: "not an Error" });
      });

      describe("workspaces", () => {
        type Page = {
          workspaces: { id: string; name: string; state: string; members: number }[];
          total: number;
          next: string | null;
        };
        const getAs = (path: string, cookie: string) => app.request(path, { headers: { cookie } });
        const list = async (cookie: string, query = "") =>
          (await (await get(`/api/instance/workspaces${query}`, cookie)).json()) as Page;
        const another = async (name: string, slug: string) => {
          const [made] = await db
            .insert(schema.organisations)
            .values({ name, slug })
            .returning({ id: schema.organisations.id });
          return made?.id ?? "";
        };

        it("makes a workspace and invites its first owner, on a subdomain of its own", async () => {
          const operator = cookieOf(await setup());
          mailer.sent.length = 0;
          const input = {
            name: "Lantern Pictures",
            slug: "lantern",
            ownerEmail: "Owner@Lantern.example",
          };
          const made = await send("POST", "/api/instance/workspaces", input, operator);
          expect(made.status).toBe(201);
          const { id } = (await made.json()) as { id: string };
          const mail = mailer.sent.find((m) => m.to === "owner@lantern.example");
          expect(mail?.text).toContain("/invite/");
          const [invitation] = await db
            .select({ role: schema.invitations.role })
            .from(schema.invitations)
            .where(eq(schema.invitations.organisationId, id));
          expect(invitation?.role).toBe("owner");
          const detail = (await (await get(`/api/instance/workspaces/${id}`, operator)).json()) as {
            invited: { email: string; role: string }[];
          };
          expect(detail.invited).toMatchObject([{ email: "owner@lantern.example", role: "owner" }]);
          // Mail that cannot go leaves the workspace made, and the link to pass on by hand.
          const deliver = mailer.send;
          mailer.send = async () => {
            throw new Error("The mail server is down");
          };
          const unsent = await send(
            "POST",
            "/api/instance/workspaces",
            {
              name: "North Choir Collective",
              slug: "north-choir",
              ownerEmail: "owner@north.example",
            },
            operator,
          );
          mailer.send = deliver;
          expect(unsent.status).toBe(201);
          expect(await unsent.json()).toMatchObject({
            mailed: false,
            link: expect.stringContaining("/invite/"),
          });
          const taken = await send("POST", "/api/instance/workspaces", input, operator);
          expect(taken.status).toBe(409);
          expect(await taken.json()).toMatchObject({ error: { code: "slug_taken" } });
          const [event] = await db
            .select()
            .from(schema.instanceEvents)
            .where(eq(schema.instanceEvents.action, "workspace.created"));
          expect(event?.target).toBe("Lantern Pictures");

          // An owner who does not operate the instance makes none.
          const owner = await join(operator, "label@example.test", "owner");
          const refused = await send(
            "POST",
            "/api/instance/workspaces",
            { ...input, slug: "lantern-two" },
            owner,
          );
          expect(refused.status).toBe(403);
        });

        it("pages the list by cursor, found by name or subdomain and filtered by state", async () => {
          const operator = cookieOf(await setup());
          for (const [name, slug] of [
            ["Hollow Reed Audio", "hollow-reed"],
            ["Lantern Pictures", "lantern-pages"],
            ["North Choir Collective", "north-choir"],
            ["Tallow and Wick Post", "tallow"],
          ] as const)
            await another(name, slug);
          const first = await list(operator, "?limit=2");
          expect(first.total).toBe(5);
          expect(first.workspaces.map((w) => w.name)).toEqual([
            "Hollow Reed Audio",
            "Lantern Pictures",
          ]);
          const second = await list(operator, `?limit=2&after=${first.next}`);
          expect(second.workspaces.map((w) => w.name)).toEqual([
            "North Choir Collective",
            "Studio",
          ]);
          const last = await list(operator, `?limit=2&after=${second.next}`);
          expect(last.workspaces.map((w) => w.name)).toEqual(["Tallow and Wick Post"]);
          expect(last.next).toBeNull();
          expect((await list(operator, "?q=choir")).workspaces.map((w) => w.name)).toEqual([
            "North Choir Collective",
          ]);
          expect((await list(operator, "?q=tallow")).total).toBe(1);
          // A search is taken as text, never as a pattern.
          expect((await list(operator, "?q=%25")).total).toBe(0);
          const tallow = (await list(operator, "?q=tallow")).workspaces[0]?.id;
          await send(
            "POST",
            `/api/instance/workspaces/${tallow}/suspend`,
            { reason: "Unpaid" },
            operator,
          );
          expect((await list(operator, "?state=suspended")).workspaces.map((w) => w.name)).toEqual([
            "Tallow and Wick Post",
          ]);
          expect((await list(operator, "?state=active")).total).toBe(4);
        });

        it("suspends a workspace: its members are told why, its guests' links stop, and nothing is lost", async () => {
          const operator = cookieOf(await setup());
          const member = await join(operator, "member@example.test");
          const made = await app.request(
            "/api/projects",
            json({ name: "Joplin Rags", profile: "music" }, member),
          );
          expect(made.status).toBe(201);
          const [studio] = await db
            .select({ id: schema.organisations.id })
            .from(schema.organisations)
            .where(eq(schema.organisations.slug, "studio"));
          const organisationId = studio?.id ?? "";
          const [guest] = await db
            .insert(schema.guests)
            .values({ organisationId, name: "Mira Solberg", email: "mira@example.test" })
            .returning();
          const opened = await app.request(
            "/api/guest/sessions",
            json({ token: (await issueGuestLink(db, organisationId, guest?.id ?? "")).token }),
          );
          expect(opened.status).toBe(201);
          const guestCookie = cookieOf(opened);
          const unused = (await issueGuestLink(db, organisationId, guest?.id ?? "")).token;

          // Only an operator suspends.
          const owner = await join(operator, "label@example.test", "owner");
          expect(
            (
              await send(
                "POST",
                `/api/instance/workspaces/${organisationId}/suspend`,
                { reason: "Unpaid" },
                owner,
              )
            ).status,
          ).toBe(403);
          const suspend = (reason: string) =>
            send(
              "POST",
              `/api/instance/workspaces/${organisationId}/suspend`,
              { reason },
              operator,
            );
          expect((await suspend("")).status).toBe(400);
          expect((await suspend("The invoice for October is unpaid.")).status).toBe(204);
          expect((await suspend("Again")).status).toBe(409);

          const refused = await getAs("/api/projects", member);
          expect(refused.status).toBe(403);
          expect(await refused.json()).toMatchObject({
            error: {
              code: "workspace_suspended",
              message: "This workspace is suspended: The invoice for October is unpaid.",
            },
          });
          // They may still read who they are, and switch to another workspace.
          expect((await getAs("/api/me", member)).status).toBe(200);
          expect((await getAs("/api/guest/me", guestCookie)).status).toBe(401);
          expect((await app.request("/api/guest/sessions", json({ token: unused }))).status).toBe(
            410,
          );

          // The instance side still opens for whoever owns it, and shows where it stands.
          const shown = (await (
            await get(`/api/instance/workspaces/${organisationId}`, owner)
          ).json()) as { state: string; suspendedReason: string };
          expect(shown).toMatchObject({
            state: "suspended",
            suspendedReason: "The invoice for October is unpaid.",
          });

          const reinstate = () =>
            send("POST", `/api/instance/workspaces/${organisationId}/reinstate`, {}, operator);
          expect((await reinstate()).status).toBe(204);
          expect((await reinstate()).status).toBe(409);
          const back = (await (await getAs("/api/projects", member)).json()) as {
            projects: { name: string }[];
          };
          expect(back.projects.map((p) => p.name)).toEqual(["Joplin Rags"]);
          expect((await app.request("/api/guest/sessions", json({ token: unused }))).status).toBe(
            201,
          );
          const events = await db
            .select({
              action: schema.instanceEvents.action,
              details: schema.instanceEvents.details,
            })
            .from(schema.instanceEvents)
            .where(like(schema.instanceEvents.action, "workspace.%"));
          expect(events.map((e) => e.action)).toEqual([
            "workspace.suspended",
            "workspace.reinstated",
          ]);
          expect(
            (
              await send(
                "POST",
                `/api/instance/workspaces/${crypto.randomUUID()}/reinstate`,
                {},
                operator,
              )
            ).status,
          ).toBe(404);
        });

        it("shows a workspace's figures, members and projects to an operator, and to its own owner alone", async () => {
          const operator = cookieOf(await setup());
          const member = await join(operator, "member@example.test");
          await app.request(
            "/api/projects",
            json({ name: "Joplin Rags", profile: "music" }, member),
          );
          const [studio] = await db
            .select({ id: schema.organisations.id })
            .from(schema.organisations)
            .where(eq(schema.organisations.slug, "studio"));
          const id = studio?.id ?? "";
          const detail = (await (await get(`/api/instance/workspaces/${id}`, operator)).json()) as {
            members: number;
            projects: number;
            signIn: { method: string; secondFactor: boolean };
            recent: { action: string }[];
          };
          expect(detail).toMatchObject({
            members: 2,
            projects: 1,
            signIn: { method: "password", secondFactor: false },
          });
          const members = (await (
            await get(`/api/instance/workspaces/${id}/members`, operator)
          ).json()) as { members: { email: string; role: string; factor: string }[] };
          expect(members.members.map((m) => [m.email, m.role, m.factor])).toEqual([
            [owner.email, "owner", "none"],
            ["member@example.test", "member", "none"],
          ]);
          const projects = (await (
            await get(`/api/instance/workspaces/${id}/projects`, operator)
          ).json()) as { projects: { name: string; files: number; openReviews: number }[] };
          expect(projects.projects).toMatchObject([
            { name: "Joplin Rags", files: 0, openReviews: 0 },
          ]);

          // An owner of another workspace finds none of it, and a member opens nothing here.
          const elsewhere = await another("Saltmarsh Films", "elsewhere-instance");
          const [user] = await db
            .select({ id: schema.users.id })
            .from(schema.users)
            .where(eq(schema.users.email, "member@example.test"));
          await db
            .insert(schema.members)
            .values({ organisationId: elsewhere, userId: user?.id ?? "", role: "owner" });
          for (const path of ["", "/members", "/projects"])
            expect((await get(`/api/instance/workspaces/${id}${path}`, member)).status).toBe(404);
          for (const path of ["", "/members", "/projects"])
            expect((await get(`/api/instance/workspaces/${elsewhere}${path}`, member)).status).toBe(
              200,
            );
          expect((await list(member)).workspaces.map((w) => w.name)).toEqual(["Saltmarsh Films"]);
        });

        it("helps a member sign in again without ever signing in as them", async () => {
          const operator = cookieOf(await setup());
          const member = await join(operator, "member@example.test");
          const [studio] = await db
            .select({ id: schema.organisations.id })
            .from(schema.organisations)
            .where(eq(schema.organisations.slug, "studio"));
          const id = studio?.id ?? "";
          const [user] = await db
            .select({ id: schema.users.id })
            .from(schema.users)
            .where(eq(schema.users.email, "member@example.test"));
          const help = (
            action: string,
            userId = user?.id ?? "",
            workspace = id,
            cookie = operator,
          ) =>
            send(
              "POST",
              `/api/instance/workspaces/${workspace}/members/${userId}/${action}`,
              {},
              cookie,
            );

          mailer.sent.length = 0;
          expect((await help("password-reset")).status).toBe(204);
          expect(mailer.sent.find((m) => m.to === "member@example.test")?.subject).toContain(
            "code to set a new Hekate password",
          );
          expect((await help("second-factor")).status).toBe(204);
          expect((await help("sessions")).status).toBe(204);
          expect((await getAs("/api/projects", member)).status).toBe(401);
          expect((await help("sign-in-as")).status).toBe(400);

          // Someone who is not a member of that workspace is not found there.
          const elsewhere = await another("Saltmarsh Films", "elsewhere-help");
          expect((await help("sessions", user?.id, elsewhere)).status).toBe(404);
          // An owner who does not operate the instance does none of it.
          const owner = await join(operator, "label@example.test", "owner");
          expect((await help("sessions", user?.id, id, owner)).status).toBe(403);
          const events = await db
            .select({ action: schema.instanceEvents.action, target: schema.instanceEvents.target })
            .from(schema.instanceEvents)
            .where(like(schema.instanceEvents.action, "member.%"));
          expect(events).toEqual([
            { action: "member.password_reset", target: "member@example.test" },
            { action: "member.second_factor_reset", target: "member@example.test" },
            { action: "member.sessions_revoked", target: "member@example.test" },
          ]);
        });

        const studioId = async () => {
          const [studio] = await db
            .select({ id: schema.organisations.id })
            .from(schema.organisations)
            .where(eq(schema.organisations.slug, "studio"));
          return studio?.id ?? "";
        };

        it("shows a workspace's storage and settings to an operator and its own owner alone", async () => {
          const operator = cookieOf(await setup());
          const id = await studioId();
          const [project] = await db
            .insert(schema.projects)
            .values({ organisationId: id, name: "Joplin Rags", profile: "music" })
            .returning();
          const original = await storage.put(id, Buffer.from("an original recording"));
          await storage.put(id, Buffer.from("a rendition"));
          await db.insert(schema.files).values({
            organisationId: id,
            projectId: project?.id ?? "",
            name: "Maple Leaf Rag.wav",
            kind: "audio",
            blobId: original.id,
            contentType: "audio/wav",
            byteSize: original.byteSize,
          });
          const stored = (await (
            await get(`/api/instance/workspaces/${id}/storage`, operator)
          ).json()) as {
            originalBytes: number;
            derivedBytes: number;
            backend: string;
            backends: { name: string; objects: number }[];
          };
          expect(stored).toMatchObject({
            originalBytes: original.byteSize,
            derivedBytes: "a rendition".length,
            backend: "local",
            backends: [{ name: "local", objects: 2 }],
          });
          await app.request("/api/organisation/settings", {
            ...json({ guestLinkDays: 14 }, operator),
            method: "PATCH",
          });
          const settings = (await (
            await get(`/api/instance/workspaces/${id}/settings`, operator)
          ).json()) as { guestLinkDays: number; sso: unknown; directory: boolean };
          expect(settings).toMatchObject({ guestLinkDays: 14, sso: null, directory: false });

          // Another workspace's owner finds none of it.
          const owner = await join(operator, "member@example.test");
          const [user] = await db
            .select({ id: schema.users.id })
            .from(schema.users)
            .where(eq(schema.users.email, "member@example.test"));
          const elsewhere = await another("Saltmarsh Films", "elsewhere-storage-tab");
          await db
            .insert(schema.members)
            .values({ organisationId: elsewhere, userId: user?.id ?? "", role: "owner" });
          for (const path of ["/storage", "/settings", "/keys"]) {
            expect((await get(`/api/instance/workspaces/${id}${path}`, owner)).status).toBe(404);
            expect((await get(`/api/instance/workspaces/${elsewhere}${path}`, owner)).status).toBe(
              200,
            );
          }
        });

        it("rotates a workspace's key and rewraps everything it holds, which still opens", async () => {
          const operator = cookieOf(await setup());
          const id = await studioId();
          const blob = await storage.put(id, Buffer.from("the album master"));
          type Keys = { current: number; pending: number; versions: { version: number }[] };
          const keys = async () =>
            (await (await get(`/api/instance/workspaces/${id}/keys`, operator)).json()) as Keys;
          expect(await keys()).toMatchObject({ current: 1, pending: 0 });

          sent.length = 0;
          const rotated = await send(
            "POST",
            `/api/instance/workspaces/${id}/keys/rotate`,
            {},
            operator,
          );
          expect(await rotated.json()).toEqual({ version: 2 });
          expect(sent).toEqual([{ name: "organisation-rewrap", data: { organisationId: id } }]);
          expect(await keys()).toMatchObject({ current: 2, pending: 1 });
          // What the old version wraps opens until it is rewrapped, and after.
          const read = async () =>
            (await buffer((await storage.open(id, blob.id)).stream)).toString();
          expect(await read()).toBe("the album master");
          expect(await rewrapOrganisation(db, keyring, id)).toBe(1);
          expect(await keys()).toMatchObject({ current: 2, pending: 0 });
          expect(await read()).toBe("the album master");
          // New bytes are wrapped with the new version.
          const later = await storage.put(id, Buffer.from("a later mix"));
          const [row] = await db
            .select({ keyVersion: schema.blobs.keyVersion })
            .from(schema.blobs)
            .where(eq(schema.blobs.id, later.id));
          expect(row?.keyVersion).toBe(2);
          // A rotation whose job never ran is caught by the hourly sweep.
          await send("POST", `/api/instance/workspaces/${id}/keys/rotate`, {}, operator);
          expect(await keys()).toMatchObject({ current: 3, pending: 2 });
          expect(await rewrapBehind(db, keyring)).toBe(2);
          expect(await keys()).toMatchObject({ current: 3, pending: 0 });
          expect(await read()).toBe("the album master");

          const owner = await join(operator, "label@example.test", "owner");
          expect((await get(`/api/instance/workspaces/${id}/keys`, owner)).status).toBe(200);
          expect(
            (await send("POST", `/api/instance/workspaces/${id}/keys/rotate`, {}, owner)).status,
          ).toBe(403);
        });

        it("lets an operator move a project between workspaces, confirmed with its name and their password (#240)", async () => {
          const operator = cookieOf(await setup());
          const from = await studioId();
          const to = await another("Lantern Pictures", "elsewhere-move");
          const [project] = await db
            .insert(schema.projects)
            .values({ organisationId: from, name: "Opening titles", profile: "video" })
            .returning();
          const path = `/api/instance/workspaces/${from}/projects/${project?.id}/move`;
          const password = "correct horse battery";
          expect(
            (await send("POST", path, { to, name: "Openings", password }, operator)).status,
          ).toBe(422);
          expect(
            (await send("POST", path, { to, name: "Opening titles", password: "wrong" }, operator))
              .status,
          ).toBe(403);
          // A workspace's owner is no operator.
          const owner = await join(operator, "label@example.test", "owner");
          expect(
            (await send("POST", path, { to, name: "Opening titles", password }, owner)).status,
          ).toBe(403);
          // A move refused leaves a transfer waiting on the project as it was.
          const [waiting] = await db
            .insert(schema.projectTransfers)
            .values({
              fromOrganisationId: from,
              toOrganisationId: to,
              projectId: project?.id ?? "",
              projectName: "Opening titles",
              expiresAt: new Date(Date.now() + 86400e3),
            })
            .returning();
          const stored = await storage.put(from, Buffer.from("cut"));
          await db.insert(schema.files).values({
            organisationId: from,
            projectId: project?.id ?? "",
            name: "Cut 3.mp4",
            kind: "video",
            blobId: stored.id,
            contentType: "video/mp4",
            byteSize: stored.byteSize,
            streamStatus: "pending",
          });
          expect(
            (await send("POST", path, { to, name: "Opening titles", password }, operator)).status,
          ).toBe(409);
          const waitingStatus = async () =>
            (
              await db
                .select({ status: schema.projectTransfers.status })
                .from(schema.projectTransfers)
                .where(eq(schema.projectTransfers.id, waiting?.id ?? ""))
            )[0]?.status;
          expect(await waitingStatus()).toBe("pending");
          await db
            .update(schema.files)
            .set({ streamStatus: "ready" })
            .where(eq(schema.files.blobId, stored.id));
          const moved = await send(
            "POST",
            path,
            { to, name: "opening titles", password },
            operator,
          );
          expect(moved.status).toBe(200);
          const [after] = await db
            .select({ organisationId: schema.projects.organisationId })
            .from(schema.projects)
            .where(eq(schema.projects.id, project?.id ?? ""));
          expect(after?.organisationId).toBe(to);
          // Kept as a transfer already done, the one waiting withdrawn, in both logs and the
          // instance's events.
          expect(await waitingStatus()).toBe("cancelled");
          expect(
            (
              await db
                .select({ status: schema.projectTransfers.status })
                .from(schema.projectTransfers)
                .where(eq(schema.projectTransfers.projectId, project?.id ?? ""))
            )
              .map((t) => t.status)
              .sort(),
          ).toEqual(["cancelled", "moved"]);
          for (const organisationId of [from, to])
            expect(
              await db
                .select({ details: schema.accessEvents.details })
                .from(schema.accessEvents)
                .where(
                  and(
                    eq(schema.accessEvents.organisationId, organisationId),
                    eq(schema.accessEvents.action, "project.transfer"),
                  ),
                ),
            ).toEqual([
              {
                details: {
                  name: "Opening titles",
                  from: "Studio",
                  to: "Lantern Pictures",
                  byOperator: true,
                },
              },
            ]);
          const events = await db
            .select({ action: schema.instanceEvents.action, target: schema.instanceEvents.target })
            .from(schema.instanceEvents)
            .where(eq(schema.instanceEvents.action, "workspace.project_moved"));
          expect(events).toEqual([{ action: "workspace.project_moved", target: "Opening titles" }]);
          // Not again from where it no longer is.
          expect(
            (await send("POST", path, { to, name: "Opening titles", password }, operator)).status,
          ).toBe(404);
        });

        it("deletes a suspended workspace once its grace period is over, with everything in it", async () => {
          const operator = cookieOf(await setup());
          // A second workspace, whose content is a studio's: a track with a version, its file,
          // and the access log.
          const id = await another("Lantern Pictures", "elsewhere-purge");
          const [project] = await db
            .insert(schema.projects)
            .values({ organisationId: id, name: "Opening titles", profile: "music" })
            .returning();
          const blob = await storage.put(id, Buffer.from("the cut"));
          const [file] = await db
            .insert(schema.files)
            .values({
              organisationId: id,
              projectId: project?.id ?? "",
              name: "Cut 3.wav",
              kind: "audio",
              blobId: blob.id,
              contentType: "audio/wav",
              byteSize: blob.byteSize,
            })
            .returning();
          const [track] = await db
            .insert(schema.tracks)
            .values({ organisationId: id, projectId: project?.id ?? "", name: "Main titles" })
            .returning();
          const [version] = await db
            .insert(schema.versions)
            .values({ organisationId: id, trackId: track?.id ?? "", number: 1 })
            .returning();
          await db.insert(schema.variations).values({
            organisationId: id,
            versionId: version?.id ?? "",
            fileId: file?.id ?? "",
            name: "Mix",
            isPrimary: true,
          });
          await audit.record(id, { type: "system", label: "Hekate" }, { action: "file.upload" });
          // An upload left unfinished, whose parts no listing of the prefix would find.
          const session = await storage.beginUpload(id, 6, "audio/wav");
          await backends
            .get(session.backend)
            .putPart(session.key, session.backendUploadId, 1, Buffer.from("part"));
          await db.insert(schema.uploads).values({
            ...session,
            organisationId: id,
            projectId: project?.id ?? "",
            name: "Cut 4.wav",
            expiresAt: new Date(Date.now() + 86_400_000),
          });

          const del = (path = "") =>
            send("POST", `/api/instance/workspaces/${id}/delete${path}`, {}, operator);
          expect((await del()).status).toBe(409);
          await send(
            "POST",
            `/api/instance/workspaces/${id}/suspend`,
            { reason: "Closed" },
            operator,
          );
          const scheduled = await del();
          expect(scheduled.status).toBe(200);
          const { deleteAfter } = (await scheduled.json()) as { deleteAfter: string };
          const days = (new Date(deleteAfter).getTime() - Date.now()) / 86_400_000;
          expect(Math.round(days)).toBe(30);
          expect((await del()).status).toBe(409);
          expect((await del("/cancel")).status).toBe(204);
          expect((await del("/cancel")).status).toBe(409);
          expect((await del()).status).toBe(200);

          // Not before its time.
          expect(await purgeDueWorkspaces(db, backends)).toBe(0);
          const owner = await join(operator, "label@example.test", "owner");
          expect((await del("/cancel")).status).toBe(204);
          expect(
            (await send("POST", `/api/instance/workspaces/${id}/delete`, {}, owner)).status,
          ).toBe(403);
          expect((await del()).status).toBe(200);
          const after = new Date(Date.now() + 31 * 86_400_000);
          // An upload that cannot be aborted holds the purge back until it can be.
          const backend = backends.get(session.backend);
          const abort = vi
            .spyOn(backend, "abortMultipart")
            .mockRejectedValueOnce(new Error("unreachable"));
          expect(await purgeDueWorkspaces(db, backends, after)).toBe(0);
          expect(abort).toHaveBeenCalledTimes(1);
          abort.mockRestore();
          expect(await purgeDueWorkspaces(db, backends, after)).toBe(1);
          await expect(
            backend.putPart(session.key, session.backendUploadId, 2, Buffer.from("more")),
          ).rejects.toThrow();
          const [gone] = await db
            .select()
            .from(schema.organisations)
            .where(eq(schema.organisations.id, id));
          expect(gone).toBeUndefined();
          const left = [];
          for await (const object of backends.get(blob.backend).list(`org/${id}/`))
            left.push(object);
          expect(left).toEqual([]);
          const [event] = await db
            .select({ target: schema.instanceEvents.target })
            .from(schema.instanceEvents)
            .where(eq(schema.instanceEvents.action, "workspace.purged"));
          expect(event?.target).toBe("Lantern Pictures");
          // The other workspace is untouched.
          expect((await getAs("/api/projects", operator)).status).toBe(200);
        });
      });
    });

    it("invites someone new, who joins with a name and password", async () => {
      mailer.sent.length = 0;
      const owner = cookieOf(await setup());
      const { res, body } = await invite(owner, "Conductor@Example.test", "admin");
      expect(res.status).toBe(201);
      expect(mailer.sent[0]?.to).toBe("conductor@example.test");
      expect(mailer.sent[0]?.text).toContain(body.link);

      const token = tokenFrom(body.link);
      const info = (await (await app.request(`/api/invitations/${token}`)).json()) as Record<
        string,
        unknown
      >;
      expect(info).toMatchObject({
        organisation: "Studio",
        email: "conductor@example.test",
        role: "admin",
        status: "valid",
        hasAccount: false,
      });

      const accepted = await app.request(
        `/api/invitations/${token}/accept`,
        json({ name: "Conductor", password: "a long enough password" }),
      );
      expect(accepted.status).toBe(201);
      const me = (await (
        await app.request("/api/me", { headers: { cookie: cookieOf(accepted) } })
      ).json()) as { organisations: { role: string }[] };
      expect(me.organisations).toEqual([
        expect.objectContaining({ name: "Studio", role: "admin" }),
      ]);

      // The link works once.
      const again = await app.request(
        `/api/invitations/${token}/accept`,
        json({ name: "x", password: "a long enough password" }),
      );
      expect(again.status).toBe(410);
    });

    it("stores only a hash of the token", async () => {
      const owner = cookieOf(await setup());
      const { body } = await invite(owner, "hash@example.test");
      const rows = await db.select().from(schema.invitations);
      expect(rows.some((r) => r.tokenHash === tokenFrom(body.link))).toBe(false);
    });

    it("refuses revoked and expired invitations", async () => {
      const owner = cookieOf(await setup());
      const revoked = await invite(owner, "revoked@example.test");
      const del = await app.request(`/api/organisation/invitations/${revoked.body.invitation.id}`, {
        method: "DELETE",
        headers: { cookie: owner },
      });
      expect(del.status).toBe(204);
      expect(
        (
          await app.request(
            `/api/invitations/${tokenFrom(revoked.body.link)}/accept`,
            json({ name: "x", password: "a long enough password" }),
          )
        ).status,
      ).toBe(410);

      const expired = await invite(owner, "late@example.test");
      await db
        .update(schema.invitations)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(sql`email = 'late@example.test'`);
      const info = (await (
        await app.request(`/api/invitations/${tokenFrom(expired.body.link)}`)
      ).json()) as { status: string };
      expect(info.status).toBe("expired");
    });

    it("limits invitations and role changes by role", async () => {
      const owner = cookieOf(await setup());
      const { body } = await invite(owner, "member@example.test", "member");
      const joined = await app.request(
        `/api/invitations/${tokenFrom(body.link)}/accept`,
        json({ name: "Member", password: "a long enough password" }),
      );
      const member = cookieOf(joined);
      expect((await invite(member, "someone@example.test")).res.status).toBe(403);
      expect(
        (await app.request("/api/organisation/invitations", { headers: { cookie: member } }))
          .status,
      ).toBe(403);
      // Members can see who else is in the organisation.
      const list = (await (
        await app.request("/api/organisation/members", { headers: { cookie: member } })
      ).json()) as { members: { email: string; id: string; role: string }[] };
      expect(list.members.map((m) => m.email).sort()).toEqual([
        "member@example.test",
        "producer@example.test",
      ]);

      const self = list.members.find((m) => m.email === "member@example.test");
      const promote = await app.request(`/api/organisation/members/${self?.id}`, {
        ...json({ role: "admin" }, member),
        method: "PATCH",
      });
      expect(promote.status).toBe(403);
    });

    it("always keeps at least one owner", async () => {
      const owner = cookieOf(await setup());
      const list = (await (
        await app.request("/api/organisation/members", { headers: { cookie: owner } })
      ).json()) as { members: { id: string }[] };
      const id = list.members[0]?.id;
      const demote = await app.request(`/api/organisation/members/${id}`, {
        ...json({ role: "admin" }, owner),
        method: "PATCH",
      });
      expect(demote.status).toBe(409);
      const leave = await app.request(`/api/organisation/members/${id}`, {
        method: "DELETE",
        headers: { cookie: owner },
      });
      expect(leave.status).toBe(409);
    });

    it("refuses to invite an existing member and asks existing accounts to sign in", async () => {
      const owner = cookieOf(await setup());
      expect((await invite(owner, "producer@example.test")).res.status).toBe(409);

      // An account from another organisation must be signed in to accept.
      const [other] = await db
        .insert(schema.organisations)
        .values({ name: "Elsewhere", slug: "elsewhere" })
        .returning();
      const { body } = await invite(owner, "guest@example.test");
      const joined = await app.request(
        `/api/invitations/${tokenFrom(body.link)}/accept`,
        json({ name: "Guest", password: "a long enough password" }),
      );
      expect(joined.status).toBe(201);
      await db.insert(schema.members).values({
        organisationId: other?.id ?? "",
        userId:
          (await db.select().from(schema.users).where(sql`email = 'producer@example.test'`))[0]
            ?.id ?? "",
        role: "owner",
      });
      const elsewhere = await app.request("/api/me/organisation", {
        ...json({ organisationId: other?.id }, owner),
        method: "PUT",
      });
      expect(elsewhere.status).toBe(200);
      const second = await invite(owner, "guest@example.test");
      const info = (await (
        await app.request(`/api/invitations/${tokenFrom(second.body.link)}`)
      ).json()) as { hasAccount: boolean };
      expect(info.hasAccount).toBe(true);
      const anonymous = await app.request(
        `/api/invitations/${tokenFrom(second.body.link)}/accept`,
        json({}),
      );
      expect(anonymous.status).toBe(401);
      const signedIn = await app.request(
        `/api/invitations/${tokenFrom(second.body.link)}/accept`,
        json({}, cookieOf(joined)),
      );
      expect(signedIn.status).toBe(201);
    });

    it("never swaps a workspace's identity provider once people sign in through it", async () => {
      const owner = cookieOf(await setup());
      const saml = (idpEntityId: string, groupsClaim = "groups") => ({
        enabled: true,
        protocol: "saml",
        issuer: "",
        clientId: "",
        entryPoint: "https://idp.example.com/saml/sso",
        idpEntityId,
        certificate: "MIIBexample",
        groupsClaim,
        roles: [],
        enforce: false,
      });
      const put = (body: unknown) =>
        app.request("/api/organisation/sso", { ...json(body, owner), method: "PUT" });
      expect((await put(saml("https://idp.example.com/one"))).status).toBe(200);
      // Before anyone has signed in through it, it may still be replaced.
      expect((await put(saml("https://idp.example.com/two"))).status).toBe(200);
      const [provider] = await db.select().from(schema.ssoProviders);
      await db.insert(schema.authAccounts).values({
        id: "sso-subject",
        userId: (await db.select({ id: schema.users.id }).from(schema.users))[0]?.id ?? "",
        accountId: "subject-1",
        providerId: provider?.providerId ?? "",
      });
      // Now another provider's subject 1 would be someone else: refused, whatever the protocol.
      const swapped = await put(saml("https://idp.example.com/three"));
      expect(swapped.status).toBe(422);
      expect(await swapped.text()).toContain("cannot be swapped for another");
      // Its other settings still change.
      expect((await put(saml("https://idp.example.com/two", "roles"))).status).toBe(200);
    });

    describe.runIf(process.env.KEYCLOAK_URL)("single sign-on", () => {
      const kc = process.env.KEYCLOAK_URL ?? "";
      const realm = `${kc}/realms/hekate`;
      const oidc = {
        enabled: true,
        protocol: "oidc",
        issuer: realm,
        clientId: "hekate",
        clientSecret: "oidc-client-secret-for-tests",
        entryPoint: "",
        idpEntityId: "",
        certificate: "",
        groupsClaim: "groups",
        roles: [{ group: "producers", role: "admin" }],
        enforce: false,
      };
      const put = (body: unknown, cookie: string) =>
        app.request("/api/organisation/sso", { ...json(body, cookie), method: "PUT" });
      type Me = { organisations: { name: string; role: string }[]; user: { name: string } };
      const me = async (cookie: string) =>
        (await (await app.request("/api/me", { headers: { cookie } })).json()) as Me;

      /** A browser at Keycloak: its cookies, followed redirects, and the login form posted. */
      const atKeycloak = async (start: string, username: string, password: string) => {
        const jar = new Map<string, string>();
        const keep = (res: Response) => {
          for (const c of res.headers.getSetCookie()) {
            const pair = c.split(";")[0] ?? "";
            const at = pair.indexOf("=");
            jar.set(pair.slice(0, at), pair.slice(at + 1));
          }
          return res;
        };
        const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
        let res = keep(await fetch(start, { redirect: "manual", headers: { cookie: cookie() } }));
        while (res.status >= 300 && res.status < 400) {
          const next = new URL(res.headers.get("location") ?? "", start).toString();
          res = keep(await fetch(next, { redirect: "manual", headers: { cookie: cookie() } }));
        }
        const page = await res.text();
        const action = /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/.exec(page)?.[1];
        expect(action).toBeTruthy();
        return keep(
          await fetch((action ?? "").replaceAll("&amp;", "&"), {
            method: "POST",
            redirect: "manual",
            headers: { cookie: cookie(), "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ username, password, credentialId: "" }),
          }),
        );
      };

      /** Starts at the sign-in page's button and returns the signed-in response, or the refusal. */
      const signIn = async (username: string, password: string, workspace = "studio") => {
        const found = await app.request(`/api/sign-in-methods/sso?workspace=${workspace}`);
        expect(found.status).toBe(200);
        const { providerId } = (await found.json()) as { providerId: string };
        const started = await app.request(
          "/api/auth/sign-in/sso",
          json({ providerId, callbackURL: "/", errorCallbackURL: "/sign-in?view=sso" }),
        );
        expect(started.status).toBe(200);
        const { url } = (await started.json()) as { url: string };
        const state = cookieOf(started);
        const back = await atKeycloak(url, username, password);
        if (back.status === 302) {
          // OIDC: back to the callback with a code.
          const to = new URL(back.headers.get("location") ?? "");
          return app.request(to.pathname + to.search, { headers: { cookie: state } });
        }
        // SAML: a page that posts the response to the ACS.
        const page = await back.text();
        const field = (name: string) =>
          new RegExp(`name="${name}" value="([^"]+)"`).exec(page)?.[1]?.replaceAll("&#x2b;", "+") ??
          "";
        const acs = new URL(
          (/<form[^>]*action="([^"]+)"/.exec(page)?.[1] ?? "")
            .replaceAll("&#x3a;", ":")
            .replaceAll("&#x2f;", "/"),
        );
        return app.request(acs.pathname, {
          method: "POST",
          headers: {
            cookie: state,
            "content-type": "application/x-www-form-urlencoded",
            origin: kc,
          },
          body: new URLSearchParams({
            SAMLResponse: field("SAMLResponse"),
            RelayState: field("RelayState"),
          }).toString(),
        });
      };

      it("signs members in through the workspace's OIDC provider, with the role their groups give", async () => {
        const owner = cookieOf(await setup());
        const offered = async () =>
          ((await (await app.request("/api/sign-in-methods")).json()) as { sso: boolean }).sso;
        expect(await offered()).toBe(false);
        expect((await app.request("/api/sign-in-methods/sso?workspace=studio")).status).toBe(404);
        const saved = await put(oidc, owner);
        expect(saved.status).toBe(200);
        const body = (await saved.json()) as {
          sso: Record<string, unknown>;
          serviceProvider: { redirectUri: string };
        };
        // The secret goes in and never comes back; the redirect URI is what Keycloak is given.
        expect(body.sso).toMatchObject({ hasClientSecret: true, enabled: true, issuer: realm });
        expect(JSON.stringify(body)).not.toContain("oidc-client-secret");
        expect(body.serviceProvider.redirectUri).toMatch(
          /^http:\/\/localhost:3000\/api\/auth\/sso\/callback\/workspace-/,
        );
        expect(await offered()).toBe(true);

        // Mira's groups make her an admin; she joins on her first sign-in.
        const mira = await signIn("mira", "mira-sso-pass");
        expect(mira.status).toBe(302);
        const miraMe = await me(cookieOf(mira));
        expect(miraMe.user.name).toBe("Mira Solberg");
        expect(miraMe.organisations).toEqual([
          expect.objectContaining({ name: "Studio", role: "admin" }),
        ]);
        // Tomas is in no admin group: a member. Both are in the access log.
        const tomas = await signIn("tomas", "tomas-sso-pass");
        expect((await me(cookieOf(tomas))).organisations[0]?.role).toBe("member");
        const logged = await db
          .select()
          .from(schema.accessEvents)
          .where(eq(schema.accessEvents.action, "account.sso_sign_in"));
        expect(logged).toHaveLength(2);
        // A member neither sees nor changes it.
        expect(
          (
            await app.request("/api/organisation/sso", {
              headers: { cookie: cookieOf(tomas) },
            })
          ).status,
        ).toBe(403);
        expect((await put(oidc, cookieOf(tomas))).status).toBe(403);

        // Turned off, it signs no one in and the page stops offering it.
        const { clientSecret: _, ...kept } = oidc;
        expect((await put({ ...kept, enabled: false }, owner)).status).toBe(200);
        expect(await offered()).toBe(false);
        const providerId = body.serviceProvider.redirectUri.split("/").pop();
        expect(
          (await app.request("/api/auth/sign-in/sso", json({ providerId, callbackURL: "/" })))
            .status,
        ).toBe(400);
      }, 60_000);

      it("enforced, holds back members who signed in otherwise, but never the owner", async () => {
        const owner = cookieOf(await setup());
        const { body } = await invite(owner, "player@example.test");
        const player = cookieOf(
          await app.request(
            `/api/invitations/${tokenFrom(body.link)}/accept`,
            json({ name: "Player", password: "correct horse battery" }),
          ),
        );
        expect((await put({ ...oidc, enforce: true }, owner)).status).toBe(200);
        const refused = await app.request("/api/projects", { headers: { cookie: player } });
        expect(refused.status).toBe(403);
        expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
          "sso_required",
        );
        // Who they are still answers, so the app can send them to sign in.
        expect((await app.request("/api/me", { headers: { cookie: player } })).status).toBe(200);
        // The owner keeps their password (break-glass); a member who came through it works.
        expect((await app.request("/api/projects", { headers: { cookie: owner } })).status).toBe(
          200,
        );
        const mira = cookieOf(await signIn("mira", "mira-sso-pass"));
        expect((await app.request("/api/projects", { headers: { cookie: mira } })).status).toBe(
          200,
        );
      }, 60_000);

      it("never takes over an account that already has the address", async () => {
        const owner = cookieOf(await setup());
        const { body } = await invite(owner, "tomas@example.test");
        await app.request(
          `/api/invitations/${tokenFrom(body.link)}/accept`,
          json({ name: "Tomas", password: "correct horse battery" }),
        );
        expect((await put(oidc, owner)).status).toBe(200);
        const refused = await signIn("tomas", "tomas-sso-pass");
        expect(refused.status).toBe(302);
        expect(refused.headers.get("location")).toMatch(/error=/);
        expect(cookieOf(refused)).not.toContain("session_token");
      }, 60_000);

      it("signs members in through a SAML identity provider", async () => {
        const owner = cookieOf(await setup());
        const read = (await (
          await app.request("/api/organisation/sso", { headers: { cookie: owner } })
        ).json()) as { serviceProvider: { entityId: string; acsUrl: string } };
        // Keycloak is told about this workspace's service provider through its admin API.
        const token = (
          (await (
            await fetch(`${kc}/realms/master/protocol/openid-connect/token`, {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                grant_type: "password",
                client_id: "admin-cli",
                username: "admin",
                password: "admin-secret-for-tests",
              }),
            })
          ).json()) as { access_token: string }
        ).access_token;
        const property = (name: string, attribute: string) => ({
          name,
          protocol: "saml",
          protocolMapper: "saml-user-property-mapper",
          config: { "user.attribute": attribute, "attribute.name": name },
        });
        const made = await fetch(`${kc}/admin/realms/hekate/clients`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            clientId: read.serviceProvider.entityId,
            protocol: "saml",
            redirectUris: [read.serviceProvider.acsUrl],
            attributes: {
              "saml.assertion.signature": "true",
              "saml.server.signature": "true",
              "saml.client.signature": "false",
              "saml.authnstatement": "true",
              saml_assertion_consumer_url_post: read.serviceProvider.acsUrl,
            },
            protocolMappers: [
              property("email", "email"),
              property("givenName", "firstName"),
              property("surname", "lastName"),
              {
                name: "groups",
                protocol: "saml",
                protocolMapper: "saml-group-membership-mapper",
                config: { "attribute.name": "groups", "full.path": "false", single: "false" },
              },
            ],
          }),
        });
        expect(made.status).toBe(201);
        const descriptor = await (await fetch(`${realm}/protocol/saml/descriptor`)).text();
        const certificate = /<ds:X509Certificate>([^<]+)</.exec(descriptor)?.[1] ?? "";
        expect(
          (
            await put(
              {
                ...oidc,
                protocol: "saml",
                issuer: "",
                clientId: "",
                clientSecret: "",
                entryPoint: `${realm}/protocol/saml`,
                idpEntityId: realm,
                certificate,
              },
              owner,
            )
          ).status,
        ).toBe(200);
        const mira = await signIn("mira", "mira-sso-pass");
        expect(mira.status).toBe(302);
        const miraMe = await me(cookieOf(mira));
        expect(miraMe.user.name).toBe("Mira Solberg");
        expect(miraMe.organisations).toEqual([
          expect.objectContaining({ name: "Studio", role: "admin" }),
        ]);
      }, 60_000);
    });

    describe.runIf(process.env.LDAP_TEST_URL)("directory", () => {
      const settings = {
        enabled: true,
        url: process.env.LDAP_TEST_URL ?? "",
        verifyCertificate: true,
        bindDn: "cn=hekate,ou=services,dc=example,dc=test",
        bindPassword: "bind-secret-for-tests",
        userBase: "ou=people,dc=example,dc=test",
        userFilter: "(uid={username})",
        emailAttribute: "mail",
        nameAttribute: "cn",
        groupBase: "ou=groups,dc=example,dc=test",
        groupFilter: "(member={dn})",
        roles: [{ group: "producers", role: "admin" }],
      };
      const put = (body: unknown, cookie: string) =>
        app.request("/api/organisation/directory", { ...json(body, cookie), method: "PUT" });
      const signIn = (username: string, password: string, workspace = "studio") =>
        app.request("/api/auth/sign-in/directory", json({ workspace, username, password }));
      type Me = { organisations: { name: string; role: string }[]; user: { name: string } };

      it("signs members in with the workspace's directory, giving each the role their groups say", async () => {
        const owner = cookieOf(await setup());
        const offered = async () =>
          ((await (await app.request("/api/sign-in-methods")).json()) as { directory: boolean })
            .directory;
        // Off until it is set up, and the sign-in page does not offer it.
        expect((await signIn("mira", "mira-directory-pass")).status).toBe(400);
        expect(await offered()).toBe(false);
        expect((await put(settings, owner)).status).toBe(200);
        expect(await offered()).toBe(true);
        const read = (await (
          await app.request("/api/organisation/directory", { headers: { cookie: owner } })
        ).json()) as { directory: Record<string, unknown>; workspace: string };
        // With the short name people type to sign in with it.
        expect(read.workspace).toBe("studio");
        // The bind password goes in and never comes back.
        expect(read.directory).toMatchObject({ hasBindPassword: true, enabled: true });
        expect(JSON.stringify(read)).not.toContain("bind-secret");
        const [stored] = await db.select().from(schema.directories);
        expect(stored?.bindPasswordSealed).not.toContain("bind-secret");
        const tested = await app.request("/api/organisation/directory/test", json({}, owner));
        expect(await tested.json()).toEqual({ ok: true, problem: null });

        // Mira's groups make her an admin; she joins on her first sign-in.
        const mira = await signIn("mira", "mira-directory-pass");
        expect(mira.status).toBe(200);
        const miraMe = (await (
          await app.request("/api/me", { headers: { cookie: cookieOf(mira) } })
        ).json()) as Me;
        expect(miraMe.user.name).toBe("Mira Solberg");
        expect(miraMe.organisations).toEqual([
          expect.objectContaining({ name: "Studio", role: "admin" }),
        ]);
        // Tomas is in no admin group: a member. Two first sign-ins at once make one account.
        const [tomas, again] = await Promise.all([
          signIn("tomas", "tomas-directory-pass"),
          signIn("tomas", "tomas-directory-pass"),
        ]);
        expect([tomas.status, again.status]).toEqual([200, 200]);
        expect(
          await db
            .select({ id: schema.users.id })
            .from(schema.users)
            .where(eq(schema.users.email, "tomas@example.test")),
        ).toHaveLength(1);
        const tomasMe = (await (
          await app.request("/api/me", { headers: { cookie: cookieOf(tomas) } })
        ).json()) as Me;
        expect(tomasMe.organisations[0]?.role).toBe("member");
        // A member does not see or change the directory.
        expect(
          (
            await app.request("/api/organisation/directory", {
              headers: { cookie: cookieOf(tomas) },
            })
          ).status,
        ).toBe(403);

        // Wrong passwords, unknown names and entries without an address are refused.
        expect((await signIn("mira", "wrong")).status).toBe(401);
        expect((await signIn("nobody", "mira-directory-pass")).status).toBe(401);
        expect((await signIn("ines", "ines-directory-pass")).status).toBe(403);
        // Leaving the bind password out keeps it.
        const { bindPassword: _, ...withoutPassword } = settings;
        expect((await put({ ...withoutPassword, roles: [] }, owner)).status).toBe(200);
        expect((await signIn("tomas", "tomas-directory-pass")).status).toBe(200);
        // Tomas has no password here: his directory's confirms deleting his account.
        const remove = (password: string) =>
          app.request("/api/me", {
            ...json({ email: "tomas@example.test", password }, cookieOf(tomas)),
            method: "DELETE",
          });
        expect((await remove("wrong")).status).toBe(403);
        expect((await remove("tomas-directory-pass")).status).toBe(204);
        // Turned off, it signs no one in.
        expect((await put({ ...withoutPassword, enabled: false }, owner)).status).toBe(200);
        expect((await signIn("mira", "mira-directory-pass")).status).toBe(400);
        expect(await offered()).toBe(false);
      });

      it("never takes over an account that already has the address", async () => {
        const owner = cookieOf(await setup());
        expect((await put(settings, owner)).status).toBe(200);
        // Tomas already has an account here, by invitation.
        const { body } = await invite(owner, "tomas@example.test");
        await app.request(
          `/api/invitations/${tokenFrom(body.link)}/accept`,
          json({ name: "Tomas", password: "correct horse battery" }),
        );
        const refused = await signIn("tomas", "tomas-directory-pass");
        expect(refused.status).toBe(403);
        expect(((await refused.json()) as { message: string }).message).toMatch(/already exists/);
      });
    });

    describe("protection", () => {
      it("sends the security headers with every response, pages and errors alike", async () => {
        for (const res of [
          await app.request("/api/health"),
          await app.request("/api/no-such-thing"),
          await app.request("/api/me"),
        ]) {
          const csp = res.headers.get("content-security-policy") ?? "";
          expect(csp).toContain("default-src 'self'");
          expect(csp).toContain("script-src 'self'");
          expect(csp).not.toContain("unsafe-eval");
          expect(csp).toContain("frame-ancestors 'none'");
          expect(res.headers.get("x-frame-options")).toBe("DENY");
          expect(res.headers.get("x-content-type-options")).toBe("nosniff");
          expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin");
          expect(res.headers.get("permissions-policy")).toContain("camera=()");
          // Not over plain HTTP, where it would lock browsers out of the instance.
          expect(res.headers.get("strict-transport-security")).toBeNull();
        }
      });

      it("refuses bodies past the limit, outside the upload chunks", async () => {
        const huge = JSON.stringify({ name: "x".repeat(MAX_BODY_BYTES + 10) });
        const res = await app.request("/api/setup", {
          method: "POST",
          headers: { "content-type": "application/json", "content-length": String(huge.length) },
          body: huge,
        });
        expect(res.status).toBe(413);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe("too_large");
      });

      it("limits guest links and codes per address, in the database every replica shares", async () => {
        const open = (address: string) =>
          app.request("/api/guest/sessions", {
            ...json({ token: "x".repeat(32) }),
            headers: {
              "content-type": "application/json",
              "x-forwarded-for": address,
            },
          });
        for (let i = 0; i < 30; i++) expect((await open("198.51.100.7")).status).toBe(410);
        const refused = await open("198.51.100.7");
        expect(refused.status).toBe(429);
        expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
        // Someone else is not held back by them.
        expect((await open("198.51.100.8")).status).toBe(410);
        const [row] = await db
          .select()
          .from(schema.requestLimits)
          .where(eq(schema.requestLimits.key, "guest:198.51.100.7"));
        expect(row?.count).toBe(31);
      });

      it("counts each window afresh, and counts at once under a burst", async () => {
        const rule = { max: 3, windowMs: 60_000 };
        const at = new Date("2026-10-16T12:00:00Z");
        const burst = await Promise.all(
          Array.from({ length: 6 }, () => admit(db, "test:burst", rule, at)),
        );
        expect(burst.filter((r) => r.allowed)).toHaveLength(3);
        const later = new Date(at.getTime() + 61_000);
        expect((await admit(db, "test:burst", rule, later)).allowed).toBe(true);
      });
    });

    describe("second factor", () => {
      /** The code an authenticator app shows for this setup link, now (RFC 6238). */
      const codeFor = (uri: string, at = Date.now()) => {
        const secret = new URL(uri).searchParams.get("secret") ?? "";
        const bits = [...secret.replace(/=+$/, "").toUpperCase()]
          .map((ch) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(ch).toString(2).padStart(5, "0"))
          .join("");
        const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => Number.parseInt(b, 2)));
        const counter = Buffer.alloc(8);
        counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
        const mac = createHmac("sha1", key).update(counter).digest();
        const offset = (mac.at(-1) ?? 0) & 15;
        return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
      };
      const wrong = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, "0");
      type Me = {
        secondFactor: {
          enabled: boolean;
          passkeys: number;
          required: boolean;
          securityKey: boolean;
          met: boolean;
          recoveryCodesLeft: number;
        };
      };
      const me = async (cookie: string) =>
        (await (await app.request("/api/me", { headers: { cookie } })).json()) as Me;
      /** Add a code app to the account, as the account page does. */
      const enrol = async (cookie: string, password: string) => {
        const enabled = await app.request(
          "/api/auth/two-factor/enable",
          json({ password }, cookie),
        );
        expect(enabled.status).toBe(200);
        const body = (await enabled.json()) as { totpURI: string; backupCodes: string[] };
        const verified = await app.request(
          "/api/auth/two-factor/verify-totp",
          json({ code: codeFor(body.totpURI) }, cookie),
        );
        expect(verified.status).toBe(200);
        // The session is renewed once the factor is on.
        return { ...body, cookie: cookieOf(verified) };
      };
      const signIn = (password: string, email = owner.email, cookie?: string) =>
        app.request("/api/auth/sign-in/email", json({ email, password }, cookie));

      it("adds a code app, asks for it at sign-in, and takes each recovery code once", async () => {
        const first = cookieOf(await setup());
        expect((await me(first)).secondFactor).toEqual({
          enabled: false,
          passkeys: 0,
          required: false,
          securityKey: false,
          met: true,
          recoveryCodesLeft: 0,
        });
        // The password is asked again before anything changes.
        expect(
          (
            await app.request(
              "/api/auth/two-factor/enable",
              json({ password: "wrong password here" }, first),
            )
          ).status,
        ).toBe(400);
        const started = await app.request(
          "/api/auth/two-factor/enable",
          json({ password: owner.password }, first),
        );
        const { totpURI, backupCodes } = (await started.json()) as {
          totpURI: string;
          backupCodes: string[];
        };
        expect(totpURI).toMatch(/^otpauth:\/\/totp\/Hekate:/);
        expect(backupCodes).toHaveLength(10);
        // A wrong first code leaves the factor off.
        const missed = await app.request(
          "/api/auth/two-factor/verify-totp",
          json({ code: wrong(codeFor(totpURI)) }, first),
        );
        expect(missed.status).toBe(401);
        expect((await me(first)).secondFactor.enabled).toBe(false);
        const verified = await app.request(
          "/api/auth/two-factor/verify-totp",
          json({ code: codeFor(totpURI) }, first),
        );
        expect(verified.status).toBe(200);
        const cookie = cookieOf(verified);
        expect((await me(cookie)).secondFactor).toEqual({
          enabled: true,
          passkeys: 0,
          required: false,
          securityKey: false,
          met: true,
          recoveryCodesLeft: 10,
        });
        // The recovery codes are stored only as hashes.
        const [row] = await db.select().from(schema.twoFactors);
        for (const code of backupCodes) expect(row?.backupCodes).not.toContain(code);

        // Signing in now stops at the second factor: no session until a code is given.
        const halfway = await signIn(owner.password);
        expect(halfway.status).toBe(200);
        expect(await halfway.json()).toMatchObject({ twoFactorRedirect: true });
        const pending = cookieOf(halfway);
        expect((await app.request("/api/me", { headers: { cookie: pending } })).status).toBe(401);
        expect(
          (
            await app.request(
              "/api/auth/two-factor/verify-totp",
              json({ code: wrong(codeFor(totpURI)) }, pending),
            )
          ).status,
        ).toBe(401);
        // A recovery code works however it is typed, and only once.
        const code = backupCodes[0] ?? "";
        const recovered = await app.request(
          "/api/auth/two-factor/verify-backup-code",
          json({ code: ` ${code.replace("-", "").toUpperCase()} ` }, pending),
        );
        expect(recovered.status).toBe(200);
        expect((await me(cookieOf(recovered))).secondFactor.recoveryCodesLeft).toBe(9);
        const again = cookieOf(await signIn(owner.password));
        const reused = await app.request(
          "/api/auth/two-factor/verify-backup-code",
          json({ code }, again),
        );
        expect(reused.status).toBe(401);

        // A trusted browser skips the code for 30 days.
        const trusted = await app.request(
          "/api/auth/two-factor/verify-totp",
          json({ code: codeFor(totpURI), trustDevice: true }, again),
        );
        expect(trusted.status).toBe(200);
        const remembered = trusted.headers
          .getSetCookie()
          .map((c) => c.split(";")[0])
          .filter((c) => c?.startsWith("hekate.trust_device="))
          .join("; ");
        expect(remembered).not.toBe("");
        const skipped = await signIn(owner.password, owner.email, remembered);
        expect(await skipped.json()).not.toHaveProperty("twoFactorRedirect");
        expect(cookieOf(skipped)).toContain("hekate.session_token=");

        // New recovery codes replace the old; adding, and the new codes, are in the access log.
        const fresh = await app.request(
          "/api/auth/two-factor/generate-backup-codes",
          json({ password: owner.password }, cookieOf(skipped)),
        );
        expect(fresh.status).toBe(200);
        const actions = (
          await db.select({ action: schema.accessEvents.action }).from(schema.accessEvents)
        ).map((e) => e.action);
        expect(actions).toContain("account.second_factor_added");
        expect(actions).toContain("account.recovery_codes");
      });

      it("asks owners and admins for a passkey session where the workspace says so", async () => {
        const first = cookieOf(await setup());
        const [user] = await db.select().from(schema.users);
        const keyFor = (n: number) => ({
          id: `key-${n}`,
          userId: user?.id ?? "",
          name: `Key ${n}`,
          publicKey: "not a real key",
          credentialID: `credential-${n}`,
          counter: 0,
          deviceType: "singleDevice",
          backedUp: false,
        });
        const ask = (body: Record<string, unknown>) =>
          app.request("/api/organisation/settings", {
            ...json(body, first),
            method: "PATCH",
          });
        // Asking for a key starts with having one.
        expect((await ask({ securityKeyForAdmins: true })).status).toBe(422);
        await db.insert(schema.passkeys).values(keyFor(1));
        expect((await ask({ securityKeyForAdmins: true })).status).toBe(200);

        // A password session falls short: everything but who they are is refused.
        const standing = await me(first);
        expect(standing.secondFactor).toMatchObject({
          passkeys: 1,
          required: true,
          securityKey: true,
          met: false,
        });
        const refused = await app.request("/api/projects", { headers: { cookie: first } });
        expect(refused.status).toBe(403);
        expect(((await refused.json()) as { error: { message: string } }).error.message).toMatch(
          /passkey or hardware security key/,
        );
        // A session signed in with a passkey meets it.
        await db
          .update(schema.authSessions)
          .set({ factor: "passkey" })
          .where(eq(schema.authSessions.userId, user?.id ?? ""));
        expect((await app.request("/api/projects", { headers: { cookie: first } })).status).toBe(
          200,
        );

        // Up to five keys: the sixth is refused before the browser is asked.
        await db.insert(schema.passkeys).values([2, 3, 4, 5].map(keyFor));
        const sixth = await app.request("/api/auth/passkey/generate-register-options", {
          headers: { cookie: first, origin: "http://localhost:3000" },
        });
        expect(sixth.status).toBe(403);
        expect(((await sixth.json()) as { message: string }).message).toMatch(/5 keys/);
        // Options fetched before the fifth key was added are no way round it.
        const saved = await app.request("/api/auth/passkey/verify-registration", {
          ...json({ response: {} }, first),
          headers: {
            cookie: first,
            origin: "http://localhost:3000",
            "content-type": "application/json",
          },
        });
        expect(saved.status).toBe(403);
        expect(((await saved.json()) as { message: string }).message).toMatch(/5 keys/);
      });

      it("holds back a member without one where the workspace asks for it", async () => {
        const first = cookieOf(await setup());
        // Asking it of others starts with having it.
        const ask = (cookie: string) =>
          app.request("/api/organisation/settings", {
            ...json({ secondFactor: "everyone" }, cookie),
            method: "PATCH",
          });
        expect((await ask(first)).status).toBe(422);
        const { cookie: ownerCookie } = await enrol(first, owner.password);
        expect((await ask(ownerCookie)).status).toBe(200);

        const { body } = await invite(ownerCookie, "player@example.test");
        const joined = await app.request(
          `/api/invitations/${tokenFrom(body.link)}/accept`,
          json({ name: "Player", password: "correct horse battery" }),
        );
        const member = cookieOf(joined);
        // Everything is refused, with a code the web app acts on.
        const refused = await app.request("/api/projects", { headers: { cookie: member } });
        expect(refused.status).toBe(403);
        expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
          "second_factor_required",
        );
        // Who they are still answers, so they can be sent to add one.
        expect((await me(member)).secondFactor).toEqual({
          enabled: false,
          passkeys: 0,
          required: true,
          securityKey: false,
          met: false,
          recoveryCodesLeft: 0,
        });
        const { cookie: enrolled } = await enrol(member, "correct horse battery");
        expect((await app.request("/api/projects", { headers: { cookie: enrolled } })).status).toBe(
          200,
        );
        // Removing it, with the password, holds them back again, and is logged.
        const removed = await app.request(
          "/api/auth/two-factor/disable",
          json({ password: "correct horse battery" }, enrolled),
        );
        expect(removed.status).toBe(200);
        expect(
          (await app.request("/api/projects", { headers: { cookie: cookieOf(removed) } })).status,
        ).toBe(403);
        const removals = await db
          .select()
          .from(schema.accessEvents)
          .where(eq(schema.accessEvents.action, "account.second_factor_removed"));
        expect(removals).toHaveLength(1);
      });
    });

    describe("storage", () => {
      const joinAs = async (owner: string, email: string, role: string) => {
        const { body } = await invite(owner, email, role);
        const res = await app.request(
          `/api/invitations/${tokenFrom(body.link)}/accept`,
          json({ name: "Colleague", password: "correct horse battery" }),
        );
        expect(res.status).toBe(201);
        return cookieOf(res);
      };
      const organisationOf = async (cookie: string) => {
        const me = (await (await app.request("/api/me", { headers: { cookie } })).json()) as {
          activeOrganisationId: string;
        };
        return me.activeOrganisationId;
      };
      const sha256 = (data: Buffer) =>
        import("node:crypto").then(({ createHash }) =>
          createHash("sha256").update(data).digest("hex"),
        );

      it("verifies that a database, its storage and the master key belong together", async () => {
        const owner = cookieOf(await setup());
        const organisationId = await organisationOf(owner);
        const kept = await storage.put(organisationId, Buffer.from("the final master"));
        await storage.put(organisationId, Buffer.from("the alternate take"));
        const clean = await verifyBackup({ db, storage, keyring }, { sample: 5 });
        expect(clean).toMatchObject({
          ok: true,
          keys: { checked: 1, failed: [] },
          objects: { checked: 2, missing: [] },
          sample: { checked: 2, failed: [] },
        });
        expect(describeReport(clean)).toContain("belong together");

        // With another master key, no workspace key opens and no file decrypts.
        const stranger = createKeyring(db, { current: Buffer.alloc(32, 9), previous: [] });
        const wrongKey = await verifyBackup(
          { db, storage: createStorage(db, backends, stranger), keyring: stranger },
          { sample: 5 },
        );
        expect(wrongKey.ok).toBe(false);
        expect(wrongKey.keys.failed).toHaveLength(1);
        expect(wrongKey.sample.failed).toHaveLength(2);

        // A file the storage lost is named.
        await backends.get(kept.backend).delete(kept.key);
        const lost = await verifyBackup({ db, storage, keyring }, { sample: 0 });
        expect(lost.ok).toBe(false);
        expect(lost.objects.missing).toEqual([`${kept.backend}:${kept.key}`]);
        expect(describeReport(lost)).toContain("does not restore cleanly");
      });

      it("stores, reads and removes blobs within an organisation", async () => {
        const owner = cookieOf(await setup());
        const organisationId = await organisationOf(owner);
        const data = Buffer.from("a mix of the slow movement, take 4");
        const blob = await storage.put(organisationId, data, { contentType: "audio/wav" });
        expect(blob).toMatchObject({
          organisationId,
          backend: "local",
          key: `org/${organisationId}/${blob.id}`,
          byteSize: data.length,
          sha256: await sha256(data),
          contentType: "audio/wav",
        });
        const { stream } = await storage.open(organisationId, blob.id, { start: 2, end: 4 });
        expect((await buffer(stream)).toString()).toBe("mix");

        await storage.remove(organisationId, blob.id);
        await expect(storage.open(organisationId, blob.id)).rejects.toThrow(/not found/);
        expect(await backends.get("local").head(blob.key)).toBeNull();
      });

      it("never opens or removes another organisation's blob", async () => {
        const owner = cookieOf(await setup());
        const organisationId = await organisationOf(owner);
        const [other] = await db
          .insert(schema.organisations)
          .values({ name: "Elsewhere", slug: "elsewhere-storage" })
          .returning();
        const foreign = await storage.put(other?.id ?? "", Buffer.from("not yours"));
        await expect(storage.open(organisationId, foreign.id)).rejects.toThrow(/not found/);
        await expect(storage.remove(organisationId, foreign.id)).rejects.toThrow(/not found/);
        expect(await backends.get("local").head(foreign.key)).toEqual({ size: encryptedSize(9) });
      });

      it("keeps a blob that a file still uses", async () => {
        const owner = cookieOf(await setup());
        const organisationId = await organisationOf(owner);
        const blob = await storage.put(organisationId, Buffer.from("score.pdf"));
        const [project] = await db
          .insert(schema.projects)
          .values({ organisationId, name: "Rags", profile: "music" })
          .returning();
        await db.insert(schema.files).values({
          organisationId,
          projectId: project?.id ?? "",
          name: "score.pdf",
          kind: "document",
          blobId: blob.id,
          contentType: "application/pdf",
          byteSize: 9,
        });
        await expect(storage.remove(organisationId, blob.id)).rejects.toThrow();
        expect(await backends.get("local").head(blob.key)).toEqual({ size: encryptedSize(9) });
      });

      it("shows a workspace's storage by backend and project, and reconciles it alone", async () => {
        const owner = cookieOf(await setup());
        const organisationId = await organisationOf(owner);
        const [project] = await db
          .insert(schema.projects)
          .values({ organisationId, name: "Joplin Rags", profile: "music" })
          .returning();
        const used = await storage.put(organisationId, Buffer.alloc(3000, 1));
        await storage.put(organisationId, Buffer.alloc(500, 2));
        await db.insert(schema.files).values({
          organisationId,
          projectId: project?.id ?? "",
          name: "maple-leaf.wav",
          kind: "audio",
          blobId: used.id,
          contentType: "audio/wav",
          byteSize: 3000,
        });
        type Usage = {
          backends: { name: string; bytes: number; objects: number }[];
          projects: { name: string; bytes: number }[];
          bytes: number;
          reconciliation: { removing: boolean; lastRun: unknown; missing: number };
        };
        const usage = (await (
          await app.request("/api/organisation/storage/usage", { headers: { cookie: owner } })
        ).json()) as Usage;
        expect(usage.backends).toEqual([{ name: "local", bytes: 3500, objects: 2 }]);
        expect(usage.projects).toEqual([{ id: project?.id, name: "Joplin Rags", bytes: 3000 }]);
        expect(usage.bytes).toBe(3500);
        expect(usage.reconciliation).toMatchObject({ removing: true, lastRun: null, missing: 0 });

        // A member sees none of it.
        const member = await joinAs(owner, "member@example.test", "member");
        expect(
          (await app.request("/api/organisation/storage/usage", { headers: { cookie: member } }))
            .status,
        ).toBe(403);

        // A run over this workspace is recorded, finds the lost file, and is rationed.
        await backends.get(used.backend).delete(used.key);
        const run = () => app.request("/api/organisation/storage/reconcile", json({}, owner));
        const ran = (await (await run()).json()) as Usage;
        expect(ran.reconciliation.lastRun).not.toBeNull();
        expect(ran.reconciliation.missing).toBe(1);
        expect((await run()).status).toBe(200);
        expect((await run()).status).toBe(200);
        expect((await run()).status).toBe(429);
      });

      it("lets owners choose the backend for new objects", async () => {
        const owner = cookieOf(await setup());
        const organisationId = await organisationOf(owner);
        const before = await storage.put(organisationId, Buffer.from("first"));

        const current = await app.request("/api/organisation/storage", {
          headers: { cookie: owner },
        });
        expect(await current.json()).toEqual({
          backend: null,
          defaultBackend: "local",
          available: ["local", "spare"],
        });
        const put = (backend: string | null, cookie: string) =>
          app.request("/api/organisation/storage", { ...json({ backend }, cookie), method: "PUT" });

        expect((await put("tape", owner)).status).toBe(400);
        expect((await put("Not Valid", owner)).status).toBe(400);
        expect((await put("spare", owner)).status).toBe(200);
        const after = await storage.put(organisationId, Buffer.from("second"));
        expect(after.backend).toBe("spare");
        // Existing objects stay readable where they are.
        expect(
          (await buffer((await storage.open(organisationId, before.id)).stream)).toString(),
        ).toBe("first");

        const admin = await joinAs(owner, "engineer@example.test", "admin");
        expect(
          (await app.request("/api/organisation/storage", { headers: { cookie: admin } })).status,
        ).toBe(200);
        expect((await put(null, admin)).status).toBe(403);
        const member = await joinAs(owner, "player@example.test", "member");
        expect(
          (await app.request("/api/organisation/storage", { headers: { cookie: member } })).status,
        ).toBe(403);

        expect((await put(null, owner)).status).toBe(200);
        expect((await storage.put(organisationId, Buffer.from("third"))).backend).toBe("local");
      });

      it("lets owners choose a project's backend for its new files, over the workspace's (#240)", async () => {
        const owner = cookieOf(await setup());
        const organisationId = await organisationOf(owner);
        const made = await app.request(
          "/api/projects",
          json({ name: "Opening titles", profile: "video" }, owner),
        );
        const projectId = ((await made.json()) as { project: { id: string } }).project.id;
        const path = `/api/projects/${projectId}/storage`;
        const put = (backend: string | null, cookie: string, url = path) =>
          app.request(url, { ...json({ backend }, cookie), method: "PUT" });
        const before = await storage.put(organisationId, Buffer.from("first"), { projectId });

        expect(await (await app.request(path, { headers: { cookie: owner } })).json()).toEqual({
          backend: null,
          workspaceBackend: "local",
          available: ["local", "spare"],
          bytes: 0,
        });
        expect((await put("tape", owner)).status).toBe(400);
        expect((await put("spare", owner)).status).toBe(200);
        // The project's files go to its own backend; the workspace's others stay on the default.
        expect((await storage.put(organisationId, Buffer.from("x"), { projectId })).backend).toBe(
          "spare",
        );
        expect((await storage.put(organisationId, Buffer.from("y"))).backend).toBe("local");
        const session = await storage.beginUpload(organisationId, 5, "audio/wav", projectId);
        expect(session.backend).toBe("spare");
        await storage.abortUpload(session);
        // Existing objects stay readable where they are.
        expect(
          (await buffer((await storage.open(organisationId, before.id)).stream)).toString(),
        ).toBe("first");

        // Admins see it; only owners choose; members see nothing.
        const admin = await joinAs(owner, "engineer@example.test", "admin");
        expect((await app.request(path, { headers: { cookie: admin } })).status).toBe(200);
        expect((await put(null, admin)).status).toBe(403);
        const member = await joinAs(owner, "player@example.test", "member");
        expect((await app.request(path, { headers: { cookie: member } })).status).toBe(403);

        // Another workspace's project cannot be found.
        const [elsewhere] = await db
          .insert(schema.organisations)
          .values({ name: "Elsewhere", slug: "elsewhere-storage" })
          .returning();
        const [foreign] = await db
          .insert(schema.projects)
          .values({ organisationId: elsewhere?.id ?? "", name: "Theirs", profile: "music" })
          .returning();
        expect((await put("spare", owner, `/api/projects/${foreign?.id}/storage`)).status).toBe(
          404,
        );

        expect((await put(null, owner)).status).toBe(200);
        expect((await storage.put(organisationId, Buffer.from("z"), { projectId })).backend).toBe(
          "local",
        );
        // An archived project is read-only: its storage too.
        expect(
          (await app.request(`/api/projects/${projectId}/archive`, json({}, owner))).status,
        ).toBe(204);
        expect((await put("spare", owner)).status).toBe(409);
      });

      it("lets only owners rename the workspace", async () => {
        const owner = cookieOf(await setup());
        const rename = (name: string, cookie: string) =>
          app.request("/api/organisation", { ...json({ name }, cookie), method: "PATCH" });
        const nameOf = async (cookie: string) => {
          const me = (await (await app.request("/api/me", { headers: { cookie } })).json()) as {
            activeOrganisationId: string;
            organisations: { id: string; name: string }[];
          };
          return me.organisations.find((o) => o.id === me.activeOrganisationId)?.name;
        };

        expect((await rename("   ", owner)).status).toBe(400);
        expect((await rename("Endless Hall Recordings", owner)).status).toBe(200);
        expect(await nameOf(owner)).toBe("Endless Hall Recordings");
        // The access log says who renamed it, from what.
        const logged = (await (
          await app.request("/api/organisation/audit?action=organisation.rename", {
            headers: { cookie: owner },
          })
        ).json()) as { events: { actorLabel: string; details: unknown }[] };
        expect(logged.events).toHaveLength(1);
        expect(logged.events[0]?.details).toEqual({
          from: "Studio",
          to: "Endless Hall Recordings",
        });

        const admin = await joinAs(owner, "engineer@example.test", "admin");
        expect((await rename("Taken over", admin)).status).toBe(403);
        const member = await joinAs(owner, "player@example.test", "member");
        expect((await rename("Taken over", member)).status).toBe(403);
        expect(await nameOf(owner)).toBe("Endless Hall Recordings");
      });

      it("lets every member read the workspace settings and only admins change them", async () => {
        const owner = cookieOf(await setup());
        type Settings = {
          settings: { guestLinkDays: number; locale: string | null; reviewer: { decide: boolean } };
        };
        const read = async (cookie: string) => {
          const res = await app.request("/api/organisation/settings", { headers: { cookie } });
          return { status: res.status, body: (await res.json()) as Settings };
        };
        const change = (body: Record<string, unknown>, cookie: string) =>
          app.request("/api/organisation/settings", { ...json(body, cookie), method: "PATCH" });

        expect((await read(owner)).body.settings).toEqual({
          defaultProfile: "music",
          guestLinkDays: 3,
          guestVerification: "link",
          locale: null,
          carriedCommentsShown: true,
          deliveryProfile: null,
          emailSubjects: {},
          secondFactor: "off",
          securityKeyForAdmins: false,
          roleTools: {
            Producer: ["qa", "meters", "spectrogram", "score", "compare", "loops", "normalise"],
            Engineer: ["qa", "meters", "spectrogram", "score", "compare", "loops", "normalise"],
            Editor: ["qa", "meters", "spectrogram", "score", "compare", "loops", "normalise"],
            Reviewer: ["score", "compare", "loops", "normalise"],
            Viewer: ["score"],
          },
          reviewer: {
            comment: true,
            decide: true,
            comments: "all",
            history: false,
            download: "none",
            windowDays: null,
          },
        });
        expect((await change({ guestLinkDays: 7 }, owner)).status).toBe(400);
        expect((await change({ storageBackend: "spare" }, owner)).status).toBe(400);
        expect((await change({}, owner)).status).toBe(400);

        const admin = await joinAs(owner, "engineer@example.test", "admin");
        expect((await change({ locale: "de-DE" }, admin)).status).toBe(200);
        // A second change keeps the first.
        expect((await change({ reviewer: { decide: false } }, owner)).status).toBe(200);
        const member = await joinAs(owner, "player@example.test", "member");
        expect((await change({ guestLinkDays: 30 }, member)).status).toBe(403);
        const seen = await read(member);
        expect(seen.status).toBe(200);
        expect(seen.body.settings).toMatchObject({
          guestLinkDays: 3,
          locale: "de-DE",
          reviewer: { decide: false },
        });
        // Members without a language of their own get the workspace's.
        const me = (await (
          await app.request("/api/me", { headers: { cookie: member } })
        ).json()) as {
          organisations: { locale: string | null }[];
        };
        expect(me.organisations[0]?.locale).toBe("de-DE");

        // Each change is in the access log.
        const logged = (await (
          await app.request("/api/organisation/audit?action=organisation.settings", {
            headers: { cookie: owner },
          })
        ).json()) as { events: { details: unknown }[] };
        expect(logged.events.map((e) => e.details)).toEqual([
          { change: { reviewer: { decide: false } } },
          { change: { locale: "de-DE" } },
        ]);

        // A new project starts with the workspace's carry-over default.
        expect((await change({ carriedCommentsShown: false }, owner)).status).toBe(200);
        const made = await app.request(
          "/api/projects",
          json({ name: "Opening titles", profile: "video" }, owner),
        );
        const { project } = (await made.json()) as { project: { id: string } };
        const [row] = await db
          .select({ shown: schema.projects.carriedCommentsShown })
          .from(schema.projects)
          .where(eq(schema.projects.id, project.id));
        expect(row?.shown).toBe(false);

        // And its default roles with the workspace's tools (#55).
        expect(
          (await change({ roleTools: { Viewer: ["score", "loops"], Editor: [] } }, owner)).status,
        ).toBe(200);
        const tooled = (await (
          await app.request("/api/projects", json({ name: "Joplin Rags", profile: "music" }, owner))
        ).json()) as { project: { id: string } };
        const roles = await db
          .select({ name: schema.projectRoles.name, tools: schema.projectRoles.tools })
          .from(schema.projectRoles)
          .where(eq(schema.projectRoles.projectId, tooled.project.id));
        const toolsOf = (name: string) => roles.find((r) => r.name === name)?.tools;
        expect(toolsOf("Viewer")).toEqual(["score", "loops"]);
        expect(toolsOf("Editor")).toEqual([]);
        expect(toolsOf("Reviewer")).toEqual(["score", "compare", "loops", "normalise"]);
        // The project made before keeps what it started with.
        const [before] = await db
          .select({ tools: schema.projectRoles.tools })
          .from(schema.projectRoles)
          .where(
            and(
              eq(schema.projectRoles.projectId, project.id),
              eq(schema.projectRoles.name, "Viewer"),
            ),
          );
        expect(before?.tools).toEqual(["score"]);

        // Another workspace keeps its own.
        const [other] = await db
          .insert(schema.organisations)
          .values({ name: "Elsewhere", slug: "elsewhere-settings" })
          .returning({ settings: schema.organisations.settings });
        expect(other?.settings).toEqual({});
      });

      it("previews each message with the workspace's subject lines, and sends a test", async () => {
        const owner = cookieOf(await setup());
        const change = (body: Record<string, unknown>, cookie: string) =>
          app.request("/api/organisation/settings", { ...json(body, cookie), method: "PATCH" });
        // Only the template's own placeholders.
        expect(
          (await change({ emailSubjects: { invitation: "Join {review}" } }, owner)).status,
        ).toBe(400);
        expect(
          (
            await change(
              { emailSubjects: { invitation: "{inviter} asks you into {workspace}" } },
              owner,
            )
          ).status,
        ).toBe(200);
        const preview = async (path: string, cookie: string) =>
          app.request(`/api/organisation/email/${path}`, { headers: { cookie } });
        const light = (await (await preview("invitation", owner)).json()) as {
          subject: string;
          text: string;
          html: string;
        };
        expect(light.subject).toBe("Ines Arlow asks you into Studio");
        expect(light.text).toContain("Accept the invitation:");
        const dark = (await (await preview("invitation?scheme=dark", owner)).json()) as {
          html: string;
        };
        expect(dark.html).toContain("#0e0e10");
        expect((await preview("nonsense", owner)).status).toBe(400);
        // Back to the default.
        expect((await change({ emailSubjects: { invitation: null } }, owner)).status).toBe(200);
        expect(
          ((await (await preview("invitation", owner)).json()) as { subject: string }).subject,
        ).toBe("Join Studio on Hekate");

        mailer.sent.length = 0;
        const test = await app.request(
          "/api/organisation/email/test",
          json({ template: "decision" }, owner),
        );
        expect(test.status).toBe(200);
        expect(mailer.sent).toHaveLength(1);
        expect(mailer.sent[0]?.subject).toBe("Test: Album masters: changes requested");
        expect(mailer.sent[0]?.html).toContain("See the review");

        const member = await joinAs(owner, "player@example.test", "member");
        expect((await preview("invitation", member)).status).toBe(403);
        expect(
          (
            await app.request(
              "/api/organisation/email/test",
              json({ template: "decision" }, member),
            )
          ).status,
        ).toBe(403);
      });

      it("keeps the blob record when removing its bytes fails, so removal can be retried", async () => {
        const owner = cookieOf(await setup());
        const organisationId = await organisationOf(owner);
        const local = backends.get("local");
        let failDeletes = true;
        const flaky = createStorage(
          db,
          {
            ...backends,
            get: (name: string) =>
              name === "local"
                ? {
                    ...local,
                    delete: async (key: string) => {
                      if (failDeletes) throw new Error("storage unavailable");
                      await local.delete(key);
                    },
                  }
                : backends.get(name),
          },
          keyring,
        );
        const blob = await flaky.put(organisationId, Buffer.from("retry me"));
        await expect(flaky.remove(organisationId, blob.id)).rejects.toThrow("storage unavailable");
        expect((await flaky.open(organisationId, blob.id)).blob.id).toBe(blob.id);

        failDeletes = false;
        await flaky.remove(organisationId, blob.id);
        await expect(flaky.open(organisationId, blob.id)).rejects.toThrow(/not found/);
        expect(await local.head(blob.key)).toBeNull();
      });

      it("stores only ciphertext, and reads plaintext ranges back", async () => {
        const owner = cookieOf(await setup());
        const organisationId = await organisationOf(owner);
        const secret = Buffer.from("the unreleased master, bar 72, take 3 ".repeat(5000));
        const blob = await storage.put(organisationId, secret, { contentType: "audio/wav" });
        expect(blob.byteSize).toBe(secret.length);

        const stored = await buffer(await backends.get("local").get(blob.key));
        expect(stored.length).toBeGreaterThan(secret.length);
        expect(stored.includes(Buffer.from("unreleased master"))).toBe(false);
        expect(blob.wrappedKey).not.toContain(stored.subarray(0, 32).toString("base64"));

        const whole = await buffer((await storage.open(organisationId, blob.id)).stream);
        expect(whole.equals(secret)).toBe(true);
        const start = 100_000;
        const part = await buffer(
          (await storage.open(organisationId, blob.id, { start, end: start + 37 })).stream,
        );
        expect(part.toString()).toBe(secret.subarray(start, start + 38).toString());
      });

      it("refuses ciphertext moved from another blob", async () => {
        const owner = cookieOf(await setup());
        const organisationId = await organisationOf(owner);
        const a = await storage.put(organisationId, Buffer.from("version one"));
        const b = await storage.put(organisationId, Buffer.from("version two"));
        // Replace a's stored bytes with b's, as someone with access to storage might.
        const local = backends.get("local");
        await local.put(a.key, await buffer(await local.get(b.key)));
        await expect(buffer((await storage.open(organisationId, a.id)).stream)).rejects.toThrow(
          /failed authentication/,
        );
      });

      it("keeps every file readable across a master key rotation", async () => {
        const owner = cookieOf(await setup());
        const organisationId = await organisationOf(owner);
        const before = await storage.put(organisationId, Buffer.from("recorded before rotation"));

        const newMaster = Buffer.alloc(32, 9);
        // Without the old key the new instance must refuse to start rather than fail on reads.
        await expect(
          createKeyring(db, { current: newMaster, previous: [] }).reconcile(),
        ).rejects.toThrow(/MASTER_KEYS_PREVIOUS/);

        const rotated = createKeyring(db, { current: newMaster, previous: [masterKey] });
        expect(await rotated.reconcile()).toEqual({ rewrapped: 1 });
        expect(await rotated.reconcile()).toEqual({ rewrapped: 0 });

        // The old master key is no longer needed: files and blob rows are untouched.
        const afterRotation = createStorage(
          db,
          backends,
          createKeyring(db, { current: newMaster, previous: [] }),
        );
        const read = await buffer((await afterRotation.open(organisationId, before.id)).stream);
        expect(read.toString()).toBe("recorded before rotation");
        const [row] = await db.select().from(schema.blobs).where(sql`id = ${before.id}`);
        expect(row?.wrappedKey).toBe(before.wrappedKey);
      });

      it("refuses to start with a corrupted organisation key", async () => {
        const owner = cookieOf(await setup());
        const organisationId = await organisationOf(owner);
        await storage.put(organisationId, Buffer.from("x"));
        const [row] = await db.select().from(schema.organisationKeys);
        const bytes = Buffer.from(row?.wrappedKey ?? "", "base64");
        bytes[20] = (bytes[20] ?? 0) ^ 1;
        await db
          .update(schema.organisationKeys)
          .set({ wrappedKey: bytes.toString("base64") })
          .where(sql`id = ${row?.id}`);
        await expect(
          createKeyring(db, { current: masterKey, previous: [] }).reconcile(),
        ).rejects.toThrow(/corrupt/);
      });

      it("gives each organisation its own key", async () => {
        const owner = cookieOf(await setup());
        const organisationId = await organisationOf(owner);
        const [other] = await db
          .insert(schema.organisations)
          .values({ name: "Elsewhere", slug: "elsewhere-keys" })
          .returning();
        const ours = await keyring.current(organisationId);
        const theirs = await keyring.current(other?.id ?? "");
        expect(ours.key.equals(theirs.key)).toBe(false);
        // Created once, then reused.
        expect((await keyring.current(organisationId)).key.equals(ours.key)).toBe(true);
        const rows = await db.select().from(schema.organisationKeys);
        expect(rows).toHaveLength(2);
      });

      it("refuses to write when the chosen backend is no longer configured", async () => {
        const owner = cookieOf(await setup());
        const organisationId = await organisationOf(owner);
        await db
          .update(schema.organisations)
          .set({ storageBackend: "retired" })
          .where(sql`id = ${organisationId}`);
        await expect(storage.put(organisationId, Buffer.from("x"))).rejects.toThrow(
          /not configured/,
        );
      });
    });

    describe("access log", () => {
      const joinAs = async (owner: string, email: string, role: string) => {
        const { body } = await invite(owner, email, role);
        const res = await app.request(
          `/api/invitations/${tokenFrom(body.link)}/accept`,
          json({ name: "Colleague", password: "correct horse battery" }),
        );
        return cookieOf(res);
      };
      const organisationOf = async (cookie: string) =>
        (
          (await (await app.request("/api/me", { headers: { cookie } })).json()) as {
            activeOrganisationId: string;
          }
        ).activeOrganisationId;
      const get = (path: string, cookie: string, headers: Record<string, string> = {}) =>
        app.request(path, { headers: { cookie, ...headers } });

      it("is append-only, except for an explicit purge", async () => {
        const owner = cookieOf(await setup());
        const organisationId = await organisationOf(owner);
        const event = await audit.record(
          organisationId,
          { type: "system", label: "Hekate" },
          { action: "download" },
        );
        await expect(
          db
            .update(schema.accessEvents)
            .set({ actorLabel: "someone else" })
            .where(sql`id = ${event.id}`),
        ).rejects.toThrow();
        await expect(db.delete(schema.accessEvents).where(sql`id = ${event.id}`)).rejects.toThrow();
        await expect(db.execute(sql`truncate ${schema.accessEvents}`)).rejects.toThrow();
        await withAuditPurge(db, (tx) =>
          tx.delete(schema.accessEvents).where(sql`id = ${event.id}`),
        );
        expect(await db.select().from(schema.accessEvents)).toHaveLength(0);
      });

      it("filters and pages newest first, within the organisation", async () => {
        const owner = cookieOf(await setup());
        const organisationId = await organisationOf(owner);
        const me = await audit.member((await db.select().from(schema.users))[0]?.id ?? "");
        expect(me.label).toBe("Producer <producer@example.test>");
        const fileA = "01999999-0000-7000-8000-00000000000a";
        const fileB = "01999999-0000-7000-8000-00000000000b";
        for (let i = 0; i < 5; i++) {
          await audit.record(organisationId, me, {
            action: "stream.key",
            fileId: i < 3 ? fileA : fileB,
            details: { i },
          });
        }
        await audit.record(organisationId, me, { action: "download", fileId: fileA });
        const [other] = await db
          .insert(schema.organisations)
          .values({ name: "Elsewhere", slug: "elsewhere-audit" })
          .returning();
        await audit.record(
          other?.id ?? "",
          { type: "system", label: "Hekate" },
          { action: "download", fileId: fileA },
        );

        type Page = {
          events: { action: string; fileId: string; details: { i: number } | null }[];
          nextBefore: string | null;
        };
        const all = (await (await get("/api/organisation/audit", owner)).json()) as Page;
        expect(all.events).toHaveLength(6);
        expect(all.events[0]?.action).toBe("download");
        expect(all.nextBefore).toBeNull();

        const first = (await (
          await get("/api/organisation/audit?action=stream.key&limit=2", owner)
        ).json()) as Page;
        expect(first.events.map((e) => e.details?.i)).toEqual([4, 3]);
        const second = (await (
          await get(
            `/api/organisation/audit?action=stream.key&limit=2&before=${first.nextBefore}`,
            owner,
          )
        ).json()) as Page;
        expect(second.events.map((e) => e.details?.i)).toEqual([2, 1]);

        const forFile = (await (
          await get(`/api/organisation/audit?fileId=${fileA}`, owner)
        ).json()) as Page;
        expect(forFile.events).toHaveLength(4);
        expect((await get("/api/organisation/audit?action=nonsense", owner)).status).toBe(400);
      });

      it("names the file each entry touched, and nothing for one it cannot find", async () => {
        const owner = cookieOf(await setup());
        const organisationId = await organisationOf(owner);
        const me = await audit.member((await db.select().from(schema.users))[0]?.id ?? "");
        const [project] = await db
          .insert(schema.projects)
          .values({ organisationId, name: "Rags", profile: "music" })
          .returning();
        const blob = await storage.put(organisationId, Buffer.from("not really audio"));
        const [file] = await db
          .insert(schema.files)
          .values({
            organisationId,
            projectId: project?.id ?? "",
            name: "Mix v3.wav",
            kind: "audio",
            blobId: blob.id,
            contentType: "audio/wav",
            byteSize: blob.byteSize,
          })
          .returning();
        await audit.record(organisationId, me, {
          action: "download",
          fileId: "01999999-0000-7000-8000-00000000000a",
        });
        await audit.record(organisationId, me, { action: "download", fileId: file?.id ?? "" });
        const page = (await (await get("/api/organisation/audit", owner)).json()) as {
          events: { fileName: string | null; reviewTitle: string | null }[];
        };
        expect(page.events.map((e) => e.fileName)).toEqual(["Mix v3.wav", null]);
        expect(page.events.every((e) => e.reviewTitle === null)).toBe(true);
      });

      it("is for admins and owners only", async () => {
        const owner = cookieOf(await setup());
        const admin = await joinAs(owner, "engineer@example.test", "admin");
        const member = await joinAs(owner, "player@example.test", "member");
        expect((await get("/api/organisation/audit", admin)).status).toBe(200);
        expect((await get("/api/organisation/audit", member)).status).toBe(403);
        expect((await get("/api/organisation/audit.csv", member)).status).toBe(403);
      });

      it("exports CSV safely, and records the export with the client's address", async () => {
        const owner = cookieOf(await setup());
        const organisationId = await organisationOf(owner);
        await audit.record(
          organisationId,
          { type: "guest", label: '=HYPERLINK("http://evil.test","click")' },
          { action: "page.render" },
          { ipAddress: "2001:db8::7", userAgent: 'Mozilla "quoted"' },
        );
        const res = await get("/api/organisation/audit.csv", owner, {
          "x-forwarded-for": "198.51.100.23",
          "user-agent": "Hekate test",
        });
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/csv");
        expect(res.headers.get("content-disposition")).toMatch(
          /attachment; filename="hekate-access-log-/,
        );
        const lines = (await res.text()).trim().split("\r\n");
        expect(lines[0]).toBe(
          "occurred_at,action,actor_type,actor,user_id,guest_id,project_id,file_id,review_id,ip_address,user_agent,details",
        );
        // The export itself is the newest row, then the guest's page render.
        expect(lines[1]).toContain('"audit.export"');
        expect(lines[1]).toContain('"198.51.100.23"');
        expect(lines[1]).toContain('"Hekate test"');
        expect(lines[2]).toContain(`"'=HYPERLINK(""http://evil.test"",""click"")"`);
        expect(lines[2]).toContain('"2001:db8::7"');
        expect(lines[2]).toContain('"Mozilla ""quoted"""');
      });

      it("never trusts a client's claimed address without a proxy", async () => {
        const owner = cookieOf(await setup());
        const organisationId = await organisationOf(owner);
        const direct = createApp({
          db,
          auth,
          mailer,
          storage,
          audit,
          jobs,
          keyring,
          playbackSecret: playbackSecret("test-secret-test-secret-test-secret-0"),
          publicUrl: "http://localhost:3000",
          log: false,
        });
        await direct.request("/api/organisation/audit.csv", {
          headers: { cookie: owner, "x-forwarded-for": "203.0.113.9" },
        });
        const { events } = await audit.query(organisationId, { limit: 1 });
        expect(events[0]?.action).toBe("audit.export");
        expect(events[0]?.ipAddress).not.toBe("203.0.113.9");
      });

      it("neutralises spreadsheet formulas in any cell", () => {
        expect(csvCell("+1")).toBe(`"'+1"`);
        expect(csvCell("-sum")).toBe(`"'-sum"`);
        expect(csvCell("@cmd")).toBe(`"'@cmd"`);
        expect(csvCell("plain")).toBe('"plain"');
        expect(csvCell(null)).toBe('""');
      });
    });

    describe("uploads", () => {
      const joinAs = async (owner: string, email: string, role: string) => {
        const { body } = await invite(owner, email, role);
        const res = await app.request(
          `/api/invitations/${tokenFrom(body.link)}/accept`,
          json({ name: "Colleague", password: "correct horse battery" }),
        );
        return cookieOf(res);
      };
      const newProject = async (cookie: string) => {
        const res = await app.request(
          "/api/projects",
          json({ name: "Rags", profile: "music" }, cookie),
        );
        return ((await res.json()) as { project: { id: string } }).project.id;
      };
      type UploadView = {
        id: string;
        chunkSize: number;
        chunkCount: number;
        receivedChunks: number[];
        status: string;
      };
      const create = async (cookie: string, body: Record<string, unknown>) => {
        const res = await app.request("/api/uploads", json(body, cookie));
        return {
          res,
          upload:
            res.status === 201 ? ((await res.json()) as { upload: UploadView }).upload : undefined,
        };
      };
      const putChunk = (
        cookie: string,
        id: string,
        index: number,
        bytes: Uint8Array,
        digest?: string,
      ) =>
        app.request(`/api/uploads/${id}/chunks/${index}`, {
          method: "PUT",
          headers: {
            cookie,
            origin: "http://localhost:3000",
            "content-type": "application/octet-stream",
            ...(digest ? { "content-digest": `sha-256=:${digest}:` } : {}),
          },
          body: new Uint8Array(bytes),
        });
      const complete = (cookie: string, id: string) =>
        app.request(`/api/uploads/${id}/complete`, json({}, cookie));
      const sha = (bytes: Uint8Array) =>
        import("node:crypto").then(({ createHash }) =>
          createHash("sha256").update(bytes).digest("base64"),
        );

      it("uploads in chunks, out of order, and becomes an encrypted file", async () => {
        sent.length = 0;
        const owner = cookieOf(await setup());
        const projectId = await newProject(owner);
        const content = Buffer.alloc(CHUNK_SIZE + 4321);
        for (let i = 0; i < content.length; i += 4096) content.write("unreleased mix bar 72 ", i);
        const { upload } = await create(owner, {
          projectId,
          name: "C:\\Sessions\\Take 4.wav",
          size: content.length,
          contentType: "audio/wav",
        });
        expect(upload).toMatchObject({
          chunkSize: CHUNK_SIZE,
          chunkCount: 2,
          receivedChunks: [],
          status: "open",
        });
        const id = upload?.id ?? "";
        const second = content.subarray(CHUNK_SIZE);
        const first = content.subarray(0, CHUNK_SIZE);
        expect((await putChunk(owner, id, 1, second, await sha(second))).status).toBe(204);
        // A chunk sent twice (a retry) simply replaces the first copy.
        expect((await putChunk(owner, id, 0, first)).status).toBe(204);
        expect((await putChunk(owner, id, 0, first, await sha(first))).status).toBe(204);
        const status = (await (
          await app.request(`/api/uploads/${id}`, { headers: { cookie: owner } })
        ).json()) as {
          upload: UploadView;
        };
        expect(status.upload.receivedChunks).toEqual([0, 1]);

        const done = await complete(owner, id);
        expect(done.status).toBe(201);
        const { file } = (await done.json()) as {
          file: { id: string; name: string; kind: string; blobId: string; byteSize: number };
        };
        expect(file).toMatchObject({ name: "Take 4.wav", kind: "audio", byteSize: content.length });

        const [blob] = await db.select().from(schema.blobs).where(sql`id = ${file.blobId}`);
        expect(blob?.sha256).toBeNull();
        const stored = await buffer(
          await backends.get(blob?.backend ?? "local").get(blob?.key ?? ""),
        );
        expect(stored.length).toBe(encryptedSize(content.length));
        expect(stored.includes(Buffer.from("unreleased mix"))).toBe(false);
        const organisationId = blob?.organisationId ?? "";
        const read = await buffer((await storage.open(organisationId, file.blobId)).stream);
        expect(read.equals(content)).toBe(true);

        expect(sent.map((j) => j.name).sort()).toEqual(["blob-checksum", "media-probe"]);
        const events = await audit.query(organisationId, { action: "file.upload", limit: 5 });
        expect(events.events[0]).toMatchObject({ fileId: file.id, projectId });

        // The checksum job fills in the hash by reading the file back through decryption.
        const controller = new AbortController();
        await checksumHandler({ db, storage, keyring, jobs })(
          { organisationId, blobId: file.blobId },
          { id: "job", signal: controller.signal, retryCount: 0 },
        );
        const [hashed] = await db.select().from(schema.blobs).where(sql`id = ${file.blobId}`);
        expect(hashed?.sha256).toBe(
          (await import("node:crypto")).createHash("sha256").update(content).digest("hex"),
        );

        // Completing again (a retry after a lost response) returns the same file.
        const again = await complete(owner, id);
        expect(again.status).toBe(200);
        expect(((await again.json()) as { file: { id: string } }).file.id).toBe(file.id);

        const listed = (await (
          await app.request(`/api/projects/${projectId}/files`, { headers: { cookie: owner } })
        ).json()) as {
          files: { id: string; name: string; uploadedBy: string }[];
        };
        expect(listed.files).toEqual([
          expect.objectContaining({ id: file.id, name: "Take 4.wav", uploadedBy: "Producer" }),
        ]);
      }, 60_000);

      it("checks every chunk and refuses to complete with chunks missing", async () => {
        const owner = cookieOf(await setup());
        const projectId = await newProject(owner);
        const { upload } = await create(owner, {
          projectId,
          name: "score.pdf",
          size: CHUNK_SIZE + 10,
        });
        const id = upload?.id ?? "";
        expect((await putChunk(owner, id, 1, Buffer.alloc(9))).status).toBe(400);
        expect((await putChunk(owner, id, 2, Buffer.alloc(10))).status).toBe(400);
        expect(
          (await putChunk(owner, id, 1, Buffer.alloc(10), await sha(Buffer.alloc(10, 1)))).status,
        ).toBe(400);
        expect((await putChunk(owner, id, 1, Buffer.alloc(10))).status).toBe(204);
        const incomplete = await complete(owner, id);
        expect(incomplete.status).toBe(409);
        expect(
          ((await incomplete.json()) as { error: { message: string } }).error.message,
        ).toContain("0");
        // The failed completion left it open to carry on.
        expect((await putChunk(owner, id, 0, Buffer.alloc(CHUNK_SIZE))).status).toBe(204);
        expect((await complete(owner, id)).status).toBe(201);
      }, 60_000);

      it("keeps uploads to their organisation, project and owner", async () => {
        const owner = cookieOf(await setup());
        const projectId = await newProject(owner);
        const [other] = await db
          .insert(schema.organisations)
          .values({ name: "Elsewhere", slug: "elsewhere-up" })
          .returning();
        const [foreign] = await db
          .insert(schema.projects)
          .values({ organisationId: other?.id ?? "", name: "Not yours", profile: "video" })
          .returning();
        expect(
          (await create(owner, { projectId: foreign?.id, name: "x.wav", size: 1 })).res.status,
        ).toBe(404);
        const [otherFolder] = await db
          .insert(schema.folders)
          .values({ organisationId: other?.id ?? "", projectId: foreign?.id ?? "", name: "Stems" })
          .returning();
        expect(
          (await create(owner, { projectId, folderId: otherFolder?.id, name: "x.wav", size: 1 }))
            .res.status,
        ).toBe(404);
        expect(
          (await create(owner, { projectId, name: "huge.wav", size: 10_001 * CHUNK_SIZE })).res
            .status,
        ).toBe(400);

        const { upload } = await create(owner, { projectId, name: "mine.wav", size: 3 });
        const colleague = await joinAs(owner, "engineer@example.test", "admin");
        expect((await putChunk(colleague, upload?.id ?? "", 0, Buffer.from("abc"))).status).toBe(
          404,
        );
        expect((await complete(colleague, upload?.id ?? "")).status).toBe(404);
      });

      it("discards cancelled and expired uploads", async () => {
        const owner = cookieOf(await setup());
        const projectId = await newProject(owner);
        const cancelled =
          (await create(owner, { projectId, name: "a.wav", size: 3 })).upload?.id ?? "";
        await putChunk(owner, cancelled, 0, Buffer.from("abc"));
        const del = await app.request(`/api/uploads/${cancelled}`, {
          method: "DELETE",
          headers: { cookie: owner, origin: "http://localhost:3000" },
        });
        expect(del.status).toBe(204);
        expect((await putChunk(owner, cancelled, 0, Buffer.from("abc"))).status).toBe(409);

        const stale = (await create(owner, { projectId, name: "b.wav", size: 3 })).upload?.id ?? "";
        await db
          .update(schema.uploads)
          .set({ expiresAt: new Date(Date.now() - 1000) })
          .where(sql`id = ${stale}`);
        expect((await putChunk(owner, stale, 0, Buffer.from("abc"))).status).toBe(409);
        expect(await expireUploads(db, storage)).toBe(1);
        const [row] = await db.select().from(schema.uploads).where(sql`id = ${stale}`);
        expect(row?.status).toBe("aborted");
        expect(await expireUploads(db, storage)).toBe(0);
      });

      it("catches up on work lost after the file was created", async () => {
        sent.length = 0;
        const owner = cookieOf(await setup());
        const projectId = await newProject(owner);
        const { upload } = await create(owner, { projectId, name: "Take 7.wav", size: 3 });
        const id = upload?.id ?? "";
        await putChunk(owner, id, 0, Buffer.from("abc"));
        failNextSend = true;
        expect((await complete(owner, id)).status).toBe(500);
        // The retry finds the upload completed and replays what was missed, once.
        const retry = await complete(owner, id);
        expect(retry.status).toBe(200);
        const { file } = (await retry.json()) as { file: { id: string } };
        expect(sent.map((j) => j.name).sort()).toEqual(["blob-checksum", "media-probe"]);
        await complete(owner, id);
        const [row] = await db.select().from(schema.files).where(sql`id = ${file.id}`);
        const logged = await audit.query(row?.organisationId ?? "", {
          action: "file.upload",
          limit: 10,
        });
        expect(logged.events.filter((e) => e.fileId === file.id)).toHaveLength(1);
      });

      it("lets a stale completion claim be retaken, but not a fresh one", async () => {
        const owner = cookieOf(await setup());
        const projectId = await newProject(owner);
        const { upload } = await create(owner, { projectId, name: "Take 8.wav", size: 3 });
        const id = upload?.id ?? "";
        await putChunk(owner, id, 0, Buffer.from("abc"));
        await db.update(schema.uploads).set({ status: "completing" }).where(sql`id = ${id}`);
        expect((await complete(owner, id)).status).toBe(409);
        await db
          .update(schema.uploads)
          .set({ status: "completing", updatedAt: new Date(Date.now() - 20 * 60_000) })
          .where(sql`id = ${id}`);
        expect((await complete(owner, id)).status).toBe(201);
      });

      it("keeps an upload open when its stored parts cannot be discarded yet", async () => {
        const owner = cookieOf(await setup());
        const projectId = await newProject(owner);
        const id = (await create(owner, { projectId, name: "c.wav", size: 3 })).upload?.id ?? "";
        await db
          .update(schema.uploads)
          .set({ expiresAt: new Date(Date.now() - 1000) })
          .where(sql`id = ${id}`);
        const unavailable = {
          ...storage,
          abortUpload: async () => {
            throw new Error("storage unavailable");
          },
        };
        expect(await expireUploads(db, unavailable)).toBe(0);
        const [still] = await db.select().from(schema.uploads).where(sql`id = ${id}`);
        expect(still?.status).toBe("open");
        expect(await expireUploads(db, storage)).toBe(1);
      });

      it("uploads an empty file", async () => {
        const owner = cookieOf(await setup());
        const projectId = await newProject(owner);
        const { upload } = await create(owner, { projectId, name: "empty.txt", size: 0 });
        expect(upload?.chunkCount).toBe(1);
        expect((await putChunk(owner, upload?.id ?? "", 0, new Uint8Array())).status).toBe(204);
        const done = await complete(owner, upload?.id ?? "");
        expect(done.status).toBe(201);
        expect(((await done.json()) as { file: { kind: string } }).file.kind).toBe("document");
      });
    });

    describe("tracks", () => {
      type TrackView = {
        id: string;
        name: string;
        position: number;
        scoreFileId: string | null;
        versions: {
          id: string;
          number: number;
          variations: {
            id: string;
            fileId: string;
            name: string;
            isPrimary: boolean;
            subtitled?: boolean | null;
          }[];
        }[];
      };
      const joinAs = async (owner: string, email: string, role: string) => {
        const { body } = await invite(owner, email, role);
        const res = await app.request(
          `/api/invitations/${tokenFrom(body.link)}/accept`,
          json({ name: "Colleague", password: "correct horse battery" }),
        );
        return cookieOf(res);
      };
      const organisationOf = async (cookie: string) =>
        (
          (await (await app.request("/api/me", { headers: { cookie } })).json()) as {
            activeOrganisationId: string;
          }
        ).activeOrganisationId;
      const newProject = async (organisationId: string, name = "Rags") => {
        const [project] = await db
          .insert(schema.projects)
          .values({ organisationId, name, profile: "music" })
          .returning();
        return project?.id ?? "";
      };
      const addFile = async (organisationId: string, projectId: string, name: string) => {
        const blob = await storage.put(organisationId, Buffer.from(name));
        const [file] = await db
          .insert(schema.files)
          .values({
            organisationId,
            projectId,
            name,
            kind: name.endsWith(".pdf") ? "document" : "audio",
            blobId: blob.id,
            contentType: "application/octet-stream",
            byteSize: blob.byteSize,
          })
          .returning();
        return file?.id ?? "";
      };
      const send = (method: string, path: string, body: unknown, cookie: string) =>
        app.request(path, { ...json(body, cookie), method });
      const trackFrom = async (res: Response) => ((await res.json()) as { track: TrackView }).track;

      it("carries the score marks and takes to their bars when the score is swapped (#52)", async () => {
        const owner = cookieOf(await setup());
        const organisationId = await organisationOf(owner);
        const projectId = await newProject(organisationId);
        const [first = "", second = "", third = ""] = await Promise.all(
          ["Score 1899.pdf", "Score 1903.pdf", "Score scan.pdf"].map((n) =>
            addFile(organisationId, projectId, n),
          ),
        );
        const bars = (page: number, y: number, bar: number) => ({ page, x: 0.05, y, bar });
        // The first edition prints four bars a system, the second six; the scan prints none.
        await db
          .update(schema.files)
          .set({
            printedBars: [bars(1, 0.3, 5), bars(1, 0.55, 9), bars(2, 0.1, 17), bars(2, 0.35, 21)],
          })
          .where(eq(schema.files.id, first));
        await db
          .update(schema.files)
          .set({
            printedBars: [bars(1, 0.2, 7), bars(1, 0.45, 13), bars(1, 0.7, 19), bars(2, 0.1, 25)],
          })
          .where(eq(schema.files.id, second));
        const track = await trackFrom(
          await app.request(
            `/api/projects/${projectId}/tracks`,
            json({ name: "Maple Leaf Rag", scoreFileId: first }, owner),
          ),
        );
        const mark = (values: Partial<typeof schema.scoreMarks.$inferInsert>) =>
          db
            .insert(schema.scoreMarks)
            .values({
              organisationId,
              trackId: track.id,
              kind: "note",
              page: 1,
              x: 0.5,
              y: 0.5,
              text: "Breath",
              ...values,
            })
            .returning()
            .then(([m]) => m?.id ?? "");
        const atBar = await mark({ page: 2, y: 0.4, barFrom: 21 });
        const ink = await mark({
          kind: "ink",
          text: null,
          page: 2,
          y: 0.4,
          barFrom: 21,
          points: [
            [0.2, 0.4],
            [0.3, 0.45],
          ],
        });
        // A stroke that would cross the foot of the page moves up as one, keeping its shape.
        const low = await mark({
          kind: "ink",
          text: null,
          page: 1,
          y: 0.3,
          barFrom: 9,
          points: [
            [0.2, 0.3],
            [0.3, 0.9],
          ],
        });
        const noBar = await mark({ page: 2, y: 0.8 });
        await db
          .insert(schema.takes)
          .values({ organisationId, trackId: track.id, number: 1, page: 2, barFrom: 21 });
        // A take over two pages of the first edition, bars 9 to 21, all on page 1 of the second.
        const [spanning] = await db
          .insert(schema.takes)
          .values({
            organisationId,
            trackId: track.id,
            number: 2,
            page: 1,
            pageTo: 2,
            barFrom: 9,
            barTo: 21,
          })
          .returning();

        const swap = async (scoreFileId: string) => {
          const res = await send("PATCH", `/api/tracks/${track.id}`, { scoreFileId }, owner);
          expect(res.status).toBe(200);
          return ((await res.json()) as { rehomed?: unknown }).rehomed;
        };
        expect(await swap(second)).toEqual({ marks: 3, takes: 2, stayed: 1 });
        const where = async (id: string) => {
          const [m] = await db.select().from(schema.scoreMarks).where(eq(schema.scoreMarks.id, id));
          return m;
        };
        // Bar 21 is on page 1 of the second edition, in the system from bar 19.
        expect(await where(atBar)).toMatchObject({ page: 1, y: 0.75 });
        const moved = await where(ink);
        expect(moved?.page).toBe(1);
        expect(moved?.points?.[1]?.[1]).toBeCloseTo(0.8, 9);
        expect(await where(noBar)).toMatchObject({ page: 2, y: 0.8 });
        const lowered = await where(low);
        const [[, top] = [0, 0], [, foot] = [0, 0]] = lowered?.points ?? [];
        expect(foot - top).toBeCloseTo(0.6, 9);
        expect(foot).toBeLessThanOrEqual(1);
        const takeOf = async (id: string) => {
          const [t] = await db.select().from(schema.takes).where(eq(schema.takes.id, id));
          return t;
        };
        const historyOf = (id: string) =>
          db.select().from(schema.takeChanges).where(eq(schema.takeChanges.takeId, id));
        const [take] = await db
          .select()
          .from(schema.takes)
          .where(eq(schema.takes.trackId, track.id))
          .orderBy(schema.takes.number);
        expect(take?.page).toBe(1);
        // In the take's history, as the owner's change.
        const [change] = await historyOf(take?.id ?? "");
        expect(change).toMatchObject({ field: "page", before: 2, after: 1 });
        expect(change?.changedById).toBeTruthy();
        // Both ends of a take over two pages follow their bars, the last never before the first.
        expect(await takeOf(spanning?.id ?? "")).toMatchObject({ page: 1, pageTo: 1 });
        expect(
          (await historyOf(spanning?.id ?? "")).map((h) => [h.field, h.before, h.after]),
        ).toEqual([["pageTo", 2, 1]]);

        // A score still being drawn: the marks wait for its bars, then follow them.
        const fresh = await addFile(organisationId, projectId, "Score 1910.pdf");
        await db
          .update(schema.files)
          .set({ streamStatus: "pending" })
          .where(eq(schema.files.id, fresh));
        expect(await swap(fresh)).toEqual({ marks: 0, takes: 0, stayed: 0, waiting: true });
        await db
          .update(schema.files)
          .set({
            streamStatus: "ready",
            printedBars: [bars(1, 0.3, 5), bars(1, 0.55, 9), bars(2, 0.1, 17), bars(2, 0.35, 21)],
          })
          .where(eq(schema.files.id, fresh));
        await rehomePending(db, organisationId, fresh);
        // From the second edition, where the marks were, to bar 21 on page 2 of this one.
        expect(await where(atBar)).toMatchObject({ page: 2 });
        // Back to the second: they follow again, and nothing is left waiting.
        expect(await swap(second)).toMatchObject({ marks: 3 });

        // A scan prints no bars: everything stays where it was, and nothing is said to move.
        expect(await swap(third)).toEqual({ marks: 0, takes: 0, stayed: 4 });
        expect(await where(atBar)).toMatchObject({ page: 1, y: 0.75 });
        // Linking the score again, or unlinking it, moves nothing.
        expect(await swap(third)).toBeUndefined();
      });

      it("builds a track from numbered versions, each with one primary variation", async () => {
        const owner = cookieOf(await setup());
        const organisationId = await organisationOf(owner);
        const projectId = await newProject(organisationId);
        const [dry, wet, v2, wet2, score] = await Promise.all(
          ["Dry v1.wav", "Wet v1.wav", "Dry v2.wav", "Wet v2.wav", "Score.pdf"].map((n) =>
            addFile(organisationId, projectId, n),
          ),
        );

        const created = await app.request(
          `/api/projects/${projectId}/tracks`,
          json({ name: "Maple Leaf Rag", scoreFileId: score }, owner),
        );
        expect(created.status).toBe(201);
        const track = await trackFrom(created);
        expect(track).toMatchObject({ name: "Maple Leaf Rag", position: 0, scoreFileId: score });
        const second = await trackFrom(
          await app.request(
            `/api/projects/${projectId}/tracks`,
            json({ name: "The Entertainer" }, owner),
          ),
        );
        expect(second.position).toBe(1);

        const first = await app.request(
          `/api/tracks/${track.id}/versions`,
          json(
            {
              notes: "First edit",
              variations: [
                { fileId: dry, name: "Dry" },
                { fileId: wet, name: "Wet" },
              ],
            },
            owner,
          ),
        );
        expect(first.status).toBe(201);
        const afterFirst = await trackFrom(first);
        expect(afterFirst.versions[0]?.number).toBe(1);
        expect(afterFirst.versions[0]?.variations.map((v) => [v.name, v.isPrimary])).toEqual([
          ["Dry", true],
          ["Wet", false],
        ]);

        const next = await trackFrom(
          await app.request(
            `/api/tracks/${track.id}/versions`,
            json({ variations: [{ fileId: v2, name: "Dry" }] }, owner),
          ),
        );
        const version2 = next.versions[1];
        expect(version2?.number).toBe(2);

        // A file is one variation only.
        expect(
          (
            await app.request(
              `/api/tracks/${track.id}/versions`,
              json({ variations: [{ fileId: dry, name: "Again" }] }, owner),
            )
          ).status,
        ).toBe(409);

        // A wet mix arrives for version 2 and becomes the primary; then the dry one is restored.
        const withWet = await trackFrom(
          await app.request(
            `/api/versions/${version2?.id}/variations`,
            json({ fileId: wet2, name: "Wet", primary: true }, owner),
          ),
        );
        const variations2 = withWet.versions[1]?.variations ?? [];
        expect(variations2.map((v) => [v.name, v.isPrimary])).toEqual([
          ["Dry", false],
          ["Wet", true],
        ]);
        const restored = await trackFrom(
          await app.request(`/api/variations/${variations2[0]?.id}/primary`, json({}, owner)),
        );
        expect(restored.versions[1]?.variations.map((v) => v.isPrimary)).toEqual([true, false]);

        // A variation is renamed; in a music project it has no treatment to say (#16).
        const variationPath = `/api/variations/${variations2[1]?.id}`;
        expect((await send("PATCH", variationPath, { subtitled: true }, owner)).status).toBe(422);
        // In a video project it is a rendition, and says it; unsaid stays null.
        const asVideo = (profile: "music" | "video") =>
          db.update(schema.projects).set({ profile }).where(eq(schema.projects.id, projectId));
        await asVideo("video");
        const treated = await trackFrom(
          await send("PATCH", variationPath, { name: "Wet, subtitled", subtitled: true }, owner),
        );
        expect(treated.versions[1]?.variations[1]).toMatchObject({
          name: "Wet, subtitled",
          subtitled: true,
          graded: null,
          video: null,
        });
        // Its name back, its treatment kept.
        const named = await trackFrom(
          await send("PATCH", `/api/variations/${variations2[1]?.id}`, { name: "Wet" }, owner),
        );
        expect(named.versions[1]?.variations[1]).toMatchObject({ name: "Wet", subtitled: true });
        expect(
          (await send("PATCH", `/api/variations/${variations2[1]?.id}`, {}, owner)).status,
        ).toBe(400);
        // Only those who organise the project change it.
        const reviewer = await joinAs(owner, "variation-reviewer@example.test", "member");
        await grantRole(owner, projectId, reviewer, "Reviewer");
        expect(
          (await send("PATCH", `/api/variations/${variations2[1]?.id}`, { graded: true }, reviewer))
            .status,
        ).toBe(403);
        await asVideo("music");

        const renamed = await trackFrom(
          await send(
            "PATCH",
            `/api/tracks/${track.id}`,
            { name: "Maple Leaf Rag (1899)", scoreFileId: null },
            owner,
          ),
        );
        expect(renamed).toMatchObject({ name: "Maple Leaf Rag (1899)", scoreFileId: null });

        const listed = (
          (await (
            await app.request(`/api/projects/${projectId}/tracks`, { headers: { cookie: owner } })
          ).json()) as { tracks: TrackView[] }
        ).tracks;
        // A variation's file knows where it sits.
        const detail = (
          (await (
            await app.request(`/api/files/${wet2}`, { headers: { cookie: owner } })
          ).json()) as {
            file: { variation: unknown };
          }
        ).file.variation;
        expect(detail).toMatchObject({
          name: "Wet",
          isPrimary: false,
          versionNumber: 2,
          trackId: track.id,
          trackName: "Maple Leaf Rag (1899)",
        });

        expect(listed.map((t) => [t.name, t.versions.length])).toEqual([
          ["Maple Leaf Rag (1899)", 2],
          ["The Entertainer", 0],
        ]);
      });

      it("numbers and orders what is added at the same moment", async () => {
        const owner = cookieOf(await setup());
        const organisationId = await organisationOf(owner);
        const projectId = await newProject(organisationId);
        const fileIds = await Promise.all(
          ["a.wav", "b.wav", "c.wav", "d.wav"].map((n) => addFile(organisationId, projectId, n)),
        );
        const track = await trackFrom(
          await app.request(`/api/projects/${projectId}/tracks`, json({ name: "Rag" }, owner)),
        );
        const results = await Promise.all(
          fileIds.map((fileId) =>
            app.request(
              `/api/tracks/${track.id}/versions`,
              json({ variations: [{ fileId, name: "Mix" }] }, owner),
            ),
          ),
        );
        expect(results.map((r) => r.status)).toEqual([201, 201, 201, 201]);
        const final = await trackFrom(
          await app.request(`/api/tracks/${track.id}`, { headers: { cookie: owner } }),
        );
        expect(final.versions.map((v) => v.number)).toEqual([1, 2, 3, 4]);

        // Variations added at once, each asking to be primary: distinct positions, one primary.
        const more = await Promise.all(
          ["e.wav", "f.wav", "g.wav"].map((n) => addFile(organisationId, projectId, n)),
        );
        const version = final.versions[0]?.id ?? "";
        const added = await Promise.all(
          more.map((fileId, i) =>
            app.request(
              `/api/versions/${version}/variations`,
              json({ fileId, name: `Mix ${i}`, primary: true }, owner),
            ),
          ),
        );
        expect(added.map((r) => r.status)).toEqual([201, 201, 201]);
        // And primaries switched at once still leave exactly one.
        const afterAdding = await trackFrom(
          await app.request(`/api/tracks/${track.id}`, { headers: { cookie: owner } }),
        );
        const variations = afterAdding.versions[0]?.variations ?? [];
        const switched = await Promise.all(
          variations.map((v) => app.request(`/api/variations/${v.id}/primary`, json({}, owner))),
        );
        expect(switched.every((r) => r.status === 200)).toBe(true);
        const settled = (
          await trackFrom(
            await app.request(`/api/tracks/${track.id}`, { headers: { cookie: owner } }),
          )
        ).versions[0]?.variations;
        expect(settled?.map((v) => (v as unknown as { position: number }).position)).toEqual([
          0, 1, 2, 3,
        ]);
        expect(settled?.filter((v) => v.isPrimary)).toHaveLength(1);

        // Tracks added at once take consecutive positions.
        await Promise.all(
          ["One", "Two", "Three"].map((name) =>
            app.request(`/api/projects/${projectId}/tracks`, json({ name }, owner)),
          ),
        );
        const listed = (
          (await (
            await app.request(`/api/projects/${projectId}/tracks`, { headers: { cookie: owner } })
          ).json()) as { tracks: TrackView[] }
        ).tracks;
        expect(listed.map((t) => t.position)).toEqual([0, 1, 2, 3]);
      });

      it("keeps tracks to their own project and organisation", async () => {
        const owner = cookieOf(await setup());
        const organisationId = await organisationOf(owner);
        const projectId = await newProject(organisationId);
        const otherProject = await newProject(organisationId, "Elsewhere");
        const stray = await addFile(organisationId, otherProject, "Stray.wav");
        const track = await trackFrom(
          await app.request(`/api/projects/${projectId}/tracks`, json({ name: "Rag" }, owner)),
        );
        // Files from another project are refused, as variations and as scores.
        expect(
          (
            await app.request(
              `/api/tracks/${track.id}/versions`,
              json({ variations: [{ fileId: stray, name: "Mix" }] }, owner),
            )
          ).status,
        ).toBe(422);
        expect(
          (await send("PATCH", `/api/tracks/${track.id}`, { scoreFileId: stray }, owner)).status,
        ).toBe(422);
        // A score is a PDF: a recording cannot be one.
        const mix = await addFile(organisationId, projectId, "Mix.wav");
        const notScore = await send(
          "PATCH",
          `/api/tracks/${track.id}`,
          { scoreFileId: mix },
          owner,
        );
        expect(notScore.status).toBe(422);
        expect(await notScore.text()).toMatch(/A score is a PDF/);

        const [other] = await db
          .insert(schema.organisations)
          .values({ name: "Elsewhere", slug: "elsewhere-tracks" })
          .returning();
        const foreignProject = await newProject(other?.id ?? "");
        const foreignFile = await addFile(other?.id ?? "", foreignProject, "Theirs.wav");
        const [foreignTrack] = await db
          .insert(schema.tracks)
          .values({ organisationId: other?.id ?? "", projectId: foreignProject, name: "Theirs" })
          .returning();
        const [foreignVersion] = await db
          .insert(schema.versions)
          .values({ organisationId: other?.id ?? "", trackId: foreignTrack?.id ?? "", number: 1 })
          .returning();
        const [foreignVariation] = await db
          .insert(schema.variations)
          .values({
            organisationId: other?.id ?? "",
            versionId: foreignVersion?.id ?? "",
            fileId: foreignFile,
            name: "Mix",
            isPrimary: true,
          })
          .returning();
        const headers = { cookie: owner };
        expect(
          (await app.request(`/api/projects/${foreignProject}/tracks`, { headers })).status,
        ).toBe(404);
        expect((await app.request(`/api/tracks/${foreignTrack?.id}`, { headers })).status).toBe(
          404,
        );
        expect(
          (await send("PATCH", `/api/tracks/${foreignTrack?.id}`, { name: "Mine" }, owner)).status,
        ).toBe(404);
        expect(
          (
            await app.request(
              `/api/versions/${foreignVersion?.id}/variations`,
              json({ fileId: foreignFile, name: "x" }, owner),
            )
          ).status,
        ).toBe(404);
        expect(
          (await app.request(`/api/variations/${foreignVariation?.id}/primary`, json({}, owner)))
            .status,
        ).toBe(404);
        expect(
          (await send("PATCH", `/api/variations/${foreignVariation?.id}`, { graded: true }, owner))
            .status,
        ).toBe(404);
        // Nor can another organisation's file become a variation here.
        expect(
          (
            await app.request(
              `/api/tracks/${track.id}/versions`,
              json({ variations: [{ fileId: foreignFile, name: "x" }] }, owner),
            )
          ).status,
        ).toBe(422);
      });
    });

    describe("project roles", () => {
      const joinAs = async (owner: string, email: string, role = "member") => {
        const { body } = await invite(owner, email, role);
        const res = await app.request(
          `/api/invitations/${tokenFrom(body.link)}/accept`,
          json({ name: email.split("@")[0], password: "correct horse battery" }),
        );
        expect(res.status).toBe(201);
        return cookieOf(res);
      };
      const send = (method: string, path: string, body: unknown, cookie: string) =>
        app.request(path, { ...json(body, cookie), method });
      const getAs = (path: string, cookie: string) => app.request(path, { headers: { cookie } });
      const organisationOf = async (cookie: string) =>
        ((await (await getAs("/api/me", cookie)).json()) as { activeOrganisationId: string })
          .activeOrganisationId;

      /** A project made through the API, with an audio file in it, as the owner. */
      const studio = async () => {
        const owner = cookieOf(await setup());
        const organisationId = await organisationOf(owner);
        const made = await app.request(
          "/api/projects",
          json({ name: "Rags", profile: "music" }, owner),
        );
        const { project } = (await made.json()) as { project: { id: string } };
        const blob = await storage.put(organisationId, Buffer.from("not really audio"));
        const [file] = await db
          .insert(schema.files)
          .values({
            organisationId,
            projectId: project.id,
            name: "Mix v1.wav",
            kind: "audio",
            blobId: blob.id,
            contentType: "audio/wav",
            byteSize: blob.byteSize,
            mediaInfo: {
              duration: 60,
              audio: { codec: "pcm_s24le", channels: 2, sampleRate: 48000 },
            },
          })
          .returning();
        return { owner, organisationId, projectId: project.id, fileId: file?.id ?? "" };
      };

      it("gives the QA report to take away, as PDF, CSV or JSON, stamped (#43)", async () => {
        const { owner, fileId } = await studio();
        const download = (format: string, cookie = owner) =>
          getAs(`/api/files/${fileId}/qa/report?format=${format}`, cookie);
        const csv = await download("csv");
        expect(csv.status).toBe(200);
        expect(csv.headers.get("content-type")).toBe("text/csv; charset=utf-8");
        expect(csv.headers.get("content-disposition")).toContain("QA report.csv");
        const rows = (await csv.text()).split("\r\n");
        expect(rows[0]).toMatch(/^severity,check,start_seconds,end_seconds,channel,summary,file,/);
        // Stamped on every row with the workspace and the project.
        expect(rows[1]).toContain(",Studio,Rags,");
        expect(rows.some((r) => r.startsWith("fail,format,"))).toBe(true);
        const report = (await (await download("json")).json()) as {
          workspace: string;
          requestedBy: { role: string | null };
          findings: unknown[];
        };
        // Their part in the project: whoever made it is its producer.
        expect(report.requestedBy.role).toBe("Producer");
        expect(report.findings.length).toBeGreaterThan(0);
        const pdf = await download("pdf");
        expect(pdf.headers.get("content-type")).toBe("application/pdf");
        expect(
          Buffer.from(await pdf.arrayBuffer())
            .subarray(0, 8)
            .toString("latin1"),
        ).toBe("%PDF-1.4");
        // Only the formats there are, and only for a file that can be seen.
        expect((await download("docx")).status).toBe(400);
        expect(
          (
            await getAs(
              "/api/files/0190a6f0-0000-7000-8000-0000000000ff/qa/report?format=csv",
              owner,
            )
          ).status,
        ).toBe(404);
        // A member outside the project, and the owner of another workspace, find nothing.
        const outsider = await joinAs(owner, "outsider-qa-report@example.test");
        expect((await download("csv", outsider)).status).toBe(404);
        const [other] = await db
          .insert(schema.organisations)
          .values({ name: "Saltmarsh Films", slug: "saltmarsh-qa-report" })
          .returning({ id: schema.organisations.id });
        const outsiderId = (
          (await (await getAs("/api/me", outsider)).json()) as { user: { id: string } }
        ).user.id;
        await db
          .insert(schema.members)
          .values({ organisationId: other?.id ?? "", userId: outsiderId, role: "owner" });
        expect(
          (
            await app.request("/api/me/organisation", {
              ...json({ organisationId: other?.id }, outsider),
              method: "PUT",
            })
          ).status,
        ).toBe(200);
        expect((await download("csv", outsider)).status).toBe(404);
      });

      it("applies the project's QA rules to its reports: switches, severities and its own rules", async () => {
        const { owner, projectId, fileId } = await studio();
        type Report = { findings: { check: string; severity: string; summary: string }[] };
        const report = async () =>
          ((await (await getAs(`/api/files/${fileId}/qa`, owner)).json()) as Report).findings;
        // A recording with no bit depth fails the format check of the profile it is suggested.
        expect((await report()).find((f) => f.check === "format")?.severity).toBe("fail");
        const rules = {
          delivery: true,
          checks: { format: { on: true, severity: "warn" } },
          rules: [
            {
              id: "0190a6f0-0000-7000-8000-0000000000aa",
              name: "Masters at 96 kHz",
              appliesTo: "audio",
              measure: "sampleRate",
              operator: "atLeast",
              value: "96",
              severity: "fail",
              on: true,
            },
          ],
        };
        const set = (body: unknown, cookie = owner) =>
          app.request(`/api/projects/${projectId}`, { ...json(body, cookie), method: "PATCH" });
        expect((await set({ qaSettings: rules })).status).toBe(200);
        const after = await report();
        expect(after.find((f) => f.check === "format")?.severity).toBe("warn");
        expect(after.find((f) => f.check === "custom")).toMatchObject({
          severity: "fail",
          summary: "Masters at 96 kHz: 48 kHz, not at least 96",
        });
        // A rule that cannot be measured as written is refused, as is a lesser role.
        const broken = { ...rules, rules: [{ ...rules.rules[0], value: "fast" }] };
        expect((await set({ qaSettings: broken })).status).toBe(400);
        const member = await joinAs(owner, "editor@example.test");
        await grantRole(owner, projectId, member, "Editor");
        expect((await set({ qaSettings: rules }, member)).status).toBe(403);
        // Another workspace's project is not found.
        const [elsewhere] = await db
          .insert(schema.organisations)
          .values({ name: "Elsewhere", slug: "elsewhere-qa-rules" })
          .returning();
        const [theirs] = await db
          .insert(schema.projects)
          .values({ organisationId: elsewhere?.id ?? "", name: "Theirs", profile: "music" })
          .returning();
        const theirRules = await app.request(`/api/projects/${theirs?.id}`, {
          ...json({ qaSettings: rules }, owner),
          method: "PATCH",
        });
        expect(theirRules.status).toBe(404);
        // The delivery checks switched off together.
        expect((await set({ qaSettings: { ...rules, delivery: false } })).status).toBe(200);
        expect((await report()).some((f) => f.check === "format")).toBe(false);
        expect((await set({ qaSettings: rules })).status).toBe(200);
        // A template carries its rules to the projects made from it.
        const copy = await app.request(
          "/api/projects",
          json({ name: "Second set", profile: "music", templateId: projectId }, owner),
        );
        const made = ((await copy.json()) as { project: { qaSettings: unknown } }).project;
        expect(made.qaSettings).toEqual(rules);
      });

      it("measures a file against the nearest profile: its own, its track's, the project's, the workspace's", async () => {
        const { owner, projectId, fileId } = await studio();
        const send = (method: string, url: string, body: unknown, cookie = owner) =>
          app.request(url, { ...json(body, cookie), method });
        type Chosen = { id: string; label: string; source: string; chosen: boolean };
        const profile = async () =>
          ((await (await getAs(`/api/files/${fileId}/qa`, owner)).json()) as { profile: Chosen })
            .profile;
        expect(await profile()).toMatchObject({ id: "streaming", source: "suggested" });

        // The workspace's own profile, made by an admin and read by every member.
        const vinyl = {
          label: "Vinyl cut",
          loudness: null,
          truePeakMax: -3,
          sampleRates: { rates: [96_000], atLeast: false },
          bitDepthMin: 24,
          channels: null,
        };
        const made = await app.request("/api/organisation/delivery-profiles", json(vinyl, owner));
        expect(made.status).toBe(201);
        const ref = `custom:${((await made.json()) as { profile: { id: string } }).profile.id}`;
        expect(
          (await app.request("/api/organisation/delivery-profiles", json(vinyl, owner))).status,
        ).toBe(409);
        const member = await joinAs(owner, "mixer@example.test");
        expect((await getAs("/api/organisation/delivery-profiles", member)).status).toBe(200);
        expect(
          (await app.request("/api/organisation/delivery-profiles", json(vinyl, member))).status,
        ).toBe(403);

        // Nearest first: the workspace, then the project, the track and the file itself.
        expect(
          (await send("PATCH", "/api/organisation/settings", { deliveryProfile: ref })).status,
        ).toBe(200);
        expect(await profile()).toMatchObject({ id: ref, label: "Vinyl cut", source: "workspace" });
        expect(
          (await send("PATCH", `/api/projects/${projectId}`, { deliveryProfile: "cd" })).status,
        ).toBe(200);
        expect(await profile()).toMatchObject({ id: "cd", source: "project" });
        const unknown = "custom:0190a6f0-0000-7000-8000-0000000000ff";
        expect(
          (
            await send("PATCH", `/api/projects/${projectId}`, {
              deliveryProfile: `custom:${"-".repeat(36)}`,
            })
          ).status,
        ).toBe(400);
        expect(
          (await send("PATCH", `/api/projects/${projectId}`, { deliveryProfile: unknown })).status,
        ).toBe(422);
        const track = await app.request(
          `/api/projects/${projectId}/tracks`,
          json({ name: "Maple Leaf Rag" }, owner),
        );
        const trackId = ((await track.json()) as { track: { id: string } }).track.id;
        await app.request(
          `/api/tracks/${trackId}/versions`,
          json({ variations: [{ fileId, name: "Mix" }] }, owner),
        );
        const onTrack = await send("PUT", `/api/tracks/${trackId}/delivery-profile`, {
          deliveryProfile: "broadcast",
        });
        expect(onTrack.status).toBe(200);
        expect(await profile()).toMatchObject({ id: "broadcast", source: "track" });
        expect(
          (await send("PUT", `/api/files/${fileId}/delivery-profile`, { deliveryProfile: ref }))
            .status,
        ).toBe(204);
        expect(await profile()).toMatchObject({ id: ref, source: "file" });

        // Choosing is for whoever edits the project's workflow.
        await grantRole(owner, projectId, member, "Engineer");
        expect(
          (
            await send(
              "PUT",
              `/api/files/${fileId}/delivery-profile`,
              { deliveryProfile: null },
              member,
            )
          ).status,
        ).toBe(403);

        // Another workspace's file and profile are not found, nor may its profile be chosen.
        const [elsewhere] = await db
          .insert(schema.organisations)
          .values({ name: "Elsewhere", slug: "elsewhere-profiles" })
          .returning();
        const [theirProfile] = await db
          .insert(schema.deliveryProfiles)
          .values({
            organisationId: elsewhere?.id ?? "",
            label: "Theirs",
            spec: { ...vinyl, bitDepthMin: 24 },
          })
          .returning();
        const theirs = await storage.put(elsewhere?.id ?? "", Buffer.from("theirs"));
        const [theirProject] = await db
          .insert(schema.projects)
          .values({ organisationId: elsewhere?.id ?? "", name: "Theirs", profile: "music" })
          .returning();
        const [theirFile] = await db
          .insert(schema.files)
          .values({
            organisationId: elsewhere?.id ?? "",
            projectId: theirProject?.id ?? "",
            name: "Theirs.wav",
            kind: "audio",
            blobId: theirs.id,
            contentType: "audio/wav",
            byteSize: theirs.byteSize,
          })
          .returning();
        expect((await getAs(`/api/files/${theirFile?.id}/qa`, owner)).status).toBe(404);
        expect(
          (
            await send("PUT", `/api/files/${theirFile?.id}/delivery-profile`, {
              deliveryProfile: "cd",
            })
          ).status,
        ).toBe(404);
        expect(
          (
            await send("PUT", `/api/files/${fileId}/delivery-profile`, {
              deliveryProfile: `custom:${theirProfile?.id}`,
            })
          ).status,
        ).toBe(422);
        expect(
          (await send("DELETE", `/api/organisation/delivery-profiles/${theirProfile?.id}`, {}))
            .status,
        ).toBe(404);

        // Removing the profile removes every choice of it: the track's applies again.
        expect(
          (await send("DELETE", `/api/organisation/delivery-profiles/${ref.slice(7)}`, {})).status,
        ).toBe(204);
        expect(await profile()).toMatchObject({ id: "broadcast", source: "track" });
        const settings = (await (await getAs("/api/organisation/settings", owner)).json()) as {
          settings: { deliveryProfile: string | null };
        };
        expect(settings.settings.deliveryProfile).toBeNull();
      });

      it("makes each download once, for its session, logged, and only as the role allows", async () => {
        const { owner, organisationId, projectId, fileId } = await studio();
        type Choices = {
          level: string;
          proxy: { available: boolean };
          original: { available: boolean };
        };
        const options = (await (
          await getAs(`/api/files/${fileId}/downloads`, owner)
        ).json()) as Choices;
        // An owner has every level; a recording without its stream yet offers the original.
        expect(options.level).toBe("original");
        expect(options.original.available).toBe(true);
        expect(options.proxy.available).toBe(false);
        expect(
          (await send("POST", `/api/files/${fileId}/downloads`, { kind: "proxy" }, owner)).status,
        ).toBe(422);

        const ask = async (cookie: string) => {
          const res = await send(
            "POST",
            `/api/files/${fileId}/downloads`,
            { kind: "original" },
            cookie,
          );
          expect(res.status).toBe(201);
          return ((await res.json()) as { url: string }).url;
        };
        const url = await ask(owner);
        expect(url).toMatch(/^\/api\/downloads\/[\w-]{40,}$/);
        // Nothing has left yet, so nothing is logged yet.
        const logged = async () =>
          (await audit.query(organisationId, { action: "download", limit: 50 })).events.length;
        expect(await logged()).toBe(0);

        // Another sign-in of the same account cannot use it, and does not spend it.
        const other = cookieOf(
          await app.request(
            "/api/auth/sign-in/email",
            json({ email: "producer@example.test", password: "correct horse battery" }),
          ),
        );
        expect((await getAs(url, other)).status).toBe(410);

        const got = await getAs(url, owner);
        expect(got.status).toBe(200);
        expect(got.headers.get("cache-control")).toContain("no-store");
        expect(got.headers.get("content-disposition")).toContain('filename="Mix v1.wav"');
        expect(await got.text()).toBe("not really audio");
        expect(await logged()).toBe(1);
        // Once only.
        expect((await getAs(url, owner)).status).toBe(410);

        // A Viewer may not download; a role with only proxies may not take the original.
        const viewer = await joinAs(owner, "viewer@example.test");
        await grantRole(owner, projectId, viewer, "Viewer");
        expect(
          (await send("POST", `/api/files/${fileId}/downloads`, { kind: "original" }, viewer))
            .status,
        ).toBe(403);
        expect(
          ((await (await getAs(`/api/files/${fileId}/downloads`, viewer)).json()) as Choices).level,
        ).toBe("none");
        const listed = (await (await getAs(`/api/projects/${projectId}/roles`, owner)).json()) as {
          roles: { id: string; name: string }[];
        };
        const viewerRole = listed.roles.find((r) => r.name === "Viewer")?.id ?? "";
        expect(
          (
            await send(
              "PATCH",
              `/api/projects/${projectId}/roles/${viewerRole}`,
              { name: "Viewer", permissions: ["view", "download_proxy"] },
              owner,
            )
          ).status,
        ).toBe(200);
        expect(
          (await send("POST", `/api/files/${fileId}/downloads`, { kind: "original" }, viewer))
            .status,
        ).toBe(403);

        // A link asked for, then the role taken away: the link no longer gives anything.
        const engineer = await joinAs(owner, "engineer@example.test");
        await grantRole(owner, projectId, engineer, "Engineer");
        const kept = await ask(engineer);
        await grantRole(owner, projectId, engineer, "Viewer");
        expect((await getAs(kept, engineer)).status).toBe(403);

        // Another workspace's file does not exist here.
        const [elsewhere] = await db
          .insert(schema.organisations)
          .values({ name: "Elsewhere", slug: "elsewhere-downloads" })
          .returning();
        const theirs = await storage.put(elsewhere?.id ?? "", Buffer.from("theirs"));
        const [project] = await db
          .insert(schema.projects)
          .values({ organisationId: elsewhere?.id ?? "", name: "Theirs", profile: "music" })
          .returning();
        const [file] = await db
          .insert(schema.files)
          .values({
            organisationId: elsewhere?.id ?? "",
            projectId: project?.id ?? "",
            name: "Theirs.wav",
            kind: "audio",
            blobId: theirs.id,
            contentType: "audio/wav",
            byteSize: theirs.byteSize,
          })
          .returning();
        expect(
          (await send("POST", `/api/files/${file?.id}/downloads`, { kind: "original" }, owner))
            .status,
        ).toBe(404);
      });

      it.runIf(
        (spawnSync("ffmpeg", ["-version"]).status === 0 &&
          spawnSync("pdfinfo", ["-v"]).status === 0) ||
          process.env.CI,
      )(
        "makes a document's pages and a picture's original into downloads marked for whoever asks",
        async () => {
          const { owner, organisationId, projectId } = await studio();
          const dir = mkdtempSync(join(tmpdir(), "hekate-marked-"));
          try {
            const draw = async (name: string, size: string) => {
              const out = join(dir, name);
              await run("ffmpeg", [
                ...["-hide_banner", "-nostdin", "-v", "error", "-f", "lavfi"],
                ...["-i", `color=white:s=${size}`, "-frames:v", "1", out],
              ]);
              return readFileSync(out);
            };
            const page = await draw("page.webp", "707x1000");
            const addFile = async (
              values: { name: string; kind: "document" | "image"; contentType: string },
              bytes: Buffer,
              pages: number,
            ) => {
              const blob = await storage.put(organisationId, bytes);
              const [file] = await db
                .insert(schema.files)
                .values({
                  organisationId,
                  projectId,
                  ...values,
                  blobId: blob.id,
                  byteSize: blob.byteSize,
                  streamStatus: pages > 0 ? "ready" : "none",
                  pageCount: values.kind === "document" && pages > 0 ? pages : null,
                })
                .returning();
              for (let n = 1; n <= pages; n++) {
                const view = await storage.put(organisationId, page);
                await db.insert(schema.filePages).values({
                  organisationId,
                  fileId: file?.id ?? "",
                  page: n,
                  width: 707,
                  height: 1000,
                  blobId: view.id,
                  thumbBlobId: view.id,
                });
              }
              return file?.id ?? "";
            };
            const score = await addFile(
              { name: "Score.pdf", kind: "document", contentType: "application/pdf" },
              samplePdf(2),
              2,
            );
            const cover = await addFile(
              { name: "Cover.jpg", kind: "image", contentType: "image/jpeg" },
              await draw("cover.jpg", "640x480"),
              1,
            );
            const notes = await addFile(
              { name: "Notes.txt", kind: "document", contentType: "text/plain" },
              Buffer.from("Bar 12: too fast"),
              0,
            );

            type Choices = { proxy: { available: boolean }; original: { available: boolean } };
            const choices = async (fileId: string) =>
              (await (await getAs(`/api/files/${fileId}/downloads`, owner)).json()) as Choices;
            expect(await choices(score)).toMatchObject({
              proxy: { available: true },
              original: { available: true },
            });
            expect(await choices(cover)).toMatchObject({ original: { available: true } });
            // A document never drawn as pages has nothing to mark, so nothing to download.
            expect(await choices(notes)).toMatchObject({
              proxy: { available: false },
              original: { available: false },
            });
            expect(
              (await send("POST", `/api/files/${notes}/downloads`, { kind: "proxy" }, owner))
                .status,
            ).toBe(422);

            const take = async (fileId: string, kind: "proxy" | "original") => {
              const asked = await send("POST", `/api/files/${fileId}/downloads`, { kind }, owner);
              expect(asked.status).toBe(201);
              const got = await getAs(((await asked.json()) as { url: string }).url, owner);
              expect(got.status).toBe(200);
              expect(got.headers.get("cache-control")).toContain("no-store");
              return { got, bytes: Buffer.from(await got.arrayBuffer()) };
            };
            const pdfInfo = async (bytes: Buffer) => {
              const path = join(dir, `got-${Math.random()}.pdf`);
              writeFileSync(path, bytes);
              return (await run("pdfinfo", [path])).stdout;
            };

            // The pages as reviewed, marked, as a PDF of as many pages.
            const proxy = await take(score, "proxy");
            expect(proxy.got.headers.get("content-type")).toBe("application/pdf");
            expect(proxy.got.headers.get("content-disposition")).toContain('filename="Score.pdf"');
            expect(await pdfInfo(proxy.bytes)).toMatch(/^Pages:\s+2$/m);
            // Drawn again from the original, at the original's own page size.
            const original = await take(score, "original");
            const info = await pdfInfo(original.bytes);
            expect(info).toMatch(/^Pages:\s+2$/m);
            expect(info).toMatch(/^Page size:\s+595 x 842 pts/m);
            // Neither is the stored file.
            expect(original.bytes.includes(Buffer.from("(Page 1) Tj"))).toBe(false);

            // A picture at full size, in its own format, with the mark drawn on it.
            const picture = await take(cover, "original");
            expect(picture.got.headers.get("content-type")).toBe("image/jpeg");
            expect(picture.got.headers.get("content-disposition")).toContain(
              'filename="Cover.jpg"',
            );
            expect(jpegSize(picture.bytes)).toEqual({ width: 640, height: 480 });

            const logged = await audit.query(organisationId, { action: "download", limit: 10 });
            expect(logged.events.map((e) => [e.fileId, e.details])).toEqual(
              expect.arrayContaining([
                [score, { kind: "proxy" }],
                [score, { kind: "original" }],
                [cover, { kind: "original" }],
              ]),
            );

            // A Viewer takes neither.
            const viewer = await joinAs(owner, "viewer-marked@example.test");
            await grantRole(owner, projectId, viewer, "Viewer");
            for (const kind of ["proxy", "original"] as const) {
              expect(
                (await send("POST", `/api/files/${score}/downloads`, { kind }, viewer)).status,
              ).toBe(403);
            }

            // A track's score with its marks drawn over it (#52), for those who see them.
            const [track] = await db
              .insert(schema.tracks)
              .values({ organisationId, projectId, name: "Maple Leaf Rag", scoreFileId: score })
              .returning();
            const [other] = await db
              .insert(schema.tracks)
              .values({ organisationId, projectId, name: "The Entertainer" })
              .returning();
            await db.insert(schema.scoreMarks).values([
              {
                organisationId,
                trackId: track?.id ?? "",
                kind: "issue",
                page: 2,
                x: 0.2,
                y: 0.3,
                text: "Left hand rushes",
                fixedBy: 2,
              },
              {
                organisationId,
                trackId: track?.id ?? "",
                kind: "edit",
                page: 1,
                x: 0.5,
                y: 0.5,
                fromTake: 3,
                toTake: 4,
              },
            ]);
            const annotated = async (body: Record<string, unknown>, cookie = owner) =>
              send("POST", `/api/files/${score}/downloads`, body, cookie);
            const asked = await annotated({ kind: "proxy", marks: track?.id });
            expect(asked.status).toBe(201);
            const got = await getAs(((await asked.json()) as { url: string }).url, owner);
            expect(got.status).toBe(200);
            expect(got.headers.get("content-disposition")).toContain(
              'filename="Score (annotated).pdf"',
            );
            const path = join(dir, "annotated.pdf");
            writeFileSync(path, Buffer.from(await got.arrayBuffer()));
            const pages = (await run("pdftotext", ["-layout", path, "-"])).stdout.split("\f");
            expect(pages[0]).toContain("3T4");
            expect(pages[1]).toContain("Left hand rushes, fixed in T2");
            const [recorded] = (await audit.query(organisationId, { action: "download", limit: 1 }))
              .events;
            expect(recorded?.details).toEqual({ kind: "proxy", scoreMarksOf: track?.id });
            // Not another track's file, nor a track from nowhere.
            expect((await annotated({ kind: "proxy", marks: other?.id })).status).toBe(422);
            expect(
              (await annotated({ kind: "proxy", marks: "0199f000-0000-7000-8000-000000000001" }))
                .status,
            ).toBe(404);
            // A role that downloads but does not see the production tools takes the score
            // without the marks only.
            const levels = {
              files: "view",
              comments: "none",
              reviews: "none",
              downloads: "proxy",
              takes: "none",
              production: "none",
              workflow: "none",
              people: "none",
              project: "none",
            };
            expect(
              (
                await send(
                  "POST",
                  `/api/projects/${projectId}/roles`,
                  { name: "Copyist", levels },
                  owner,
                )
              ).status,
            ).toBe(201);
            const copyist = await joinAs(owner, "copyist@example.test");
            await grantRole(owner, projectId, copyist, "Copyist");
            expect((await annotated({ kind: "proxy" }, copyist)).status).toBe(201);
            expect((await annotated({ kind: "proxy", marks: track?.id }, copyist)).status).toBe(
              403,
            );

            // Every score at once (#52): each track's score with its marks, as one PDF.
            const second = await addFile(
              { name: "Entertainer.pdf", kind: "document", contentType: "application/pdf" },
              samplePdf(2),
              2,
            );
            await db
              .update(schema.tracks)
              .set({ scoreFileId: second })
              .where(eq(schema.tracks.id, other?.id ?? ""));
            await db.insert(schema.scoreMarks).values({
              organisationId,
              trackId: other?.id ?? "",
              kind: "note",
              page: 1,
              x: 0.3,
              y: 0.4,
              text: "Not too fast",
            });
            const every = (body: unknown, cookie = owner, id = projectId) =>
              send("POST", `/api/projects/${id}/score-downloads`, body, cookie);
            const everyAsked = await every({ kind: "proxy" });
            expect(everyAsked.status).toBe(201);
            const everyGot = await getAs(((await everyAsked.json()) as { url: string }).url, owner);
            expect(everyGot.status).toBe(200);
            expect(everyGot.headers.get("content-disposition")).toContain("scores (annotated).pdf");
            const all = join(dir, "every.pdf");
            writeFileSync(all, Buffer.from(await everyGot.arrayBuffer()));
            expect((await run("pdfinfo", [all])).stdout).toMatch(/^Pages:\s+4$/m);
            const text = (await run("pdftotext", [all, "-"])).stdout;
            expect(text).toContain("3T4");
            expect(text).toContain("Not too fast");
            // A record for each score, before anything left.
            const everyLogged = (
              await audit.query(organisationId, { action: "download", limit: 2 })
            ).events.map((e) => e.details);
            expect(everyLogged).toEqual(
              expect.arrayContaining([
                { kind: "proxy", scoreMarksOf: track?.id, everyScore: true },
                { kind: "proxy", scoreMarksOf: other?.id, everyScore: true },
              ]),
            );
            // Not for a role without the production tools, nor a project from nowhere.
            expect((await every({ kind: "proxy" }, copyist)).status).toBe(403);
            expect(
              (await every({ kind: "proxy" }, owner, "0199f000-0000-7000-8000-000000000001"))
                .status,
            ).toBe(404);
            // Nor the original, which a score that is not a PDF cannot give.
            await db
              .update(schema.files)
              .set({ name: "Entertainer.tiff", contentType: "image/tiff" })
              .where(eq(schema.files.id, second));
            expect((await every({ kind: "original" })).status).toBe(422);
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        },
      );

      it.runIf(spawnSync("ffmpeg", ["-version"]).status === 0 || process.env.CI)(
        "makes a video's downloads with the mark burned into the picture",
        async () => {
          const { owner, organisationId, projectId } = await studio();
          const dir = mkdtempSync(join(tmpdir(), "hekate-burn-"));
          try {
            const source = join(dir, "source.mov");
            await run("ffmpeg", [
              ...["-hide_banner", "-nostdin", "-v", "error"],
              ...["-f", "lavfi", "-i", "testsrc=size=640x360:rate=25:duration=2"],
              ...["-f", "lavfi", "-i", "sine=frequency=440:duration=2"],
              ...["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "pcm_s24le", source],
            ]);
            const bytes = readFileSync(source);
            const blob = await storage.put(organisationId, bytes);
            const [file] = await db
              .insert(schema.files)
              .values({
                organisationId,
                projectId,
                name: "Opening titles v3.mov",
                kind: "video",
                blobId: blob.id,
                contentType: "video/quicktime",
                byteSize: blob.byteSize,
              })
              .returning();
            const fileId = file?.id ?? "";
            type Choices = {
              proxy: { available: boolean; detail: string };
              original: { available: boolean; detail: string };
            };
            const choices = async () =>
              (await (await getAs(`/api/files/${fileId}/downloads`, owner)).json()) as Choices;
            // Nothing to make until the file is measured and its stream prepared.
            expect(await choices()).toMatchObject({
              proxy: { available: false },
              original: { available: false },
            });
            const workers = {
              db,
              storage,
              keyring,
              jobs: { send: async () => null },
              workDir: join(dir, "work"),
            };
            const job = { id: "test", signal: new AbortController().signal, retryCount: 0 };
            await probeHandler(workers)({ organisationId, fileId }, job);
            await proxyHandler(workers)({ organisationId, fileId }, job);
            const offered = await choices();
            expect(offered.proxy).toMatchObject({ available: true });
            expect(offered.proxy.detail).toContain("360p");
            expect(offered.original).toMatchObject({ available: true });
            expect(offered.original.detail).toContain("640 × 360");

            const take = async (kind: "proxy" | "original") => {
              const asked = await send("POST", `/api/files/${fileId}/downloads`, { kind }, owner);
              expect(asked.status).toBe(201);
              const got = await getAs(((await asked.json()) as { url: string }).url, owner);
              expect(got.status).toBe(200);
              expect(got.headers.get("cache-control")).toContain("no-store");
              const path = join(dir, `${kind}-download`);
              writeFileSync(path, Buffer.from(await got.arrayBuffer()));
              return { got, info: await probe(path) };
            };
            const proxy = await take("proxy");
            expect(proxy.got.headers.get("content-type")).toBe("video/mp4");
            expect(proxy.got.headers.get("content-disposition")).toContain(
              'filename="Opening titles v3.mp4"',
            );
            expect(proxy.info.video).toMatchObject({ codec: "h264", width: 640, height: 360 });
            expect(proxy.info.audio).toMatchObject({ codec: "aac" });
            const original = await take("original");
            expect(original.got.headers.get("content-type")).toBe("video/quicktime");
            expect(original.got.headers.get("content-disposition")).toContain(
              'filename="Opening titles v3.mov"',
            );
            expect(original.info.video).toMatchObject({ width: 640, height: 360 });
            // The sound as it was.
            expect(original.info.audio).toMatchObject({ codec: "pcm_s24le" });
            expect(original.info.duration).toBeGreaterThan(1.9);

            const logged = await audit.query(organisationId, { action: "download", limit: 10 });
            expect(logged.events.filter((e) => e.fileId === fileId).map((e) => e.details)).toEqual(
              expect.arrayContaining([{ kind: "proxy" }, { kind: "original" }]),
            );
            // A Viewer takes neither.
            const viewer = await joinAs(owner, "viewer-video@example.test");
            await grantRole(owner, projectId, viewer, "Viewer");
            expect(
              (await send("POST", `/api/files/${fileId}/downloads`, { kind: "proxy" }, viewer))
                .status,
            ).toBe(403);
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        },
      );

      it.runIf(spawnSync("ffmpeg", ["-version"]).status === 0 || process.env.CI)(
        "checks a silent video's picture, and one checked before it was looked at (#42)",
        async () => {
          const { owner, organisationId, projectId } = await studio();
          const dir = mkdtempSync(join(tmpdir(), "hekate-picture-"));
          try {
            const source = join(dir, "source.mp4");
            // A second and a half of black, then the picture: no sound at all.
            await run("ffmpeg", [
              ...["-hide_banner", "-nostdin", "-v", "error", "-f", "lavfi", "-i"],
              "color=black:s=320x240:r=25:d=1.5[a];testsrc2=s=320x240:r=25:d=2[b];[a][b]concat=n=2,format=yuv420p",
              ...["-c:v", "libx264", source],
            ]);
            const blob = await storage.put(organisationId, readFileSync(source));
            const [file] = await db
              .insert(schema.files)
              .values({
                organisationId,
                projectId,
                name: "Opening titles mute.mp4",
                kind: "video",
                blobId: blob.id,
                contentType: "video/mp4",
                byteSize: blob.byteSize,
              })
              .returning();
            const fileId = file?.id ?? "";
            const queued: string[] = [];
            const workers = {
              db,
              storage,
              keyring,
              jobs: {
                send: async (name: string) => {
                  queued.push(name);
                  return null;
                },
              },
              workDir: join(dir, "work"),
            };
            const job = { id: "test", signal: new AbortController().signal, retryCount: 0 };
            await probeHandler(workers)({ organisationId, fileId }, job);
            expect(queued).toContain("media-analysis");
            const status = async () =>
              (
                await db
                  .select({ analysisStatus: schema.files.analysisStatus })
                  .from(schema.files)
                  .where(eq(schema.files.id, fileId))
              )[0]?.analysisStatus;
            expect(await status()).toBe("pending");
            await analysisHandler(workers)({ organisationId, fileId }, job);
            expect(await status()).toBe("ready");

            type Report = {
              status: string;
              findings: { check: string; severity: string; start: number | null }[];
            };
            const report = async () =>
              (await (await getAs(`/api/files/${fileId}/qa`, owner)).json()) as Report;
            const first = await report();
            expect(first.status).toBe("ready");
            expect(first.findings.filter((f) => f.check === "black-frames")).toEqual([
              expect.objectContaining({ severity: "info", start: 0 }),
            ]);
            expect(first.findings.map((f) => f.check)).toEqual(
              expect.arrayContaining([
                "frozen-frames",
                "dropped-frames",
                "interlacing",
                "broadcast-levels",
                "letterbox",
                "flashing",
              ]),
            );
            // No sound, so nothing of it is reported.
            expect(first.findings.some((f) => f.check === "loudness" || f.check === "format")).toBe(
              false,
            );

            // As if probed before the picture was checked: queued once, and checked once.
            await db.delete(schema.qaFindings).where(eq(schema.qaFindings.fileId, fileId));
            await db
              .update(schema.files)
              .set({ analysisStatus: "none" })
              .where(eq(schema.files.id, fileId));
            const again: string[] = [];
            const requeue = () =>
              requeueMissingFindings(db, {
                send: async (_name, data) => {
                  again.push((data as { fileId: string }).fileId);
                  return null;
                },
              });
            expect(await requeue()).toBe(1);
            expect(again).toEqual([fileId]);
            await analysisHandler(workers)({ organisationId, fileId }, job);
            await analysisHandler(workers)({ organisationId, fileId }, job);
            expect(await status()).toBe("ready");
            expect((await report()).findings).toHaveLength(first.findings.length);
            expect(await requeue()).toBe(0);
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        },
        60_000,
      );

      it("gives every project the default roles, and its creator the Producer's", async () => {
        const { owner, projectId } = await studio();
        const roles = (await (await getAs(`/api/projects/${projectId}/roles`, owner)).json()) as {
          roles: { name: string; permissions: string[]; members: number }[];
        };
        expect(roles.roles.map((r) => r.name)).toEqual(defaultProjectRoles.map((r) => r.name));
        expect(roles.roles.find((r) => r.name === "Reviewer")?.permissions).toEqual(
          defaultProjectRoles.find((r) => r.name === "Reviewer")?.permissions,
        );
        expect(roles.roles.find((r) => r.name === "Producer")?.members).toBe(1);
        const members = (await (
          await getAs(`/api/projects/${projectId}/members`, owner)
        ).json()) as {
          members: { name: string }[];
        };
        expect(members.members.map((m) => m.name)).toEqual(["Producer"]);
      });

      it("saves a project's set-up as a template, and starts others from it (#240)", async () => {
        const { owner, projectId } = await studio();
        // What it is set up with: a role, a category and a check of its own.
        await app.request(
          `/api/projects/${projectId}/roles`,
          json({ name: "Mixer", permissions: ["view", "comment"] }, owner),
        );
        await app.request(
          `/api/projects/${projectId}/categories`,
          json({ name: "Tuning", handling: "normal" }, owner),
        );
        await send("PATCH", `/api/projects/${projectId}`, { requireEdl: true }, owner);
        const save = (name: string, cookie: string) =>
          app.request(`/api/projects/${projectId}/template`, json({ name }, cookie));

        // Only those who edit the project save it; others in the workspace find nothing.
        const reviewer = await joinAs(owner, "reviewer-template@example.test");
        await grantRole(owner, projectId, reviewer, "Reviewer");
        expect((await save("Recital", reviewer)).status).toBe(403);
        const outsider = await joinAs(owner, "outsider-template-save@example.test");
        expect((await save("Recital", outsider)).status).toBe(404);
        const saved = await save("Recital", owner);
        expect(saved.status).toBe(201);
        const { template } = (await saved.json()) as {
          template: { id: string; roles: string[]; categories: number; removable: boolean };
        };
        expect(template.roles).toContain("Mixer");
        expect(template.removable).toBe(true);
        expect((await save("recital", owner)).status).toBe(409);

        // A copy: what the project gains later is not in it.
        await app.request(
          `/api/projects/${projectId}/roles`,
          json({ name: "Late", permissions: ["view"] }, owner),
        );
        const made = await app.request(
          "/api/projects",
          json({ name: "Recital II", profile: "music", savedTemplateId: template.id }, reviewer),
        );
        expect(made.status).toBe(201);
        const copy = ((await made.json()) as { project: { id: string; requireEdl: boolean } })
          .project;
        expect(copy.requireEdl).toBe(true);
        const roles = (
          (await (await getAs(`/api/projects/${copy.id}/roles`, reviewer)).json()) as {
            roles: { name: string; members: number; tools: string[] }[];
          }
        ).roles;
        expect(roles.map((r) => r.name)).toContain("Mixer");
        // Each role's player tools go with it (#240): a new role listens.
        expect(roles.find((r) => r.name === "Mixer")?.tools).toEqual([
          "score",
          "compare",
          "loops",
          "normalise",
        ]);
        expect(roles.map((r) => r.name)).not.toContain("Late");
        expect(roles.find((r) => r.name === "Producer")?.members).toBe(1);
        const categories = (
          (await (await getAs(`/api/projects/${copy.id}/categories`, reviewer)).json()) as {
            categories: { name: string }[];
          }
        ).categories;
        expect(categories.map((k) => k.name)).toContain("Tuning");
        const files = (await (await getAs(`/api/projects/${copy.id}/files`, reviewer)).json()) as {
          files: unknown[];
        };
        expect(files.files).toEqual([]);
        // From a project or from a template, not both.
        expect(
          (
            await app.request(
              "/api/projects",
              json(
                {
                  name: "Both",
                  profile: "music",
                  templateId: projectId,
                  savedTemplateId: template.id,
                },
                owner,
              ),
            )
          ).status,
        ).toBe(400);

        // Every member sees the workspace's templates; only who saved one, or an admin, removes it.
        const listed = (
          (await (await getAs("/api/templates", reviewer)).json()) as {
            templates: { id: string; name: string; removable: boolean }[];
          }
        ).templates;
        expect(listed).toMatchObject([{ id: template.id, name: "Recital", removable: false }]);
        const remove = (cookie: string) =>
          app.request(`/api/templates/${template.id}`, {
            method: "DELETE",
            headers: { cookie, origin: "http://localhost:3000" },
          });
        expect((await remove(reviewer)).status).toBe(403);
        // Another workspace knows nothing of it: the outsider, as owner of a workspace of their own.
        const [other] = await db
          .insert(schema.organisations)
          .values({ name: "Saltmarsh Films", slug: "saltmarsh-templates" })
          .returning({ id: schema.organisations.id });
        const outsiderId = (
          (await (await getAs("/api/me", outsider)).json()) as { user: { id: string } }
        ).user.id;
        await db
          .insert(schema.members)
          .values({ organisationId: other?.id ?? "", userId: outsiderId, role: "owner" });
        expect(
          (
            await app.request("/api/me/organisation", {
              ...json({ organisationId: other?.id }, outsider),
              method: "PUT",
            })
          ).status,
        ).toBe(200);
        const elsewhere = { owner: outsider };
        expect((await remove(elsewhere.owner)).status).toBe(404);
        expect(
          (
            await app.request(
              "/api/projects",
              json(
                { name: "Borrowed", profile: "music", savedTemplateId: template.id },
                elsewhere.owner,
              ),
            )
          ).status,
        ).toBe(404);
        expect((await remove(owner)).status).toBe(204);
        expect(
          ((await (await getAs("/api/templates", owner)).json()) as { templates: unknown[] })
            .templates,
        ).toEqual([]);
      });

      it("hides a project from members without a role, and shows it to admins", async () => {
        const { owner, projectId, fileId } = await studio();
        const member = await joinAs(owner, "outsider@example.test");
        const admin = await joinAs(owner, "admin@example.test", "admin");
        const listed = async (cookie: string) =>
          ((await (await getAs("/api/projects", cookie)).json()) as { projects: { id: string }[] })
            .projects.length;
        expect(await listed(member)).toBe(0);
        expect((await getAs(`/api/projects/${projectId}`, member)).status).toBe(404);
        expect((await getAs(`/api/projects/${projectId}/files`, member)).status).toBe(404);
        expect((await getAs(`/api/files/${fileId}`, member)).status).toBe(404);
        expect((await getAs(`/api/files/${fileId}/comments`, member)).status).toBe(404);
        expect((await getAs(`/api/files/${fileId}/peaks`, member)).status).toBe(404);
        // Organisation admins need no role.
        expect(await listed(admin)).toBe(1);
        const seen = (await (await getAs(`/api/projects/${projectId}`, admin)).json()) as {
          project: { permissions: string[] };
        };
        expect(seen.project.permissions).toContain("manage_roles");
      });

      it("starts a project from a template, archives and unarchives it, and keeps it read-only meanwhile", async () => {
        const { owner, organisationId, projectId, fileId } = await studio();
        type Listed = {
          projects: {
            id: string;
            name: string;
            mine: boolean;
            mayArchive: boolean;
            figures?: { files: number };
          }[];
        };
        const list = async (cookie: string, query = "") =>
          ((await (await getAs(`/api/projects${query}`, cookie)).json()) as Listed).projects;

        // The template: a role of its own and a setting changed. Its content is not copied.
        await app.request(
          `/api/projects/${projectId}/roles`,
          json({ name: "Mixer", permissions: ["view", "comment"] }, owner),
        );
        await send("PATCH", `/api/projects/${projectId}`, { carriedCommentsShown: false }, owner);
        const made = await app.request(
          "/api/projects",
          json(
            {
              name: "Rags II",
              profile: "music",
              description: "  Second set  ",
              templateId: projectId,
            },
            owner,
          ),
        );
        expect(made.status).toBe(201);
        const copy = (
          (await made.json()) as {
            project: { id: string; description: string; carriedCommentsShown: boolean };
          }
        ).project;
        expect(copy).toMatchObject({ description: "Second set", carriedCommentsShown: false });
        const roles = (await (await getAs(`/api/projects/${copy.id}/roles`, owner)).json()) as {
          roles: { name: string; members: number }[];
        };
        expect(roles.roles.map((r) => r.name)).toContain("Mixer");
        expect(roles.roles.find((r) => r.name === "Producer")?.members).toBe(1);
        const files = (await (await getAs(`/api/projects/${copy.id}/files`, owner)).json()) as {
          files: unknown[];
        };
        expect(files.files).toEqual([]);

        // Any member may start a project, but not from one they cannot see.
        const outsider = await joinAs(owner, "outsider-template@example.test");
        expect(
          (
            await app.request(
              "/api/projects",
              json({ name: "Borrowed", profile: "music", templateId: projectId }, outsider),
            )
          ).status,
        ).toBe(404);
        expect(
          (await app.request("/api/projects", json({ name: "Own", profile: "general" }, outsider)))
            .status,
        ).toBe(201);
        expect((await list(outsider)).map((p) => [p.name, p.mine])).toEqual([["Own", true]]);

        // The list's figures and who may archive.
        const engineer = await joinAs(owner, "engineer-archive@example.test");
        await grantRole(owner, projectId, engineer, "Engineer");

        // A template whose Producer can no longer run anything still leaves its creator able
        // to see and run the copy.
        const reduced = (
          (await (
            await app.request("/api/projects", json({ name: "Reduced", profile: "general" }, owner))
          ).json()) as { project: { id: string } }
        ).project.id;
        const reducedRoles = (await (
          await getAs(`/api/projects/${reduced}/roles`, owner)
        ).json()) as {
          roles: { id: string; name: string }[];
        };
        const producerRole = reducedRoles.roles.find((r) => r.name === "Producer");
        expect(
          (
            await send(
              "PATCH",
              `/api/projects/${reduced}/roles/${producerRole?.id}`,
              // Managing people without seeing the files: it cannot run the project.
              { name: "Producer", permissions: ["manage_roles"] },
              owner,
            )
          ).status,
        ).toBe(200);
        await grantRole(owner, reduced, engineer, "Engineer");
        const fromReduced = await app.request(
          "/api/projects",
          json({ name: "Mine now", profile: "general", templateId: reduced }, engineer),
        );
        expect(fromReduced.status).toBe(201);
        const ran = ((await fromReduced.json()) as { project: { permissions: string[] } }).project;
        expect(ran.permissions).toEqual(expect.arrayContaining(["view", "manage_roles"]));
        const engineerSees = new Map((await list(engineer)).map((p) => [p.name, p.mayArchive]));
        expect(engineerSees.get("Rags")).toBe(false);
        expect(engineerSees.get("Mine now")).toBe(true);
        expect(
          (await list(owner, "?figures=1")).find((p) => p.id === projectId)?.figures?.files,
        ).toBe(1);

        // An open review, which archiving closes.
        const ids = async (cookie: string) =>
          ((await (await getAs("/api/me", cookie)).json()) as { user: { id: string } }).user.id;
        const asked = await app.request(
          `/api/projects/${projectId}/reviews`,
          json(
            {
              kind: "feedback",
              title: "First notes",
              items: [{ fileId }],
              reviewers: [await ids(engineer)],
            },
            owner,
          ),
        );
        expect(asked.status).toBe(201);

        // Only those who run the project may archive it; a stranger to it finds nothing.
        const archive = (cookie: string, action = "archive") =>
          app.request(`/api/projects/${projectId}/${action}`, json({}, cookie));
        expect((await archive(engineer)).status).toBe(403);
        expect((await archive(outsider)).status).toBe(404);
        expect((await archive(owner)).status).toBe(204);

        expect((await list(owner)).map((p) => p.name)).not.toContain("Rags");
        expect((await list(owner, "?archived=1")).map((p) => p.name)).toEqual(["Rags"]);
        const [review] = await db
          .select({ status: schema.reviews.status })
          .from(schema.reviews)
          .where(eq(schema.reviews.projectId, projectId));
        expect(review?.status).toBe("cancelled");

        // Read-only while archived: it opens, but nothing changes, even for its Producer.
        const seen = (await (await getAs(`/api/projects/${projectId}`, owner)).json()) as {
          project: { permissions: string[]; archivedAt: string | null };
        };
        expect(seen.project.permissions).toEqual([...lookingPermissions]);
        expect(seen.project.archivedAt).not.toBeNull();
        expect((await getAs(`/api/files/${fileId}/comments`, owner)).status).toBe(200);
        expect(
          (await app.request(`/api/files/${fileId}/comments`, json({ body: "Late" }, owner)))
            .status,
        ).toBe(403);
        expect(
          (await app.request(`/api/projects/${projectId}/tracks`, json({ name: "Elite" }, owner)))
            .status,
        ).toBe(403);

        expect((await archive(engineer, "unarchive")).status).toBe(403);
        expect((await archive(owner, "unarchive")).status).toBe(204);
        expect((await list(owner)).map((p) => p.name)).toContain("Rags");
        expect(
          (await app.request(`/api/files/${fileId}/comments`, json({ body: "Back" }, owner)))
            .status,
        ).toBe(201);

        const logged = await db
          .select({ action: schema.accessEvents.action })
          .from(schema.accessEvents)
          .where(eq(schema.accessEvents.organisationId, organisationId));
        expect(logged.map((e) => e.action)).toEqual(
          expect.arrayContaining(["project.archive", "project.unarchive"]),
        );
      });

      it("allows each default role what the matrix says, and refuses the rest", async () => {
        const { owner, projectId, fileId } = await studio();
        // A track with a version and a second file, for the track routes.
        const track = await app.request(
          `/api/projects/${projectId}/tracks`,
          json({ name: "Maple Leaf Rag" }, owner),
        );
        const trackId = ((await track.json()) as { track: { id: string } }).track.id;
        const versioned = await app.request(
          `/api/tracks/${trackId}/versions`,
          json({ variations: [{ fileId, name: "Dry" }] }, owner),
        );
        const version = (
          (await versioned.json()) as {
            track: { versions: { id: string; variations: { id: string }[] }[] };
          }
        ).track.versions[0];
        const thread = await app.request(
          `/api/files/${fileId}/comments`,
          json({ body: "Pedal noise" }, owner),
        );
        const threadId = ((await thread.json()) as { comment: { id: string } }).comment.id;

        /** What each action needs, and how to try it. */
        const actions: [string, string, (cookie: string) => Response | Promise<Response>][] = [
          ["view", "see the project", (c) => getAs(`/api/projects/${projectId}`, c)],
          ["view", "see the tracks", (c) => getAs(`/api/projects/${projectId}/tracks`, c)],
          ["read_comments", "see the comments", (c) => getAs(`/api/files/${fileId}/comments`, c)],
          ["view_people", "see the roles", (c) => getAs(`/api/projects/${projectId}/roles`, c)],
          [
            "edit_project",
            "rename the project",
            (c) => send("PATCH", `/api/projects/${projectId}`, { name: "Rags" }, c),
          ],
          [
            "comment",
            "comment",
            (c) => app.request(`/api/files/${fileId}/comments`, json({ body: "Lovely" }, c)),
          ],
          [
            "triage",
            "resolve a thread",
            (c) => app.request(`/api/comments/${threadId}/resolve`, json({ resolved: false }, c)),
          ],
          [
            "triage",
            "export the comments",
            (c) => getAs(`/api/files/${fileId}/comments/export?target=csv`, c),
          ],
          [
            "upload",
            "start an upload",
            (c) =>
              app.request(
                "/api/uploads",
                json({ projectId, name: "Mix v2.wav", size: 10, contentType: "audio/wav" }, c),
              ),
          ],
          [
            "organise",
            "add a track",
            (c) => app.request(`/api/projects/${projectId}/tracks`, json({ name: "Elite" }, c)),
          ],
          [
            "organise",
            "rename a track",
            (c) => send("PATCH", `/api/tracks/${trackId}`, { name: "Maple Leaf" }, c),
          ],
          [
            "upload",
            "add a version",
            // Refused before the body is looked at; an allowed role meets the file rule (409).
            (c) =>
              app.request(
                `/api/tracks/${trackId}/versions`,
                json({ variations: [{ fileId, name: "Again" }] }, c),
              ),
          ],
          [
            "upload",
            "add a variation",
            (c) =>
              app.request(
                `/api/versions/${version?.id}/variations`,
                json({ fileId, name: "Wet" }, c),
              ),
          ],
          [
            "organise",
            "choose the primary variation",
            (c) =>
              app.request(`/api/variations/${version?.variations[0]?.id}/primary`, json({}, c)),
          ],
          [
            "manage_roles",
            "create a role",
            (c) =>
              app.request(
                `/api/projects/${projectId}/roles`,
                json({ name: `Role ${Math.random()}`, permissions: ["view"] }, c),
              ),
          ],
        ];

        for (const role of defaultProjectRoles) {
          const cookie = await joinAs(owner, `${role.name.toLowerCase()}-role@example.test`);
          await grantRole(owner, projectId, cookie, role.name);
          for (const [permission, what, attempt] of actions) {
            const res = await attempt(cookie);
            const allowed = (role.permissions as string[]).includes(permission);
            // Allowed means the role check passed: some attempts then meet a rule of their own.
            if (allowed)
              expect([200, 201, 204, 409], `${role.name} may ${what}`).toContain(res.status);
            else expect(res.status, `${role.name} may not ${what}`).toBe(403);
          }
        }
      }, 60_000);

      it("answers from the level in each area, refusing anything below it", async () => {
        const { owner, organisationId, projectId, fileId } = await studio();
        const lowest = {
          files: "view",
          comments: "none",
          reviews: "none",
          downloads: "none",
          takes: "none",
          production: "none",
          workflow: "none",
          people: "none",
          project: "none",
        };
        const made = await app.request(
          `/api/projects/${projectId}/roles`,
          json({ name: "Listener", levels: lowest }, owner),
        );
        expect(made.status).toBe(201);
        const role = ((await made.json()) as { role: { id: string; levels: object } }).role;
        expect(role.levels).toEqual(lowest);
        const listener = await joinAs(owner, "listener@example.test");
        await grantRole(owner, projectId, listener, "Listener");
        const raise = (levels: Record<string, string>) =>
          send(
            "PATCH",
            `/api/projects/${projectId}/roles/${role.id}`,
            { name: "Listener", levels: { ...lowest, ...levels } },
            owner,
          );
        const spare = async () => {
          const blob = await storage.put(organisationId, Buffer.from("spare"));
          const [row] = await db
            .insert(schema.files)
            .values({
              organisationId,
              projectId,
              name: "Spare.wav",
              kind: "audio",
              blobId: blob.id,
              contentType: "audio/wav",
              byteSize: blob.byteSize,
            })
            .returning();
          return row?.id ?? "";
        };
        const attempts: [Record<string, string>, () => Response | Promise<Response>][] = [
          [{ comments: "read" }, () => getAs(`/api/files/${fileId}/comments`, listener)],
          [{ people: "view" }, () => getAs(`/api/projects/${projectId}/members`, listener)],
          [
            { project: "settings" },
            () => send("PATCH", `/api/projects/${projectId}`, { profile: "video" }, listener),
          ],
          [
            { workflow: "edit" },
            () => send("PATCH", `/api/projects/${projectId}`, { requireEdl: false }, listener),
          ],
          // A workflow's builder chooses who each stage asks among the project's roles (#26),
          // though not among its members.
          [{ workflow: "edit" }, () => getAs(`/api/projects/${projectId}/roles`, listener)],
          [
            { files: "delete" },
            async () =>
              app.request(`/api/files/${await spare()}`, {
                ...json({}, listener),
                method: "DELETE",
              }),
          ],
          [
            { project: "delete" },
            () => app.request(`/api/projects/${projectId}/archive`, json({}, listener)),
          ],
        ];
        // The last role that manages people keeps that level.
        const roles = (await (await getAs(`/api/projects/${projectId}/roles`, owner)).json()) as {
          roles: { id: string; name: string; levels: Record<string, string> }[];
        };
        const producer = roles.roles.find((r) => r.name === "Producer");
        const demote = () =>
          send(
            "PATCH",
            `/api/projects/${projectId}/roles/${producer?.id}`,
            { name: "Producer", levels: { ...producer?.levels, people: "view" } },
            owner,
          );
        expect((await demote()).status).toBe(409);
        expect((await raise({ people: "manage" })).status).toBe(200);
        expect((await demote()).status).toBe(200);
        const restore = () =>
          send(
            "PATCH",
            `/api/projects/${projectId}/roles/${producer?.id}`,
            { name: "Producer", levels: producer?.levels },
            owner,
          );
        const restored = await restore();
        expect(restored.status).toBe(200);
        // Nor can the last role that manages people be deleted, while a change waits on it.
        const second = await app.request(
          `/api/projects/${projectId}/roles`,
          json({ name: "Stand-in", levels: { ...lowest, people: "manage" } }, owner),
        );
        const standIn = ((await second.json()) as { role: { id: string } }).role.id;
        const drop = () =>
          app.request(`/api/projects/${projectId}/roles/${standIn}`, {
            ...json({}, owner),
            method: "DELETE",
          });
        expect((await raise({})).status).toBe(200);
        expect((await demote()).status).toBe(200);
        expect((await drop()).status).toBe(409);
        expect((await restore()).status).toBe(200);
        expect((await drop()).status).toBe(204);
        // Choosing among the people (requesting a review, assigning feedback) looks them up
        // whatever the People level.
        for (const level of [{ reviews: "request" }, { comments: "triage" }] as Record<
          string,
          string
        >[]) {
          await raise(level);
          expect((await getAs(`/api/projects/${projectId}/members`, listener)).status).toBe(200);
          expect((await getAs(`/api/projects/${projectId}/roles`, listener)).status).toBe(200);
        }
        for (const [level, attempt] of attempts) {
          await raise({});
          expect((await attempt()).status, `below ${JSON.stringify(level)}`).toBe(403);
          await raise(level);
          expect([200, 201, 204], `at ${JSON.stringify(level)}`).toContain(
            (await attempt()).status,
          );
        }
        // The profile is one of the project's own settings.
        const changed = (await (await getAs(`/api/projects/${projectId}`, owner)).json()) as {
          project: { profile: string };
        };
        expect(changed.project.profile).toBe("video");
      });

      it("manages roles and members, and keeps them to the project", async () => {
        const { owner, organisationId, projectId } = await studio();
        const roles = `/api/projects/${projectId}/roles`;
        const made = await app.request(
          roles,
          json({ name: "Mixer", permissions: ["comment", "view"] }, owner),
        );
        expect(made.status).toBe(201);
        const mixer = ((await made.json()) as { role: { id: string; permissions: string[] } }).role;
        // Closed upwards: commenting brings reading.
        expect(mixer.permissions).toEqual(["view", "read_comments", "comment"]);
        expect(
          (await app.request(roles, json({ name: "Mixer", permissions: [] }, owner))).status,
        ).toBe(409);
        expect(
          (await app.request(roles, json({ name: "Flyer", permissions: ["fly"] }, owner))).status,
        ).toBe(400);
        const renamed = await send(
          "PATCH",
          `${roles}/${mixer.id}`,
          { name: "Mix engineer", permissions: ["view", "comment", "upload"] },
          owner,
        );
        expect(renamed.status).toBe(200);

        // Give it to a colleague: it cannot be deleted while they hold it.
        const colleague = await joinAs(owner, "mixer@example.test");
        await grantRole(owner, projectId, colleague, "Mix engineer");
        expect((await send("DELETE", `${roles}/${mixer.id}`, {}, owner)).status).toBe(409);
        const me = (await (await getAs("/api/me", colleague)).json()) as { user: { id: string } };
        expect(
          (await send("DELETE", `/api/projects/${projectId}/members/${me.user.id}`, {}, owner))
            .status,
        ).toBe(204);
        expect((await getAs(`/api/projects/${projectId}`, colleague)).status).toBe(404);
        expect((await send("DELETE", `${roles}/${mixer.id}`, {}, owner)).status).toBe(204);

        // Another project's role, and someone outside the organisation, are not found here.
        const other = await app.request(
          "/api/projects",
          json({ name: "Elite", profile: "music" }, owner),
        );
        const otherId = ((await other.json()) as { project: { id: string } }).project.id;
        const otherRoles = (await (
          await getAs(`/api/projects/${otherId}/roles`, owner)
        ).json()) as {
          roles: { id: string }[];
        };
        const viewer = await joinAs(owner, "viewer@example.test");
        const viewerId = (
          (await (await getAs("/api/me", viewer)).json()) as { user: { id: string } }
        ).user.id;
        const assign = (userId: string, roleId: string) =>
          send("PUT", `/api/projects/${projectId}/members/${userId}`, { roleId }, owner);
        expect((await assign(viewerId, otherRoles.roles[0]?.id ?? "")).status).toBe(404);
        expect((await assign("not-a-member", otherRoles.roles[0]?.id ?? "")).status).toBe(404);

        // Leaving the organisation takes a member's project roles with them.
        await grantRole(owner, projectId, viewer, "Viewer");
        const [membership] = await db
          .select({ id: schema.members.id })
          .from(schema.members)
          .where(eq(schema.members.userId, viewerId));
        expect(
          (await send("DELETE", `/api/organisation/members/${membership?.id}`, {}, owner)).status,
        ).toBe(204);
        const left = await db
          .select()
          .from(schema.projectMembers)
          .where(eq(schema.projectMembers.userId, viewerId));
        expect(left).toHaveLength(0);

        // Another organisation's project roles do not exist from here.
        const [elsewhere] = await db
          .insert(schema.organisations)
          .values({ name: "Elsewhere", slug: "elsewhere-roles" })
          .returning();
        const [foreign] = await db
          .insert(schema.projects)
          .values({ organisationId: elsewhere?.id ?? "", name: "Theirs", profile: "music" })
          .returning();
        expect((await getAs(`/api/projects/${foreign?.id}/roles`, owner)).status).toBe(404);
        expect(
          (
            await app.request(
              `/api/projects/${foreign?.id}/roles`,
              json({ name: "X", permissions: [] }, owner),
            )
          ).status,
        ).toBe(404);
        expect(organisationId).not.toBe(elsewhere?.id);
      });

      it("never leaves a role behind when someone leaves as it is given", async () => {
        const { owner, projectId } = await studio();
        const roles = (await (await getAs(`/api/projects/${projectId}/roles`, owner)).json()) as {
          roles: { id: string; name: string }[];
        };
        const viewer = roles.roles.find((r) => r.name === "Viewer")?.id ?? "";
        for (let round = 0; round < 5; round++) {
          const cookie = await joinAs(owner, `leaver${round}@example.test`);
          const userId = (
            (await (await getAs("/api/me", cookie)).json()) as { user: { id: string } }
          ).user.id;
          const [membership] = await db
            .select({ id: schema.members.id })
            .from(schema.members)
            .where(eq(schema.members.userId, userId));
          // Assigning and removing at the same moment: whichever wins, nothing stale is left.
          const [assigned, removed] = await Promise.all([
            send("PUT", `/api/projects/${projectId}/members/${userId}`, { roleId: viewer }, owner),
            send("DELETE", `/api/organisation/members/${membership?.id}`, {}, owner),
          ]);
          expect([204, 404]).toContain(assigned.status);
          expect(removed.status).toBe(204);
          const left = await db
            .select()
            .from(schema.projectMembers)
            .where(eq(schema.projectMembers.userId, userId));
          expect(left).toHaveLength(0);
        }
      });

      it("stops an upload whose uploader loses the role mid-way", async () => {
        const { owner, projectId } = await studio();
        const engineer = await joinAs(owner, "engineer@example.test");
        await grantRole(owner, projectId, engineer, "Engineer");
        const started = await app.request(
          "/api/uploads",
          json({ projectId, name: "Mix v2.wav", size: 10, contentType: "audio/wav" }, engineer),
        );
        expect(started.status).toBe(201);
        const { upload } = (await started.json()) as { upload: { id: string } };
        await grantRole(owner, projectId, engineer, "Reviewer");
        const chunk = await app.request(`/api/uploads/${upload.id}/chunks/0`, {
          method: "PUT",
          headers: { cookie: engineer, origin: "http://localhost:3000" },
          body: new Uint8Array(10),
        });
        expect(chunk.status).toBe(403);
        expect(
          (await app.request(`/api/uploads/${upload.id}/complete`, json({}, engineer))).status,
        ).toBe(403);
      });
    });

    describe("reviews", () => {
      const joinAs = async (owner: string, email: string, role = "member") => {
        const { body } = await invite(owner, email, role);
        const res = await app.request(
          `/api/invitations/${tokenFrom(body.link)}/accept`,
          json({ name: email.split("@")[0], password: "correct horse battery" }),
        );
        expect(res.status).toBe(201);
        return cookieOf(res);
      };
      const getAs = (path: string, cookie: string) => app.request(path, { headers: { cookie } });
      const idOf = async (cookie: string) =>
        ((await (await getAs("/api/me", cookie)).json()) as { user: { id: string } }).user.id;

      interface ReviewBody {
        id: string;
        status: string;
        outcome: string | null;
        reviewers: {
          id: string;
          userId: string;
          state: string;
          decision: string | null;
          guest?: boolean;
          email?: string | null;
        }[];
        decisions: { decision: string; reviewerName: string | null }[];
        items: {
          id: string;
          kind: string;
          fileId: string | null;
          version?: { number: number } | null;
        }[];
        you: { active: boolean; canDecide: boolean; canSubmit: boolean };
      }
      const reviewOf = async (res: Response) =>
        ((await res.json()) as { review: ReviewBody }).review;

      /** A project with a track of one version and a loose file, and three colleagues. */
      const studio = async () => {
        const owner = cookieOf(await setup());
        const organisationId = (
          (await (await getAs("/api/me", owner)).json()) as { activeOrganisationId: string }
        ).activeOrganisationId;
        const made = await app.request(
          "/api/projects",
          json({ name: "Rags", profile: "music" }, owner),
        );
        const projectId = ((await made.json()) as { project: { id: string } }).project.id;
        const file = async (name: string) => {
          const blob = await storage.put(organisationId, Buffer.from(name));
          const [row] = await db
            .insert(schema.files)
            .values({
              organisationId,
              projectId,
              name,
              kind: "audio",
              blobId: blob.id,
              contentType: "audio/wav",
              byteSize: blob.byteSize,
              mediaInfo: {
                duration: 60,
                audio: { codec: "pcm_s24le", channels: 2, sampleRate: 48000 },
              },
            })
            .returning();
          return row?.id ?? "";
        };
        const mix = await file("Mix v1.wav");
        const artwork = await file("Cover.wav");
        const track = await app.request(
          `/api/projects/${projectId}/tracks`,
          json({ name: "Maple Leaf Rag" }, owner),
        );
        const trackId = ((await track.json()) as { track: { id: string } }).track.id;
        await app.request(
          `/api/tracks/${trackId}/versions`,
          json({ variations: [{ fileId: mix, name: "Mix" }] }, owner),
        );
        const composer = await joinAs(owner, "composer@example.test");
        const accompanist = await joinAs(owner, "accompanist@example.test");
        const engineer = await joinAs(owner, "engineer@example.test");
        await grantRole(owner, projectId, composer, "Reviewer");
        await grantRole(owner, projectId, accompanist, "Reviewer");
        await grantRole(owner, projectId, engineer, "Engineer");
        return {
          owner,
          organisationId,
          projectId,
          trackId,
          mix,
          artwork,
          composer,
          accompanist,
          engineer,
          ids: {
            owner: await idOf(owner),
            composer: await idOf(composer),
            accompanist: await idOf(accompanist),
            engineer: await idOf(engineer),
          },
        };
      };
      const request = (cookie: string, projectId: string, body: Record<string, unknown>) =>
        app.request(`/api/projects/${projectId}/reviews`, json(body, cookie));

      it("compares two versions: how they line up, what was fixed and new, comments carried (#137)", async () => {
        const s = await studio();
        // A second version, with the cover's audio as its mix.
        expect(
          (
            await app.request(
              `/api/tracks/${s.trackId}/versions`,
              json({ variations: [{ fileId: s.artwork, name: "Mix" }] }, s.owner),
            )
          ).status,
        ).toBe(201);
        // A click the first version had, a dropout only the second has.
        const found = (fileId: string, check: "clipping" | "dropouts", start: number) => ({
          organisationId: s.organisationId,
          fileId,
          check,
          severity: "fail" as const,
          summary: check,
          channel: 0,
          start,
          end: start + 0.1,
          details: {},
        });
        await db
          .insert(schema.qaFindings)
          .values([found(s.mix, "clipping", 12), found(s.artwork, "dropouts", 40)]);
        await db
          .update(schema.files)
          .set({ analysisStatus: "ready" })
          .where(inArray(schema.files.id, [s.mix, s.artwork]));
        await app.request(
          `/api/files/${s.mix}/comments`,
          json({ body: "Pedal", anchor: { kind: "time", start: 30, end: 31 } }, s.owner),
        );
        type Compared = {
          a: { number: number; fileId: string };
          b: { number: number; fileId: string };
          alignment: { status: string; quality: number | null; points: unknown };
          findings: { measured: boolean; fixed: { check: string }[]; new: { check: string }[] };
          comments: { body: string; start: number; mapped: number | null }[];
        };
        const compare = async (cookie = s.owner, query = "") => {
          const res = await getAs(`/api/tracks/${s.trackId}/compare${query}`, cookie);
          return res.status === 200 ? ((await res.json()) as Compared) : res.status;
        };
        // The latest two by default; the music is still being lined up.
        const first = (await compare()) as Compared;
        expect([first.a.number, first.b.number]).toEqual([1, 2]);
        expect(first.alignment.status).toBe("aligning");
        expect(first.findings).toMatchObject({
          measured: true,
          fixed: [{ check: "clipping" }],
          new: [{ check: "dropouts" }],
        });
        expect(first.comments).toEqual([
          { id: expect.any(String), body: "Pedal", start: 30, mapped: null },
        ]);
        // The QA view of the later version says the same, against the version before (#43).
        const changes = async (fileId: string, cookie = s.owner) =>
          (await (await getAs(`/api/files/${fileId}/qa/changes`, cookie)).json()) as {
            previous: { number: number; name: string } | null;
            measured: boolean;
            fixed: { check: string }[];
            new: { check: string }[];
          };
        expect(await changes(s.artwork)).toMatchObject({
          previous: { number: 1, name: "Mix" },
          measured: true,
          fixed: [{ check: "clipping" }],
          new: [{ check: "dropouts" }],
        });
        // The first version has nothing before it.
        expect(await changes(s.mix)).toMatchObject({ previous: null, fixed: [], new: [] });

        // Once aligned, comments follow the music to where it went.
        const [row] = await db
          .select({ id: schema.alignments.id })
          .from(schema.alignments)
          .where(eq(schema.alignments.fromFileId, s.mix));
        const align = (quality: number) =>
          db
            .update(schema.alignments)
            .set({
              status: "ready",
              quality,
              points: [
                [0, 0],
                [60, 62],
              ],
            })
            .where(eq(schema.alignments.id, row?.id ?? ""));
        await align(0.9);
        const aligned = (await compare()) as Compared;
        expect(aligned.alignment).toMatchObject({ status: "ready", quality: 0.9 });
        expect(aligned.comments[0]?.mapped).toBeCloseTo(31, 5);
        // A click the edit moved two seconds later is the same click, whichever side is A.
        await db
          .insert(schema.qaFindings)
          .values([found(s.mix, "clipping", 54), found(s.artwork, "clipping", 54 + 1.8)]);
        const forward = (await compare()) as Compared;
        const back = (await compare(s.owner, "?a=2&b=1")) as Compared;
        for (const both of [forward, back]) {
          expect(both.findings).toMatchObject({
            fixed: [{ check: "clipping" }],
            new: [{ check: "dropouts" }],
          });
        }

        // Too poor to follow: said so, and worked out again on request.
        await align(0.31);
        expect(((await compare()) as Compared).alignment).toEqual({
          status: "poor",
          quality: 0.31,
          points: null,
        });
        const realign = (cookie: string) =>
          app.request(`/api/tracks/${s.trackId}/compare/realign`, json({ a: 1, b: 2 }, cookie));
        // A Reviewer compares, but does not set the work going.
        expect((await compare(s.composer)) as Compared).toMatchObject({ a: { number: 1 } });
        expect((await realign(s.composer)).status).toBe(403);
        const again = await realign(s.owner);
        expect(again.status).toBe(202);
        expect(await again.json()).toEqual({ queued: 1 });
        expect(((await compare()) as Compared).alignment.status).toBe("aligning");

        // Without reading comments, compare shows none of them.
        const reviewer = and(
          eq(schema.projectRoles.projectId, s.projectId),
          eq(schema.projectRoles.name, "Reviewer"),
        );
        await db
          .update(schema.projectRoles)
          .set({ permissions: ["view"] })
          .where(reviewer);
        expect(((await compare(s.composer)) as Compared).comments).toEqual([]);

        // By default the latest two that can be played, not one still being prepared.
        const [third] = await db
          .insert(schema.files)
          .values({
            organisationId: s.organisationId,
            projectId: s.projectId,
            name: "Mix v3.wav",
            kind: "audio",
            blobId: (await storage.put(s.organisationId, Buffer.from("v3"))).id,
            contentType: "audio/wav",
            byteSize: 2,
            streamStatus: "pending",
          })
          .returning({ id: schema.files.id });
        await app.request(
          `/api/tracks/${s.trackId}/versions`,
          json({ variations: [{ fileId: third?.id, name: "Mix" }] }, s.owner),
        );
        expect(((await compare()) as Compared).b.number).toBe(3);
        await db
          .update(schema.files)
          .set({ streamStatus: "ready" })
          .where(inArray(schema.files.id, [s.mix, s.artwork]));
        const playable = (await compare()) as Compared;
        expect([playable.a.number, playable.b.number]).toEqual([1, 2]);
        expect((await compare(s.owner, "?a=3")) as Compared).toMatchObject({
          a: { number: 3 },
          b: { number: 2 },
        });

        // Without the compare tool, refused; one version alone, nothing to compare; another
        // workspace's track, none at all.
        await db
          .update(schema.projectRoles)
          .set({ tools: ["score"] })
          .where(
            and(
              eq(schema.projectRoles.projectId, s.projectId),
              eq(schema.projectRoles.name, "Reviewer"),
            ),
          );
        expect(await compare(s.composer)).toBe(403);
        expect(await compare(s.owner, "?a=1&b=1")).toBe(422);
        expect(
          (await getAs("/api/tracks/0190a6f0-0000-7000-8000-0000000000ff/compare", s.owner)).status,
        ).toBe(404);
        // What changed since the previous version: nothing for a member outside the project,
        // nor for the owner of another workspace.
        const outsider = await joinAs(s.owner, "outsider-qa-changes@example.test");
        const changesStatus = async () =>
          (await getAs(`/api/files/${s.artwork}/qa/changes`, outsider)).status;
        expect(await changesStatus()).toBe(404);
        const [other] = await db
          .insert(schema.organisations)
          .values({ name: "Saltmarsh Films", slug: "saltmarsh-qa-changes" })
          .returning({ id: schema.organisations.id });
        await db
          .insert(schema.members)
          .values({ organisationId: other?.id ?? "", userId: await idOf(outsider), role: "owner" });
        expect(
          (
            await app.request("/api/me/organisation", {
              ...json({ organisationId: other?.id }, outsider),
              method: "PUT",
            })
          ).status,
        ).toBe(200);
        expect(await changesStatus()).toBe(404);
      });

      it("runs a review from its page: due date, reminders, notes, opened items and activity", async () => {
        const s = await studio();
        const path = (id: string, rest = "") => `/api/reviews/${id}${rest}`;
        const send = (method: string, url: string, body: unknown, cookie: string) =>
          app.request(url, { ...json(body, cookie), method });
        interface PageReview extends ReviewBody {
          dueAt: string | null;
          cancelReason: string | null;
          cancelledByName: string | null;
          items: (ReviewBody["items"][number] & { id: string; openComments: number | null })[];
          reviewers: (ReviewBody["reviewers"][number] & {
            name: string;
            note: string | null;
            comments: { count: number; fileId: string } | null;
            permissions: { comments: string; tools: string[] } | null;
          })[];
          activity: { action: string; name: string; note: string | null; subject: string | null }[];
          you: ReviewBody["you"] & { opened: string[] };
        }
        const pageOf = async (res: Response) =>
          ((await res.json()) as { review: PageReview }).review;
        const made = await pageOf(
          await request(s.owner, s.projectId, {
            kind: "approval",
            title: "Master sign-off",
            items: [{ trackId: s.trackId }, { fileId: s.artwork }],
            reviewers: [
              s.ids.composer,
              s.ids.accompanist,
              { name: "Ines Arlow", email: "ines@example.test" },
            ],
            order: "sequence",
            dueAt: "2026-11-01T17:00:00Z",
          }),
        );
        const trackItem = made.items.find((i) => i.kind === "track")?.id ?? "";

        // The composer listens to the mix and says something about it.
        expect((await getAs(`/api/files/${s.mix}`, s.composer)).status).toBe(200);
        await app.request(`/api/files/${s.mix}/comments`, json({ body: "Pedal" }, s.composer));
        const theirs = await pageOf(await getAs(path(made.id), s.composer));
        expect(theirs.you.opened).toEqual([trackItem]);
        // Its project's profile names its items in the project's words (#16).
        expect((theirs as PageReview & { profile: string }).profile).toBe("music");
        const seen = await pageOf(await getAs(path(made.id), s.owner));
        expect(seen.reviewers[0]?.comments).toMatchObject({ count: 1, fileId: s.mix });
        expect(seen.items.find((i) => i.id === trackItem)?.openComments).toBe(1);

        // The due date is the requester's to change; a reviewer may not.
        const later = { dueAt: "2026-11-08T17:00:00Z" };
        expect((await send("PATCH", path(made.id), later, s.composer)).status).toBe(403);
        const moved = await send("PATCH", path(made.id), later, s.owner);
        expect(moved.status).toBe(200);
        expect((await pageOf(moved)).dueAt).toBe("2026-11-08T17:00:00.000Z");
        expect((await send("PATCH", path(made.id), { dueAt: "soon" }, s.owner)).status).toBe(400);

        // Reminders go to whoever the review is waiting on now, a few an hour.
        const remind = (body: unknown, cookie = s.owner) =>
          app.request(path(made.id, "/remind"), json(body, cookie));
        expect((await remind({}, s.composer)).status).toBe(403);
        // Another producer reminds: the reminder is from them, not whoever asked.
        const producer = await joinAs(s.owner, "coproducer@example.test");
        await grantRole(s.owner, s.projectId, producer, "Producer");
        const reminded = await remind({}, producer);
        expect(reminded.status).toBe(200);
        expect(await reminded.json()).toEqual({ reminded: 1 });
        const [reminder] = await db
          .select({ actor: schema.notifications.actorUserId })
          .from(schema.notifications)
          .where(
            and(
              eq(schema.notifications.userId, s.ids.composer),
              like(schema.notifications.text, "reminds you%"),
            ),
          );
        expect(reminder?.actor).toBe(await idOf(producer));
        const second = seen.reviewers[1]?.id ?? "";
        expect((await remind({ reviewerId: second })).status).toBe(409);
        for (let i = 0; i < 4; i++) expect((await remind({})).status).toBe(200);
        expect((await remind({})).status).toBe(429);

        // A decision's note reads beside the reviewer.
        await app.request(
          path(made.id, "/decisions"),
          json({ decision: "approved", note: "Lovely balance" }, s.composer),
        );
        const decided = await pageOf(await getAs(path(made.id), s.owner));
        expect(decided.reviewers[0]?.note).toBe("Lovely balance");

        // Cancelled, with the reason, by whom.
        expect(
          (await app.request(path(made.id, "/cancel"), json({ reason: "Wrong mix" }, s.composer)))
            .status,
        ).toBe(403);
        const cancelled = await pageOf(
          await app.request(path(made.id, "/cancel"), json({ reason: "Wrong mix" }, s.owner)),
        );
        expect(cancelled).toMatchObject({
          status: "cancelled",
          cancelReason: "Wrong mix",
          cancelledByName: "Producer",
        });
        expect((await send("PATCH", path(made.id), later, s.owner)).status).toBe(409);

        // The activity says who did what, newest first, with names and never addresses.
        const actions = cancelled.activity.map((a) => a.action);
        expect(actions[0]).toBe("review.cancel");
        expect(actions).toEqual(
          expect.arrayContaining([
            "review.create",
            "review.due",
            "review.remind",
            "review.decision",
          ]),
        );
        expect(cancelled.activity.find((a) => a.action === "review.cancel")?.note).toBe(
          "Wrong mix",
        );
        expect(cancelled.activity.find((a) => a.action === "review.decision")?.note).toBe(
          "Lovely balance",
        );
        expect(JSON.stringify(cancelled.activity)).not.toContain("@");
        // Members who review see it too; guests never do.
        expect(
          (await pageOf(await getAs(path(made.id), s.composer))).activity.length,
        ).toBeGreaterThan(0);

        // Feedback is submitted with a word about the whole.
        const feedback = await pageOf(
          await request(s.owner, s.projectId, {
            kind: "feedback",
            title: "First listen",
            items: [{ fileId: s.artwork }],
            reviewers: [s.ids.composer, { name: "Ines Arlow", email: "ines@example.test" }],
          }),
        );
        const submitted = await pageOf(
          await app.request(
            path(feedback.id, "/submit"),
            json({ note: "Warm overall" }, s.composer),
          ),
        );
        expect(submitted.reviewers[0]?.note).toBe("Warm overall");
        expect(submitted.activity.find((a) => a.action === "review.submit")?.note).toBe(
          "Warm overall",
        );
        // A guest's link is in the activity by name; their address stays in the access log.
        expect(submitted.activity.find((a) => a.action === "guest.link")?.name).toBe("Ines Arlow");
        expect(JSON.stringify(submitted.activity)).not.toContain("@");

        // Someone asked later may do what everyone was granted, and no more.
        const narrow = await pageOf(
          await request(s.owner, s.projectId, {
            kind: "feedback",
            title: "Private notes",
            items: [{ fileId: s.artwork }],
            reviewers: [s.ids.composer],
            permissions: { comments: "own", tools: ["loops"] },
          }),
        );
        const widened = await pageOf(
          await app.request(
            path(narrow.id, "/reviewers"),
            json({ name: "Tomas Varga", email: "tomas.varga@example.test" }, s.owner),
          ),
        );
        expect(widened.reviewers.find((r) => r.name === "Tomas Varga")?.permissions).toMatchObject({
          comments: "own",
          tools: ["loops"],
        });

        // Another workspace's review does not exist from here.
        const [elsewhere] = await db
          .insert(schema.organisations)
          .values({ name: "Elsewhere", slug: "elsewhere-review-page" })
          .returning();
        const [project] = await db
          .insert(schema.projects)
          .values({ organisationId: elsewhere?.id ?? "", name: "Theirs", profile: "music" })
          .returning();
        const [foreign] = await db
          .insert(schema.reviews)
          .values({
            organisationId: elsewhere?.id ?? "",
            projectId: project?.id ?? "",
            kind: "approval",
            title: "Theirs",
            rule: "all",
          })
          .returning();
        expect((await send("PATCH", path(foreign?.id ?? ""), later, s.owner)).status).toBe(404);
        expect((await remind({}, s.owner)).status).toBe(409);
        expect(
          (await app.request(path(foreign?.id ?? "", "/remind"), json({}, s.owner))).status,
        ).toBe(404);
      });

      it("deletes an account, keeping its comments and decisions as a former member's", async () => {
        const s = await studio();
        const remove = (cookie: string, body: Record<string, unknown>) =>
          app.request("/api/me", { ...json(body, cookie), method: "DELETE" });
        const errorOf = async (res: Response) =>
          ((await res.json()) as { error: { code: string; message: string } }).error;

        // The only owner hands the workspace on first.
        const sole = await remove(s.owner, { email: owner.email, password: owner.password });
        expect(sole.status).toBe(409);
        expect((await errorOf(sole)).message).toContain("Studio");

        // The composer comments and approves, then deletes their account.
        const said = await app.request(
          `/api/files/${s.mix}/comments`,
          json({ body: "The coda is lovely." }, s.composer),
        );
        expect(said.status).toBe(201);
        const review = await reviewOf(
          await request(s.owner, s.projectId, {
            kind: "approval",
            title: "Master sign-off",
            items: [{ trackId: s.trackId }],
            reviewers: [s.ids.composer, s.ids.accompanist],
          }),
        );
        await app.request(
          `/api/reviews/${review.id}/decisions`,
          json({ decision: "approved" }, s.composer),
        );
        // The address must be theirs, and the password right.
        expect(
          (
            await remove(s.composer, {
              email: "someone@example.test",
              password: "correct horse battery",
            })
          ).status,
        ).toBe(403);
        expect(
          (await remove(s.composer, { email: "composer@example.test", password: "wrong password" }))
            .status,
        ).toBe(403);
        // An invitation to their address waits in a workspace they never joined.
        const [elsewhere] = await db
          .insert(schema.organisations)
          .values({ name: "Elsewhere", slug: "elsewhere" })
          .returning();
        await db.insert(schema.invitations).values({
          organisationId: elsewhere?.id ?? "",
          email: "composer@example.test",
          role: "member",
          tokenHash: "pending-invitation-hash",
          expiresAt: new Date(Date.now() + 86_400_000),
        });
        const gone = await remove(s.composer, {
          email: "Composer@Example.test",
          password: "correct horse battery",
        });
        expect(gone.status).toBe(204);
        // Their address has left every invitation, and the one still open is withdrawn.
        const invited = await db.select().from(schema.invitations);
        expect(invited.filter((i) => i.email.includes("composer"))).toEqual([]);
        expect(invited.find((i) => i.organisationId === elsewhere?.id)?.revokedAt).not.toBeNull();
        // A request that read their name before the deletion cannot write it back to the log.
        await audit.record(
          s.organisationId,
          { type: "member", userId: s.ids.composer, label: "Composer <composer@example.test>" },
          { action: "comment.create" },
        );

        // Signed out everywhere, and no way back in.
        expect((await getAs("/api/me", s.composer)).status).toBe(401);
        expect(
          (
            await app.request(
              "/api/auth/sign-in/email",
              json({ email: "composer@example.test", password: "correct horse battery" }),
            )
          ).status,
        ).toBe(401);

        // What they wrote and decided stays, with no name or address of theirs.
        const comments = (await (await getAs(`/api/files/${s.mix}/comments`, s.owner)).json()) as {
          comments: { body: string; authorName: string | null }[];
        };
        expect(comments.comments).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ body: "The coda is lovely.", authorName: "A former member" }),
          ]),
        );
        const after = (await (await getAs(`/api/reviews/${review.id}`, s.owner)).json()) as {
          review: ReviewBody;
        };
        expect(after.review.decisions).toEqual([
          expect.objectContaining({ decision: "approved", reviewerName: "A former member" }),
        ]);
        const [row] = await db
          .select()
          .from(schema.users)
          .where(eq(schema.users.id, s.ids.composer));
        expect(row?.name).toBe("A former member");
        expect(row?.email).not.toContain("composer");
        expect(row?.deletedAt).not.toBeNull();
        // The access log keeps every entry, none naming them; the deletion is one of them.
        const trail = await db
          .select({ action: schema.accessEvents.action, label: schema.accessEvents.actorLabel })
          .from(schema.accessEvents)
          .where(eq(schema.accessEvents.userId, s.ids.composer));
        expect(trail.length).toBeGreaterThan(1);
        for (const entry of trail) expect(entry.label).toBe("A former member");
        expect(trail.map((e) => e.action)).toContain("account.deleted");
        // The log still refuses any other change.
        const [someoneElse] = await db
          .select({ id: schema.accessEvents.id })
          .from(schema.accessEvents)
          .where(
            and(
              eq(schema.accessEvents.organisationId, s.organisationId),
              ne(schema.accessEvents.userId, s.ids.composer),
            ),
          )
          .limit(1);
        expect(someoneElse).toBeDefined();
        await expect(
          db
            .update(schema.accessEvents)
            .set({ actorLabel: "A former member" })
            .where(eq(schema.accessEvents.id, someoneElse?.id ?? "")),
        ).rejects.toThrow();
        // They are no longer a member anywhere.
        expect(
          await db.select().from(schema.members).where(eq(schema.members.userId, s.ids.composer)),
        ).toEqual([]);
      });

      it("lets someone in no workspace delete their account", async () => {
        const s = await studio();
        // Removed from their only workspace, they are still signed in, with nowhere to go.
        await db.delete(schema.members).where(eq(schema.members.userId, s.ids.composer));
        expect((await getAs("/api/projects", s.composer)).status).toBe(403);
        const gone = await app.request("/api/me", {
          ...json(
            { email: "composer@example.test", password: "correct horse battery" },
            s.composer,
          ),
          method: "DELETE",
        });
        expect(gone.status).toBe(204);
        // Without a session, nothing.
        expect(
          (
            await app.request("/api/me", {
              ...json({ email: "composer@example.test", password: "correct horse battery" }),
              method: "DELETE",
            })
          ).status,
        ).toBe(401);
      });

      it("asks an account with no password for a fresh sign-in before deleting it", async () => {
        const s = await studio();
        const del = (body: object) =>
          app.request("/api/me", { ...json(body, s.composer), method: "DELETE" });
        const codeOf = async (res: Response) =>
          ((await res.json()) as { error: { code: string } }).error.code;
        // With a password, the password confirms it: leaving it out is refused.
        const without = await del({ email: "composer@example.test" });
        expect(without.status).toBe(403);
        expect(await codeOf(without)).toBe("confirm_refused");
        // Signed in only through single sign-on (#37): no password here to give.
        await db
          .delete(schema.authAccounts)
          .where(
            and(
              eq(schema.authAccounts.userId, s.ids.composer),
              eq(schema.authAccounts.providerId, "credential"),
            ),
          );
        await db.insert(schema.authAccounts).values({
          id: "sso-link",
          userId: s.ids.composer,
          accountId: "kc-composer",
          providerId: "workspace-endless",
        });
        const confirm = async () =>
          (await (await getAs("/api/me/deletion", s.composer)).json()) as {
            with: string;
            providerId: string | null;
            fresh: boolean;
          };
        expect(await confirm()).toEqual({
          with: "sign_in",
          providerId: "workspace-endless",
          fresh: true,
        });
        // A sign-in more than ten minutes old does not confirm it.
        const aged = (minutes: number) =>
          db
            .update(schema.authSessions)
            .set({ createdAt: new Date(Date.now() - minutes * 60_000) })
            .where(eq(schema.authSessions.userId, s.ids.composer));
        await aged(11);
        expect((await confirm()).fresh).toBe(false);
        const stale = await del({ email: "composer@example.test" });
        expect(stale.status).toBe(403);
        expect(await codeOf(stale)).toBe("sign_in_again");
        // Signed in again just now, the address alone confirms it.
        await aged(1);
        expect((await del({ email: "someone@example.test" })).status).toBe(403);
        expect((await del({ email: "composer@example.test" })).status).toBe(204);
      });

      it("sums up one project for its overview, as each role may see it, and keeps each person's layout", async () => {
        const s = await studio();
        type Overview = {
          figures: {
            tracks: number;
            openReviews: number;
            openComments: number | null;
            nextDueAt: string | null;
          };
          failed: { id: string }[];
          qaFailing: { id: string; name: string; summary: string }[];
          overdue: { title: string; waitingOn: { name: string }[] }[];
          tracks: {
            name: string;
            state: string;
            version: { number: number } | null;
            waitingOn: { name: string }[];
          }[];
          activity: { kind: string }[];
          role: string | null;
          layout: string[] | null;
        };
        const overview = async (cookie: string) => {
          const res = await getAs(`/api/projects/${s.projectId}/overview`, cookie);
          expect(res.status).toBe(200);
          return (await res.json()) as Overview;
        };
        const before = await overview(s.owner);
        expect(before.tracks).toEqual([
          expect.objectContaining({
            name: "Maple Leaf Rag",
            state: "not_reviewed",
            version: expect.objectContaining({ number: 1 }),
          }),
        ]);
        expect(before.role).toBe("Producer");

        // An approval past its due date, in order: it waits on the composer, whose step comes
        // first, and not yet on the accompanist after them.
        const asked = await request(s.owner, s.projectId, {
          kind: "approval",
          title: "Master sign-off",
          rule: "all",
          order: "sequence",
          dueAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
          items: [{ trackId: s.trackId }],
          reviewers: [s.ids.composer, s.ids.accompanist],
        });
        expect(asked.status).toBe(201);
        const owner = await overview(s.owner);
        expect(owner.figures.openReviews).toBe(1);
        expect(owner.figures.nextDueAt).not.toBeNull();
        expect(owner.figures.openComments).toBe(0);
        expect(owner.tracks[0]).toMatchObject({
          state: "in_review",
          waitingOn: [{ name: "composer" }],
        });
        expect(owner.overdue).toEqual([
          expect.objectContaining({
            title: "Master sign-off",
            waitingOn: [expect.objectContaining({ name: "composer" })],
          }),
        ]);
        expect(owner.activity.map((a) => a.kind)).toContain("review");

        // A file fails here exactly as its QA page says it does, delivery checks included.
        const qaPage = (await (await getAs(`/api/files/${s.mix}/qa`, s.owner)).json()) as {
          findings: { severity: string; summary: string }[];
        };
        const worst = qaPage.findings.find((f) => f.severity === "fail");
        expect(worst).toBeDefined();
        expect(owner.qaFailing.find((f) => f.id === s.mix)?.summary).toBe(worst?.summary);

        // The file browser's lists carry the same standing, and each file's open threads.
        const listed = (await (
          await getAs(`/api/projects/${s.projectId}/tracks`, s.owner)
        ).json()) as {
          tracks: { state: string; waitingOn: { name: string }[] }[];
        };
        expect(listed.tracks[0]).toMatchObject({
          state: "in_review",
          waitingOn: [{ name: "composer" }],
        });
        await app.request(
          `/api/files/${s.mix}/comments`,
          json({ body: "Pedal noise at bar 12" }, s.owner),
        );
        const filesList = (await (
          await getAs(`/api/projects/${s.projectId}/files`, s.owner)
        ).json()) as {
          files: { id: string; openComments: number; uploadedById: string | null }[];
        };
        expect(filesList.files.find((f) => f.id === s.mix)?.openComments).toBe(1);

        // A Reviewer neither triages nor uploads: no thread count, no failed files.
        const composer = await overview(s.composer);
        expect(composer.figures.openComments).toBeNull();
        expect(composer.failed).toEqual([]);
        expect(composer.role).toBe("Reviewer");

        // Each person's own order, refused when it is not one.
        const layout = (cookie: string, sections: unknown) =>
          app.request(`/api/projects/${s.projectId}/overview/layout`, {
            ...json({ sections }, cookie),
            method: "PUT",
          });
        expect((await layout(s.composer, ["tracks", "attention"])).status).toBe(200);
        expect((await overview(s.composer)).layout).toEqual(["tracks", "attention"]);
        expect((await overview(s.owner)).layout).toBeNull();
        expect((await layout(s.composer, ["tasks"])).status).toBe(400);
        expect((await layout(s.composer, ["stats", "stats"])).status).toBe(400);

        // Someone outside the project finds nothing.
        const outsider = await joinAs(s.owner, "outsider-overview@example.test");
        expect((await getAs(`/api/projects/${s.projectId}/overview`, outsider)).status).toBe(404);
        expect((await layout(outsider, ["stats"])).status).toBe(404);
      });

      it("tags files for the whole workspace, and only with its own tags", async () => {
        const s = await studio();
        const put = (cookie: string, fileId: string, tagIds: string[]) =>
          app.request(`/api/files/${fileId}/tags`, { ...json({ tagIds }, cookie), method: "PUT" });
        const made = await app.request("/api/tags", json({ name: "  Masters " }, s.engineer));
        expect(made.status).toBe(201);
        const masters = ((await made.json()) as { tag: { id: string; name: string } }).tag;
        expect(masters.name).toBe("Masters");
        // One "Masters" however it is written.
        expect((await app.request("/api/tags", json({ name: "masters" }, s.owner))).status).toBe(
          409,
        );

        // Tagging is organising: an Engineer may, a Reviewer may not.
        expect((await put(s.engineer, s.mix, [masters.id])).status).toBe(200);
        expect((await put(s.composer, s.mix, [])).status).toBe(403);
        const listed = (await (
          await getAs(`/api/projects/${s.projectId}/files`, s.composer)
        ).json()) as { files: { id: string; tagIds: string[] }[] };
        expect(listed.files.find((f) => f.id === s.mix)?.tagIds).toEqual([masters.id]);
        expect(listed.files.find((f) => f.id === s.artwork)?.tagIds).toEqual([]);

        // Another workspace's tag is not one to use, nor one to see.
        const [other] = await db
          .insert(schema.organisations)
          .values({ name: "Elsewhere", slug: "elsewhere-tags" })
          .returning();
        const [foreign] = await db
          .insert(schema.tags)
          .values({ organisationId: other?.id ?? "", name: "Theirs" })
          .returning();
        expect((await put(s.engineer, s.mix, [masters.id, foreign?.id ?? ""])).status).toBe(422);
        const tags = (await (await getAs("/api/tags", s.composer)).json()) as {
          tags: { name: string; files: number }[];
        };
        expect(tags.tags).toEqual([expect.objectContaining({ name: "Masters", files: 1 })]);

        // Search finds a file by its tag's name, and narrows to a tag.
        const search = async (query: string) =>
          (
            (await (await getAs(`/api/search?${query}`, s.owner)).json()) as {
              results: { kind: string; id: string }[];
            }
          ).results;
        expect((await search("q=masters")).map((r) => r.id)).toContain(s.mix);
        expect((await search(`tagId=${masters.id}`)).map((r) => [r.kind, r.id])).toEqual([
          ["files", s.mix],
        ]);

        // Renaming and deleting change every project's files: owners and admins only.
        const rename = (cookie: string) =>
          app.request(`/api/tags/${masters.id}`, {
            ...json({ name: "Finals" }, cookie),
            method: "PATCH",
          });
        expect((await rename(s.engineer)).status).toBe(403);
        expect((await rename(s.owner)).status).toBe(200);
        const remove = (cookie: string, id = masters.id) =>
          app.request(`/api/tags/${id}`, { method: "DELETE", headers: { cookie } });
        expect((await remove(s.engineer)).status).toBe(403);
        expect((await remove(s.owner, foreign?.id)).status).toBe(404);
        expect((await remove(s.owner)).status).toBe(204);
        const after = (await (
          await getAs(`/api/projects/${s.projectId}/files`, s.owner)
        ).json()) as { files: { id: string; tagIds: string[] }[] };
        expect(after.files.find((f) => f.id === s.mix)?.tagIds).toEqual([]);
      });

      it("prepares a failed file again, once, for those who may upload", async () => {
        const s = await studio();
        await db
          .update(schema.files)
          .set({ streamStatus: "failed", analysisStatus: "failed" })
          .where(eq(schema.files.id, s.mix));
        const retry = (cookie: string) =>
          app.request(`/api/files/${s.mix}/retry`, json({}, cookie));
        expect((await retry(s.composer)).status).toBe(403);
        sent.length = 0;
        const res = await retry(s.engineer);
        expect(res.status).toBe(202);
        expect(sent.map((j) => j.name)).toEqual(["media-proxy", "media-analysis"]);
        const [row] = await db
          .select({ stream: schema.files.streamStatus, analysis: schema.files.analysisStatus })
          .from(schema.files)
          .where(eq(schema.files.id, s.mix));
        expect(row).toEqual({ stream: "pending", analysis: "pending" });
        // Already under way: nothing failed now.
        expect((await retry(s.engineer)).status).toBe(409);
        const outsider = await joinAs(s.owner, "outsider-retry@example.test");
        expect((await retry(outsider)).status).toBe(404);

        // A queue that does not take the work leaves that stage failed, to be tried again.
        await db
          .update(schema.files)
          .set({ streamStatus: "failed", analysisStatus: "failed" })
          .where(eq(schema.files.id, s.mix));
        failNextSend = true;
        expect((await retry(s.engineer)).status).toBe(503);
        const [after] = await db
          .select({ stream: schema.files.streamStatus, analysis: schema.files.analysisStatus })
          .from(schema.files)
          .where(eq(schema.files.id, s.mix));
        expect(after).toEqual({ stream: "failed", analysis: "pending" });
      });

      it("tells everything about one file, and what each role may do with it", async () => {
        const s = await studio();
        type Details = {
          file: { name: string; uploadedBy: string | null };
          storage: { backend: string; encrypted: boolean; sha256: string | null };
          usedIn: {
            versions: { track: string; number: number; variation: string; latest: boolean }[];
            reviews: { title: string }[];
          };
          can: { organise: boolean; log: boolean; delete: boolean };
        };
        const details = async (cookie: string, fileId: string) => {
          const res = await getAs(`/api/files/${fileId}/details`, cookie);
          return { status: res.status, body: (await res.json()) as Details };
        };
        const mix = await details(s.composer, s.mix);
        expect(mix.status).toBe(200);
        expect(mix.body.file.name).toBe("Mix v1.wav");
        expect(mix.body.storage).toMatchObject({ backend: "local", encrypted: true });
        expect(mix.body.storage).not.toHaveProperty("key");
        expect(mix.body.usedIn.versions).toEqual([
          expect.objectContaining({
            track: "Maple Leaf Rag",
            number: 1,
            variation: "Mix",
            latest: true,
          }),
        ]);
        // A Reviewer sees the facts but neither organises nor reads the log.
        expect(mix.body.can).toEqual(
          expect.objectContaining({ organise: false, log: false, delete: false }),
        );

        // A review of the track's latest asks about this file too, so it stays.
        await request(s.owner, s.projectId, {
          kind: "feedback",
          title: "First listen",
          items: [{ trackId: s.trackId }],
          reviewers: [s.ids.composer],
        });
        const owned = await details(s.owner, s.mix);
        expect(owned.body.usedIn.reviews.map((r) => r.title)).toEqual(["First listen"]);
        expect(owned.body.can).toEqual(
          expect.objectContaining({ organise: true, log: true, delete: false }),
        );
        expect((await details(s.owner, s.artwork)).body.can.delete).toBe(true);

        // Someone outside the project finds nothing.
        const outsider = await joinAs(s.owner, "outsider-details@example.test");
        expect((await details(outsider, s.mix)).status).toBe(404);
      });

      it("keeps each member's file columns for this workspace", async () => {
        const s = await studio();
        const columnsOf = async (cookie: string) =>
          ((await (await getAs("/api/me/file-columns", cookie)).json()) as { columns: unknown })
            .columns;
        const put = (cookie: string, columns: unknown) =>
          app.request("/api/me/file-columns", { ...json({ columns }, cookie), method: "PUT" });
        expect(await columnsOf(s.composer)).toBeNull();
        const mine = [
          { id: "tags", width: 160 },
          { id: "status", width: 120 },
        ];
        expect((await put(s.composer, mine)).status).toBe(200);
        expect(await columnsOf(s.composer)).toEqual(mine);
        expect(await columnsOf(s.owner)).toBeNull();
        expect((await put(s.composer, [mine[0], mine[0]])).status).toBe(400);
        expect((await put(s.composer, [{ id: "tags", width: 9999 }])).status).toBe(400);
        expect((await put(s.composer, [{ id: "colour", width: 100 }])).status).toBe(400);
      });

      it("keeps each person's pins, favourites and seen files to themselves", async () => {
        const s = await studio();
        const mark = (cookie: string, body: Record<string, unknown>, projectId = s.projectId) =>
          app.request(`/api/projects/${projectId}/marks`, json(body, cookie));
        const marksOf = async (cookie: string) =>
          (
            (await (await getAs(`/api/projects/${s.projectId}/marks`, cookie)).json()) as {
              marks: {
                kind: string;
                id: string;
                pinned: boolean;
                favourite: boolean;
                viewed: boolean;
              }[];
            }
          ).marks;

        // A Reviewer marks what they can see, for themselves.
        expect(
          (await mark(s.composer, { items: [{ kind: "track", id: s.trackId }], pinned: true }))
            .status,
        ).toBe(204);
        expect(
          (
            await mark(s.composer, {
              items: [
                { kind: "file", id: s.mix },
                { kind: "file", id: s.artwork },
              ],
              viewed: true,
            })
          ).status,
        ).toBe(204);
        expect(
          (await mark(s.composer, { items: [{ kind: "file", id: s.mix }], favourite: true }))
            .status,
        ).toBe(204);
        const mine = await marksOf(s.composer);
        expect(mine).toHaveLength(3);
        expect(mine).toEqual(
          expect.arrayContaining([
            { kind: "track", id: s.trackId, pinned: true, favourite: false, viewed: false },
            { kind: "file", id: s.mix, pinned: false, favourite: true, viewed: true },
            { kind: "file", id: s.artwork, pinned: false, favourite: false, viewed: true },
          ]),
        );
        expect(await marksOf(s.owner)).toEqual([]);

        // Taking every mark off leaves nothing behind.
        await mark(s.composer, { items: [{ kind: "track", id: s.trackId }], pinned: false });
        expect((await marksOf(s.composer)).map((m) => m.id).sort()).toEqual(
          [s.mix, s.artwork].sort(),
        );

        // Only files are seen; something to mark must be said; ids from elsewhere are refused.
        const folder = await app.request(
          `/api/projects/${s.projectId}/folders`,
          json({ name: "Mixes" }, s.owner),
        );
        const folderId = ((await folder.json()) as { folder: { id: string } }).folder.id;
        expect(
          (await mark(s.composer, { items: [{ kind: "folder", id: folderId }], viewed: true }))
            .status,
        ).toBe(400);
        expect((await mark(s.composer, { items: [{ kind: "folder", id: folderId }] })).status).toBe(
          400,
        );
        const [other] = await db
          .insert(schema.organisations)
          .values({ name: "Elsewhere", slug: "elsewhere-marks" })
          .returning();
        const [project] = await db
          .insert(schema.projects)
          .values({ organisationId: other?.id ?? "", name: "Not yours", profile: "music" })
          .returning();
        const [foreign] = await db
          .insert(schema.folders)
          .values({ organisationId: other?.id ?? "", projectId: project?.id ?? "", name: "X" })
          .returning();
        expect(
          (await mark(s.composer, { items: [{ kind: "folder", id: foreign?.id }], pinned: true }))
            .status,
        ).toBe(422);
        expect(
          (
            await mark(
              s.owner,
              { items: [{ kind: "folder", id: foreign?.id }], pinned: true },
              project?.id,
            )
          ).status,
        ).toBe(404);

        // Someone outside the project cannot mark in it.
        const outsider = await joinAs(s.owner, "outsider-marks@example.test");
        expect(
          (await mark(outsider, { items: [{ kind: "file", id: s.mix }], pinned: true })).status,
        ).toBe(404);
      });

      it("sums up the projects a member can see for the home page, and nothing else", async () => {
        const s = await studio();
        type Home = {
          projects: {
            id: string;
            files: number;
            tracks: number;
            versionedTracks: number;
            approvedTracks: number;
            openReviews: number;
            members: number;
            faces: { id: string; name: string }[];
          }[];
          openComments: number;
          failed: unknown[];
          activity: { kind: string; title?: string; trackName?: string }[];
        };
        const home = async (cookie: string) => {
          const res = await getAs("/api/home", cookie);
          expect(res.status).toBe(200);
          return (await res.json()) as Home;
        };
        const before = (await home(s.owner)).projects.find((p) => p.id === s.projectId);
        expect(before).toMatchObject({ tracks: 1, openReviews: 0 });
        expect(before?.files).toBeGreaterThanOrEqual(2);

        await request(s.owner, s.projectId, {
          kind: "feedback",
          title: "First listen",
          items: [{ trackId: s.trackId }],
          reviewers: [s.ids.composer],
        });
        expect((await home(s.owner)).projects.find((p) => p.id === s.projectId)).toMatchObject({
          openReviews: 1,
          versionedTracks: 1,
          approvedTracks: 0,
        });

        // An approval that settles as approved counts the track as approved.
        const approval = await reviewOf(
          await request(s.owner, s.projectId, {
            kind: "approval",
            title: "Master sign-off",
            rule: "any",
            items: [{ trackId: s.trackId }],
            reviewers: [s.ids.composer],
          }),
        );
        await app.request(
          `/api/reviews/${approval.id}/decisions`,
          json({ decision: "approved" }, s.composer),
        );
        const after = await home(s.owner);
        const card = after.projects.find((p) => p.id === s.projectId);
        expect(card).toMatchObject({ approvedTracks: 1, openReviews: 1 });
        // The board (#141) reads a review that follows the track as one of its latest version.
        const board = (await (
          await app.request(`/api/projects/${s.projectId}/board`, { headers: { cookie: s.owner } })
        ).json()) as { cards: { decisions: { decision: string }[] }[] };
        expect(board.cards[0]?.decisions).toEqual([
          expect.objectContaining({ decision: "approved" }),
        ]);
        expect(card?.faces.length).toBe(Math.min(card?.members ?? 0, 4));
        // The newest first: the approval settling, then the requests and the version.
        expect(after.activity[0]).toMatchObject({
          kind: "review_completed",
          title: "Master sign-off",
        });
        expect(after.activity.map((a) => a.kind)).toEqual(
          expect.arrayContaining(["review", "version"]),
        );

        // A version uploaded after the approval has not been reviewed.
        await app.request(
          `/api/tracks/${s.trackId}/versions`,
          json({ variations: [{ fileId: s.artwork, name: "Mix" }] }, s.owner),
        );
        expect(
          (await home(s.owner)).projects.find((p) => p.id === s.projectId)?.approvedTracks,
        ).toBe(0);

        // A file that failed to process is for those who can replace it, not for reviewers.
        await db
          .update(schema.files)
          .set({ streamStatus: "failed" })
          .where(eq(schema.files.id, s.mix));
        expect((await home(s.owner)).failed).toMatchObject([{ id: s.mix }]);
        expect((await home(s.engineer)).failed).toMatchObject([{ id: s.mix }]);
        expect((await home(s.composer)).failed).toEqual([]);

        // Another workspace's projects never show, even to an owner here.
        const [other] = await db
          .insert(schema.organisations)
          .values({ name: "Elsewhere", slug: "elsewhere-home" })
          .returning();
        const [foreign] = await db
          .insert(schema.projects)
          .values({ organisationId: other?.id ?? "", name: "Theirs", profile: "video" })
          .returning();
        expect((await home(s.owner)).projects.map((p) => p.id)).not.toContain(foreign?.id);
        // The composer has a role in the project and sees it; a newcomer with none sees nothing.
        expect((await home(s.composer)).projects.map((p) => p.id)).toEqual([s.projectId]);
        const newcomer = await joinAs(s.owner, "newcomer@example.test");
        expect(await home(newcomer)).toEqual({
          projects: [],
          openComments: 0,
          newVersions: 0,
          failed: [],
          activity: [],
        });
        expect((await app.request("/api/home")).status).toBe(401);
      });

      it("searches what a member may see, and nothing else", async () => {
        const s = await studio();
        type Found = { results: { kind: string; label: string; link: string }[] };
        const search = async (cookie: string, q: string) => {
          const res = await getAs(`/api/search?q=${encodeURIComponent(q)}`, cookie);
          expect(res.status).toBe(200);
          return ((await res.json()) as Found).results;
        };
        await request(s.owner, s.projectId, {
          kind: "feedback",
          title: "Balance check",
          message: "Listen for the left hand.",
          items: [{ trackId: s.trackId }],
          reviewers: [s.ids.composer],
        });
        await app.request(
          `/api/files/${s.mix}/comments`,
          json({ body: "The pedal blurs the bass line here." }, s.owner),
        );

        // Words as they are typed, each a prefix.
        expect(await search(s.owner, "map le")).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ kind: "tracks", label: "Maple Leaf Rag" }),
          ]),
        );
        expect((await search(s.owner, "mix v1")).map((r) => [r.kind, r.label])).toContainEqual([
          "files",
          "Mix v1.wav",
        ]);
        expect((await search(s.owner, "left hand")).map((r) => r.kind)).toContain("reviews");
        expect(await search(s.owner, "blurs")).toEqual([
          expect.objectContaining({
            kind: "comments",
            label: "The pedal blurs the bass line here.",
            link: `/files/${s.mix}`,
          }),
        ]);
        expect((await search(s.owner, "compos")).map((r) => [r.kind, r.label])).toEqual([
          ["people", "composer"],
        ]);
        // A reviewer in the project finds it; a member without a role finds nothing in it.
        expect((await search(s.composer, "maple")).length).toBeGreaterThan(0);
        const newcomer = await joinAs(s.owner, "newcomer@example.test");
        expect(await search(newcomer, "maple")).toEqual([]);

        // Another workspace's project of the same name never surfaces.
        const [other] = await db
          .insert(schema.organisations)
          .values({ name: "Elsewhere", slug: "elsewhere-search" })
          .returning();
        await db
          .insert(schema.projects)
          .values({ organisationId: other?.id ?? "", name: "Maple Theirs", profile: "music" });
        expect((await search(s.owner, "maple")).map((r) => r.label)).not.toContain("Maple Theirs");
        // Nor does an archived one, with what is in it.
        await db
          .update(schema.projects)
          .set({ archivedAt: new Date() })
          .where(eq(schema.projects.id, s.projectId));
        expect(await search(s.owner, "maple")).toEqual([]);

        // Nothing typed and nothing narrowed: nothing to look for.
        expect(await search(s.owner, "")).toEqual([]);
        expect((await getAs("/api/search?q=x&kind=tasks", s.owner)).status).toBe(400);
        expect((await app.request("/api/search?q=maple")).status).toBe(401);
      });

      it("narrows a search by kind, project, person, file kind and date, and keeps saved ones", async () => {
        const s = await studio();
        type Found = { results: { kind: string; label: string }[] };
        const find = async (query: string, cookie = s.owner) =>
          ((await (await getAs(`/api/search?${query}`, cookie)).json()) as Found).results.map(
            (r) => `${r.kind}:${r.label}`,
          );
        await request(s.owner, s.projectId, {
          kind: "feedback",
          title: "Mix notes",
          items: [{ trackId: s.trackId }],
          reviewers: [s.ids.composer],
        });
        const ownerId = (
          await db
            .select({ id: schema.users.id })
            .from(schema.users)
            .where(eq(schema.users.email, "producer@example.test"))
        )[0]?.id;

        expect(await find("q=mix&kind=files")).toEqual(["files:Mix v1.wav"]);
        // A kind alone is a search too, people included.
        expect((await find("kind=people")).sort()).toEqual([
          "people:Producer",
          "people:accompanist",
          "people:composer",
          "people:engineer",
        ]);
        // Filters alone list the newest of what they allow.
        expect(await find(`kind=reviews&projectId=${s.projectId}`)).toEqual(["reviews:Mix notes"]);
        expect(await find(`personId=${ownerId}&kind=reviews`)).toEqual(["reviews:Mix notes"]);
        expect(await find(`personId=${s.ids.composer}&kind=reviews`)).toEqual([]);
        expect(await find("q=mix&fileKind=video")).toEqual([]);
        expect((await find("q=mix&fileKind=audio")).every((r) => r.startsWith("files:"))).toBe(
          true,
        );
        expect(await find("q=mix&since=week")).toContain("reviews:Mix notes");
        await db
          .update(schema.reviews)
          .set({ createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) })
          .where(eq(schema.reviews.projectId, s.projectId));
        expect(await find("q=mix&since=month")).not.toContain("reviews:Mix notes");

        // Saved searches are each person's own.
        const saved = await app.request(
          "/api/search/saved",
          json({ name: "Audio mixes", search: { q: "mix", fileKind: "audio" } }, s.owner),
        );
        expect(saved.status).toBe(201);
        const { saved: row } = (await saved.json()) as { saved: { id: string } };
        type Saved = { saved: { name: string; search: { q: string; fileKind?: string } }[] };
        const list = async (cookie: string) =>
          ((await (await getAs("/api/search/saved", cookie)).json()) as Saved).saved;
        expect(await list(s.owner)).toEqual([
          expect.objectContaining({ name: "Audio mixes", search: { q: "mix", fileKind: "audio" } }),
        ]);
        expect(await list(s.composer)).toEqual([]);
        expect((await app.request("/api/search/saved")).status).toBe(401);
        expect(
          (await app.request("/api/search/saved", json({ name: "", search: { q: "x" } }, s.owner)))
            .status,
        ).toBe(400);
        const remove = (cookie: string) =>
          app.request(`/api/search/saved/${row.id}`, { method: "DELETE", headers: { cookie } });
        expect((await remove(s.composer)).status).toBe(404);
        expect((await remove(s.owner)).status).toBe(204);
        expect(await list(s.owner)).toEqual([]);
      });

      describe("notifications", () => {
        type Listed = {
          notifications: { id: string; kind: string; actorName: string | null; text: string }[];
          unread: number;
          nextBefore: string | null;
        };
        const inbox = async (cookie: string, query = "") =>
          (await (await getAs(`/api/notifications${query}`, cookie)).json()) as Listed;
        const put = (path: string, body: unknown, cookie: string) =>
          app.request(path, { ...json(body, cookie), method: "PUT" });

        it("deletes a project only when a second owner confirms, with everything in it (#240)", async () => {
          const s = await studio();
          const deletion = (cookie: string, rest = "", method = "POST", id = s.projectId) =>
            app.request(`/api/projects/${id}/deletion${rest}`, { ...json({}, cookie), method });
          const viewOf = async (cookie: string) =>
            (
              (await (await getAs(`/api/projects/${s.projectId}`, cookie)).json()) as {
                project: {
                  deletion: {
                    requestedBy: string | null;
                    mayConfirm: boolean;
                    mayCancel: boolean;
                    confirmableAt: string | null;
                  } | null;
                };
              }
            ).project.deletion;
          // Something in every corner: a thread, a review of the track and a file.
          expect(
            (
              await app.request(
                `/api/files/${s.mix}/comments`,
                json({ body: "Pedal noise", anchor: { kind: "time", start: 3, end: 3 } }, s.owner),
              )
            ).status,
          ).toBe(201);
          expect(
            (
              await request(s.owner, s.projectId, {
                kind: "approval",
                title: "Master sign-off",
                items: [{ trackId: s.trackId }, { fileId: s.artwork }],
                reviewers: [s.ids.composer],
                order: "parallel",
              })
            ).status,
          ).toBe(201);

          // Only a role that may delete the project may ask.
          expect((await deletion(s.engineer)).status).toBe(403);

          // The workspace's only owner asks, and must wait a day to confirm alone.
          expect((await deletion(s.owner)).status).toBe(200);
          expect((await deletion(s.owner)).status).toBe(409);
          const alone = await viewOf(s.owner);
          expect(alone).toMatchObject({ mayConfirm: false, mayCancel: true });
          expect(alone?.confirmableAt).not.toBeNull();
          const early = await deletion(s.owner, "/confirm");
          expect(early.status).toBe(403);
          expect(await early.text()).toMatch(/a day after asking/);
          // A reviewer may neither confirm nor withdraw it.
          expect((await deletion(s.composer, "/confirm")).status).toBe(403);
          expect((await deletion(s.composer, "", "DELETE")).status).toBe(403);
          expect((await deletion(s.owner, "", "DELETE")).status).toBe(204);
          expect(await viewOf(s.owner)).toBeNull();

          // With a second owner, the one who asked may not confirm; the other may, and hears of it.
          await db
            .update(schema.members)
            .set({ role: "owner" })
            .where(
              and(
                eq(schema.members.organisationId, s.organisationId),
                eq(schema.members.userId, s.ids.engineer),
              ),
            );
          expect((await deletion(s.owner)).status).toBe(200);
          expect((await inbox(s.engineer)).notifications[0]).toMatchObject({
            kind: "deletion_requested",
            text: "asked to delete Rags",
          });
          expect((await deletion(s.owner, "/confirm")).status).toBe(403);
          expect(await viewOf(s.engineer)).toMatchObject({ mayConfirm: true });

          // Another workspace's project cannot be found, let alone deleted.
          const [elsewhere] = await db
            .insert(schema.organisations)
            .values({ name: "Elsewhere", slug: "elsewhere-deletion" })
            .returning();
          const [foreign] = await db
            .insert(schema.projects)
            .values({ organisationId: elsewhere?.id ?? "", name: "Theirs", profile: "music" })
            .returning();
          expect((await deletion(s.engineer, "/confirm", "POST", foreign?.id)).status).toBe(404);

          // Confirmed: archived at once, its open review closed, and gone in seven days.
          const confirmed = await deletion(s.engineer, "/confirm");
          expect(confirmed.status).toBe(200);
          const { deleteAfter } = (await confirmed.json()) as { deleteAfter: string };
          const week = new Date(deleteAfter).getTime() - Date.now();
          expect(week).toBeGreaterThan(6.9 * 24 * 3600 * 1000);
          expect((await deletion(s.engineer, "/confirm")).status).toBe(409);
          expect(await viewOf(s.owner)).toMatchObject({ deleteAfter, mayConfirm: false });
          const [archived] = await db
            .select({ archivedAt: schema.projects.archivedAt })
            .from(schema.projects)
            .where(eq(schema.projects.id, s.projectId));
          expect(archived?.archivedAt).not.toBeNull();
          const open = await db
            .select({ id: schema.reviews.id })
            .from(schema.reviews)
            .where(
              and(eq(schema.reviews.projectId, s.projectId), eq(schema.reviews.status, "open")),
            );
          expect(open).toEqual([]);
          // It cannot be brought back while due; kept, it can.
          const back = () =>
            app.request(`/api/projects/${s.projectId}/unarchive`, json({}, s.owner));
          expect((await back()).status).toBe(409);
          expect((await deletion(s.owner, "", "DELETE")).status).toBe(204);
          expect(await viewOf(s.owner)).toBeNull();
          expect(
            await purgeDueProjects(db, storage, audit, new Date(Date.now() + 8 * 86400e3)),
          ).toBe(0);

          // Asked and confirmed again, it goes for good once the week is over, and not before.
          expect((await deletion(s.owner)).status).toBe(200);
          expect((await deletion(s.engineer, "/confirm")).status).toBe(200);
          expect(await purgeDueProjects(db, storage, audit)).toBe(0);
          expect(
            await purgeDueProjects(db, storage, audit, new Date(Date.now() + 8 * 86400e3)),
          ).toBe(1);
          expect((await getAs(`/api/projects/${s.projectId}`, s.owner)).status).toBe(404);
          const left = await db
            .select({ id: schema.files.id })
            .from(schema.files)
            .where(eq(schema.files.projectId, s.projectId));
          expect(left).toEqual([]);
          // The access log keeps every step, and the deletion with the project's name.
          const logged = await db
            .select({ action: schema.accessEvents.action, details: schema.accessEvents.details })
            .from(schema.accessEvents)
            .where(
              and(
                eq(schema.accessEvents.projectId, s.projectId),
                eq(schema.accessEvents.action, "project.delete"),
              ),
            );
          expect(logged).toEqual([{ action: "project.delete", details: { name: "Rags" } }]);
          const steps = await db
            .select({ action: schema.accessEvents.action })
            .from(schema.accessEvents)
            .where(eq(schema.accessEvents.projectId, s.projectId));
          expect(
            new Set(steps.map((e) => e.action).filter((a) => a.startsWith("project."))),
          ).toEqual(
            new Set([
              "project.deletion_request",
              "project.deletion_cancel",
              "project.deletion_confirm",
              "project.delete",
            ]),
          );
        });

        it("moves a project to another workspace with its rows, keys, objects and decisions (#240)", async () => {
          const s = await studio();
          await app.request(
            `/api/files/${s.mix}/comments`,
            json({ body: "Pedal noise", anchor: { kind: "time", start: 3, end: 3 } }, s.owner),
          );
          const approval = await reviewOf(
            await request(s.owner, s.projectId, {
              kind: "approval",
              title: "Master sign-off",
              items: [{ trackId: s.trackId }],
              reviewers: [s.ids.composer],
            }),
          );
          expect(
            (
              await app.request(
                `/api/reviews/${approval.id}/decisions`,
                json({ decision: "approved" }, s.composer),
              )
            ).status,
          ).toBe(200);
          const decisionsOf = () =>
            db
              .select()
              .from(schema.reviewDecisionLog)
              .where(eq(schema.reviewDecisionLog.reviewId, approval.id));
          const [decided] = await decisionsOf();
          if (!decided) throw new Error("no decision");

          // Decisions stay append-only: no change outside a move, and only the workspace in one.
          await expect(
            db
              .update(schema.reviewDecisionLog)
              .set({ decision: "changes_requested" })
              .where(eq(schema.reviewDecisionLog.id, decided.id)),
          ).rejects.toThrow();
          const [gaining] = await db
            .insert(schema.organisations)
            .values({ name: "Endless Hall Records East", slug: "endless-hall-east" })
            .returning();
          const to = gaining?.id ?? "";
          await expect(
            db
              .update(schema.reviewDecisionLog)
              .set({ organisationId: to })
              .where(eq(schema.reviewDecisionLog.id, decided.id)),
          ).rejects.toThrow();
          await expect(
            db.transaction(async (tx) => {
              await tx.execute(sql`set local hekate.project_transfer = 'on'`);
              await tx
                .update(schema.reviewDecisionLog)
                .set({ organisationId: to, decision: "changes_requested" })
                .where(eq(schema.reviewDecisionLog.id, decided.id));
            }),
          ).rejects.toThrow();
          expect(await decisionsOf()).toEqual([decided]);

          // The owner and the engineer are in the gaining workspace; the reviewers are not.
          await db.insert(schema.members).values([
            { organisationId: to, userId: s.ids.owner, role: "owner" },
            { organisationId: to, userId: s.ids.engineer, role: "member" },
          ]);
          const [mixFile] = await db.select().from(schema.files).where(eq(schema.files.id, s.mix));
          const [oldBlob] = await db
            .select()
            .from(schema.blobs)
            .where(eq(schema.blobs.id, mixFile?.blobId ?? ""));
          if (!oldBlob) throw new Error("no blob");

          // A tag the gaining workspace already has by another spelling, and a calendar link.
          const [mixTag] = await db
            .insert(schema.tags)
            .values({ organisationId: s.organisationId, name: "Masters" })
            .returning();
          await db
            .insert(schema.fileTags)
            .values({ organisationId: s.organisationId, fileId: s.mix, tagId: mixTag?.id ?? "" });
          const [theirTag] = await db
            .insert(schema.tags)
            .values({ organisationId: to, name: "masters" })
            .returning();
          await db.insert(schema.calendarFeeds).values({
            organisationId: s.organisationId,
            userId: s.ids.owner,
            projectId: s.projectId,
            tokenHash: "f".repeat(64),
          });
          // What the People page says for two of its people (#55).
          await db.insert(schema.projectReviewerGrants).values(
            [s.ids.engineer, s.ids.composer].map((userId) => ({
              organisationId: s.organisationId,
              projectId: s.projectId,
              userId,
              grant: { invite: true },
            })),
          );

          const deps = { db, keyring, backends, jobs };
          const move = { projectId: s.projectId, from: s.organisationId, to };
          await expect(moveProject(deps, { ...move, to: s.organisationId })).rejects.toThrow(
            /already in that workspace/,
          );
          await expect(
            moveProject(deps, { ...move, from: to, to: s.organisationId }),
          ).rejects.toThrow(/Project/);
          // Not into a workspace being closed, nor a project being deleted.
          await db
            .update(schema.organisations)
            .set({ suspendedAt: new Date() })
            .where(eq(schema.organisations.id, to));
          await expect(moveProject(deps, move)).rejects.toThrow(/cannot take projects/);
          await db
            .update(schema.organisations)
            .set({ suspendedAt: null })
            .where(eq(schema.organisations.id, to));
          await db
            .update(schema.projects)
            .set({ deleteAfter: new Date(Date.now() + 86400e3) })
            .where(eq(schema.projects.id, s.projectId));
          await expect(moveProject(deps, move)).rejects.toThrow(/being deleted/);
          await db
            .update(schema.projects)
            .set({ deleteAfter: null })
            .where(eq(schema.projects.id, s.projectId));
          // A copy that fails part way leaves nothing behind under the gaining workspace.
          const lost = await storage.put(s.organisationId, Buffer.from("lost"));
          await db.insert(schema.files).values({
            organisationId: s.organisationId,
            projectId: s.projectId,
            name: "Lost.wav",
            kind: "audio",
            blobId: lost.id,
            contentType: "audio/wav",
            byteSize: lost.byteSize,
          });
          await backends.get(lost.backend).delete(lost.key);
          await expect(moveProject(deps, move)).rejects.toThrow();
          expect(await backends.get(oldBlob.backend).head(`org/${to}/${oldBlob.id}`)).toBeNull();
          expect(await backends.get(oldBlob.backend).head(oldBlob.key)).not.toBeNull();
          await db.delete(schema.files).where(eq(schema.files.blobId, lost.id));
          await db.delete(schema.blobs).where(eq(schema.blobs.id, lost.id));
          // A checksum still to compute is asked for again, in the gaining workspace.
          await db
            .update(schema.blobs)
            .set({ sha256: null })
            .where(eq(schema.blobs.id, oldBlob.id));
          sent.length = 0;
          const moved = await moveProject(deps, move);
          expect(sent).toEqual([
            { name: "blob-checksum", data: { organisationId: to, blobId: oldBlob.id } },
          ]);
          expect(moved.objects).toBeGreaterThanOrEqual(2);
          expect(moved.leftBehind.map((p) => p.userId).sort()).toEqual(
            [s.ids.composer, s.ids.accompanist].sort(),
          );

          // Every row went: none of the project is left in the losing workspace.
          for (const table of [schema.projects, schema.tracks, schema.files, schema.reviews])
            expect(
              await db
                .select({ n: count() })
                .from(table)
                .where(eq(table.organisationId, s.organisationId)),
            ).toEqual([{ n: 0 }]);
          // The decision moved as recorded: same id, decision, maker and time.
          expect(await decisionsOf()).toEqual([{ ...decided, organisationId: to }]);
          // Its file opens in the gaining workspace, under its prefix and key, and no longer
          // in the losing one; the old object is gone.
          const opened = await storage.open(to, oldBlob.id);
          expect((await buffer(opened.stream)).toString()).toBe("Mix v1.wav");
          expect(opened.blob.key).toBe(`org/${to}/${oldBlob.id}`);
          expect(opened.blob.wrappedKey).not.toBe(oldBlob.wrappedKey);
          await expect(storage.open(s.organisationId, oldBlob.id)).rejects.toThrow();
          expect(await backends.get(oldBlob.backend).head(oldBlob.key)).toBeNull();
          // Those left behind lost their place; those who came keep theirs.
          const people = await db
            .select({ userId: schema.projectMembers.userId })
            .from(schema.projectMembers)
            .where(eq(schema.projectMembers.projectId, s.projectId));
          expect(people.map((p) => p.userId).sort()).toEqual([s.ids.owner, s.ids.engineer].sort());
          // So do their standing grants.
          expect(
            await db
              .select({
                userId: schema.projectReviewerGrants.userId,
                organisationId: schema.projectReviewerGrants.organisationId,
              })
              .from(schema.projectReviewerGrants)
              .where(eq(schema.projectReviewerGrants.projectId, s.projectId)),
          ).toEqual([{ userId: s.ids.engineer, organisationId: to }]);
          // The tag is the gaining workspace's own; the calendar link, given out before, is gone.
          expect(
            await db
              .select({
                tagId: schema.fileTags.tagId,
                organisationId: schema.fileTags.organisationId,
              })
              .from(schema.fileTags)
              .where(eq(schema.fileTags.fileId, s.mix)),
          ).toEqual([{ tagId: theirTag?.id, organisationId: to }]);
          expect(
            await db
              .select({ n: count() })
              .from(schema.calendarFeeds)
              .where(eq(schema.calendarFeeds.projectId, s.projectId)),
          ).toEqual([{ n: 0 }]);
          // The comment is still there, still the owner's.
          const [thread] = await db
            .select({ body: schema.comments.body, organisationId: schema.comments.organisationId })
            .from(schema.comments)
            .where(eq(schema.comments.fileId, s.mix));
          expect(thread).toEqual({ body: "Pedal noise", organisationId: to });
        });

        it("moves a project once a second member approves and the gaining workspace accepts (#240)", async () => {
          const s = await studio();
          const password = "correct horse battery";
          const [east] = await db
            .insert(schema.organisations)
            .values({ name: "Endless Hall Records East", slug: "endless-hall-east-transfer" })
            .returning();
          const to = east?.id ?? "";
          // The owner is a plain member there; the composer runs it.
          await db.insert(schema.members).values([
            { organisationId: to, userId: s.ids.owner, role: "member" },
            { organisationId: to, userId: s.ids.composer, role: "owner" },
          ]);
          const ask = (cookie: string, body: unknown) =>
            app.request(`/api/projects/${s.projectId}/transfer`, json(body, cookie));
          type Seen = {
            id: string;
            status: string;
            approvedAt: string | null;
            acceptedAt: string | null;
            you: {
              mayApprove: boolean;
              mayAccept: boolean;
              mayRefuse: boolean;
              mayCancel: boolean;
            };
          };
          const transferOf = async (res: Response) =>
            ((await res.json()) as { transfer: Seen }).transfer;

          // Only a role that may delete the project may ask, and only as it is confirmed.
          expect((await ask(s.engineer, { to: { id: to }, name: "Rags", password })).status).toBe(
            403,
          );
          expect(
            await (
              await getAs(`/api/projects/${s.projectId}/transfer/destinations`, s.owner)
            ).json(),
          ).toEqual({
            destinations: [{ id: to, name: "Endless Hall Records East", atOnce: false }],
          });
          const misnamed = await ask(s.owner, { to: { id: to }, name: "Rag", password });
          expect(misnamed.status).toBe(422);
          expect(
            (await ask(s.owner, { to: { id: to }, name: "Rags", password: "wrong" })).status,
          ).toBe(403);
          expect(
            (await ask(s.owner, { to: { address: "nowhere" }, name: "Rags", password })).status,
          ).toBe(404);
          const asked = await ask(s.owner, { to: { id: to }, name: " rags ", password });
          expect(asked.status).toBe(201);
          const transfer = await transferOf(asked);
          expect(transfer).toMatchObject({
            status: "pending",
            approvedAt: null,
            acceptedAt: null,
            you: { mayApprove: false, mayCancel: true },
          });
          expect((await ask(s.owner, { to: { id: to }, name: "Rags", password })).status).toBe(409);

          // Whoever asked may not approve it; a second member who may delete the project does.
          const approve = (cookie: string) =>
            app.request(
              `/api/transfers/${transfer.id}/approve`,
              json({ name: "Rags", password }, cookie),
            );
          const accept = (cookie: string, name = "Rags", id = transfer.id) =>
            app.request(`/api/transfers/${id}/accept`, json({ name, password }, cookie));
          expect((await approve(s.owner)).status).toBe(403);
          expect((await approve(s.engineer)).status).toBe(403);
          await db
            .update(schema.members)
            .set({ role: "admin" })
            .where(
              and(
                eq(schema.members.organisationId, s.organisationId),
                eq(schema.members.userId, s.ids.engineer),
              ),
            );
          // Its deletion cannot be asked for while it waits to move.
          expect(
            (await app.request(`/api/projects/${s.projectId}/deletion`, json({}, s.owner))).status,
          ).toBe(409);
          // Two approvals at the same moment: one is taken, the other refused.
          const both = await Promise.all([approve(s.engineer), approve(s.engineer)]);
          expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
          const approved = both.find((r) => r.status === 200) as Response;
          expect(await transferOf(approved)).toMatchObject({ status: "pending" });
          // The losing side cannot accept for the gaining one.
          expect((await accept(s.owner)).status).toBe(404);
          // A member sees the transfers of projects they can see; one who cannot, none.
          const listedBy = async (cookie: string) =>
            ((await (await getAs("/api/transfers", cookie)).json()) as { transfers: Seen[] })
              .transfers;
          expect((await listedBy(s.accompanist)).map((t) => t.id)).toEqual([transfer.id]);
          await db
            .delete(schema.projectMembers)
            .where(
              and(
                eq(schema.projectMembers.projectId, s.projectId),
                eq(schema.projectMembers.userId, s.ids.accompanist),
              ),
            );
          expect(await listedBy(s.accompanist)).toEqual([]);

          // The gaining workspace's owner sees it waiting on them, and accepts.
          expect(
            (
              await app.request("/api/me/organisation", {
                ...json({ organisationId: to }, s.composer),
                method: "PUT",
              })
            ).status,
          ).toBe(200);
          const listed = (await (await getAs("/api/transfers", s.composer)).json()) as {
            transfers: Seen[];
          };
          expect(listed.transfers).toEqual([
            expect.objectContaining({
              id: transfer.id,
              you: expect.objectContaining({ mayAccept: true }),
            }),
          ]);
          expect((await accept(s.composer, "Ragtime")).status).toBe(422);
          // A move that cannot happen yet takes the acceptance back, to be given again.
          await db
            .update(schema.files)
            .set({ streamStatus: "pending" })
            .where(eq(schema.files.id, s.mix));
          const early = await accept(s.composer);
          expect(early.status).toBe(409);
          expect(await early.text()).toMatch(/still being prepared/);
          const [held] = await db
            .select({
              status: schema.projectTransfers.status,
              acceptedAt: schema.projectTransfers.acceptedAt,
              approvedAt: schema.projectTransfers.approvedAt,
            })
            .from(schema.projectTransfers)
            .where(eq(schema.projectTransfers.id, transfer.id));
          expect(held).toMatchObject({ status: "pending", acceptedAt: null });
          expect(held?.approvedAt).not.toBeNull();
          await db
            .update(schema.files)
            .set({ streamStatus: "ready" })
            .where(eq(schema.files.id, s.mix));
          const accepted = await accept(s.composer);
          expect(accepted.status).toBe(200);
          expect(await transferOf(accepted)).toMatchObject({ status: "moved" });
          const [moved] = await db
            .select({ organisationId: schema.projects.organisationId })
            .from(schema.projects)
            .where(eq(schema.projects.id, s.projectId));
          expect(moved?.organisationId).toBe(to);
          // Every step is in both workspaces' logs.
          for (const organisationId of [s.organisationId, to]) {
            const steps = await db
              .select({ action: schema.accessEvents.action })
              .from(schema.accessEvents)
              .where(
                and(
                  eq(schema.accessEvents.organisationId, organisationId),
                  sql`${schema.accessEvents.action}::text like 'project.transfer%'`,
                ),
              );
            expect(steps.map((e) => e.action).sort()).toEqual(
              [
                "project.transfer",
                "project.transfer_accept",
                "project.transfer_approve",
                "project.transfer_request",
              ].sort(),
            );
          }
          // The one who asked heard it approved, and of the move.
          expect(
            (await inbox(s.owner)).notifications
              .filter((n) => n.kind === "transfer")
              .map((n) => n.text),
          ).toEqual(expect.arrayContaining(["approved moving Rags"]));

          // Someone who may do both moves it at once: the composer, an admin of the studio too.
          await db
            .update(schema.members)
            .set({ role: "admin" })
            .where(
              and(
                eq(schema.members.organisationId, s.organisationId),
                eq(schema.members.userId, s.ids.composer),
              ),
            );
          const back = await ask(s.composer, {
            to: { id: s.organisationId },
            name: "Rags",
            password,
          });
          expect(back.status).toBe(201);
          expect(await transferOf(back)).toMatchObject({ status: "moved" });

          // Refused by the gaining side, withdrawn by whoever asked, lapsed after a week.
          const refused = await transferOf(
            await ask(s.owner, { to: { id: to }, name: "Rags", password }),
          );
          const refuse = await app.request(
            `/api/transfers/${refused.id}/refuse`,
            json({}, s.composer),
          );
          expect(await transferOf(refuse)).toMatchObject({ status: "refused" });
          expect(
            (
              await app.request(`/api/transfers/${refused.id}`, {
                ...json({}, s.owner),
                method: "DELETE",
              })
            ).status,
          ).toBe(409);
          const withdrawn = await transferOf(
            await ask(s.owner, { to: { id: to }, name: "Rags", password }),
          );
          expect(
            (
              await app.request(`/api/transfers/${withdrawn.id}`, {
                ...json({}, s.composer),
                method: "DELETE",
              })
            ).status,
          ).toBe(403);
          expect(
            (
              await app.request(`/api/transfers/${withdrawn.id}`, {
                ...json({}, s.owner),
                method: "DELETE",
              })
            ).status,
          ).toBe(204);
          const lapsing = await transferOf(
            await ask(s.owner, { to: { id: to }, name: "Rags", password }),
          );
          await db
            .update(schema.projectTransfers)
            .set({ expiresAt: new Date(Date.now() - 1000) })
            .where(eq(schema.projectTransfers.id, lapsing.id));
          expect(
            (await (
              await getAs(`/api/projects/${s.projectId}/transfer`, s.owner)
            ).json()) as unknown,
          ).toEqual({ transfer: null });
          expect((await accept(s.composer, "Rags", lapsing.id)).status).toBe(409);
          // One that lapsed unread does not stand in the way of asking again.
          const unread = await transferOf(
            await ask(s.owner, { to: { id: to }, name: "Rags", password }),
          );
          await db
            .update(schema.projectTransfers)
            .set({ expiresAt: new Date(Date.now() - 1000) })
            .where(eq(schema.projectTransfers.id, unread.id));
          expect((await ask(s.owner, { to: { id: to }, name: "Rags", password })).status).toBe(201);
          // A workspace the transfer does not name can neither see nor act on it.
          const [elsewhere] = await db
            .insert(schema.organisations)
            .values({ name: "Elsewhere", slug: "elsewhere-transfer" })
            .returning();
          await db.insert(schema.members).values({
            organisationId: elsewhere?.id ?? "",
            userId: s.ids.accompanist,
            role: "owner",
          });
          await app.request("/api/me/organisation", {
            ...json({ organisationId: elsewhere?.id }, s.accompanist),
            method: "PUT",
          });
          expect((await (await getAs("/api/transfers", s.accompanist)).json()) as unknown).toEqual({
            transfers: [],
          });
          expect(
            (await app.request(`/api/transfers/${lapsing.id}/refuse`, json({}, s.accompanist)))
              .status,
          ).toBe(404);
        });

        it("tells reviewers and requesters, in the app and by mail, and no one else", async () => {
          const s = await studio();
          mailer.sent.length = 0;
          const review = await reviewOf(
            await request(s.owner, s.projectId, {
              kind: "approval",
              title: "Master sign-off",
              rule: "any",
              items: [{ trackId: s.trackId }],
              reviewers: [s.ids.composer],
            }),
          );
          const asked = await inbox(s.composer);
          expect(asked.unread).toBe(1);
          expect(asked.notifications[0]).toMatchObject({
            kind: "review_requested",
            actorName: "Producer",
            text: 'asks you to approve "Master sign-off"',
          });
          expect(mailer.sent.map((m) => m.to)).toEqual(["composer@example.test"]);
          // Whoever asked is not told of their own request.
          expect((await inbox(s.owner)).notifications).toEqual([]);

          await app.request(
            `/api/reviews/${review.id}/decisions`,
            json({ decision: "approved" }, s.composer),
          );
          expect((await inbox(s.owner)).notifications[0]).toMatchObject({
            kind: "decision",
            actorName: "composer",
            text: 'approved "Master sign-off"',
          });
          // Nobody else heard anything.
          expect((await inbox(s.accompanist)).notifications).toEqual([]);
          expect((await inbox(s.engineer)).notifications).toEqual([]);
          expect((await app.request("/api/notifications")).status).toBe(401);
        });

        it("marks read one at a time or all at once, only your own, only in this workspace", async () => {
          const s = await studio();
          for (const title of ["One", "Two"]) {
            await request(s.owner, s.projectId, {
              kind: "feedback",
              title,
              items: [{ trackId: s.trackId }],
              reviewers: [s.ids.composer],
            });
          }
          const listed = await inbox(s.composer);
          expect(listed.unread).toBe(2);
          const [first, second] = listed.notifications;
          // Someone else's notification does not exist for you.
          expect(
            (await app.request(`/api/notifications/${first?.id}/read`, json({}, s.accompanist)))
              .status,
          ).toBe(404);
          expect(
            (await app.request(`/api/notifications/${first?.id}/read`, json({}, s.composer)))
              .status,
          ).toBe(204);
          const unread = await inbox(s.composer, "?unread=1");
          expect(unread.notifications.map((n) => n.id)).toEqual([second?.id]);
          expect(unread.unread).toBe(1);
          const paged = await inbox(s.composer, "?limit=1");
          expect(paged.notifications).toHaveLength(1);
          expect(paged.nextBefore).toBe(paged.notifications[0]?.id);
          await app.request("/api/notifications/read-all", json({}, s.composer));
          expect((await inbox(s.composer)).unread).toBe(0);

          // A row in another workspace never shows here.
          const [other] = await db
            .insert(schema.organisations)
            .values({ name: "Elsewhere", slug: "elsewhere-notifications" })
            .returning();
          await db.insert(schema.notifications).values({
            organisationId: other?.id ?? "",
            userId: s.ids.composer,
            kind: "decision",
            text: "approved something elsewhere",
            link: "/reviews/elsewhere",
          });
          expect((await inbox(s.composer)).notifications.map((n) => n.text)).not.toContain(
            "approved something elsewhere",
          );
        });

        it("follows each person's choices, keeping requests and mentions in the app", async () => {
          const s = await studio();
          const off = { app: false, mail: false };
          expect(
            (
              await put(
                "/api/notifications/preferences",
                {
                  mailMode: "instant",
                  digest: "daily",
                  kinds: { review_requested: off, decision: off },
                },
                s.composer,
              )
            ).status,
          ).toBe(200);
          expect(
            (
              await put(
                "/api/notifications/preferences",
                { mailMode: "weekly", digest: "daily", kinds: {} },
                s.composer,
              )
            ).status,
          ).toBe(400);
          const saved = (await (
            await getAs("/api/notifications/preferences", s.composer)
          ).json()) as {
            preferences: { kinds: Record<string, unknown> };
          };
          expect(saved.preferences.kinds).toEqual({ review_requested: off, decision: off });

          mailer.sent.length = 0;
          await request(s.owner, s.projectId, {
            kind: "feedback",
            title: "Quiet please",
            items: [{ trackId: s.trackId }],
            reviewers: [s.ids.composer],
          });
          // Still told in the app, but not by mail, as chosen.
          expect((await inbox(s.composer)).notifications.map((n) => n.kind)).toEqual([
            "review_requested",
          ]);
          expect(mailer.sent).toEqual([]);
        });

        it("tells people they are mentioned, and thread starters of replies", async () => {
          const s = await studio();
          const started = await app.request(
            `/api/files/${s.mix}/comments`,
            json({ body: "Is the pedal too long here, @composer?" }, s.owner),
          );
          const { comment } = (await started.json()) as { comment: { id: string } };
          expect((await inbox(s.composer)).notifications[0]).toMatchObject({
            kind: "mention",
            text: "mentioned you on Mix v1.wav",
          });
          await app.request(
            `/api/files/${s.mix}/comments`,
            json({ body: "A touch, yes.", parentId: comment.id }, s.composer),
          );
          expect((await inbox(s.owner)).notifications[0]).toMatchObject({
            kind: "reply",
            actorName: "composer",
            text: "replied to your comment on Mix v1.wav",
          });
          // A name that only starts like someone's is not a mention.
          await app.request(
            `/api/files/${s.mix}/comments`,
            json({ body: "Ask @composers everywhere" }, s.owner),
          );
          expect((await inbox(s.composer)).notifications).toHaveLength(1);
        });

        it("takes mentions from the picker, refusing anyone outside the project (#133)", async () => {
          const s = await studio();
          const newcomer = await joinAs(s.owner, "newcomer@example.test");
          // Whom the owner may mention: the project's people, by name, never by address.
          const offered = (await (
            await getAs(`/api/files/${s.mix}/mentionable`, s.owner)
          ).json()) as { people: { id: string; name: string }[] };
          expect(offered.people.map((p) => p.id).sort()).toEqual(
            [s.ids.owner, s.ids.composer, s.ids.accompanist, s.ids.engineer].sort(),
          );
          expect(Object.keys(offered.people[0] ?? {}).sort()).toEqual(["id", "name"]);

          const post = (body: unknown, cookie = s.owner) =>
            app.request(`/api/files/${s.mix}/comments`, json(body, cookie));
          const outside = await post({
            body: "Over to @newcomer",
            mentions: [await idOf(newcomer)],
          });
          expect(outside.status).toBe(422);
          expect(await outside.json()).toMatchObject({ error: { code: "mention_outside" } });
          expect((await inbox(newcomer)).notifications).toEqual([]);

          const made = await post({
            body: "Can you hear it, @composer?",
            mentions: [s.ids.composer],
          });
          expect(made.status).toBe(201);
          const { comment } = (await made.json()) as {
            comment: { id: string; mentions: { id: string; name: string }[] };
          };
          expect(comment.mentions).toEqual([{ id: s.ids.composer, name: "composer" }]);
          expect((await inbox(s.composer)).notifications.map((n) => n.kind)).toEqual(["mention"]);

          // An edit that adds someone tells them, and only them; one that keeps tells nobody.
          const edit = (body: unknown) =>
            app.request(`/api/comments/${comment.id}`, { ...json(body, s.owner), method: "PATCH" });
          expect(
            (
              await edit({
                body: "Can you hear it, @composer and @accompanist?",
                mentions: [s.ids.composer, s.ids.accompanist],
              })
            ).status,
          ).toBe(200);
          expect((await inbox(s.accompanist)).notifications.map((n) => n.kind)).toEqual([
            "mention",
          ]);
          expect((await inbox(s.composer)).notifications).toHaveLength(1);
          expect((await edit({ body: "Can you hear it now?" })).status).toBe(200);
          expect((await inbox(s.composer)).notifications).toHaveLength(1);
          const outsideEdit = await edit({
            body: "And @newcomer",
            mentions: [await idOf(newcomer)],
          });
          expect(outsideEdit.status).toBe(422);

          // Two people with one name: only the one chosen is told.
          await db
            .update(schema.users)
            .set({ name: "composer" })
            .where(eq(schema.users.id, s.ids.engineer));
          await post({ body: "Listen to bar 9, @composer", mentions: [s.ids.composer] });
          expect((await inbox(s.engineer)).notifications).toEqual([]);
          expect((await inbox(s.composer)).notifications).toHaveLength(2);
        });

        it("makes a thread a task that its assignee or triage marks done (#133)", async () => {
          const s = await studio();
          const made = await app.request(
            `/api/files/${s.mix}/comments`,
            json({ body: "Fix the edit at bar 12" }, s.owner),
          );
          const { comment } = (await made.json()) as { comment: { id: string } };
          const todo = (body: unknown, cookie: string) =>
            app.request(`/api/comments/${comment.id}/todo`, json(body, cookie));
          type Task = {
            comment: { todo: boolean; todoDoneAt: string | null; todoDoneByName: string | null };
          };
          // The composer reviews: no triage, and not theirs, so they cannot make it a task.
          expect((await todo({ todo: true }, s.composer)).status).toBe(403);
          const task = await todo({ todo: true }, s.owner);
          expect(task.status).toBe(200);
          expect(((await task.json()) as Task).comment).toMatchObject({
            todo: true,
            todoDoneAt: null,
          });
          // Not theirs yet: refused. Assigned to them: they may mark it done, and only that.
          expect((await todo({ todo: true, done: true }, s.composer)).status).toBe(403);
          await app.request(
            `/api/files/${s.mix}/comments/triage`,
            json({ commentIds: [comment.id], assigneeId: s.ids.composer }, s.owner),
          );
          const done = await todo({ todo: true, done: true }, s.composer);
          expect(done.status).toBe(200);
          expect(((await done.json()) as Task).comment).toMatchObject({
            todo: true,
            todoDoneByName: "composer",
          });
          expect((await todo({ todo: false }, s.composer)).status).toBe(403);
          expect((await todo({ todo: true, done: false }, s.composer)).status).toBe(200);
          // A reply is no task, and a member who cannot see the project finds nothing.
          const reply = await app.request(
            `/api/files/${s.mix}/comments`,
            json({ body: "On it", parentId: comment.id }, s.composer),
          );
          const { comment: answer } = (await reply.json()) as { comment: { id: string } };
          expect(
            (await app.request(`/api/comments/${answer.id}/todo`, json({ todo: true }, s.owner)))
              .status,
          ).toBe(404);
          const newcomer = await joinAs(s.owner, "newcomer@example.test");
          expect((await todo({ todo: true }, newcomer)).status).toBe(404);
          // Archived, the project is read-only, its assignees' tasks included.
          expect(
            (await app.request(`/api/projects/${s.projectId}/archive`, json({}, s.owner))).status,
          ).toBe(204);
          expect((await todo({ todo: true, done: true }, s.composer)).status).toBe(403);
        });

        it("keeps a project's tasks: made by hand or from a thread, run by their rights (#140)", async () => {
          const s = await studio();
          type Rights = { edit: boolean; statusTo: string[]; delete: boolean };
          type Task = {
            id: string;
            key: string;
            number: number;
            title: string;
            status: string;
            assignee: { id: string; name: string } | null;
            commentId: string | null;
            rights: Rights;
            comment: { body: string } | null;
            events: { text: string; actorName: string | null; note: string | null }[];
          };
          const make = (body: unknown, cookie: string, project = s.projectId) =>
            app.request(`/api/projects/${project}/tasks`, json(body, cookie));
          const change = (id: string, body: unknown, cookie: string) =>
            app.request(`/api/tasks/${id}`, { ...json(body, cookie), method: "PATCH" });
          const read = async (res: Response) => ((await res.json()) as { task: Task }).task;
          const list = async (cookie: string) =>
            (
              (await (await getAs(`/api/projects/${s.projectId}/tasks`, cookie)).json()) as {
                tasks: Task[];
              }
            ).tasks;

          // Anyone who writes in the project may make one; whoever only looks may not.
          const viewer = await joinAs(s.owner, "viewer-tasks@example.test");
          await grantRole(s.owner, s.projectId, viewer, "Viewer");
          expect((await make({ title: "Re-export the stems" }, viewer)).status).toBe(403);
          expect((await make({ title: " " }, s.composer)).status).toBe(400);
          const outsider = await joinAs(s.owner, "outsider-tasks@example.test");
          expect(
            (await make({ title: "Mine", assigneeId: await idOf(outsider) }, s.owner)).status,
          ).toBe(422);
          const made = await make(
            { title: "Re-export the stems", assigneeId: s.ids.composer, dueOn: "2026-10-21" },
            s.owner,
          );
          expect(made.status).toBe(201);
          const first = await read(made);
          expect(first).toMatchObject({ key: "R-1", number: 1, status: "pending" });
          expect(first.events.map((e) => e.text)).toEqual([
            "created the task",
            "gave it to composer",
          ]);
          expect((await inbox(s.composer)).notifications.map((n) => n.kind)).toEqual(["task"]);

          // A thread made a task is the next one, titled by its first line, and for whoever the
          // thread is for.
          const posted = await app.request(
            `/api/files/${s.mix}/comments`,
            json({ body: "Clean the pedal noise at bar 5\nIt is worst on the left." }, s.owner),
          );
          const { comment } = (await posted.json()) as { comment: { id: string } };
          await app.request(
            `/api/files/${s.mix}/comments/triage`,
            json({ commentIds: [comment.id], assigneeId: s.ids.accompanist }, s.owner),
          );
          const todo = await app.request(
            `/api/comments/${comment.id}/todo`,
            json({ todo: true }, s.engineer),
          );
          const { comment: thread } = (await todo.json()) as {
            comment: { todo: boolean; taskId: string };
          };
          expect(thread.todo).toBe(true);
          const fromThread = await read(await getAs(`/api/tasks/${thread.taskId}`, s.composer));
          expect(fromThread).toMatchObject({
            key: "R-2",
            title: "Clean the pedal noise at bar 5",
            assignee: { id: s.ids.accompanist },
            commentId: comment.id,
            comment: { body: "Clean the pedal noise at bar 5\nIt is worst on the left." },
          });
          // Making it a task again makes no second one.
          await app.request(`/api/comments/${comment.id}/todo`, json({ todo: true }, s.owner));
          expect((await list(s.owner)).map((t) => t.key)).toEqual(["R-1", "R-2"]);
          // The comment it came from is only for those who may read comments.
          expect(
            (await read(await getAs(`/api/tasks/${thread.taskId}`, viewer))).comment,
          ).toMatchObject({ body: expect.any(String) });
          // Giving the task to someone else gives them the thread too.
          expect(
            (await change(thread.taskId, { assigneeId: s.ids.composer }, s.engineer)).status,
          ).toBe(200);
          const threads = (await (await getAs(`/api/files/${s.mix}/comments`, s.owner)).json()) as {
            comments: { id: string; assigneeId: string | null }[];
          };
          expect(threads.comments.find((c) => c.id === comment.id)?.assigneeId).toBe(
            s.ids.composer,
          );
          // And giving the thread to someone gives them the task, and tells them so.
          await app.request(
            `/api/files/${s.mix}/comments/triage`,
            json({ commentIds: [comment.id], assigneeId: s.ids.accompanist }, s.owner),
          );
          expect((await inbox(s.accompanist)).notifications.map((n) => n.kind)).toContain("task");
          expect(
            (await read(await getAs(`/api/tasks/${thread.taskId}`, s.owner))).assignee,
          ).toMatchObject({
            id: s.ids.accompanist,
          });

          // Whoever it is for moves it along, but neither edits it nor approves their own.
          const mine = (await list(s.composer)).find((t) => t.id === first.id);
          expect(mine?.rights).toMatchObject({ edit: false, delete: false });
          expect((await change(first.id, { title: "Mine now" }, s.composer)).status).toBe(403);
          expect((await change(first.id, { status: "in_progress" }, s.composer)).status).toBe(200);
          const waiting = await change(first.id, { status: "needs_approval" }, s.composer);
          expect((await read(waiting)).status).toBe("needs_approval");
          expect((await inbox(s.owner)).notifications.map((n) => n.kind)).toContain("task");
          expect((await change(first.id, { status: "done" }, s.composer)).status).toBe(403);
          // Someone else in the project only reads it, and may add a note.
          expect((await change(first.id, { status: "done" }, s.accompanist)).status).toBe(403);
          expect(
            (
              await app.request(
                `/api/tasks/${first.id}/notes`,
                json({ note: "Heard it" }, s.accompanist),
              )
            ).status,
          ).toBe(201);
          expect(
            (await app.request(`/api/tasks/${first.id}/notes`, json({ note: "Me too" }, viewer)))
              .status,
          ).toBe(403);
          const approved = await read(await change(first.id, { status: "done" }, s.owner));
          expect(approved.events.map((e) => e.text).slice(-3)).toEqual([
            "marked it done, waiting for approval",
            "added a note",
            "approved and closed it",
          ]);

          // The list as a spreadsheet, done last.
          const csv = await getAs(`/api/projects/${s.projectId}/tasks.csv`, viewer);
          expect(csv.headers.get("content-type")).toContain("text/csv");
          const lines = (await csv.text()).trim().split("\r\n");
          expect(lines.map((l) => l.split(",")[0])).toEqual(["Key", "R-2", "R-1"]);

          // A member who cannot see the project finds nothing, nor as another workspace's owner.
          expect((await getAs(`/api/tasks/${first.id}`, outsider)).status).toBe(404);
          expect((await change(first.id, { title: "Theirs" }, outsider)).status).toBe(404);
          const [other] = await db
            .insert(schema.organisations)
            .values({ name: "Saltmarsh Films", slug: "saltmarsh-tasks" })
            .returning({ id: schema.organisations.id });
          await db.insert(schema.members).values({
            organisationId: other?.id ?? "",
            userId: await idOf(outsider),
            role: "owner",
          });
          expect(
            (
              await app.request("/api/me/organisation", {
                ...json({ organisationId: other?.id }, outsider),
                method: "PUT",
              })
            ).status,
          ).toBe(200);
          expect((await getAs(`/api/tasks/${first.id}`, outsider)).status).toBe(404);
          expect((await make({ title: "Theirs" }, outsider)).status).toBe(404);
          expect((await change(first.id, { status: "done" }, outsider)).status).toBe(404);

          // Deleting is for whoever runs it; a thread no longer a task has none.
          expect(
            (
              await app.request(`/api/tasks/${first.id}`, {
                ...json({}, s.composer),
                method: "DELETE",
              })
            ).status,
          ).toBe(403);
          expect(
            (
              await app.request(`/api/tasks/${first.id}`, {
                ...json({}, s.owner),
                method: "DELETE",
              })
            ).status,
          ).toBe(204);
          await app.request(`/api/comments/${comment.id}/todo`, json({ todo: false }, s.owner));
          expect(await list(s.owner)).toEqual([]);
          // Numbers are never reused.
          expect((await read(await make({ title: "Again" }, s.owner))).key).toBe("R-3");
        });

        it("reminds whoever a task is for on its day and once late, once each (#140)", async () => {
          const s = await studio();
          const made = await app.request(
            `/api/projects/${s.projectId}/tasks`,
            json(
              { title: "Bounce the stems", assigneeId: s.ids.composer, dueOn: "2026-10-21" },
              s.owner,
            ),
          );
          const { task } = (await made.json()) as { task: { id: string } };
          const texts = async () =>
            (await inbox(s.composer)).notifications
              .filter((n) => n.kind === "task")
              .map((n) => n.text);
          // Being given it is one; the day before, and before eight on the day, nothing more.
          expect(await texts()).toHaveLength(1);
          expect(await remindTasksDue(db, new Date("2026-10-20T12:00:00Z"))).toBe(0);
          expect(await remindTasksDue(db, new Date("2026-10-21T07:00:00Z"))).toBe(0);
          // On the day, once; the next day, late, once.
          expect(await remindTasksDue(db, new Date("2026-10-21T09:00:00Z"))).toBe(1);
          expect(await remindTasksDue(db, new Date("2026-10-21T15:00:00Z"))).toBe(0);
          expect(await remindTasksDue(db, new Date("2026-10-22T09:00:00Z"))).toBe(1);
          expect(await remindTasksDue(db, new Date("2026-10-23T09:00:00Z"))).toBe(0);
          expect((await texts()).slice(0, 2)).toEqual([
            "your task R-1 is overdue",
            "your task R-1 is due today",
          ]);
          // Moved away and set back to the same day, it is reminded of afresh.
          const move = (dueOn: string) =>
            app.request(`/api/tasks/${task.id}`, { ...json({ dueOn }, s.owner), method: "PATCH" });
          await move("2026-10-30");
          await move("2026-10-21");
          expect(await remindTasksDue(db, new Date("2026-10-23T09:00:00Z"))).toBe(1);
          // Done, it is never reminded of again, even given a new date.
          await app.request(`/api/tasks/${task.id}`, {
            ...json({ dueOn: "2026-10-28", status: "done" }, s.owner),
            method: "PATCH",
          });
          expect(await remindTasksDue(db, new Date("2026-10-28T09:00:00Z"))).toBe(0);
        });

        it("keeps a project's calendar, and a feed of it that only its owner's access opens (#141)", async () => {
          const s = await studio();
          await app.request(
            `/api/projects/${s.projectId}/tasks`,
            json({ title: "Bounce the stems; then, master", dueOn: "2026-10-21" }, s.owner),
          );
          type Month = {
            events: { kind: string; date: string; title: string; link: string }[];
            feed: { createdAt: string } | null;
          };
          const month = async (cookie: string, m = "2026-10") =>
            (await (
              await getAs(`/api/projects/${s.projectId}/calendar?month=${m}`, cookie)
            ).json()) as Month;
          // A review due at five in the afternoon in Los Angeles is that day there, though
          // already the next in UTC.
          await db
            .update(schema.users)
            .set({ timeZone: "America/Los_Angeles" })
            .where(eq(schema.users.id, s.ids.composer));
          await request(s.owner, s.projectId, {
            kind: "feedback",
            title: "First listen",
            items: [{ trackId: s.trackId }],
            reviewers: [s.ids.composer],
            dueAt: "2026-10-22T00:00:00.000Z",
          });
          const october = await month(s.composer);
          expect(october.events).toMatchObject([
            { kind: "review", date: "2026-10-21", title: "First listen" },
            { kind: "task", date: "2026-10-21", title: "Bounce the stems; then, master" },
          ]);
          expect((await month(s.owner)).events.find((e) => e.kind === "review")?.date).toBe(
            "2026-10-22",
          );
          expect(october.feed).toBeNull();
          expect((await month(s.composer, "2026-12")).events).toEqual([]);
          expect(
            (await getAs(`/api/projects/${s.projectId}/calendar?month=2026-13`, s.composer)).status,
          ).toBe(400);

          // A feed: shown once, then read with no session, as a calendar reads it.
          const feedOf = async (cookie: string) =>
            (
              (await (
                await app.request(`/api/projects/${s.projectId}/calendar/feed`, json({}, cookie))
              ).json()) as {
                url: string;
              }
            ).url;
          const read = (url: string) => app.request(new URL(url).pathname);
          const first = await feedOf(s.composer);
          const ics = await read(first);
          expect(ics.status).toBe(200);
          expect(ics.headers.get("content-type")).toContain("text/calendar");
          const text = await ics.text();
          expect(text).toContain("SUMMARY:Bounce the stems\\; then\\, master");
          expect(text).toContain("DTSTART;VALUE=DATE:20261021");
          expect((await month(s.composer)).feed).not.toBeNull();
          expect(text).toContain("SUMMARY:First listen");
          expect(text).toContain(
            "DTSTART;VALUE=DATE:20261021\r\nDTEND;VALUE=DATE:20261022\r\nSUMMARY:First listen",
          );
          // A new link replaces the old, even two asked for at once; a made-up one opens nothing.
          const both = await Promise.all([feedOf(s.composer), feedOf(s.composer)]);
          expect(
            (await Promise.all(both.map(async (url) => (await read(url)).status))).sort(),
          ).toEqual([200, 404]);
          const second = await feedOf(s.composer);
          expect((await read(first)).status).toBe(404);
          expect((await read(second)).status).toBe(200);
          expect((await app.request(`/api/calendar/${"a".repeat(43)}.ics`)).status).toBe(404);
          // It shows only what its owner may still see: out of the project, nothing.
          await db
            .delete(schema.projectMembers)
            .where(eq(schema.projectMembers.userId, s.ids.composer));
          expect((await read(second)).status).toBe(404);
          // Nor for someone who has left the workspace.
          const engineers = await feedOf(s.engineer);
          expect((await read(engineers)).status).toBe(200);
          await db
            .delete(schema.members)
            .where(
              and(
                eq(schema.members.organisationId, s.organisationId),
                eq(schema.members.userId, s.ids.engineer),
              ),
            );
          expect((await read(engineers)).status).toBe(404);
          // A member who cannot see the project neither reads its calendar nor gets a feed of it.
          const outsider = await joinAs(s.owner, "outsider-calendar@example.test");
          expect(
            (await getAs(`/api/projects/${s.projectId}/calendar?month=2026-10`, outsider)).status,
          ).toBe(404);
          expect(
            (await app.request(`/api/projects/${s.projectId}/calendar/feed`, json({}, outsider)))
              .status,
          ).toBe(404);
          // A suspended workspace's feeds open nothing until it is back.
          const owners = await feedOf(s.owner);
          expect((await read(owners)).status).toBe(200);
          const suspend = (at: Date | null) =>
            db
              .update(schema.organisations)
              .set({ suspendedAt: at })
              .where(eq(schema.organisations.id, s.organisationId));
          await suspend(new Date());
          expect((await read(owners)).status).toBe(404);
          await suspend(null);
          // Stopped, it is gone.
          expect((await read(owners)).status).toBe(200);
          await app.request(`/api/projects/${s.projectId}/calendar/feed`, {
            ...json({}, s.owner),
            method: "DELETE",
          });
          expect((await read(owners)).status).toBe(404);
        });

        it("carries files attached to a comment, downloaded once each and logged (#133)", async () => {
          const s = await studio();
          const post = (body: unknown, cookie = s.owner) =>
            app.request(`/api/files/${s.mix}/comments`, json(body, cookie));
          const { comment } = (await (await post({ body: "Markings for bar 12" })).json()) as {
            comment: { id: string };
          };
          const attach = (bytes: Buffer, name: string, cookie = s.owner, commentId = comment.id) =>
            app.request(`/api/files/${s.mix}/comments/${commentId}/attachments`, {
              method: "POST",
              headers: {
                cookie,
                origin: "http://localhost:3000",
                "content-type": "image/png",
                "x-file-name": encodeURIComponent(name),
              },
              body: new Uint8Array(bytes),
            });
          const picture = Buffer.from("not really a picture, but bytes all the same");
          const added = await attach(picture, "Bar 12 markings.png");
          expect(added.status).toBe(201);
          const { attachment } = (await added.json()) as { attachment: { id: string } };
          type Listed = {
            comments: {
              id: string;
              attachments: { id: string; name: string; byteSize: number }[];
            }[];
          };
          const listed = async (cookie: string) =>
            ((await (await getAs(`/api/files/${s.mix}/comments`, cookie)).json()) as Listed)
              .comments;
          expect((await listed(s.composer)).find((c) => c.id === comment.id)?.attachments).toEqual([
            {
              id: attachment.id,
              name: "Bar 12 markings.png",
              contentType: "image/png",
              byteSize: picture.length,
            },
          ]);
          // Stored like any other bytes: encrypted, never as they came.
          const [row] = await db
            .select({ blobId: schema.commentAttachments.blobId })
            .from(schema.commentAttachments)
            .where(eq(schema.commentAttachments.id, attachment.id));
          const [blob] = await db
            .select()
            .from(schema.blobs)
            .where(eq(schema.blobs.id, row?.blobId ?? ""));
          expect(blob?.wrappedKey).toBeTruthy();

          // Only its author attaches to a comment; names, sizes and the count are checked, and a
          // refusal is made before anything is stored.
          const stored = async () =>
            (
              await db
                .select({ n: count() })
                .from(schema.blobs)
                .where(eq(schema.blobs.organisationId, s.organisationId))
            )[0]?.n;
          const before = await stored();
          expect((await attach(picture, "Mine.png", s.composer)).status).toBe(403);
          expect(await stored()).toBe(before);
          expect((await attach(Buffer.alloc(0), "Empty.png")).status).toBe(400);
          expect((await attach(picture, "../etc/passwd")).status).toBe(400);
          expect((await attach(Buffer.alloc(25 * 1024 * 1024 + 1), "Too large.wav")).status).toBe(
            413,
          );
          for (let i = 2; i <= 5; i++)
            expect((await attach(picture, `Page ${i}.png`)).status).toBe(201);
          const full = await stored();
          expect((await attach(picture, "Page 6.png")).status).toBe(409);
          expect(await stored()).toBe(full);

          // A download is made for one person, works once, and is logged first.
          const ticket = (cookie: string, id = attachment.id) =>
            app.request(`/api/files/${s.mix}/attachments/${id}/download`, json({}, cookie));
          const made = await ticket(s.composer);
          expect(made.status).toBe(201);
          const { url } = (await made.json()) as { url: string };
          expect((await getAs(url, s.owner)).status).toBe(410);
          const fetched = await getAs(url, s.composer);
          expect(fetched.status).toBe(200);
          expect(fetched.headers.get("content-disposition")).toContain("attachment;");
          expect(fetched.headers.get("cache-control")).toContain("no-store");
          expect(Buffer.from(await fetched.arrayBuffer())).toEqual(picture);
          expect((await getAs(url, s.composer)).status).toBe(410);
          const logged = await db
            .select({ action: schema.accessEvents.action })
            .from(schema.accessEvents)
            .where(
              sql`${schema.accessEvents.action} in ('comment.attachment_add', 'comment.attachment_download')`,
            );
          expect(logged.map((e) => e.action).sort()).toEqual([
            ...Array(5).fill("comment.attachment_add"),
            "comment.attachment_download",
          ]);
          // Someone who cannot see the project finds nothing.
          const newcomer = await joinAs(s.owner, "newcomer@example.test");
          expect((await ticket(newcomer)).status).toBe(404);

          // Reconciliation counts the bytes as in use.
          const [report] = await reconcileStorage(
            { db, storage, audit },
            { graceMs: 0, remove: false, organisations: [s.organisationId] },
          );
          expect(report?.unreferencedBlobs).toBe(0);

          // Its author removes one; nobody else may.
          const remove = (cookie: string) =>
            app.request(`/api/files/${s.mix}/attachments/${attachment.id}`, {
              method: "DELETE",
              headers: { cookie, origin: "http://localhost:3000" },
            });
          expect((await remove(s.composer)).status).toBe(403);
          expect((await remove(s.owner)).status).toBe(204);
          expect(
            (await listed(s.owner)).find((c) => c.id === comment.id)?.attachments,
          ).toHaveLength(4);
          const [gone] = await db
            .select()
            .from(schema.blobs)
            .where(eq(schema.blobs.id, row?.blobId ?? ""));
          expect(gone).toBeUndefined();
          expect((await ticket(s.owner)).status).toBe(404);
        });

        it("lays a video's captions from sidecar files, for whoever may see it (#146)", async () => {
          const s = await studio();
          const add = (body: string, name: string, label: string, cookie = s.owner) =>
            app.request(`/api/files/${s.mix}/captions?label=${encodeURIComponent(label)}`, {
              method: "POST",
              headers: {
                cookie,
                origin: "http://localhost:3000",
                "content-type": "application/octet-stream",
                "x-file-name": encodeURIComponent(name),
              },
              body: new TextEncoder().encode(body),
            });
          const srt = "1\n00:00:06,000 --> 00:00:09,500\n<i>ENDLESS HALL RECORDS</i>\nPRESENTS\n";
          // A recording carries none.
          expect((await add(srt, "Titles.srt", "English")).status).toBe(409);
          await db.update(schema.files).set({ kind: "video" }).where(eq(schema.files.id, s.mix));
          const added = await add(srt, "Titles.srt", "English", s.engineer);
          expect(added.status).toBe(201);
          const { caption } = (await added.json()) as { caption: { id: string } };
          type Listed = {
            captions: { id: string; label: string; format: string; cues: object[] }[];
          };
          const listed = async (cookie: string) => {
            const res = await getAs(`/api/files/${s.mix}/captions`, cookie);
            return res.status === 200 ? ((await res.json()) as Listed).captions : res.status;
          };
          // Whoever may view the video reads its cues; nobody else learns it has any.
          expect(await listed(s.composer)).toEqual([
            {
              id: caption.id,
              label: "English",
              name: "Titles.srt",
              format: "srt",
              cues: [{ start: 6, end: 9.5, text: "ENDLESS HALL RECORDS\nPRESENTS" }],
              createdAt: expect.any(String),
            },
          ]);
          const outsider = await joinAs(s.owner, "outsider-captions@example.test");
          expect(await listed(outsider)).toBe(404);
          // Stored like any other bytes: encrypted.
          const [row] = await db
            .select({ blobId: schema.captionTracks.blobId })
            .from(schema.captionTracks)
            .where(eq(schema.captionTracks.id, caption.id));
          const [blob] = await db
            .select()
            .from(schema.blobs)
            .where(eq(schema.blobs.id, row?.blobId ?? ""));
          expect(blob?.wrappedKey).toBeTruthy();

          // Only those who may upload add or remove captions, and only files that read as some.
          const stored = async () =>
            (
              await db
                .select({ n: count() })
                .from(schema.blobs)
                .where(eq(schema.blobs.organisationId, s.organisationId))
            )[0]?.n;
          const before = await stored();
          expect((await add(srt, "Mine.srt", "Mine", s.composer)).status).toBe(403);
          expect((await add("Just some words", "Notes.txt", "Notes")).status).toBe(422);
          const broken = await add("WEBVTT\n\n00:01 --> 00:02\nHi\n", "Broken.vtt", "Broken");
          expect(broken.status).toBe(422);
          expect(((await broken.json()) as { error: { message: string } }).error.message).toContain(
            "This timing cannot be read",
          );
          expect((await add(srt, "Titles.srt", "")).status).toBe(400);
          expect(await stored()).toBe(before);
          const vtt = "WEBVTT\n\n00:06.000 --> 00:09.500\nENDLESS HALL RECORDS PRÉSENTE\n";
          expect((await add(vtt, "Titres.vtt", "Français")).status).toBe(201);
          const removing = (id: string, cookie = s.owner) =>
            app.request(`/api/files/${s.mix}/captions/${id}`, {
              ...json({}, cookie),
              method: "DELETE",
            });
          expect((await removing(caption.id, s.composer)).status).toBe(403);
          expect((await removing(caption.id)).status).toBe(204);
          expect((await removing(caption.id)).status).toBe(404);
          const left = await listed(s.owner);
          expect(Array.isArray(left) && left.map((c) => c.label)).toEqual(["Français"]);
          const actions = await db
            .select({ action: schema.accessEvents.action })
            .from(schema.accessEvents)
            .where(eq(schema.accessEvents.organisationId, s.organisationId));
          expect(actions.filter((a) => a.action.startsWith("file.captions_")).length).toBe(3);
        });

        it("gives each role its player tools, and refuses a tool a role has off (#240)", async () => {
          const s = await studio();
          type Roles = {
            roles: { id: string; name: string; tools: string[]; levels: object }[];
          };
          const roles = async () =>
            ((await (await getAs(`/api/projects/${s.projectId}/roles`, s.owner)).json()) as Roles)
              .roles;
          const before = await roles();
          // A new project's roles: the engineer's tools for those who make the record.
          expect(before.find((r) => r.name === "Producer")?.tools).toEqual([
            "qa",
            "meters",
            "spectrogram",
            "score",
            "compare",
            "loops",
            "normalise",
          ]);
          const reviewer = before.find((r) => r.name === "Reviewer");
          expect(reviewer?.tools).toEqual(["score", "compare", "loops", "normalise"]);

          // The server refuses what the role has off, not only the page.
          for (const path of ["qa", "loudness", "spectrograms"])
            expect((await getAs(`/api/files/${s.mix}/${path}`, s.composer)).status).toBe(403);
          expect((await getAs(`/api/files/${s.mix}/qa`, s.engineer)).status).toBe(200);
          const file = (await (await getAs(`/api/files/${s.mix}`, s.composer)).json()) as {
            file: { tools: string[] | null };
          };
          expect(file.file.tools).toEqual(["score", "compare", "loops", "normalise"]);

          // Only those who manage roles turn tools on; then the reviewer has QA.
          const change = (tools: string[], cookie: string) =>
            app.request(`/api/projects/${s.projectId}/roles/${reviewer?.id}`, {
              ...json({ name: "Reviewer", levels: reviewer?.levels, tools }, cookie),
              method: "PATCH",
            });
          expect((await change(["qa", "score"], s.engineer)).status).toBe(403);
          expect((await change(["qa", "score"], s.owner)).status).toBe(200);
          expect((await getAs(`/api/files/${s.mix}/qa`, s.composer)).status).toBe(200);
          expect((await getAs(`/api/files/${s.mix}/loudness`, s.composer)).status).toBe(403);
          // A change that leaves tools out keeps them.
          expect(
            (
              await app.request(`/api/projects/${s.projectId}/roles/${reviewer?.id}`, {
                ...json({ name: "Reviewers", levels: reviewer?.levels }, s.owner),
                method: "PATCH",
              })
            ).status,
          ).toBe(200);
          expect((await roles()).find((r) => r.id === reviewer?.id)?.tools).toEqual([
            "qa",
            "score",
          ]);
          // A new role listens.
          const made = await app.request(
            `/api/projects/${s.projectId}/roles`,
            json({ name: "Soloist", permissions: ["view"] }, s.owner),
          );
          expect(((await made.json()) as { role: { tools: string[] } }).role.tools).toEqual([
            "score",
            "compare",
            "loops",
            "normalise",
          ]);
          // Workspace owners have every tool, whatever their role.
          expect((await getAs(`/api/files/${s.mix}/loudness`, s.owner)).status).not.toBe(403);
        });

        it("keeps a track's takes, with their bars, and finds those covering a bar (#21, #46)", async () => {
          const s = await studio();
          const recording = async (name: string, kind: "audio" | "document" = "audio") => {
            const blob = await storage.put(s.organisationId, Buffer.from(name));
            const [row] = await db
              .insert(schema.files)
              .values({
                organisationId: s.organisationId,
                projectId: s.projectId,
                name,
                kind,
                blobId: blob.id,
                contentType: kind === "audio" ? "audio/wav" : "application/pdf",
                byteSize: blob.byteSize,
                mediaInfo: { duration: 92.5 } as never,
              })
              .returning();
            return row?.id ?? "";
          };
          const t1 = await recording("Take 1.wav");
          const t2 = await recording("Take 2.wav");
          const t3 = await recording("Take 3.wav");
          const add = (fileIds: string[], cookie = s.engineer) =>
            app.request(`/api/tracks/${s.trackId}/takes`, json({ fileIds }, cookie));
          type Listed = { takes: { id: string; number: number; file: { id: string } | null }[] };

          // A reviewer sees takes but cannot make them; an engineer can.
          expect((await add([t1], s.composer)).status).toBe(403);
          const added = await add([t1, t2, t3]);
          expect(added.status).toBe(201);
          const { takes } = (await added.json()) as Listed;
          expect(takes.map((t) => [t.number, t.file?.id])).toEqual([
            [1, t1],
            [2, t2],
            [3, t3],
          ]);
          // Not twice, not a version's file, not a document, not another project's.
          expect((await add([t1])).status).toBe(409);
          expect((await add([s.mix])).status).toBe(409);
          expect((await add([await recording("Notes.pdf", "document")])).status).toBe(422);
          expect((await add(["0199f000-0000-7000-8000-000000000001"])).status).toBe(404);

          // Bars, rating, star and notes; bars in the wrong order are refused.
          const change = (id: string, body: unknown, cookie = s.engineer) =>
            app.request(`/api/takes/${id}`, { ...json(body, cookie), method: "PATCH" });
          const [one, two, three] = takes;
          expect(
            (await change(one?.id ?? "", { barFrom: 60, barTo: 80, rating: 3, notes: "Steady" }))
              .status,
          ).toBe(200);
          expect((await change(two?.id ?? "", { barFrom: 70, barTo: 90, rating: 5 })).status).toBe(
            200,
          );
          expect(
            (await change(three?.id ?? "", { barFrom: 72, page: 7, starred: true })).status,
          ).toBe(200);
          expect((await change(one?.id ?? "", { barTo: 50 })).status).toBe(422);
          expect((await change(one?.id ?? "", { inPoint: 30, outPoint: 12 })).status).toBe(422);
          expect((await change(one?.id ?? "", { rating: 2 }, s.composer)).status).toBe(403);

          // "Any other options for bar 72?": circled first, then the best.
          const covering = (await (
            await getAs(`/api/tracks/${s.trackId}/takes?bar=72`, s.composer)
          ).json()) as Listed;
          expect(covering.takes.map((t) => t.number)).toEqual([3, 2, 1]);
          const none = (await (
            await getAs(`/api/tracks/${s.trackId}/takes?bar=95`, s.composer)
          ).json()) as Listed;
          expect(none.takes).toEqual([]);

          // A score mark (#52) saying take 1 fixed bar 95 offers it there, first, to those who
          // see the production tools; a reviewer, who does not, still sees the takes by bars.
          await db.insert(schema.scoreMarks).values({
            organisationId: s.organisationId,
            trackId: s.trackId,
            kind: "issue",
            page: 1,
            x: 0.5,
            y: 0.5,
            barFrom: 94,
            barTo: 96,
            text: "Late entry",
            takes: [2],
            fixedBy: 1,
          });
          const atBar = async (bar: number, cookie: string) =>
            (
              (await (
                await getAs(`/api/tracks/${s.trackId}/takes?bar=${bar}`, cookie)
              ).json()) as Listed
            ).takes.map((t) => t.number);
          expect(await atBar(95, s.engineer)).toEqual([1]);
          expect(await atBar(95, s.composer)).toEqual([]);
          expect(await atBar(72, s.engineer)).toEqual([3, 2, 1]);

          // The file page says which take a file is.
          const details = (await (await getAs(`/api/files/${t3}/details`, s.composer)).json()) as {
            usedIn: { take: { number: number; track: string } | null };
          };
          expect(details.usedIn.take).toMatchObject({ number: 3, track: "Maple Leaf Rag" });

          // A member who cannot see the project finds nothing.
          const newcomer = await joinAs(s.owner, "newcomer@example.test");
          expect((await getAs(`/api/tracks/${s.trackId}/takes`, newcomer)).status).toBe(404);

          // Removed, the file stays in the project and is no longer a take.
          const remove = await app.request(`/api/takes/${one?.id}`, {
            method: "DELETE",
            headers: { cookie: s.engineer, origin: "http://localhost:3000" },
          });
          expect(remove.status).toBe(204);
          const [file] = await db
            .select({ takeId: schema.files.takeId })
            .from(schema.files)
            .where(eq(schema.files.id, t1));
          expect(file).toEqual({ takeId: null });
          expect(
            ((await (await getAs(`/api/tracks/${s.trackId}/takes`, s.owner)).json()) as Listed)
              .takes,
          ).toHaveLength(2);

          // An archived project's takes are read-only.
          expect(
            (await app.request(`/api/projects/${s.projectId}/archive`, json({}, s.owner))).status,
          ).toBe(204);
          expect((await change(two?.id ?? "", { rating: 1 })).status).toBe(403);
          const kept = await app.request(`/api/takes/${two?.id}`, {
            method: "DELETE",
            headers: { cookie: s.engineer, origin: "http://localhost:3000" },
          });
          expect(kept.status).toBe(403);
        });

        it("keeps recording sessions: the tracks each recorded and the takes made in it (#21, #45)", async () => {
          const s = await studio();
          const blob = await storage.put(s.organisationId, Buffer.from("Take 1.wav"));
          const [mix] = await db
            .insert(schema.files)
            .values({
              organisationId: s.organisationId,
              projectId: s.projectId,
              name: "Take 1.wav",
              kind: "audio",
              blobId: blob.id,
              contentType: "audio/wav",
              byteSize: blob.byteSize,
              mediaInfo: { duration: 61.5 } as never,
            })
            .returning();
          const added = (await (
            await app.request(
              `/api/tracks/${s.trackId}/takes`,
              json({ fileIds: [mix?.id ?? ""] }, s.engineer),
            )
          ).json()) as { takes: { id: string }[] };
          const takeId = added.takes[0]?.id ?? "";
          const send = (method: string, url: string, body: unknown, cookie = s.engineer) =>
            app.request(url, { ...json(body, cookie), method });
          type Summary = {
            id: string;
            name: string;
            recordedOn: string | null;
            tracks: { id: string; name: string }[];
            takes: number;
            starred: number;
            duration: number;
          };

          // Made by those who edit takes, with the tracks it recorded; a reviewer only sees them.
          const day = { name: "Day 2", recordedOn: "2026-10-14", venue: "Endless Hall" };
          expect(
            (await send("POST", `/api/projects/${s.projectId}/sessions`, day, s.composer)).status,
          ).toBe(403);
          const made = await send("POST", `/api/projects/${s.projectId}/sessions`, {
            ...day,
            trackIds: [s.trackId],
          });
          expect(made.status).toBe(201);
          const session = ((await made.json()) as { session: Summary }).session;
          expect(session).toMatchObject({
            name: "Day 2",
            recordedOn: "2026-10-14",
            tracks: [{ id: s.trackId }],
            takes: 0,
          });
          // Not with a track of another project.
          expect(
            (
              await send("POST", `/api/projects/${s.projectId}/sessions`, {
                name: "Stray",
                trackIds: ["0199f000-0000-7000-8000-000000000001"],
              })
            ).status,
          ).toBe(404);

          // A take says which session it was recorded in; the session then counts it.
          const change = (body: unknown, cookie = s.engineer) =>
            send("PATCH", `/api/takes/${takeId}`, body, cookie);
          expect((await change({ sessionId: session.id, starred: true })).status).toBe(200);
          expect((await change({ sessionId: "0199f000-0000-7000-8000-000000000001" })).status).toBe(
            404,
          );
          const listed = (await (
            await getAs(`/api/projects/${s.projectId}/sessions`, s.composer)
          ).json()) as { sessions: Summary[] };
          expect(listed.sessions).toEqual([
            expect.objectContaining({ id: session.id, takes: 1, starred: 1, duration: 61.5 }),
          ]);
          const detail = (await (
            await getAs(`/api/sessions/${session.id}`, s.composer)
          ).json()) as {
            session: { takeRows: { id: string; sessionId: string; track: { id: string } }[] };
          };
          expect(detail.session.takeRows).toEqual([
            expect.objectContaining({
              id: takeId,
              sessionId: session.id,
              track: expect.objectContaining({ id: s.trackId }),
            }),
          ]);

          // Renamed and its tracks replaced; a reviewer may not.
          expect(
            (await send("PATCH", `/api/sessions/${session.id}`, { name: "Day 3" }, s.composer))
              .status,
          ).toBe(403);
          const renamed = await send("PATCH", `/api/sessions/${session.id}`, {
            name: "Day 3",
            trackIds: [],
          });
          expect(((await renamed.json()) as { session: Summary }).session).toMatchObject({
            name: "Day 3",
            tracks: [],
          });

          // A member who cannot see the project finds nothing.
          const newcomer = await joinAs(s.owner, "newcomer@example.test");
          expect((await getAs(`/api/sessions/${session.id}`, newcomer)).status).toBe(404);
          expect((await getAs(`/api/projects/${s.projectId}/sessions`, newcomer)).status).toBe(404);
          // Another workspace's session does not exist from here, and no take can name it.
          const [elsewhere] = await db
            .insert(schema.organisations)
            .values({ name: "Elsewhere", slug: "elsewhere-sessions" })
            .returning();
          const [foreignProject] = await db
            .insert(schema.projects)
            .values({ organisationId: elsewhere?.id ?? "", name: "Theirs", profile: "music" })
            .returning();
          const [foreign] = await db
            .insert(schema.sessions)
            .values({
              organisationId: elsewhere?.id ?? "",
              projectId: foreignProject?.id ?? "",
              name: "Theirs",
            })
            .returning();
          expect((await getAs(`/api/sessions/${foreign?.id}`, s.owner)).status).toBe(404);
          expect((await change({ sessionId: foreign?.id })).status).toBe(404);

          // Removed, its takes stay with their track and no longer name it.
          const gone = await app.request(`/api/sessions/${session.id}`, {
            method: "DELETE",
            headers: { cookie: s.engineer, origin: "http://localhost:3000" },
          });
          expect(gone.status).toBe(204);
          const [kept] = await db
            .select({ sessionId: schema.takes.sessionId })
            .from(schema.takes)
            .where(eq(schema.takes.id, takeId));
          expect(kept).toEqual({ sessionId: null });
        });

        it("logs takes live: numbered as the session says, rolled, stopped and timed (#51)", async () => {
          const s = await studio();
          const send = (method: string, url: string, body: unknown, cookie = s.engineer) =>
            app.request(url, { ...json(body, cookie), method });
          const [second] = await db
            .insert(schema.tracks)
            .values({ organisationId: s.organisationId, projectId: s.projectId, name: "Trio" })
            .returning();
          const trio = second?.id ?? "";
          type Take = {
            id: string;
            number: number;
            lifecycle: string;
            wallIn: string | null;
            wallOut: string | null;
            timecodeIn: string | null;
            falseStarts: number;
          };
          const made = await send("POST", `/api/projects/${s.projectId}/sessions`, {
            name: "Day 1",
            numbering: "continuous",
            slotStart: "2026-10-14T14:00:00Z",
            slotEnd: "2026-10-14T16:00:00Z",
          });
          expect(made.status).toBe(201);
          const session = ((await made.json()) as { session: { id: string; numbering: string } })
            .session;
          expect(session).toMatchObject({
            numbering: "continuous",
            slotStart: "2026-10-14T14:00:00.000Z",
            slotEnd: "2026-10-14T16:00:00.000Z",
          });
          // A slot that ends before it starts is refused.
          expect(
            (
              await send("PATCH", `/api/sessions/${session.id}`, {
                slotEnd: "2026-10-14T13:00:00Z",
              })
            ).status,
          ).toBe(422);

          const start = (body: Record<string, unknown>, cookie = s.engineer) =>
            send("POST", `/api/sessions/${session.id}/takes`, body, cookie);
          // A reviewer may not log takes.
          expect((await start({ trackId: s.trackId }, s.composer)).status).toBe(403);
          const first = await start({ trackId: s.trackId, timecodeIn: "10:00:00:00" });
          expect(first.status).toBe(201);
          const one = ((await first.json()) as { take: Take }).take;
          expect(one).toMatchObject({
            number: 1,
            lifecycle: "recording",
            timecodeIn: "10:00:00:00",
          });
          expect(one.wallIn).not.toBeNull();

          // One take is live at a time: a second start while the first rolls is refused.
          const meanwhile = await start({ trackId: trio });
          expect(meanwhile.status).toBe(409);
          expect(((await meanwhile.json()) as { error: { message: string } }).error.message).toBe(
            "Take 1 is still recording; stop it before starting the next",
          );
          await send("PATCH", `/api/takes/${one.id}`, { lifecycle: "recorded" });

          // Continuous numbering runs on across the project's tracks; the session gains the track.
          const two = (
            (await (await start({ trackId: trio, lifecycle: "armed" })).json()) as {
              take: Take;
            }
          ).take;
          expect(two).toMatchObject({ number: 2, lifecycle: "armed", wallIn: null });
          const detail = (await (
            await getAs(`/api/sessions/${session.id}`, s.composer)
          ).json()) as {
            session: { tracks: { id: string }[]; takeRows: Take[] };
          };
          expect(detail.session.tracks.map((t) => t.id).sort()).toEqual([s.trackId, trio].sort());
          // It says what each track's next take would be numbered, for the log to show.
          expect(
            (
              (await (await getAs(`/api/sessions/${session.id}`, s.composer)).json()) as {
                session: { nextNumbers: Record<string, number> };
              }
            ).session.nextNumbers,
          ).toEqual({ [s.trackId]: 3, [trio]: 3 });
          expect(detail.session.takeRows.map((t) => t.number).sort()).toEqual([1, 2]);

          // Stopped, it was timed out; a false start counted; a recorded take cannot roll again.
          const change = (id: string, body: unknown) => send("PATCH", `/api/takes/${id}`, body);
          const stopped = await change(one.id, { falseStarts: 1 });
          expect(stopped.status).toBe(200);
          const after = ((await stopped.json()) as { take: Take }).take;
          expect(after).toMatchObject({ lifecycle: "recorded", falseStarts: 1 });
          expect(after.wallOut).not.toBeNull();
          expect((await change(one.id, { lifecycle: "recording" })).status).toBe(409);
          // Nor is it aborted after the event.
          expect((await change(one.id, { lifecycle: "aborted" })).status).toBe(409);
          // Its pages run forwards, the first given.
          expect((await change(one.id, { pageTo: 3 })).status).toBe(422);
          expect((await change(one.id, { page: 4, pageTo: 3 })).status).toBe(422);
          expect((await change(one.id, { page: 3, pageTo: 4 })).status).toBe(200);
          // Armed, then rolling, then aborted; an aborted take may be counted after all.
          expect((await change(two.id, { lifecycle: "recording" })).status).toBe(200);
          expect((await change(two.id, { lifecycle: "aborted" })).status).toBe(200);
          expect((await change(two.id, { lifecycle: "recorded" })).status).toBe(200);
          // Timecodes are timecodes.
          expect((await change(two.id, { timecodeOut: "ten past" })).status).toBe(400);

          // Numbered per track, a session starts each track from its own last take.
          const perTrack = (
            (await (
              await send("POST", `/api/projects/${s.projectId}/sessions`, {
                name: "Day 2",
                numbering: "per-track",
              })
            ).json()) as { session: { id: string } }
          ).session;
          const next = await send("POST", `/api/sessions/${perTrack.id}/takes`, { trackId: trio });
          const third = ((await next.json()) as { take: Take }).take;
          expect(third.number).toBe(3);
          await send("PATCH", `/api/takes/${third.id}`, { lifecycle: "recorded" });
          // By the recorder, its number is taken as given, and refused when already logged.
          await send("PATCH", `/api/sessions/${perTrack.id}`, { numbering: "recorder" });
          const recorder = (n: number) =>
            send("POST", `/api/sessions/${perTrack.id}/takes`, { trackId: s.trackId, number: n });
          const forty = ((await (await recorder(41)).json()) as { take: Take }).take;
          expect(forty.number).toBe(41);
          await send("PATCH", `/api/takes/${forty.id}`, { lifecycle: "recorded" });
          expect((await recorder(41)).status).toBe(409);

          // Not with another project's track, nor in another workspace's session.
          expect((await start({ trackId: "0199f000-0000-7000-8000-000000000001" })).status).toBe(
            404,
          );
          const [elsewhere] = await db
            .insert(schema.organisations)
            .values({ name: "Elsewhere", slug: "elsewhere-take-log" })
            .returning();
          const [theirProject] = await db
            .insert(schema.projects)
            .values({ organisationId: elsewhere?.id ?? "", name: "Theirs", profile: "music" })
            .returning();
          const [theirs] = await db
            .insert(schema.sessions)
            .values({
              organisationId: elsewhere?.id ?? "",
              projectId: theirProject?.id ?? "",
              name: "Theirs",
            })
            .returning();
          expect(
            (await send("POST", `/api/sessions/${theirs?.id}/takes`, { trackId: s.trackId }))
              .status,
          ).toBe(404);

          // The room's notes, the producer's quick reference and the to-do list (#51).
          const noted = await send("PATCH", `/api/sessions/${session.id}`, {
            notes: "Piano a touch bright after lunch",
            reference: "Trio from bar 65. Coda at 89.",
          });
          expect(((await noted.json()) as { session: object }).session).toMatchObject({
            notes: "Piano a touch bright after lunch",
            reference: "Trio from bar 65. Coda at 89.",
          });
          const todo = (body: unknown, cookie = s.engineer) =>
            send("POST", `/api/sessions/${session.id}/todos`, body, cookie);
          expect((await todo({ text: "Pick-ups, bars 17 to 19" }, s.composer)).status).toBe(403);
          expect((await todo({ text: " " })).status).toBe(400);
          const item = (
            (await (await todo({ text: "Pick-ups, bars 17 to 19" })).json()) as {
              todo: { id: string };
            }
          ).todo;
          await todo({ text: "Tell the tuner about the A" });
          expect(
            (await send("PATCH", `/api/sessions/${session.id}/todos/${item.id}`, { done: true }))
              .status,
          ).toBe(200);
          const listed = (
            (await (await getAs(`/api/sessions/${session.id}`, s.composer)).json()) as {
              session: { todos: { text: string; done: boolean }[] };
            }
          ).session.todos;
          expect(listed).toEqual([
            expect.objectContaining({ text: "Pick-ups, bars 17 to 19", done: true }),
            expect.objectContaining({ text: "Tell the tuner about the A", done: false }),
          ]);
          // Not through another workspace's session, nor on another session's item.
          expect(
            (await send("POST", `/api/sessions/${theirs?.id}/todos`, { text: "Theirs" })).status,
          ).toBe(404);
          expect(
            (await send("PATCH", `/api/sessions/${perTrack.id}/todos/${item.id}`, { done: false }))
              .status,
          ).toBe(404);
          // Named by a log written offline (#51): sent twice, made once; never another session's.
          const named = { id: "01920000-0000-7000-8000-0000000000aa", text: "Check the page turn" };
          expect((await todo(named)).status).toBe(201);
          const again = await todo(named);
          expect(again.status).toBe(200);
          expect(((await again.json()) as { todo: { id: string } }).todo.id).toBe(named.id);
          expect((await send("POST", `/api/sessions/${perTrack.id}/todos`, named)).status).toBe(
            409,
          );
          const kept = (
            (await (await getAs(`/api/sessions/${session.id}`, s.composer)).json()) as {
              session: { todos: { text: string }[] };
            }
          ).session.todos.filter((t) => t.text === "Check the page turn");
          expect(kept).toHaveLength(1);
          const gone = await app.request(`/api/sessions/${session.id}/todos/${item.id}`, {
            method: "DELETE",
            headers: { cookie: s.engineer, origin: "http://localhost:3000" },
          });
          expect(gone.status).toBe(204);
        });

        it("logs takes written offline once, at their own times, keeping each field's history (#51)", async () => {
          const s = await studio();
          const send = (method: string, url: string, body: unknown, cookie = s.engineer) =>
            app.request(url, { ...json(body, cookie), method });
          type Take = { id: string; number: number; wallIn: string | null; notes: string | null };
          const session = (
            (await (
              await send("POST", `/api/projects/${s.projectId}/sessions`, { name: "Day 4" })
            ).json()) as { session: { id: string } }
          ).session;
          const start = (body: Record<string, unknown>) =>
            send("POST", `/api/sessions/${session.id}/takes`, body);

          // Started offline ten minutes ago with the log's own id, then sent twice: one take,
          // rolling since the log said.
          const id = uuidv7();
          const at = new Date(Date.now() - 10 * 60_000).toISOString();
          const first = await start({ trackId: s.trackId, id, at });
          expect(first.status).toBe(201);
          const take = ((await first.json()) as { take: Take }).take;
          expect(take).toMatchObject({ id, number: 1 });
          expect(Date.parse(take.wallIn ?? "")).toBe(Date.parse(at));
          const again = await start({ trackId: s.trackId, id, at });
          expect(((await again.json()) as { take: Take }).take.id).toBe(id);
          const [{ n } = { n: 0 }] = await db
            .select({ n: count() })
            .from(schema.takes)
            .where(eq(schema.takes.sessionId, session.id));
          expect(n).toBe(1);
          // A start from the future is taken as now.
          await send("PATCH", `/api/takes/${id}`, { lifecycle: "recorded" });
          const later = await start({
            trackId: s.trackId,
            at: new Date(Date.now() + 3_600_000).toISOString(),
          });
          const next = ((await later.json()) as { take: Take }).take;
          expect(Date.parse(next.wallIn ?? "")).toBeLessThanOrEqual(Date.now());
          await send("PATCH", `/api/takes/${next.id}`, { lifecycle: "recorded" });
          // Only a UUIDv7 is taken as an id.
          expect(
            (await start({ trackId: s.trackId, id: "8f14e45f-ceea-467a-9575-0123456789ab" }))
              .status,
          ).toBe(400);

          // Two people change the note: the producer online, the engineer offline from what they
          // last saw. The later write stands; the history keeps both and says which overwrote.
          await send("PATCH", `/api/takes/${id}`, { notes: "Lovely rubato" });
          await send("PATCH", `/api/takes/${id}`, { notes: "Keeper into the trio" }, s.owner);
          const written = new Date(Date.now() - 60_000).toISOString();
          const offline = await send("PATCH", `/api/takes/${id}`, {
            notes: "Lovely rubato, a touch fast",
            rating: 4,
            base: { notes: "Lovely rubato", rating: 0 },
            at: written,
          });
          expect(((await offline.json()) as { take: Take }).take.notes).toBe(
            "Lovely rubato, a touch fast",
          );
          const history = (await (await getAs(`/api/takes/${id}/history`, s.composer)).json()) as {
            history: {
              field: string;
              before: unknown;
              after: unknown;
              overwrote: boolean;
              writtenAt: string;
              by: { name: string } | null;
            }[];
          };
          const notes = history.history.filter((h) => h.field === "notes");
          expect(notes.map((h) => [h.before, h.after, h.overwrote])).toEqual([
            [null, "Lovely rubato", false],
            ["Lovely rubato", "Keeper into the trio", false],
            ["Keeper into the trio", "Lovely rubato, a touch fast", true],
          ]);
          expect(notes.at(-1)?.writtenAt).toBe(written);
          expect(notes.at(-1)?.by?.name).toBeTruthy();
          // Its rating had not changed meanwhile, so setting it overwrote nobody.
          expect(history.history.find((h) => h.field === "rating")).toMatchObject({
            before: 0,
            after: 4,
            overwrote: false,
          });
          // The stop is in it too, with its time.
          expect(history.history.some((h) => h.field === "wallOut")).toBe(true);

          // Another workspace's take: no history for anyone here, and its id cannot be taken.
          const [elsewhere] = await db
            .insert(schema.organisations)
            .values({ name: "Elsewhere", slug: "elsewhere-offline-takes" })
            .returning();
          const [theirProject] = await db
            .insert(schema.projects)
            .values({ organisationId: elsewhere?.id ?? "", name: "Theirs", profile: "music" })
            .returning();
          const [theirTrack] = await db
            .insert(schema.tracks)
            .values({
              organisationId: elsewhere?.id ?? "",
              projectId: theirProject?.id ?? "",
              name: "Theirs",
            })
            .returning();
          const [theirTake] = await db
            .insert(schema.takes)
            .values({
              organisationId: elsewhere?.id ?? "",
              trackId: theirTrack?.id ?? "",
              number: 1,
            })
            .returning();
          expect((await getAs(`/api/takes/${theirTake?.id}/history`, s.owner)).status).toBe(404);
          expect((await start({ trackId: s.trackId, id: theirTake?.id })).status).toBe(409);
          // Nor may someone without the project read this one's, nor a member whose role keeps
          // the takes from them.
          const newcomer = await joinAs(s.owner, "newcomer@example.test");
          expect((await getAs(`/api/takes/${id}/history`, newcomer)).status).toBe(404);
          const levels = {
            files: "view",
            comments: "none",
            reviews: "none",
            downloads: "none",
            takes: "none",
            production: "none",
            workflow: "none",
            people: "none",
            project: "none",
          };
          expect(
            (
              await send(
                "POST",
                `/api/projects/${s.projectId}/roles`,
                { name: "Listener", levels },
                s.owner,
              )
            ).status,
          ).toBe(201);
          const listener = await joinAs(s.owner, "listener@example.test");
          await grantRole(s.owner, s.projectId, listener, "Listener");
          expect((await getAs(`/api/takes/${id}/history`, listener)).status).toBe(403);
        });

        it("keeps a project's patch list: stage boxes and their channels (#54)", async () => {
          const s = await studio();
          const send = (method: string, url: string, body: unknown, cookie = s.owner) =>
            app.request(url, { ...json(body, cookie), method });
          type Box = {
            id: string;
            name: string;
            inputs: { id: string; channel: number; source: string; cable: string }[];
            outputs: { id: string; channel: number; source: string }[];
          };
          const list = async (cookie = s.owner) =>
            (
              (await (await getAs(`/api/projects/${s.projectId}/patch`, cookie)).json()) as {
                boxes: Box[];
              }
            ).boxes;
          expect(await list()).toEqual([]);

          const made = await send("POST", `/api/projects/${s.projectId}/stage-boxes`, {
            name: "Stage box A",
          });
          expect(made.status).toBe(201);
          const box = ((await made.json()) as { box: Box }).box;
          expect(
            (
              await send("POST", `/api/projects/${s.projectId}/stage-boxes`, {
                name: "Stage box A",
              })
            ).status,
          ).toBe(409);
          await send("POST", `/api/projects/${s.projectId}/stage-boxes`, { name: "Stage box B" });

          const row = (body: Record<string, unknown>, cookie = s.owner) =>
            send("POST", `/api/stage-boxes/${box.id}/rows`, body, cookie);
          // Numbered on from the highest when no channel is given; a channel used is refused.
          expect((await row({ direction: "input", source: "Main L", cable: "A1" })).status).toBe(
            201,
          );
          expect(
            (await row({ direction: "input", channel: 3, source: "Spot piano L" })).status,
          ).toBe(201);
          const fourth = (await (await row({ direction: "input", source: "Room L" })).json()) as {
            row: { id: string; channel: number };
          };
          expect(fourth.row.channel).toBe(4);
          const taken = await row({ direction: "input", channel: 3, source: "Again" });
          expect(taken.status).toBe(409);
          expect(await taken.text()).toContain("Input 3 of this box is already patched");
          expect((await row({ direction: "output", source: "Talkback" })).status).toBe(201);

          const [first] = await list();
          expect(first?.inputs.map((r) => [r.channel, r.source])).toEqual([
            [1, "Main L"],
            [3, "Spot piano L"],
            [4, "Room L"],
          ]);
          expect(first?.outputs.map((r) => [r.channel, r.source])).toEqual([[1, "Talkback"]]);

          // Changed, moved to a free channel, refused onto a used one, unpatched.
          expect(
            (await send("PATCH", `/api/patch-rows/${fourth.row.id}`, { channel: 2, cable: "A2" }))
              .status,
          ).toBe(200);
          expect(
            (await send("PATCH", `/api/patch-rows/${fourth.row.id}`, { channel: 1 })).status,
          ).toBe(409);
          expect((await send("PATCH", `/api/patch-rows/${fourth.row.id}`, {})).status).toBe(400);
          expect((await send("DELETE", `/api/patch-rows/${fourth.row.id}`, {})).status).toBe(204);
          expect((await list())[0]?.inputs.map((r) => r.channel)).toEqual([1, 3]);
          expect(
            (await send("PATCH", `/api/stage-boxes/${box.id}`, { name: "Stage box B" })).status,
          ).toBe(409);
          expect(
            (await send("PATCH", `/api/stage-boxes/${box.id}`, { name: "Piano box" })).status,
          ).toBe(200);

          // The engineer sees it but may not change it; a reviewer sees none of it.
          expect((await list(s.engineer)).map((b) => b.name)).toEqual(["Piano box", "Stage box B"]);
          expect((await row({ direction: "input", source: "Mine" }, s.engineer)).status).toBe(403);
          expect((await getAs(`/api/projects/${s.projectId}/patch`, s.composer)).status).toBe(403);

          // Another workspace's box, and its channels, are not this one's to touch.
          const [elsewhere] = await db
            .insert(schema.organisations)
            .values({ name: "Elsewhere", slug: "elsewhere-patch" })
            .returning();
          const [theirProject] = await db
            .insert(schema.projects)
            .values({ organisationId: elsewhere?.id ?? "", name: "Theirs", profile: "music" })
            .returning();
          const [theirBox] = await db
            .insert(schema.stageBoxes)
            .values({
              organisationId: elsewhere?.id ?? "",
              projectId: theirProject?.id ?? "",
              name: "Theirs",
            })
            .returning();
          const [theirRow] = await db
            .insert(schema.patchRows)
            .values({
              organisationId: elsewhere?.id ?? "",
              stageBoxId: theirBox?.id ?? "",
              direction: "input",
              channel: 1,
            })
            .returning();
          expect(
            (await send("PATCH", `/api/stage-boxes/${theirBox?.id}`, { name: "Mine" })).status,
          ).toBe(404);
          expect(
            (await send("POST", `/api/stage-boxes/${theirBox?.id}/rows`, { direction: "input" }))
              .status,
          ).toBe(404);
          expect((await send("DELETE", `/api/patch-rows/${theirRow?.id}`, {})).status).toBe(404);
          expect((await getAs(`/api/projects/${theirProject?.id}/patch`, s.owner)).status).toBe(
            404,
          );

          // Two channels added at once to a box are numbered one after the other, both kept.
          const pair = (
            (await (
              await send("POST", `/api/projects/${s.projectId}/stage-boxes`, { name: "Box C" })
            ).json()) as { box: Box }
          ).box;
          const together = await Promise.all(
            ["Harp", "Celesta"].map((source) =>
              send("POST", `/api/stage-boxes/${pair.id}/rows`, { direction: "input", source }),
            ),
          );
          expect(together.map((r) => r.status)).toEqual([201, 201]);
          const numbered = await Promise.all(
            together.map(
              async (r) => ((await r.json()) as { row: { channel: number } }).row.channel,
            ),
          );
          expect(numbered.sort()).toEqual([1, 2]);

          // As a PDF and a workbook (#54), for those who see it; the files name the project.
          const pdf = await getAs(`/api/projects/${s.projectId}/patch/pdf`, s.engineer);
          expect(pdf.status).toBe(200);
          expect(pdf.headers.get("content-type")).toBe("application/pdf");
          expect(pdf.headers.get("cache-control")).toContain("no-store");
          expect(pdf.headers.get("content-disposition")).toContain("patch list.pdf");
          const pdfText = Buffer.from(await pdf.arrayBuffer()).toString("latin1");
          expect(pdfText.startsWith("%PDF-")).toBe(true);
          expect(pdfText).toContain("(Piano box) Tj");
          const book = await getAs(`/api/projects/${s.projectId}/patch/xlsx`, s.engineer);
          expect(book.status).toBe(200);
          expect(book.headers.get("content-disposition")).toContain("patch list.xlsx");
          expect(
            Buffer.from(await book.arrayBuffer())
              .subarray(0, 2)
              .toString(),
          ).toBe("PK");
          expect((await getAs(`/api/projects/${s.projectId}/patch/pdf`, s.composer)).status).toBe(
            403,
          );
          expect((await getAs(`/api/projects/${s.projectId}/patch/csv`, s.owner)).status).toBe(404);

          // Removing a box takes its channels with it.
          expect((await send("DELETE", `/api/stage-boxes/${box.id}`, {})).status).toBe(204);
          expect((await list()).map((b) => b.name)).toEqual(["Stage box B", "Box C"]);
        });

        it("keeps a project's repertoire and venues (#48)", async () => {
          const s = await studio();
          const send = (method: string, url: string, body: unknown, cookie = s.owner) =>
            app.request(url, { ...json(body, cookie), method });
          type Listed = {
            works: {
              id: string;
              title: string;
              tracks: { trackId: string; number: string; name: string }[];
            }[];
            venues: { id: string; name: string; address: string }[];
            tracks: { id: string; name: string }[];
          };
          const list = async (cookie = s.owner) =>
            (await (
              await getAs(`/api/projects/${s.projectId}/repertoire`, cookie)
            ).json()) as Listed;
          const first = await list();
          expect(first.works).toEqual([]);
          expect(first.tracks.map((t) => t.id)).toContain(s.trackId);
          const [project] = await db
            .select()
            .from(schema.projects)
            .where(eq(schema.projects.id, s.projectId));
          const [second] = await db
            .insert(schema.tracks)
            .values({
              organisationId: project?.organisationId ?? "",
              projectId: s.projectId,
              name: "The Entertainer",
            })
            .returning();

          // A work with its tracks numbered as the score prints them, in order.
          const made = await send("POST", `/api/projects/${s.projectId}/works`, {
            title: "Rags",
            composer: "Scott Joplin",
            abbreviation: "RAGS",
            tracks: [
              { trackId: second?.id, number: "II" },
              { trackId: s.trackId, number: "I" },
            ],
          });
          expect(made.status).toBe(201);
          const rags = ((await made.json()) as { work: Listed["works"][number] }).work;
          expect(rags.tracks.map((t) => [t.number, t.name])).toEqual([
            ["II", "The Entertainer"],
            ["I", expect.any(String)],
          ]);
          // A track is in one work.
          const again = await send("POST", `/api/projects/${s.projectId}/works`, {
            title: "Encores",
            tracks: [{ trackId: s.trackId }],
          });
          expect(again.status).toBe(409);
          expect(await again.text()).toContain("already in another work");
          const reordered = await send("PUT", `/api/works/${rags.id}`, {
            title: "Rags",
            tracks: [{ trackId: s.trackId, number: "1" }],
          });
          expect(reordered.status).toBe(200);
          expect(
            ((await reordered.json()) as { work: Listed["works"][number] }).work.tracks.map(
              (t) => t.number,
            ),
          ).toEqual(["1"]);

          // A number typed in place changes alone, so two typed at once both stand.
          const both = await send("PUT", `/api/works/${rags.id}`, {
            title: "Rags",
            tracks: [
              { trackId: s.trackId, number: "1" },
              { trackId: second?.id, number: "2" },
            ],
          });
          expect(both.status).toBe(200);
          const numbered = await Promise.all([
            send("PATCH", `/api/works/${rags.id}/tracks/${s.trackId}`, { number: "I" }),
            send("PATCH", `/api/works/${rags.id}/tracks/${second?.id}`, { number: "II" }),
          ]);
          expect(numbered.map((r) => r.status)).toEqual([200, 200]);
          expect((await list()).works[0]?.tracks.map((t) => t.number)).toEqual(["I", "II"]);
          expect(
            (await send("PATCH", `/api/works/${rags.id}/tracks/${uuidv7()}`, { number: "III" }))
              .status,
          ).toBe(404);
          expect(
            (
              await send(
                "PATCH",
                `/api/works/${rags.id}/tracks/${s.trackId}`,
                { number: "1" },
                s.engineer,
              )
            ).status,
          ).toBe(403);

          // The work's score reaches its tracks, and a track's score opens at its own pages.
          const org = project?.organisationId ?? "";
          const pdfBlob = await storage.put(org, Buffer.from("%PDF-1.4"));
          const [scoreFile] = await db
            .insert(schema.files)
            .values({
              organisationId: org,
              projectId: s.projectId,
              name: "Rags - Score.pdf",
              kind: "document",
              blobId: pdfBlob.id,
              contentType: "application/pdf",
              byteSize: pdfBlob.byteSize,
            })
            .returning();
          const scored = await send("PUT", `/api/works/${rags.id}`, {
            title: "Rags",
            scoreFileId: scoreFile?.id,
            pageOffset: 2,
            tracks: [
              { trackId: s.trackId, number: "1", pageFrom: 1, pageTo: 7 },
              { trackId: second?.id, number: "2", pageFrom: 8 },
            ],
          });
          expect(scored.status).toBe(200);
          const [followed] = await db
            .select({ scoreFileId: schema.tracks.scoreFileId })
            .from(schema.tracks)
            .where(eq(schema.tracks.id, second?.id ?? ""));
          expect(followed?.scoreFileId).toBe(scoreFile?.id);
          const marking = (await (
            await getAs(`/api/tracks/${second?.id}/score-marks`, s.engineer)
          ).json()) as { pages: { from: number; to: number } | null };
          expect(marking.pages).toEqual({ from: 10, to: 10 });
          // A track given another score since has none of the work's pages.
          const [other] = await db
            .insert(schema.files)
            .values({
              organisationId: org,
              projectId: s.projectId,
              name: "Entertainer - Part.pdf",
              kind: "document",
              blobId: pdfBlob.id,
              contentType: "application/pdf",
              byteSize: pdfBlob.byteSize,
            })
            .returning();
          await db
            .update(schema.tracks)
            .set({ scoreFileId: other?.id })
            .where(eq(schema.tracks.id, second?.id ?? ""));
          expect(
            (
              (await (await getAs(`/api/tracks/${second?.id}/score-marks`, s.engineer)).json()) as {
                pages: unknown;
              }
            ).pages,
          ).toBeNull();
          const backwards = await send("PUT", `/api/works/${rags.id}`, {
            title: "Rags",
            tracks: [{ trackId: s.trackId, pageFrom: 7, pageTo: 1 }],
          });
          expect(backwards.status).toBe(400);
          const [wav] = await db
            .insert(schema.files)
            .values({
              organisationId: org,
              projectId: s.projectId,
              name: "Rags.wav",
              kind: "audio",
              blobId: pdfBlob.id,
              contentType: "audio/wav",
              byteSize: pdfBlob.byteSize,
            })
            .returning();
          expect(
            (await send("PUT", `/api/works/${rags.id}`, { title: "Rags", scoreFileId: wav?.id }))
              .status,
          ).toBe(422);
          await send("PUT", `/api/works/${rags.id}`, {
            title: "Rags",
            tracks: [{ trackId: s.trackId, number: "1" }],
          });

          // Venues, by name, once each.
          const hall = await send("POST", `/api/projects/${s.projectId}/venues`, {
            name: "Endless Hall",
            address: "Mill Lane\nBristol",
          });
          expect(hall.status).toBe(201);
          const venue = ((await hall.json()) as { venue: { id: string } }).venue;
          expect(
            (await send("POST", `/api/projects/${s.projectId}/venues`, { name: "Endless Hall" }))
              .status,
          ).toBe(409);
          expect(
            (await send("PUT", `/api/venues/${venue.id}`, { name: "Endless Hall Studio 2" }))
              .status,
          ).toBe(200);

          // The engineer sees it all but changes none of it; a reviewer sees none of it.
          const seen = await list(s.engineer);
          expect(seen.works.map((w) => w.title)).toEqual(["Rags"]);
          expect(seen.venues.map((v) => v.name)).toEqual(["Endless Hall Studio 2"]);
          expect(
            (
              await send(
                "POST",
                `/api/projects/${s.projectId}/works`,
                { title: "Mine" },
                s.engineer,
              )
            ).status,
          ).toBe(403);
          expect((await getAs(`/api/projects/${s.projectId}/repertoire`, s.composer)).status).toBe(
            403,
          );

          // Another workspace's tracks, works and venues are not this one's.
          const [elsewhere] = await db
            .insert(schema.organisations)
            .values({ name: "Elsewhere", slug: "elsewhere-repertoire" })
            .returning();
          const [theirProject] = await db
            .insert(schema.projects)
            .values({ organisationId: elsewhere?.id ?? "", name: "Theirs", profile: "music" })
            .returning();
          const [theirTrack] = await db
            .insert(schema.tracks)
            .values({
              organisationId: elsewhere?.id ?? "",
              projectId: theirProject?.id ?? "",
              name: "Theirs",
            })
            .returning();
          const [theirVenue] = await db
            .insert(schema.venues)
            .values({
              organisationId: elsewhere?.id ?? "",
              projectId: theirProject?.id ?? "",
              name: "Theirs",
            })
            .returning();
          const stolen = await send("POST", `/api/projects/${s.projectId}/works`, {
            title: "Stolen",
            tracks: [{ trackId: theirTrack?.id }],
          });
          expect(stolen.status).toBe(400);
          expect((await send("DELETE", `/api/venues/${theirVenue?.id}`, {})).status).toBe(404);

          // Removing a work leaves its tracks; removing a track takes it out of its work.
          expect((await send("DELETE", `/api/works/${rags.id}`, {})).status).toBe(204);
          expect((await list()).tracks.map((t) => t.id)).toContain(s.trackId);
          expect((await send("DELETE", `/api/venues/${venue.id}`, {})).status).toBe(204);
          expect((await list()).venues).toEqual([]);
        });

        it("keeps a project's schedule: days, rows in order, slots and ticks (#50)", async () => {
          const s = await studio();
          const send = (method: string, url: string, body: unknown, cookie = s.owner) =>
            app.request(url, { ...json(body, cookie), method });
          type Row = {
            id: string;
            kind: string;
            label: string;
            minutes: number;
            done: boolean;
            workIds: string[];
            trackIds: string[];
          };
          type Listed = {
            days: { id: string; label: string; venueId: string | null; rows: Row[] }[];
            works: { id: string; trackIds: string[] }[];
            tracks: { id: string }[];
            venues: { id: string; name: string }[];
          };
          const list = async (cookie = s.owner) =>
            (await (await getAs(`/api/projects/${s.projectId}/schedule`, cookie)).json()) as Listed;
          expect((await list()).days).toEqual([]);

          const hall = (await (
            await send("POST", `/api/projects/${s.projectId}/venues`, { name: "Endless Hall" })
          ).json()) as { venue: { id: string } };
          const rags = (await (
            await send("POST", `/api/projects/${s.projectId}/works`, {
              title: "Rags",
              tracks: [{ trackId: s.trackId }],
            })
          ).json()) as { work: { id: string } };

          // A day at a venue, its rows added in order and one inserted after another.
          const made = await send("POST", `/api/projects/${s.projectId}/schedule-days`, {
            label: "Day 1",
            date: "2026-09-12",
            venueId: hall.venue.id,
            start: "09:00",
          });
          expect(made.status).toBe(201);
          const day = ((await made.json()) as { day: { id: string } }).day;
          const addRow = (body: unknown, after?: string, cookie = s.owner) =>
            send(
              "POST",
              `/api/schedule-days/${day.id}/rows${after ? `?after=${after}` : ""}`,
              body,
              cookie,
            );
          const slot = (
            (await (
              await addRow({ kind: "slot", minutes: 90, workIds: [rags.work.id] })
            ).json()) as { row: Row }
          ).row;
          expect(slot.workIds).toEqual([rags.work.id]);
          const lunch = await addRow({ kind: "break", minutes: 60, label: "Lunch" });
          expect(lunch.status).toBe(201);
          const coffee = await addRow({ kind: "break", minutes: 20, label: "Coffee" }, slot.id);
          expect(coffee.status).toBe(201);
          const labels = async () => (await list()).days[0]?.rows.map((r) => r.label);
          expect(await labels()).toEqual(["", "Coffee", "Lunch"]);

          // Only a slot holds repertoire, and only this project's.
          expect((await addRow({ kind: "break", minutes: 10, trackIds: [s.trackId] })).status).toBe(
            400,
          );
          expect((await addRow({ kind: "slot", minutes: 10, trackIds: [uuidv7()] })).status).toBe(
            400,
          );
          expect((await addRow({ kind: "slot", minutes: 10 }, uuidv7())).status).toBe(400);

          // Moved, changed and ticked off.
          const lunchRow = ((await lunch.json()) as { row: Row }).row;
          expect(
            (await send("POST", `/api/schedule-rows/${lunchRow.id}/move`, { direction: "up" }))
              .status,
          ).toBe(204);
          expect(await labels()).toEqual(["", "Lunch", "Coffee"]);
          const changed = await send("PUT", `/api/schedule-rows/${slot.id}`, {
            kind: "slot",
            minutes: 120,
            trackIds: [s.trackId],
          });
          expect(changed.status).toBe(200);
          expect(((await changed.json()) as { row: Row }).row).toMatchObject({
            minutes: 120,
            workIds: [],
            trackIds: [s.trackId],
          });
          expect(
            (await send("PATCH", `/api/schedule-rows/${slot.id}/done`, { done: true })).status,
          ).toBe(200);
          expect((await list()).days[0]?.rows[0]?.done).toBe(true);

          // As a PDF to send out and a workbook, for those who see it; the files name the project.
          const pdf = await getAs(`/api/projects/${s.projectId}/schedule/pdf`, s.engineer);
          expect(pdf.status).toBe(200);
          expect(pdf.headers.get("content-type")).toBe("application/pdf");
          expect(pdf.headers.get("cache-control")).toContain("no-store");
          expect(pdf.headers.get("content-disposition")).toContain("schedule.pdf");
          const pdfText = Buffer.from(await pdf.arrayBuffer()).toString("latin1");
          expect(pdfText.startsWith("%PDF-")).toBe(true);
          expect(pdfText).toContain("(Endless Hall) Tj");
          const book = await getAs(`/api/projects/${s.projectId}/schedule/xlsx`, s.engineer);
          expect(book.status).toBe(200);
          expect(book.headers.get("content-disposition")).toContain("schedule.xlsx");
          expect(
            (await getAs(`/api/projects/${s.projectId}/schedule/pdf`, s.composer)).status,
          ).toBe(403);

          // The engineer sees it but changes none of it; a reviewer sees none of it.
          expect((await list(s.engineer)).days.map((d) => d.label)).toEqual(["Day 1"]);
          expect(
            (await send("PATCH", `/api/schedule-rows/${slot.id}/done`, { done: false }, s.engineer))
              .status,
          ).toBe(403);
          expect((await getAs(`/api/projects/${s.projectId}/schedule`, s.composer)).status).toBe(
            403,
          );

          // Another workspace's venues are not this one's, nor its days and rows.
          const [elsewhere] = await db
            .insert(schema.organisations)
            .values({ name: "Elsewhere", slug: "elsewhere-schedule" })
            .returning();
          const [theirProject] = await db
            .insert(schema.projects)
            .values({ organisationId: elsewhere?.id ?? "", name: "Theirs", profile: "music" })
            .returning();
          const [theirVenue] = await db
            .insert(schema.venues)
            .values({
              organisationId: elsewhere?.id ?? "",
              projectId: theirProject?.id ?? "",
              name: "Theirs",
            })
            .returning();
          const [theirDay] = await db
            .insert(schema.scheduleDays)
            .values({
              organisationId: elsewhere?.id ?? "",
              projectId: theirProject?.id ?? "",
              label: "Theirs",
            })
            .returning();
          expect(
            (
              await send("PUT", `/api/schedule-days/${day.id}`, {
                label: "Day 1",
                venueId: theirVenue?.id,
              })
            ).status,
          ).toBe(400);
          expect((await send("DELETE", `/api/schedule-days/${theirDay?.id}`, {})).status).toBe(404);

          // Removing a venue leaves the day without one.
          expect((await send("DELETE", `/api/venues/${hall.venue.id}`, {})).status).toBe(204);
          expect((await list()).days[0]?.venueId).toBeNull();
          expect((await send("DELETE", `/api/schedule-rows/${slot.id}`, {})).status).toBe(204);
          expect(await labels()).toEqual(["Lunch", "Coffee"]);
          // A row added as its day goes is refused, never half-written.
          const [added, gone] = await Promise.all([
            addRow({ kind: "break", minutes: 10 }),
            send("DELETE", `/api/schedule-days/${day.id}`, {}),
          ]);
          expect(gone.status).toBe(204);
          expect([201, 404]).toContain(added.status);
          expect((await list()).days).toEqual([]);
          expect((await addRow({ kind: "break", minutes: 10 })).status).toBe(404);
        });

        it("keeps a project's personnel, ensembles in sections, linked to members and guests (#49)", async () => {
          const s = await studio();
          const send = (method: string, url: string, body: unknown, cookie = s.owner) =>
            app.request(url, { ...json(body, cookie), method });
          type Entry = {
            id: string;
            name: string;
            kind: string;
            agreement: boolean;
            link: { kind: string; name: string } | null;
            sections: { name: string; count: number; members: { name: string }[] }[];
          };
          type Listed = {
            personnel: Entry[];
            people: { kind: string; id: string; name: string }[];
          };
          const list = async (cookie = s.owner) =>
            (await (
              await getAs(`/api/projects/${s.projectId}/personnel`, cookie)
            ).json()) as Listed;
          const add = (body: unknown, cookie = s.owner) =>
            send("POST", `/api/projects/${s.projectId}/personnel`, body, cookie);
          expect((await list()).personnel).toEqual([]);

          // The project's members may be linked; a guest only once the project knows them.
          const [project] = await db
            .select()
            .from(schema.projects)
            .where(eq(schema.projects.id, s.projectId));
          const org = project?.organisationId ?? "";
          const [guest] = await db
            .insert(schema.guests)
            .values({ organisationId: org, name: "Mira Solberg", email: "mira@example.test" })
            .returning();
          const conductor = { name: "Mira Solberg", kind: "artist", role: "Conductor" };
          const unknown = await add({ ...conductor, link: { kind: "guest", guestId: guest?.id } });
          expect(unknown.status).toBe(400);
          const [group] = await db
            .insert(schema.groups)
            .values({ organisationId: org, projectId: s.projectId, name: "Conductors" })
            .returning();
          await db.insert(schema.groupMembers).values({
            organisationId: org,
            groupId: group?.id ?? "",
            guestId: guest?.id,
            position: 0,
          });
          const { people } = await list();
          expect(people.filter((p) => p.kind === "guest").map((p) => p.name)).toEqual([
            "Mira Solberg",
          ]);
          const member = people.find((p) => p.kind === "member");
          expect(member).toBeDefined();
          expect(
            (await add({ ...conductor, link: { kind: "guest", guestId: guest?.id } })).status,
          ).toBe(201);
          expect(
            (
              await add({
                name: "Producer",
                kind: "staff",
                agreement: true,
                link: { kind: "member", userId: member?.id },
              })
            ).status,
          ).toBe(201);
          expect(
            (
              await add({
                name: "Stranger",
                kind: "staff",
                link: { kind: "member", userId: "nobody" },
              })
            ).status,
          ).toBe(400);

          // An ensemble in sections: a head-count, then players as they are named.
          const made = await add({
            name: "Endless Hall Strings",
            kind: "ensemble",
            sections: [
              { name: "Violin I", count: 4, divisi: "2 + 2", members: [{ name: "Tomas Varga" }] },
              { name: "Cello", count: 2 },
            ],
            seating: "Antiphonal violins",
          });
          expect(made.status).toBe(201);
          const strings = ((await made.json()) as { entry: Entry }).entry;
          expect(strings.sections.map((x) => [x.name, x.count, x.members.length])).toEqual([
            ["Violin I", 4, 1],
            ["Cello", 2, 0],
          ]);
          // Replaced whole: its sections and players with it.
          const changed = await send("PUT", `/api/personnel/${strings.id}`, {
            name: "Endless Hall Strings",
            kind: "ensemble",
            agreement: true,
            sections: [
              { name: "Viola", count: 2, members: [{ name: "Ines Arlow", headphones: true }] },
            ],
          });
          expect(changed.status).toBe(200);
          expect(
            ((await changed.json()) as { entry: Entry }).entry.sections.map((x) => x.name),
          ).toEqual(["Viola"]);
          const seen = await list(s.engineer);
          expect(seen.personnel.map((p) => [p.name, p.link?.kind ?? null])).toEqual([
            ["Mira Solberg", "guest"],
            ["Producer", "member"],
            ["Endless Hall Strings", null],
          ]);
          expect(await db.select().from(schema.sectionMembers)).toHaveLength(1);

          // The engineer sees it but may not change it; a reviewer sees none of it.
          expect((await add({ name: "Mine", kind: "other" }, s.engineer)).status).toBe(403);
          expect((await getAs(`/api/projects/${s.projectId}/personnel`, s.composer)).status).toBe(
            403,
          );

          // Another workspace's entry is not this one's to touch.
          const [elsewhere] = await db
            .insert(schema.organisations)
            .values({ name: "Elsewhere", slug: "elsewhere-personnel" })
            .returning();
          const [theirProject] = await db
            .insert(schema.projects)
            .values({ organisationId: elsewhere?.id ?? "", name: "Theirs", profile: "music" })
            .returning();
          const [theirs] = await db
            .insert(schema.personnel)
            .values({
              organisationId: elsewhere?.id ?? "",
              projectId: theirProject?.id ?? "",
              name: "Theirs",
              kind: "artist",
            })
            .returning();
          expect(
            (await send("PUT", `/api/personnel/${theirs?.id}`, { name: "Mine", kind: "artist" }))
              .status,
          ).toBe(404);
          expect((await send("DELETE", `/api/personnel/${theirs?.id}`, {})).status).toBe(404);

          // A guest the project no longer asks is shown unlinked, and the entry still saves.
          await db
            .delete(schema.groupMembers)
            .where(eq(schema.groupMembers.groupId, group?.id ?? ""));
          const left = (await list()).personnel.find((p) => p.name === "Mira Solberg");
          expect(left?.link).toBeNull();
          expect(
            (await send("PUT", `/api/personnel/${left?.id}`, { ...conductor, link: null })).status,
          ).toBe(200);

          // Removing an ensemble takes its sections and players with it.
          expect((await send("DELETE", `/api/personnel/${strings.id}`, {})).status).toBe(204);
          expect(await db.select().from(schema.sectionMembers)).toHaveLength(0);
          expect((await list()).personnel).toHaveLength(2);
        });

        it("keeps a project's stage plans, a step at a time, linked to the patch (#53)", async () => {
          const s = await studio();
          const send = (method: string, url: string, body: unknown, cookie = s.owner) =>
            app.request(url, { ...json(body, cookie), method });
          type Item = {
            id: string;
            kind: string;
            label: string;
            x: number;
            patchRowId: string | null;
          };
          type Plan = {
            id: string;
            name: string;
            width: number;
            grid: number;
            items: Item[];
            underlay: { fileId: string } | null;
          };
          type Listed = { plans: Plan[]; channels: { id: string; box: string; source: string }[] };
          const list = async (cookie = s.owner) =>
            (await (
              await getAs(`/api/projects/${s.projectId}/stage-plans`, cookie)
            ).json()) as Listed;
          expect((await list()).plans).toEqual([]);

          const made = await send("POST", `/api/projects/${s.projectId}/stage-plans`, {
            name: "Endless Hall",
            width: 12,
            depth: 8,
          });
          expect(made.status).toBe(201);
          const plan = ((await made.json()) as { plan: Plan }).plan;
          expect(plan).toMatchObject({ name: "Endless Hall", width: 12, grid: 0.5, items: [] });
          expect(
            (
              await send("POST", `/api/projects/${s.projectId}/stage-plans`, {
                name: "Endless Hall",
                width: 10,
                depth: 6,
              })
            ).status,
          ).toBe(409);

          const box = (
            (await (
              await send("POST", `/api/projects/${s.projectId}/stage-boxes`, {
                name: "Stage box A",
              })
            ).json()) as { box: { id: string } }
          ).box;
          const channel = (
            (await (
              await send("POST", `/api/stage-boxes/${box.id}/rows`, {
                direction: "input",
                source: "Main L",
              })
            ).json()) as { row: { id: string } }
          ).row;

          const edit = (body: unknown, cookie = s.owner, id = plan.id) =>
            send("POST", `/api/stage-plans/${id}/edits`, body, cookie);
          const [mic, riser, piano] = [uuidv7(), uuidv7(), uuidv7()];
          const step = {
            add: [
              { id: mic, kind: "mic", x: 5, y: 6, w: 0.3, h: 0.3, patchRowId: channel.id },
              { id: riser, kind: "riser", label: "Riser", x: 7, y: 2, w: 2, h: 2 },
              { id: piano, kind: "piano", x: 4, y: 2, w: 1.6, h: 2.7, rotation: -20 },
            ],
          };
          const added = await edit(step);
          expect(added.status).toBe(200);
          expect(((await added.json()) as { items: Item[] }).items.map((i) => i.id)).toEqual([
            mic,
            riser,
            piano,
          ]);
          // Sent again, it adds nothing more.
          expect((await edit(step)).status).toBe(200);

          // Moving two and removing one is one step, all of it or none.
          const moved = await edit({
            change: [
              { id: mic, x: 5.5 },
              { id: riser, x: 7.5, label: "Choir riser" },
            ],
            remove: [piano],
          });
          expect(
            ((await moved.json()) as { items: Item[] }).items.map((i) => [i.id, i.x, i.label]),
          ).toEqual([
            [mic, 5.5, ""],
            [riser, 7.5, "Choir riser"],
          ]);
          expect((await edit({})).status).toBe(400);
          // Only a cable goes without a size, and a step that breaks that leaves nothing changed.
          const shrunk = await edit({
            change: [
              { id: mic, x: 1 },
              { id: riser, w: 0 },
            ],
          });
          expect(shrunk.status).toBe(400);
          expect(await shrunk.text()).toContain("Only a cable run goes without a size");
          expect((await edit({ change: [{ id: riser, kind: "cable", w: -2, h: 0 }] })).status).toBe(
            200,
          );
          expect(
            (await edit({ change: [{ id: riser, kind: "riser", w: 2.4, h: 2.4 }] })).status,
          ).toBe(200);
          expect(
            (await edit({ add: [{ id: uuidv7(), kind: "rect", x: 0, y: 0, w: 0, h: 1 }] })).status,
          ).toBe(400);

          // The engineer sees the plan and its channels but may not change it; a reviewer sees none.
          const seen = await list(s.engineer);
          expect(seen.plans[0]?.items).toHaveLength(2);
          expect(seen.channels.map((c) => [c.box, c.source])).toEqual([["Stage box A", "Main L"]]);
          expect((await edit({ remove: [mic] }, s.engineer)).status).toBe(403);
          expect((await getAs(`/api/projects/${s.projectId}/stage-plans`, s.composer)).status).toBe(
            403,
          );

          // Printed for whoever sees it, to scale, without the label groups they hid.
          const printed = await getAs(`/api/stage-plans/${plan.id}/pdf/a3`, s.engineer);
          expect(printed.status).toBe(200);
          expect(printed.headers.get("content-type")).toBe("application/pdf");
          expect(printed.headers.get("cache-control")).toContain("no-store");
          expect(printed.headers.get("content-disposition")).toContain(
            "Endless Hall stage plan.pdf",
          );
          const page = Buffer.from(await printed.arrayBuffer()).toString("latin1");
          expect(page).toContain("1:50 on A3");
          expect(page).toContain("(Main L) Tj");
          await edit({ change: [{ id: mic, group: "Main pair" }] });
          const quiet = await getAs(`/api/stage-plans/${plan.id}/pdf/a4?hide=Main%20pair`, s.owner);
          expect(Buffer.from(await quiet.arrayBuffer()).toString("latin1")).not.toContain(
            "(Main L) Tj",
          );
          expect((await getAs(`/api/stage-plans/${plan.id}/pdf/a5`, s.owner)).status).toBe(404);
          expect((await getAs(`/api/stage-plans/${plan.id}/pdf/a3`, s.composer)).status).toBe(403);

          // Only this project's channels link; unpatching one leaves the mic, unlinked.
          const [elsewhere] = await db
            .insert(schema.organisations)
            .values({ name: "Elsewhere", slug: "elsewhere-stage" })
            .returning();
          const [theirProject] = await db
            .insert(schema.projects)
            .values({ organisationId: elsewhere?.id ?? "", name: "Theirs", profile: "music" })
            .returning();
          const [theirBox] = await db
            .insert(schema.stageBoxes)
            .values({
              organisationId: elsewhere?.id ?? "",
              projectId: theirProject?.id ?? "",
              name: "Theirs",
            })
            .returning();
          const [theirRow] = await db
            .insert(schema.patchRows)
            .values({
              organisationId: elsewhere?.id ?? "",
              stageBoxId: theirBox?.id ?? "",
              direction: "input",
              channel: 1,
            })
            .returning();
          const [theirPlan] = await db
            .insert(schema.stagePlans)
            .values({
              organisationId: elsewhere?.id ?? "",
              projectId: theirProject?.id ?? "",
              name: "Theirs",
              width: 10,
              depth: 6,
            })
            .returning();
          const linked = await edit({ change: [{ id: mic, patchRowId: theirRow?.id }] });
          expect(linked.status).toBe(400);
          expect(await linked.text()).toContain("not in this project's patch list");
          expect((await edit({ remove: [mic] }, s.owner, theirPlan?.id)).status).toBe(404);
          expect((await getAs(`/api/stage-plans/${theirPlan?.id}/pdf/a3`, s.owner)).status).toBe(
            404,
          );
          expect(
            (await send("PATCH", `/api/stage-plans/${theirPlan?.id}`, { name: "Mine" })).status,
          ).toBe(404);
          // Another plan's item is not this plan's to change.
          const other = (
            (await (
              await send("POST", `/api/projects/${s.projectId}/stage-plans`, {
                name: "Studio 2",
                width: 8,
                depth: 6,
              })
            ).json()) as { plan: Plan }
          ).plan;
          await edit({ change: [{ id: riser, x: 1 }], remove: [mic] }, s.owner, other.id);
          expect((await list()).plans[0]?.items.map((i) => [i.id, i.x])).toEqual([
            [mic, 5.5],
            [riser, 7.5],
          ]);

          // An ensemble block stands for an ensemble on this project's personnel, and is named by it.
          const strings = (
            (await (
              await send("POST", `/api/projects/${s.projectId}/personnel`, {
                name: "Endless Hall Strings",
                kind: "ensemble",
                sections: [
                  { name: "Violin I", count: 4 },
                  { name: "Cello", count: 2 },
                ],
              })
            ).json()) as { entry: { id: string } }
          ).entry;
          const block = uuidv7();
          expect(
            (
              await edit({
                add: [
                  {
                    id: block,
                    kind: "ensemble",
                    x: 1,
                    y: 1,
                    w: 3,
                    h: 2.4,
                    personnelId: strings.id,
                  },
                ],
              })
            ).status,
          ).toBe(200);
          const peopled = (await (
            await getAs(`/api/projects/${s.projectId}/stage-plans`, s.engineer)
          ).json()) as { people: { id: string; players: number }[] };
          expect(peopled.people).toEqual([
            { id: strings.id, name: "Endless Hall Strings", kind: "ensemble", players: 6 },
          ]);
          const [theirEntry] = await db
            .insert(schema.personnel)
            .values({
              organisationId: elsewhere?.id ?? "",
              projectId: theirProject?.id ?? "",
              name: "Theirs",
              kind: "ensemble",
            })
            .returning();
          const stranger = await edit({ change: [{ id: block, personnelId: theirEntry?.id }] });
          expect(stranger.status).toBe(400);
          expect(await stranger.text()).toContain("not on this project's personnel");
          // A block stands for an ensemble, a performer for anyone else, a microphone for no one.
          const misfit = await edit({ change: [{ id: block, kind: "performer" }] });
          expect(misfit.status).toBe(400);
          expect(await misfit.text()).toContain("An ensemble stands in an ensemble block");
          expect((await edit({ change: [{ id: mic, personnelId: strings.id }] })).status).toBe(400);
          // An ensemble that becomes an artist leaves its block, which stays.
          expect(
            (
              await send("PUT", `/api/personnel/${strings.id}`, {
                name: "Endless Hall Strings",
                kind: "artist",
              })
            ).status,
          ).toBe(200);
          expect((await list()).plans[0]?.items.find((i) => i.id === block)).toMatchObject({
            personnelId: null,
          });
          await edit({ change: [{ id: block, personnelId: null }] });
          // Taken off the personnel, the block stays, unlinked.
          expect((await send("DELETE", `/api/personnel/${strings.id}`, {})).status).toBe(204);
          expect((await list()).plans[0]?.items.find((i) => i.id === block)).toMatchObject({
            personnelId: null,
          });
          await edit({ remove: [block] });

          expect((await send("DELETE", `/api/patch-rows/${channel.id}`, {})).status).toBe(204);
          expect((await list()).plans[0]?.items[0]).toMatchObject({ id: mic, patchRowId: null });

          // A floor plan under the stage: a page of this project's own documents or pictures.
          const [project] = await db
            .select()
            .from(schema.projects)
            .where(eq(schema.projects.id, s.projectId));
          const stored = async (kind: "document" | "audio", projectId: string, org: string) => {
            const blob = await storage.put(org, Buffer.from(kind));
            const [row] = await db
              .insert(schema.files)
              .values({
                organisationId: org,
                projectId,
                name: `${kind}.pdf`,
                kind,
                blobId: blob.id,
                contentType: kind === "document" ? "application/pdf" : "audio/wav",
                byteSize: blob.byteSize,
              })
              .returning();
            return row?.id ?? "";
          };
          const floor = await stored("document", s.projectId, project?.organisationId ?? "");
          // Page 1 is drawn; page 2 is not, yet.
          const drawn = await storage.put(project?.organisationId ?? "", Buffer.from("page"));
          await db.insert(schema.filePages).values({
            organisationId: project?.organisationId ?? "",
            fileId: floor,
            page: 1,
            width: 1600,
            height: 1131,
            blobId: drawn.id,
            thumbBlobId: drawn.id,
          });
          const sound = await stored("audio", s.projectId, project?.organisationId ?? "");
          const theirs = await stored("document", theirProject?.id ?? "", elsewhere?.id ?? "");
          const underlay = { fileId: floor, x: -1, y: -0.5, width: 14, opacity: 0.4 };
          const laid = await send("PATCH", `/api/stage-plans/${plan.id}`, { underlay });
          expect(laid.status).toBe(200);
          expect(((await laid.json()) as { plan: { underlay: unknown } }).plan.underlay).toEqual({
            ...underlay,
            page: 1,
          });
          const undrawn = await send("PATCH", `/api/stage-plans/${plan.id}`, {
            underlay: { ...underlay, page: 2 },
          });
          expect(undrawn.status).toBe(400);
          expect(await undrawn.text()).toContain("Page 2 of that file is not drawn yet");
          for (const fileId of [sound, theirs])
            expect(
              (
                await send("PATCH", `/api/stage-plans/${plan.id}`, {
                  underlay: { ...underlay, fileId },
                })
              ).status,
            ).toBe(400);
          expect(
            (
              await send("PATCH", `/api/stage-plans/${plan.id}`, {
                underlay: { ...underlay, opacity: 2 },
              })
            ).status,
          ).toBe(400);
          expect((await list(s.engineer)).plans[0]).toMatchObject({ underlay: { fileId: floor } });
          expect(
            (await send("PATCH", `/api/stage-plans/${plan.id}`, { underlay: null })).status,
          ).toBe(200);
          expect((await list()).plans[0]?.underlay).toBeNull();
          expect(
            (await send("PATCH", `/api/stage-plans/${plan.id}`, { name: "Studio 2" })).status,
          ).toBe(409);
          expect((await send("PATCH", `/api/stage-plans/${plan.id}`, { grid: 0.25 })).status).toBe(
            200,
          );
          expect((await send("DELETE", `/api/stage-plans/${plan.id}`, {})).status).toBe(204);
          expect((await list()).plans.map((p) => p.name)).toEqual(["Studio 2"]);
        });

        it("keeps the producer's score marks on the track, and checks the edit plot (#52)", async () => {
          const s = await studio();
          const send = (method: string, url: string, body: unknown, cookie = s.owner) =>
            app.request(url, { ...json(body, cookie), method });
          type Listed = {
            marks: { id: string; kind: string; from: number | null; to: number | null }[];
            categories: { id: string; name: string; key: string | null }[];
            plot: { chain: number[]; problems: { markId: string | null; text: string }[] };
          };
          const list = async (cookie = s.owner) =>
            (await (await getAs(`/api/tracks/${s.trackId}/score-marks`, cookie)).json()) as Listed;
          // Three takes recorded for the track, and one aborted.
          for (const number of [3, 7, 12])
            await db
              .insert(schema.takes)
              .values({ organisationId: s.organisationId, trackId: s.trackId, number });
          await db.insert(schema.takes).values({
            organisationId: s.organisationId,
            trackId: s.trackId,
            number: 13,
            lifecycle: "aborted",
          });
          const mark = (body: Record<string, unknown>, cookie = s.owner) =>
            send(
              "POST",
              `/api/tracks/${s.trackId}/score-marks`,
              { page: 1, x: 0.5, ...body },
              cookie,
            );

          // A project starts with its categories of issue, keyed 1 to 4.
          const first = await list();
          expect(first.categories.map((c) => [c.name, c.key])).toEqual([
            ["Intonation", "1"],
            ["Ensemble", "2"],
            ["Noise", "3"],
            ["Balance", "4"],
          ]);
          expect(first.plot).toEqual({ chain: [], problems: [] });

          // The edit plot: lead-in T3, then 3 into 12, then 12 into 7.
          expect((await mark({ kind: "edit", y: 0.1, to: 3, barFrom: 1 })).status).toBe(201);
          await mark({ kind: "edit", y: 0.4, from: 3, to: 12, barFrom: 9 });
          const last = await mark({ kind: "edit", y: 0.8, from: 12, to: 7, barFrom: 17 });
          const lastId = ((await last.json()) as { mark: { id: string } }).mark.id;
          expect((await list()).plot).toEqual({ chain: [3, 12, 7], problems: [] });
          // A hand-over from the wrong take, into one never recorded, is told; an aborted take
          // was not recorded either.
          await send("PATCH", `/api/score-marks/${lastId}`, { from: 3, to: 40 });
          expect((await list()).plot.problems.map((p) => p.text)).toEqual([
            "bar 17: take 40 was not recorded",
            "bar 17: hands over from T3, but the plot is in T12",
          ]);
          await send("PATCH", `/api/score-marks/${lastId}`, { from: 12, to: 13 });
          expect((await list()).plot.problems.map((p) => p.text)).toEqual([
            "bar 17: take 13 was not recorded",
          ]);
          // A change keeps what each kind needs: an edit its take, a start its take, a note words.
          expect((await send("PATCH", `/api/score-marks/${lastId}`, { to: null })).status).toBe(
            422,
          );
          const started = (
            (await (await mark({ kind: "take-start", y: 0.05, to: 7 })).json()) as {
              mark: { id: string };
            }
          ).mark;
          expect((await send("PATCH", `/api/score-marks/${started.id}`, { to: null })).status).toBe(
            422,
          );
          const noted = (
            (await (await mark({ kind: "note", y: 0.07, text: "Breath" })).json()) as {
              mark: { id: string };
            }
          ).mark;
          expect((await send("PATCH", `/api/score-marks/${noted.id}`, { text: "" })).status).toBe(
            422,
          );
          for (const id of [started.id, noted.id])
            await app.request(`/api/score-marks/${id}`, {
              method: "DELETE",
              headers: { cookie: s.owner, origin: "http://localhost:3000" },
            });

          // An issue in its category, with the takes it occurred in and the take that fixed it.
          const noise = first.categories.find((c) => c.name === "Noise")?.id;
          const issue = await mark({
            kind: "issue",
            y: 0.3,
            width: 0.2,
            height: 0.05,
            barFrom: 5,
            text: "Pedal noise",
            categoryId: noise,
            takes: [3, 7],
            fixedBy: 12,
          });
          expect(issue.status).toBe(201);
          const made = ((await issue.json()) as { mark: { id: string; resolved: boolean } }).mark;
          expect(made.resolved).toBe(false);
          const resolved = await send("PATCH", `/api/score-marks/${made.id}`, { resolved: true });
          expect(((await resolved.json()) as { mark: { resolved: boolean } }).mark.resolved).toBe(
            true,
          );
          // Each kind needs what it says; the bars run forwards.
          expect((await mark({ kind: "dynamic", y: 0.5 })).status).toBe(400);
          expect((await send("PATCH", `/api/score-marks/${made.id}`, { barTo: 2 })).status).toBe(
            422,
          );

          // The engineer sees the marks but may not make them; a reviewer sees none.
          expect((await list(s.engineer)).marks).toHaveLength(4);
          expect((await mark({ kind: "note", y: 0.2, text: "Breath" }, s.engineer)).status).toBe(
            403,
          );
          expect((await getAs(`/api/tracks/${s.trackId}/score-marks`, s.composer)).status).toBe(
            403,
          );

          // Another workspace's category is not one to file under, nor its marks to change.
          const [elsewhere] = await db
            .insert(schema.organisations)
            .values({ name: "Elsewhere", slug: "elsewhere-score-marks" })
            .returning();
          const [theirProject] = await db
            .insert(schema.projects)
            .values({ organisationId: elsewhere?.id ?? "", name: "Theirs", profile: "music" })
            .returning();
          const [theirCategory] = await db
            .insert(schema.scoreMarkCategories)
            .values({
              organisationId: elsewhere?.id ?? "",
              projectId: theirProject?.id ?? "",
              name: "Theirs",
              colour: "blue",
            })
            .returning();
          expect(
            (await mark({ kind: "issue", y: 0.6, categoryId: theirCategory?.id })).status,
          ).toBe(404);
          const [theirTrack] = await db
            .insert(schema.tracks)
            .values({
              organisationId: elsewhere?.id ?? "",
              projectId: theirProject?.id ?? "",
              name: "Theirs",
            })
            .returning();
          const [theirMark] = await db
            .insert(schema.scoreMarks)
            .values({
              organisationId: elsewhere?.id ?? "",
              trackId: theirTrack?.id ?? "",
              kind: "note",
              page: 1,
              x: 0.5,
              y: 0.5,
              text: "Theirs",
            })
            .returning();
          expect(
            (await send("PATCH", `/api/score-marks/${theirMark?.id}`, { text: "Mine" })).status,
          ).toBe(404);
          expect((await getAs(`/api/tracks/${theirTrack?.id}/score-marks`, s.owner)).status).toBe(
            404,
          );

          // The project's categories: one added on a free key, but not a second name or key;
          // renamed; removed, its issues keep everything else. Not by the engineer, and not
          // another workspace's.
          const categories = (body: unknown, cookie = s.owner) =>
            send("POST", `/api/projects/${s.projectId}/score-categories`, body, cookie);
          const tuning = await categories({ name: "Tuning", colour: "blue", key: "5" });
          expect(tuning.status).toBe(201);
          const tuningId = ((await tuning.json()) as { category: { id: string } }).category.id;
          expect((await categories({ name: "noise", colour: "blue", key: null })).status).toBe(409);
          expect((await categories({ name: "Pitch", colour: "blue", key: "1" })).status).toBe(409);
          expect(
            (await categories({ name: "Pitch", colour: "blue", key: null }, s.engineer)).status,
          ).toBe(403);
          expect(
            (
              await send("PATCH", `/api/score-categories/${tuningId}`, {
                name: "Tuning, piano",
                colour: "green",
                key: "6",
              })
            ).status,
          ).toBe(200);
          expect(
            (
              await send("PATCH", `/api/score-categories/${theirCategory?.id}`, {
                name: "Mine",
                colour: "green",
                key: null,
              })
            ).status,
          ).toBe(404);
          const removed = await app.request(`/api/score-categories/${noise}`, {
            method: "DELETE",
            headers: { cookie: s.owner, origin: "http://localhost:3000" },
          });
          expect(removed.status).toBe(204);
          const afterRemoval = await list();
          expect(afterRemoval.categories.map((c) => c.name)).toEqual([
            "Intonation",
            "Ensemble",
            "Balance",
            "Tuning, piano",
          ]);

          // Rubbed out, it is gone.
          const gone = await app.request(`/api/score-marks/${made.id}`, {
            method: "DELETE",
            headers: { cookie: s.owner, origin: "http://localhost:3000" },
          });
          expect(gone.status).toBe(204);
          expect((await list()).marks).toHaveLength(3);
        });

        it("imports takes: each file the next take of its track, in its session, once (#45)", async () => {
          const s = await studio();
          const file = async (name: string, kind: "audio" | "document" = "audio") => {
            const blob = await storage.put(s.organisationId, Buffer.from(name));
            const [row] = await db
              .insert(schema.files)
              .values({
                organisationId: s.organisationId,
                projectId: s.projectId,
                name,
                kind,
                blobId: blob.id,
                contentType: kind === "audio" ? "audio/wav" : "text/plain",
                byteSize: blob.byteSize,
              })
              .returning();
            return row?.id ?? "";
          };
          const [t27, t28, notes] = [
            await file("T27_Mix.wav"),
            await file("T28_Mix.wav"),
            await file("Notes.txt", "document"),
          ];
          const send = (body: unknown, cookie = s.engineer) =>
            app.request(`/api/projects/${s.projectId}/takes/import`, json(body, cookie));
          const made = await app.request(
            `/api/projects/${s.projectId}/sessions`,
            json({ name: "Day 3", recordedOn: "2026-10-14" }, s.engineer),
          );
          const sessionId = ((await made.json()) as { session: { id: string } }).session.id;
          const both = {
            takes: [
              { fileId: t27, trackId: s.trackId, sessionId, label: "T27" },
              { fileId: t28, trackId: s.trackId, sessionId, label: "T28" },
            ],
          };

          // A reviewer may not; nor may anyone with a stray track, session or file.
          expect((await send(both, s.composer)).status).toBe(403);
          const stray = "0199f000-0000-7000-8000-000000000001";
          for (const take of [
            { fileId: t27, trackId: stray, sessionId },
            { fileId: t27, trackId: s.trackId, sessionId: stray },
            { fileId: stray, trackId: s.trackId, sessionId },
          ])
            expect((await send({ takes: [take] })).status).toBe(404);
          expect(
            (await send({ takes: [{ fileId: notes, trackId: s.trackId, sessionId: null }] }))
              .status,
          ).toBe(422);
          expect((await send({ takes: [both.takes[0], both.takes[0]] })).status).toBe(422);

          const done = await send(both);
          expect(done.status).toBe(201);
          expect(await done.json()).toEqual({ imported: 2, matched: 0, skipped: 0 });
          const takes = (await (
            await getAs(`/api/tracks/${s.trackId}/takes`, s.engineer)
          ).json()) as {
            takes: { number: number; label: string; sessionId: string; file: { id: string } }[];
          };
          expect(takes.takes.map((t) => [t.number, t.label, t.sessionId, t.file.id])).toEqual([
            [1, "T27", sessionId, t27],
            [2, "T28", sessionId, t28],
          ]);
          // The session recorded the track its takes are of.
          const session = (await (
            await getAs(`/api/sessions/${sessionId}`, s.engineer)
          ).json()) as {
            session: { tracks: { id: string }[]; takes: number };
          };
          expect(session.session).toMatchObject({ tracks: [{ id: s.trackId }], takes: 2 });

          // Sent again, as an import carrying on after a break would: nothing made twice.
          expect(await (await send(both)).json()).toEqual({ imported: 0, matched: 0, skipped: 2 });

          // A take logged live in the session (#51) is given the file recorded as its number,
          // rather than a second take of that number; a number with a file already, or one
          // that is not a whole number, makes a new take as before.
          const logged = (
            (await (
              await app.request(
                `/api/sessions/${sessionId}/takes`,
                json({ trackId: s.trackId }, s.engineer),
              )
            ).json()) as { take: { id: string; number: number } }
          ).take;
          expect(logged.number).toBe(3);
          await app.request(`/api/takes/${logged.id}`, {
            ...json({ lifecycle: "recorded" }, s.engineer),
            method: "PATCH",
          });
          const [t3, again, twelve] = [
            await file("T03_Mix.wav"),
            await file("T03_Mix again.wav"),
            await file("T12A_Mix.wav"),
          ];
          const third = await send({
            takes: [
              { fileId: t3, trackId: s.trackId, sessionId, label: "T03", take: "03" },
              { fileId: again, trackId: s.trackId, sessionId, label: "T03", take: "3" },
              { fileId: twelve, trackId: s.trackId, sessionId, label: "T12A", take: "12A" },
            ],
          });
          expect(await third.json()).toEqual({ imported: 3, matched: 1, skipped: 0 });
          const after = (await (
            await getAs(`/api/tracks/${s.trackId}/takes`, s.engineer)
          ).json()) as {
            takes: { id: string; number: number; file: { id: string } | null }[];
          };
          expect(after.takes.find((t) => t.id === logged.id)?.file?.id).toBe(t3);
          expect(after.takes.map((t) => t.number)).toEqual([1, 2, 3, 4, 5]);

          // Another workspace's file is not found from here.
          const [elsewhere] = await db
            .insert(schema.organisations)
            .values({ name: "Elsewhere", slug: "elsewhere-import" })
            .returning();
          const blob = await storage.put(elsewhere?.id ?? "", Buffer.from("theirs"));
          const [foreignProject] = await db
            .insert(schema.projects)
            .values({ organisationId: elsewhere?.id ?? "", name: "Theirs", profile: "music" })
            .returning();
          const [foreign] = await db
            .insert(schema.files)
            .values({
              organisationId: elsewhere?.id ?? "",
              projectId: foreignProject?.id ?? "",
              name: "Theirs.wav",
              kind: "audio",
              blobId: blob.id,
              contentType: "audio/wav",
              byteSize: blob.byteSize,
            })
            .returning();
          expect(
            (
              await send({
                takes: [{ fileId: foreign?.id ?? "", trackId: s.trackId, sessionId: null }],
              })
            ).status,
          ).toBe(404);
        });

        it("keeps a project's workflows, and runs only those that break no rule (#25)", async () => {
          const s = await studio();
          type Summary = {
            id: string;
            trackId: string | null;
            active: boolean;
            version: number;
            problems: { level: string; text: string }[];
          };
          const at = (id: string, type: string, name: string, x: number) => ({
            id,
            type,
            name,
            x,
            y: 0,
          });
          const review = {
            nodes: [
              at("start", "upload", "A version is uploaded", 0),
              at("fb", "feedback", "Conductor", 320),
              at("done", "finish", "Done", 640),
            ],
            connectors: [
              { id: "1", from: "start", outcome: "happened", to: "fb" },
              { id: "2", from: "fb", outcome: "done", to: "done" },
            ],
          };
          // Nothing follows the feedback: an action that leads nowhere is only a warning, but a
          // connector by an outcome feedback does not have is an error.
          const broken = {
            ...review,
            connectors: [
              ...review.connectors,
              { id: "3", from: "fb", outcome: "approved", to: "done" },
            ],
          };
          const send = (method: string, url: string, body: unknown, cookie = s.owner) =>
            app.request(url, { ...json(body, cookie), method });

          // Made by those who edit workflows; the engineer only sees them.
          expect(
            (
              await send(
                "POST",
                `/api/projects/${s.projectId}/workflows`,
                {
                  name: "Album review",
                  definition: review,
                },
                s.engineer,
              )
            ).status,
          ).toBe(403);
          const made = await send("POST", `/api/projects/${s.projectId}/workflows`, {
            name: "Album review",
            definition: broken,
          });
          expect(made.status).toBe(201);
          const workflow = ((await made.json()) as { workflow: Summary }).workflow;
          expect(workflow).toMatchObject({ active: false, version: 1, trackId: null });
          expect(workflow.problems[0]).toMatchObject({ level: "error" });
          const listed = (await (
            await getAs(`/api/projects/${s.projectId}/workflows`, s.engineer)
          ).json()) as { workflows: Summary[] };
          expect(listed.workflows.map((w) => w.id)).toEqual([workflow.id]);

          // Not switched on while it breaks a rule; mended and switched on, it is.
          const change = (body: unknown, cookie = s.owner) =>
            send("PATCH", `/api/workflows/${workflow.id}`, body, cookie);
          const refused = await change({ active: true });
          expect(refused.status).toBe(422);
          expect(await refused.text()).toContain("by an outcome it does not have");
          expect((await change({ definition: review, active: true }, s.engineer)).status).toBe(403);
          const on = await change({ definition: review, active: true, version: 1 });
          expect(((await on.json()) as { workflow: Summary }).workflow).toMatchObject({
            active: true,
            version: 2,
            problems: [],
          });
          // A change made over someone else's is refused, not lost; an active one stays sound.
          expect((await change({ name: "Late", version: 1 })).status).toBe(409);
          expect((await change({ definition: broken })).status).toBe(422);

          // A track's own workflow, of a track of this project only.
          const stray = "0199f000-0000-7000-8000-000000000001";
          expect(
            (
              await send("POST", `/api/projects/${s.projectId}/workflows`, {
                name: "Stray",
                trackId: stray,
                definition: review,
              })
            ).status,
          ).toBe(404);
          const own = (
            (await (
              await send("POST", `/api/projects/${s.projectId}/workflows`, {
                name: "Maple Leaf Rag's own",
                trackId: s.trackId,
                definition: review,
              })
            ).json()) as { workflow: Summary }
          ).workflow;
          // It replaces the project's for its track once it is switched on.
          const runsFor = async (trackId: string | null) =>
            (await workflowsFor(db, s.organisationId, s.projectId, trackId)).map((w) => w.id);
          expect(await runsFor(s.trackId)).toEqual([workflow.id]);
          await change({ active: true });
          await send("PATCH", `/api/workflows/${own.id}`, { active: true });
          expect(await runsFor(s.trackId)).toEqual([own.id]);
          expect(await runsFor(null)).toEqual([workflow.id]);

          // Not to be found from outside the project or the workspace.
          const newcomer = await joinAs(s.owner, "newcomer-wf@example.test");
          expect((await getAs(`/api/workflows/${workflow.id}`, newcomer)).status).toBe(404);
          expect((await getAs(`/api/projects/${s.projectId}/workflows`, newcomer)).status).toBe(
            404,
          );
          const [elsewhere] = await db
            .insert(schema.organisations)
            .values({ name: "Elsewhere", slug: "elsewhere-workflows" })
            .returning();
          const [foreignProject] = await db
            .insert(schema.projects)
            .values({ organisationId: elsewhere?.id ?? "", name: "Theirs", profile: "music" })
            .returning();
          const [foreign] = await db
            .insert(schema.workflows)
            .values({
              organisationId: elsewhere?.id ?? "",
              projectId: foreignProject?.id ?? "",
              name: "Theirs",
              definition: review as never,
            })
            .returning();
          expect((await getAs(`/api/workflows/${foreign?.id}`, s.owner)).status).toBe(404);
          expect(
            (await send("PATCH", `/api/workflows/${foreign?.id}`, { name: "Mine" })).status,
          ).toBe(404);

          const gone = await app.request(`/api/workflows/${own.id}`, {
            method: "DELETE",
            headers: { cookie: s.owner, origin: "http://localhost:3000" },
          });
          expect(gone.status).toBe(204);
          expect(await runsFor(s.trackId)).toEqual([workflow.id]);
        });

        it("runs a workflow when a version arrives, and logs each move it makes (#25)", async () => {
          const s = await studio();
          const at = (id: string, type: string, name: string, x: number, config = {}) => ({
            id,
            type,
            name,
            x,
            y: 0,
            config,
          });
          const definition = {
            nodes: [
              at("start", "upload", "A version is uploaded", 0),
              at("fb", "feedback", "Conductor", 1, { status: "With conductor" }),
              at("tell", "notify", "Tell the engineer", 2, {
                to: "Engineer",
                message: "Notes are in.",
              }),
              at("edit", "task", "Engineer edits", 3, { who: "Engineer", status: "Editing" }),
              at("rest", "wait", "Let it rest", 4, { days: "1" }),
              at("done", "finish", "Approved", 5, { status: "Approved" }),
            ],
            connectors: [
              { id: "1", from: "start", outcome: "happened", to: "fb" },
              { id: "2", from: "fb", outcome: "done", to: "tell" },
              { id: "3", from: "tell", outcome: "sent", to: "edit" },
              { id: "4", from: "edit", outcome: "done", to: "rest" },
              { id: "5", from: "rest", outcome: "elapsed", to: "done" },
            ],
          };
          const send = (url: string, body: unknown, cookie = s.owner) =>
            app.request(url, json(body, cookie));
          const made = (await (
            await send(`/api/projects/${s.projectId}/workflows`, {
              name: "Album review",
              definition,
            })
          ).json()) as { workflow: { id: string } };
          await app.request(`/api/workflows/${made.workflow.id}`, {
            ...json({ active: true }, s.owner),
            method: "PATCH",
          });
          type Run = {
            id: string;
            state: string;
            status: string | null;
            waiting: { nodeId: string }[];
            steps: { nodeId: string | null; outcome: string | null; effects: { kind: string }[] }[];
          };
          const runs = async (cookie = s.owner) =>
            (
              (await (await getAs(`/api/tracks/${s.trackId}/workflow-runs`, cookie)).json()) as {
                runs: Run[];
              }
            ).runs;
          const statusOf = async () =>
            (
              await db
                .select({ status: schema.tracks.workflowStatus })
                .from(schema.tracks)
                .where(eq(schema.tracks.id, s.trackId))
            )[0]?.status;
          const newVersion = async (
            name: string,
            extra: Record<string, unknown> = {},
            cookie = s.owner,
            expected = 201,
          ) => {
            const blob = await storage.put(s.organisationId, Buffer.from(name));
            const [file] = await db
              .insert(schema.files)
              .values({
                organisationId: s.organisationId,
                projectId: s.projectId,
                name,
                kind: "audio",
                blobId: blob.id,
                contentType: "audio/wav",
                byteSize: blob.byteSize,
                mediaInfo: {
                  duration: 60,
                  audio: { codec: "pcm_s24le", channels: 2, sampleRate: 48000 },
                } as never,
              })
              .returning();
            const added = await send(
              `/api/tracks/${s.trackId}/versions`,
              { variations: [{ fileId: file?.id ?? "", name: "Mix" }], ...extra },
              cookie,
            );
            expect(added.status).toBe(expected);
          };

          // Whoever follows the track hears of a new status (#110).
          expect(
            (
              await app.request(
                "/api/notifications/follows",
                json({ trackId: s.trackId }, s.accompanist),
              )
            ).status,
          ).toBe(204);
          // A new version starts it: the conductor is asked, and the track says so.
          await newVersion("Mix v2.wav");
          let [run] = await runs(s.composer);
          expect(run).toMatchObject({
            state: "running",
            status: "With conductor",
            waiting: [{ nodeId: "fb" }],
          });
          expect(await statusOf()).toBe("With conductor");
          const statusNews = (
            (await (await getAs("/api/notifications", s.accompanist)).json()) as {
              notifications: { kind: string; text: string }[];
            }
          ).notifications;
          expect(statusNews).toContainEqual(
            expect.objectContaining({
              kind: "workflow",
              text: "Maple Leaf Rag is now With conductor",
            }),
          );
          // The board (#141) has the track under its status, waiting at its stage; its columns
          // come from the workflow, in the order a run reaches them.
          type BoardBody = {
            workflows: string[];
            columns: { status: { name: string; category: string }[]; stage: { name: string }[] };
            cards: {
              name: string;
              status: string | null;
              stage: string | null;
              version: unknown;
            }[];
          };
          const board = async (cookie = s.owner) =>
            (await (await getAs(`/api/projects/${s.projectId}/board`, cookie)).json()) as BoardBody;
          const seen = await board(s.composer);
          expect(seen.workflows).toEqual(["Album review"]);
          expect(seen.columns.status.map((c) => c.name)).toEqual([
            "No version",
            "No status",
            "With conductor",
            "Editing",
            "Approved",
          ]);
          expect(seen.columns.status.find((c) => c.name === "Approved")?.category).toBe("done");
          expect(seen.columns.stage.map((c) => c.name)).toEqual([
            "No version",
            "Not at a stage",
            "Conductor",
            "Engineer edits",
            "Let it rest",
          ]);
          expect(seen.cards).toMatchObject([
            { name: "Maple Leaf Rag", status: "With conductor", stage: "Conductor" },
          ]);
          const outsiderBoard = await joinAs(s.owner, "outsider-board@example.test");
          // The track's page says the same (#26), and what comes next, to whoever sees the track.
          const standingPath = `/api/tracks/${s.trackId}/workflow-standing`;
          expect(await (await getAs(standingPath, s.composer)).json()).toEqual({
            status: "With conductor",
            category: "in_progress",
            stage: "Conductor",
            next: "Engineer edits",
          });
          expect((await getAs(standingPath, outsiderBoard)).status).toBe(404);
          expect((await getAs(`/api/projects/${s.projectId}/board`, outsiderBoard)).status).toBe(
            404,
          );
          // Its status set (#26): the board's columns follow its order and categories, and the
          // statuses only a step sets come after. Only those who edit workflows change it.
          const statusesPath = `/api/projects/${s.projectId}/workflow-statuses`;
          const putStatuses = (statuses: unknown, cookie = s.owner) =>
            app.request(statusesPath, { ...json({ statuses }, cookie), method: "PUT" });
          const set = [
            { name: "Editing", category: "todo" },
            { name: "On hold", category: "todo" },
            { name: "Approved", category: "done" },
          ];
          expect((await putStatuses(set, s.engineer)).status).toBe(403);
          expect((await putStatuses(set, outsiderBoard)).status).toBe(404);
          expect(
            (
              await putStatuses([
                { name: "Editing", category: "todo" },
                { name: "editing", category: "done" },
              ])
            ).status,
          ).toBe(400);
          const saved = (await (await putStatuses(set)).json()) as {
            statuses: { name: string; category: string; steps: number; kept: boolean }[];
          };
          expect(saved.statuses.map((x) => [x.name, x.kept])).toEqual([
            ["Editing", true],
            ["On hold", true],
            ["Approved", true],
            ["With conductor", false],
          ]);
          expect((await (await getAs(statusesPath, s.composer)).json()) as typeof saved).toEqual(
            saved,
          );
          expect((await getAs(statusesPath, outsiderBoard)).status).toBe(404);
          expect((await board(s.composer)).columns.status.map((c) => [c.name, c.category])).toEqual(
            [
              ["No version", "todo"],
              ["No status", "todo"],
              ["Editing", "todo"],
              ["On hold", "todo"],
              ["Approved", "done"],
              ["With conductor", "in_progress"],
            ],
          );
          // A step's status in another case is the set's own: one column, as the set spells it,
          // which the card and the track's line follow.
          expect(
            (await putStatuses([...set, { name: "with CONDUCTOR", category: "todo" }])).status,
          ).toBe(200);
          const cased = await board(s.composer);
          expect(
            cased.columns.status.filter((c) => c.name.toLowerCase() === "with conductor"),
          ).toEqual([expect.objectContaining({ name: "with CONDUCTOR", category: "todo" })]);
          expect(cased.cards[0]?.status).toBe("with CONDUCTOR");
          expect(await (await getAs(standingPath, s.composer)).json()).toMatchObject({
            category: "todo",
          });
          expect((await putStatuses(set)).status).toBe(200);

          // Ended by hand by those who edit workflows: the engineer is told, and given the edit.
          const step = (body: unknown, cookie = s.owner) =>
            send(`/api/workflow-runs/${run?.id}/steps`, body, cookie);
          expect((await step({ nodeId: "fb", outcome: "done" }, s.engineer)).status).toBe(403);
          expect((await step({ nodeId: "edit", outcome: "done" })).status).toBe(409);
          expect((await step({ nodeId: "fb", outcome: "approved" })).status).toBe(422);
          expect((await step({ nodeId: "fb", outcome: "done" })).status).toBe(200);
          const told = await db
            .select({ text: schema.notifications.text, detail: schema.notifications.detail })
            .from(schema.notifications)
            .where(
              and(
                eq(schema.notifications.userId, s.ids.engineer),
                eq(schema.notifications.kind, "workflow"),
              ),
            );
          expect(told).toEqual([
            { text: "Tell the engineer: Maple Leaf Rag", detail: "Notes are in." },
            { text: "Engineer edits on Maple Leaf Rag is yours", detail: null },
          ]);
          expect(await statusOf()).toBe("Editing");
          // The edit is a task of the project (#140), the engineer's, about the track.
          type StageTask = {
            id: string;
            key: string;
            title: string;
            status: string;
            fromWorkflow: boolean;
            assignee: { id: string } | null;
            track: { id: string } | null;
          };
          const stageTasks = async () =>
            (
              (await (await getAs(`/api/projects/${s.projectId}/tasks`, s.owner)).json()) as {
                tasks: StageTask[];
              }
            ).tasks;
          const [edit] = await stageTasks();
          expect(edit).toMatchObject({
            key: "R-1",
            title: "Engineer edits",
            status: "pending",
            fromWorkflow: true,
            assignee: { id: s.ids.engineer },
            track: { id: s.trackId },
          });

          // The engineer marks it done: the stage ends done, the wait is queued for its day, and
          // when it elapses the run finishes.
          sent.length = 0;
          expect(
            (
              await app.request(`/api/tasks/${edit?.id}`, {
                ...json({ status: "done" }, s.engineer),
                method: "PATCH",
              })
            ).status,
          ).toBe(200);
          const wait = sent.find((j) => j.name === "workflow-wait")?.data as {
            organisationId: string;
            runId: string;
            nodeId: string;
            stepId: string;
          };
          expect(wait).toMatchObject({ runId: run?.id, nodeId: "rest" });
          // A wait from a step the run has moved past changes nothing.
          await clockElapsed(
            { db, jobs },
            { ...wait, stepId: "0199f000-0000-7000-8000-000000000001" },
          );
          expect((await runs())[0]?.state).toBe("running");
          // Were the job never queued, the hourly sweep ends the wait once its day has passed.
          expect(await sweepRuns({ db, jobs })).toBe(0);
          expect(await sweepRuns({ db, jobs }, new Date(Date.now() + 2 * 86_400_000))).toBe(1);
          // The job arriving after the sweep changes nothing.
          await clockElapsed({ db, jobs }, wait);
          [run] = await runs();
          expect(run).toMatchObject({ state: "finished", status: "Approved", waiting: [] });
          expect(run?.steps.map((st) => [st.nodeId, st.outcome])).toEqual([
            [null, null],
            ["fb", "done"],
            ["edit", "done"],
            ["rest", "elapsed"],
          ]);
          expect(await statusOf()).toBe("Approved");

          // The next version starts it again; it is not started by hand.
          await newVersion("Mix v3.wav");
          expect((await runs()).map((r) => r.state)).toEqual(["running", "finished"]);
          // Its edit, ended by hand, is a new task, done with it.
          const [again] = await runs();
          const stepAgain = (body: unknown) => send(`/api/workflow-runs/${again?.id}/steps`, body);
          await stepAgain({ nodeId: "fb", outcome: "done" });
          expect((await stageTasks()).map((t) => [t.key, t.status])).toEqual([
            ["R-2", "pending"],
            ["R-1", "done"],
          ]);
          // One an earlier visit to the stage left open (it ended overdue) stays open: only
          // the task of the visit being ended is closed with it.
          await db.insert(schema.tasks).values({
            organisationId: s.organisationId,
            projectId: s.projectId,
            number: 0,
            title: "Engineer edits",
            runId: again?.id,
            nodeId: "edit",
          });
          await stepAgain({ nodeId: "edit", outcome: "done" });
          expect((await stageTasks()).map((t) => [t.key, t.status])).toEqual([
            ["R-0", "pending"],
            ["R-1", "done"],
            ["R-2", "done"],
          ]);
          expect(
            (await send(`/api/tracks/${s.trackId}/workflow-runs`, { workflowId: made.workflow.id }))
              .status,
          ).toBe(422);

          // A new version may start it again from a stage (#25): the run under way stops, what
          // it waited on cancelled, and a new one waits at that stage. Only those who edit
          // workflows choose so, and only a stage the track's workflow has.
          const restartFrom = (nodeId: string) => ({
            restartFrom: { workflowId: made.workflow.id, nodeId },
          });
          const versionCount = async () =>
            (
              await db
                .select({ id: schema.versions.id })
                .from(schema.versions)
                .where(eq(schema.versions.trackId, s.trackId))
            ).length;
          const versionsBefore = await versionCount();
          await newVersion("Mix v4.wav", restartFrom("edit"), s.engineer, 403);
          await newVersion("Mix v4.wav", restartFrom("tell"), s.owner, 422);
          await newVersion("Mix v4.wav", restartFrom("gone"), s.owner, 422);
          // A restart refused takes the version with it: neither lands.
          expect(await versionCount()).toBe(versionsBefore);
          const before = await runs();
          await newVersion("Mix v4.wav", restartFrom("fb"));
          const after = await runs();
          expect(after).toHaveLength(before.length + 1);
          expect(after[0]).toMatchObject({
            state: "running",
            status: "With conductor",
            waiting: [{ nodeId: "fb" }],
          });
          expect(after.find((r) => r.id === before[0]?.id)?.state).toBe("stopped");

          // Nobody outside the project sees the runs or moves them.
          const newcomer = await joinAs(s.owner, "newcomer-runs@example.test");
          expect((await getAs(`/api/tracks/${s.trackId}/workflow-runs`, newcomer)).status).toBe(
            404,
          );
          expect((await step({ nodeId: "fb", outcome: "done" }, newcomer)).status).toBe(404);
        });

        it("carries a run on from a version it waits for, even once its workflow is off (#25)", async () => {
          const s = await studio();
          const at = (id: string, type: string, name: string, x: number) => ({
            id,
            type,
            name,
            x,
            y: 0,
            config: {},
          });
          const definition = {
            nodes: [
              at("start", "upload", "A version is uploaded", 0),
              at("edit", "task", "Engineer edits", 1),
              at("again", "upload", "The edit is uploaded", 2),
              at("done", "finish", "Done", 3),
            ],
            connectors: [
              { id: "1", from: "start", outcome: "happened", to: "edit" },
              // Taken only when a member, not a job, ended the edit.
              {
                id: "2",
                from: "edit",
                outcome: "done",
                to: "again",
                condition: { test: "by", is: "member" },
              },
              { id: "3", from: "again", outcome: "happened", to: "done" },
            ],
          };
          const send = (url: string, body: unknown, method = "POST") =>
            app.request(url, { ...json(body, s.owner), method });
          const made = (await (
            await send(`/api/projects/${s.projectId}/workflows`, { name: "Edit round", definition })
          ).json()) as { workflow: { id: string } };
          await send(`/api/workflows/${made.workflow.id}`, { active: true }, "PATCH");
          const version = async (name: string) => {
            const blob = await storage.put(s.organisationId, Buffer.from(name));
            const [file] = await db
              .insert(schema.files)
              .values({
                organisationId: s.organisationId,
                projectId: s.projectId,
                name,
                kind: "audio",
                blobId: blob.id,
                contentType: "audio/wav",
                byteSize: blob.byteSize,
                mediaInfo: {
                  duration: 60,
                  audio: { codec: "pcm_s24le", channels: 2, sampleRate: 48000 },
                } as never,
              })
              .returning();
            await send(`/api/tracks/${s.trackId}/versions`, {
              variations: [{ fileId: file?.id ?? "", name: "Mix" }],
            });
          };
          type Run = { id: string; state: string; waiting: { nodeId: string }[] };
          const runs = async () =>
            (
              (await (await getAs(`/api/tracks/${s.trackId}/workflow-runs`, s.owner)).json()) as {
                runs: Run[];
              }
            ).runs;
          await version("Edit v2.wav");
          const [run] = await runs();
          // Ended by a member, the edit takes the connector kept for members.
          await send(`/api/workflow-runs/${run?.id}/steps`, { nodeId: "edit", outcome: "done" });
          expect((await runs())[0]).toMatchObject({
            state: "running",
            waiting: [{ nodeId: "again" }],
          });
          // Switched off, the workflow starts nothing new; the run under way still hears the edit.
          await send(`/api/workflows/${made.workflow.id}`, { active: false }, "PATCH");
          await version("Edit v3.wav");
          expect((await runs()).map((r) => r.state)).toEqual(["finished"]);
          await version("Edit v4.wav");
          expect((await runs()).map((r) => r.state)).toEqual(["finished"]);
        });

        it("asks for a stage's review, and its outcome moves the run on (#25)", async () => {
          const s = await studio();
          const at = (id: string, type: string, name: string, x: number, config = {}) => ({
            id,
            type,
            name,
            x,
            y: 0,
            config,
          });
          const send = (url: string, body: unknown, cookie = s.owner, method = "POST") =>
            app.request(url, { ...json(body, cookie), method });
          const switchOn = async (name: string, definition: unknown) => {
            const made = (await (
              await send(`/api/projects/${s.projectId}/workflows`, { name, definition })
            ).json()) as { workflow: { id: string } };
            await send(`/api/workflows/${made.workflow.id}`, { active: true }, s.owner, "PATCH");
            return made.workflow.id;
          };
          const version = async (name: string) => {
            const blob = await storage.put(s.organisationId, Buffer.from(name));
            const [file] = await db
              .insert(schema.files)
              .values({
                organisationId: s.organisationId,
                projectId: s.projectId,
                name,
                kind: "audio",
                blobId: blob.id,
                contentType: "audio/wav",
                byteSize: blob.byteSize,
                mediaInfo: {
                  duration: 60,
                  audio: { codec: "pcm_s24le", channels: 2, sampleRate: 48000 },
                } as never,
              })
              .returning();
            await send(`/api/tracks/${s.trackId}/versions`, {
              variations: [{ fileId: file?.id ?? "", name: "Mix" }],
            });
          };
          const stageReviews = () =>
            db
              .select({
                id: schema.reviews.id,
                title: schema.reviews.title,
                kind: schema.reviews.kind,
                status: schema.reviews.status,
                order: schema.reviews.order,
                rule: schema.reviews.rule,
                node: schema.reviews.workflowNodeId,
                completedAt: schema.reviews.completedAt,
              })
              .from(schema.reviews)
              .where(eq(schema.reviews.projectId, s.projectId))
              .orderBy(schema.reviews.createdAt);
          type Run = { state: string; status: string | null; waiting: { nodeId: string }[] };
          const latestRun = async () =>
            (
              (await (await getAs(`/api/tracks/${s.trackId}/workflow-runs`, s.owner)).json()) as {
                runs: Run[];
              }
            ).runs[0];

          // The label's approval: the project's reviewers, in turn, everyone to approve.
          const label = await switchOn("Label approval", {
            nodes: [
              at("start", "upload", "A version is uploaded", 0),
              at("approve", "approval", "Label approval", 1, {
                who: "Reviewer",
                order: "In turn",
                rule: "Everyone approves",
                status: "With the label",
              }),
              at("done", "finish", "Approved", 2, { status: "Approved" }),
              at("again", "status", "Back to editing", 2, { status: "Editing" }),
            ],
            connectors: [
              { id: "1", from: "start", outcome: "happened", to: "approve" },
              { id: "2", from: "approve", outcome: "approved", to: "done" },
              { id: "3", from: "approve", outcome: "changes", to: "again" },
            ],
          });
          await version("Label v2.wav");
          const [review] = await stageReviews();
          expect(review).toMatchObject({
            title: "Label approval: Maple Leaf Rag",
            kind: "approval",
            status: "open",
            order: "sequence",
            rule: "all",
            node: "approve",
          });
          expect(await latestRun()).toMatchObject({
            status: "With the label",
            waiting: [{ nodeId: "approve" }],
          });
          // One approval of two leaves it waiting; the second finishes the review and the run.
          const decide = (cookie: string) =>
            send(`/api/reviews/${review?.id}/decisions`, { decision: "approved" }, cookie);
          expect((await decide(s.composer)).status).toBe(200);
          expect((await latestRun())?.state).toBe("running");
          expect((await decide(s.accompanist)).status).toBe(200);
          expect(await latestRun()).toMatchObject({ state: "finished", status: "Approved" });
          await send(`/api/workflows/${label}`, { active: false }, s.owner, "PATCH");

          // A stage whose run moves past it has its review cancelled.
          await switchOn("Either way", {
            nodes: [
              at("start", "upload", "A version is uploaded", 0),
              at("ask", "feedback", "Conductor", 1, { who: "Reviewer" }),
              at("edit", "task", "Engineer edits", 1),
              at("done", "finish", "Done", 2),
            ],
            connectors: [
              { id: "1", from: "start", outcome: "happened", to: "ask" },
              { id: "2", from: "start", outcome: "happened", to: "edit" },
              { id: "3", from: "ask", outcome: "done", to: "done" },
              { id: "4", from: "edit", outcome: "done", to: "done" },
            ],
          });
          await version("Either v3.wav");
          const runId = (
            await db
              .select({ id: schema.workflowRuns.id })
              .from(schema.workflowRuns)
              .where(eq(schema.workflowRuns.state, "running"))
          )[0]?.id;
          await send(`/api/workflow-runs/${runId}/steps`, { nodeId: "edit", outcome: "done" });
          expect(
            (await stageReviews()).map((r) => [r.kind, r.status, Boolean(r.completedAt)]),
          ).toEqual([
            ["approval", "completed", true],
            ["feedback", "cancelled", true],
          ]);
          await send(
            `/api/workflows/${(await db.select({ id: schema.workflows.id }).from(schema.workflows).where(eq(schema.workflows.name, "Either way")))[0]?.id}`,
            { active: false },
            s.owner,
            "PATCH",
          );

          // A stage the same step moves past is never asked for at all.
          await switchOn("Straight through", {
            nodes: [
              at("start", "upload", "A version is uploaded", 0),
              at("ask", "feedback", "Conductor", 1, { who: "Reviewer" }),
              at("done", "finish", "Done", 1),
            ],
            connectors: [
              { id: "1", from: "start", outcome: "happened", to: "ask" },
              { id: "2", from: "start", outcome: "happened", to: "done" },
              { id: "3", from: "ask", outcome: "done", to: "done" },
            ],
          });
          await version("Straight v4.wav");
          expect(await latestRun()).toMatchObject({ state: "finished" });
          expect(await stageReviews()).toHaveLength(2);
        });

        it("ends a feedback stage overdue when its due date passes first (#25)", async () => {
          const s = await studio();
          const at = (id: string, type: string, name: string, x: number, config = {}) => ({
            id,
            type,
            name,
            x,
            y: 0,
            config,
          });
          const definition = {
            nodes: [
              at("start", "upload", "A version is uploaded", 0),
              at("fb", "feedback", "Conductor", 1, { who: "Reviewer", due: "2" }),
              at("thanks", "finish", "Heard", 2, { status: "Heard" }),
              at("late", "finish", "Chased", 2, { status: "Chased" }),
            ],
            connectors: [
              { id: "1", from: "start", outcome: "happened", to: "fb" },
              { id: "2", from: "fb", outcome: "done", to: "thanks" },
              { id: "3", from: "fb", outcome: "overdue", to: "late" },
            ],
          };
          const made = (await (
            await app.request(
              `/api/projects/${s.projectId}/workflows`,
              json({ name: "Conductor's notes", definition }, s.owner),
            )
          ).json()) as { workflow: { id: string } };
          await app.request(`/api/workflows/${made.workflow.id}`, {
            ...json({ active: true }, s.owner),
            method: "PATCH",
          });
          const latest = async () =>
            (
              (await (await getAs(`/api/tracks/${s.trackId}/workflow-runs`, s.owner)).json()) as {
                runs: {
                  state: string;
                  status: string | null;
                  steps: {
                    nodeId: string | null;
                    outcome: string | null;
                    byUserId: string | null;
                  }[];
                }[];
              }
            ).runs[0];
          const runner = { db, jobs };

          // The review is asked for, due in two days, and the stage's clock is queued for then.
          sent.length = 0;
          await app.request(
            `/api/tracks/${s.trackId}/versions`,
            json({ variations: [{ fileId: s.artwork, name: "Mix" }] }, s.owner),
          );
          const clock = sent.find((j) => j.name === "workflow-wait")?.data as {
            organisationId: string;
            runId: string;
            nodeId: string;
            stepId: string;
          };
          expect(clock).toMatchObject({ nodeId: "fb" });
          const [review] = await db
            .select({ status: schema.reviews.status, dueAt: schema.reviews.dueAt })
            .from(schema.reviews)
            .where(eq(schema.reviews.projectId, s.projectId));
          expect(review?.status).toBe("open");
          expect(review?.dueAt?.getTime()).toBeGreaterThan(Date.now() + 86_400_000);

          // Not yet due: nothing moves. Once due, the sweep ends it overdue, as the job would.
          expect(await sweepRuns(runner)).toBe(0);
          expect((await latest())?.state).toBe("running");
          expect(await sweepRuns(runner, new Date(Date.now() + 3 * 86_400_000))).toBe(1);
          const run = await latest();
          expect(run).toMatchObject({ state: "finished", status: "Chased" });
          expect(run?.steps.at(-1)).toMatchObject({
            nodeId: "fb",
            outcome: "overdue",
            byUserId: null,
          });
          // The review stays open, as late notes are still welcome; the job arriving after the
          // sweep changes nothing.
          await clockElapsed(runner, clock);
          expect((await latest())?.steps).toHaveLength(run?.steps.length ?? 0);
          const [still] = await db
            .select({ status: schema.reviews.status })
            .from(schema.reviews)
            .where(eq(schema.reviews.projectId, s.projectId));
          expect(still?.status).toBe("open");
        });

        it("shares a track with the people a stage names, and files it in a folder (#25)", async () => {
          const s = await studio();
          const at = (id: string, type: string, name: string, x: number, config = {}) => ({
            id,
            type,
            name,
            x,
            y: 0,
            config,
          });
          const switchOn = async (name: string, nodes: unknown[], connectors: unknown[]) => {
            const made = (await (
              await app.request(
                `/api/projects/${s.projectId}/workflows`,
                json({ name, definition: { nodes, connectors } }, s.owner),
              )
            ).json()) as { workflow: { id: string } };
            await app.request(`/api/workflows/${made.workflow.id}`, {
              ...json({ active: true }, s.owner),
              method: "PATCH",
            });
          };
          const folder = async (name: string, parentId?: string) =>
            (
              (await (
                await app.request(
                  `/api/projects/${s.projectId}/folders`,
                  json({ name, ...(parentId ? { parentId } : {}) }, s.owner),
                )
              ).json()) as { folder: { id: string } }
            ).folder.id;
          const masters = await folder("Masters");
          const final = await folder("Final", masters);
          // Siblings differing only by case: one written exactly is found, none is guessed.
          await folder("masters");
          await folder("FINAL", masters);
          const [mira] = await db
            .insert(schema.guests)
            .values({
              organisationId: s.organisationId,
              name: "Mira Solberg",
              email: "mira@example.test",
            })
            .returning();
          await switchOn(
            "Deliver",
            [
              at("start", "upload", "A version is uploaded", 0),
              at("send", "share", "Send to the label", 1, {
                to: "Reviewer, Mira Solberg (guest), Ines Arlow <ines@example.test>",
                expires: "7",
              }),
              at("file", "move", "File it", 2, { folder: "Masters / Final" }),
              at("done", "finish", "Delivered", 3, { status: "Delivered" }),
            ],
            [
              { id: "1", from: "start", outcome: "happened", to: "send" },
              { id: "2", from: "send", outcome: "sent", to: "file" },
              { id: "3", from: "file", outcome: "moved", to: "done" },
            ],
          );
          await switchOn(
            "Misfile",
            [
              at("start", "upload", "A version is uploaded", 0),
              at("file", "move", "Put it away", 1, { folder: "Nowhere" }),
              at("guess", "move", "Guess", 2, { folder: "MASTERS/Final" }),
              at("done", "finish", "Done", 3),
            ],
            [
              { id: "1", from: "start", outcome: "happened", to: "file" },
              { id: "2", from: "file", outcome: "moved", to: "guess" },
              { id: "3", from: "guess", outcome: "moved", to: "done" },
            ],
          );
          await app.request(
            `/api/tracks/${s.trackId}/versions`,
            json({ variations: [{ fileId: s.artwork, name: "Mix" }] }, s.owner),
          );

          // A share, of the new version, for the project's reviewers and both guests, for a week.
          const [share] = await db
            .select({ id: schema.reviews.id, title: schema.reviews.title })
            .from(schema.reviews)
            .where(
              and(eq(schema.reviews.projectId, s.projectId), eq(schema.reviews.kind, "share")),
            );
          expect(share?.title).toBe("Send to the label: Maple Leaf Rag");
          const people = await db
            .select({
              userId: schema.reviewReviewers.userId,
              email: schema.guests.email,
              name: schema.guests.name,
              permissions: schema.reviewReviewers.permissions,
            })
            .from(schema.reviewReviewers)
            .leftJoin(schema.guests, eq(schema.guests.id, schema.reviewReviewers.guestId))
            .where(eq(schema.reviewReviewers.reviewId, share?.id ?? ""));
          expect(
            people
              .filter((p) => p.userId)
              .map((p) => p.userId)
              .sort(),
          ).toEqual([s.ids.composer, s.ids.accompanist].sort());
          expect(
            people
              .filter((p) => p.email)
              .map((p) => [p.name, p.email])
              .sort(),
          ).toEqual([
            ["Ines Arlow", "ines@example.test"],
            ["Mira Solberg", mira?.email],
          ]);
          for (const p of people) {
            const until = Date.parse(p.permissions.expiresAt ?? "");
            expect(until).toBeGreaterThan(Date.now() + 6 * 86_400_000);
            expect(until).toBeLessThan(Date.now() + 8 * 86_400_000);
          }

          // Filed in Masters/Final, each written exactly though its siblings differ by case.
          const [track] = await db
            .select({ folderId: schema.tracks.folderId, status: schema.tracks.workflowStatus })
            .from(schema.tracks)
            .where(eq(schema.tracks.id, s.trackId));
          expect(track?.folderId).toBe(final);

          // A folder that is not there, or that only a guess would find, is told to whoever
          // started the run, which carries on.
          const told = await db
            .select({ text: schema.notifications.text, detail: schema.notifications.detail })
            .from(schema.notifications)
            .where(
              and(
                eq(schema.notifications.userId, s.ids.owner),
                eq(schema.notifications.kind, "workflow"),
              ),
            );
          expect(told.sort((a, b) => a.text.localeCompare(b.text))).toEqual([
            {
              text: "Guess could not move Maple Leaf Rag",
              detail:
                "Several folders are called MASTERS; the stage must name one exactly as it is written.",
            },
            {
              text: "Put it away could not move Maple Leaf Rag",
              detail: "The project has no folder Nowhere.",
            },
          ]);
          const states = (
            (await (await getAs(`/api/tracks/${s.trackId}/workflow-runs`, s.owner)).json()) as {
              runs: { state: string }[];
            }
          ).runs.map((r) => r.state);
          expect(states).toEqual(["finished", "finished"]);
        });

        it("tells whoever started the run when a stage's review cannot be asked (#25)", async () => {
          const s = await studio();
          const definition = {
            nodes: [
              { id: "start", type: "upload", name: "A version is uploaded", x: 0, y: 0 },
              {
                id: "ask",
                type: "feedback",
                name: "Soloists",
                x: 1,
                y: 0,
                config: { who: "Soloists" },
              },
              { id: "done", type: "finish", name: "Done", x: 2, y: 0 },
            ],
            connectors: [
              { id: "1", from: "start", outcome: "happened", to: "ask" },
              { id: "2", from: "ask", outcome: "done", to: "done" },
            ],
          };
          const made = (await (
            await app.request(
              `/api/projects/${s.projectId}/workflows`,
              json({ name: "Soloists", definition }, s.owner),
            )
          ).json()) as { workflow: { id: string } };
          await app.request(`/api/workflows/${made.workflow.id}`, {
            ...json({ active: true }, s.owner),
            method: "PATCH",
          });
          await app.request(
            `/api/tracks/${s.trackId}/versions`,
            json({ variations: [{ fileId: s.artwork, name: "Mix" }] }, s.owner),
          );
          const told = await db
            .select({ text: schema.notifications.text, detail: schema.notifications.detail })
            .from(schema.notifications)
            .where(
              and(
                eq(schema.notifications.userId, s.ids.owner),
                eq(schema.notifications.kind, "workflow"),
              ),
            );
          expect(told).toEqual([
            {
              text: "Soloists could not ask for its review",
              detail:
                "No role, group or guest of the project is called Soloists. It waits to be ended by hand.",
            },
          ]);
        });

        it("ends a checks stage by the quality reports of its version (#25)", async () => {
          const s = await studio();
          const at = (id: string, type: string, name: string, x: number, config = {}) => ({
            id,
            type,
            name,
            x,
            y: 0,
            config,
          });
          const definition = {
            nodes: [
              at("start", "upload", "A version is uploaded", 0),
              at("qa", "checks", "Delivery checks", 1),
              at("ok", "finish", "Clean", 2, { status: "Clean" }),
              at("warn", "finish", "Warned", 2, { status: "Warned" }),
              at("bad", "finish", "Rejected", 2, { status: "Rejected" }),
            ],
            connectors: [
              { id: "1", from: "start", outcome: "happened", to: "qa" },
              { id: "2", from: "qa", outcome: "passed", to: "ok" },
              { id: "3", from: "qa", outcome: "warnings", to: "warn" },
              { id: "4", from: "qa", outcome: "failed", to: "bad" },
            ],
          };
          const made = (await (
            await app.request(
              `/api/projects/${s.projectId}/workflows`,
              json({ name: "Delivery", definition }, s.owner),
            )
          ).json()) as { workflow: { id: string } };
          await app.request(`/api/workflows/${made.workflow.id}`, {
            ...json({ active: true }, s.owner),
            method: "PATCH",
          });
          const recording = async (name: string) => {
            const blob = await storage.put(s.organisationId, Buffer.from(name));
            const [file] = await db
              .insert(schema.files)
              .values({
                organisationId: s.organisationId,
                projectId: s.projectId,
                name,
                kind: "audio",
                blobId: blob.id,
                contentType: "audio/wav",
                byteSize: blob.byteSize,
                streamStatus: "pending",
                analysisStatus: "pending",
                mediaInfo: {
                  duration: 60,
                  audio: { codec: "pcm_s24le", channels: 2, sampleRate: 48000, bitDepth: 24 },
                } as never,
              })
              .returning();
            return file?.id ?? "";
          };
          const newVersion = (fileId: string) =>
            app.request(
              `/api/tracks/${s.trackId}/versions`,
              json({ variations: [{ fileId, name: "Mix" }] }, s.owner),
            );
          const latest = async () => {
            const [run] = (
              (await (await getAs(`/api/tracks/${s.trackId}/workflow-runs`, s.owner)).json()) as {
                runs: {
                  state: string;
                  status: string | null;
                  waiting: { nodeId: string }[];
                  steps: {
                    nodeId: string | null;
                    outcome: string | null;
                    byUserId: string | null;
                  }[];
                }[];
              }
            ).runs;
            return run;
          };
          const runner = { db, jobs };

          // Still being measured: the stage waits, and hearing of another file changes nothing.
          const warned = await recording("Mix v2.wav");
          await newVersion(warned);
          expect(await latest()).toMatchObject({ state: "running", waiting: [{ nodeId: "qa" }] });
          await fileMeasured(runner, { organisationId: s.organisationId, fileId: s.artwork });
          expect((await latest())?.state).toBe("running");

          // Measured, with a warning: the stage ends by it, done by Hekate rather than a person.
          await db.insert(schema.qaFindings).values({
            organisationId: s.organisationId,
            fileId: warned,
            check: "loudness",
            severity: "warn",
            summary: "Louder than the profile allows",
            details: {},
          });
          await db
            .update(schema.files)
            .set({ analysisStatus: "ready" })
            .where(eq(schema.files.id, warned));
          await fileMeasured(runner, { organisationId: s.organisationId, fileId: warned });
          let run = await latest();
          expect(run).toMatchObject({ state: "finished", status: "Warned" });
          expect(run?.steps.at(-1)).toMatchObject({
            nodeId: "qa",
            outcome: "warnings",
            byUserId: null,
          });

          // A version with nothing to check (a score) passes at once.
          const blob = await storage.put(s.organisationId, Buffer.from("score"));
          const [score] = await db
            .insert(schema.files)
            .values({
              organisationId: s.organisationId,
              projectId: s.projectId,
              name: "Score.pdf",
              kind: "document",
              blobId: blob.id,
              contentType: "application/pdf",
              byteSize: blob.byteSize,
            })
            .returning();
          await newVersion(score?.id ?? "");
          expect(await latest()).toMatchObject({ state: "finished", status: "Clean" });

          // One that cannot be measured fails; the hourly sweep ends it where no job did.
          const broken = await recording("Mix v4.wav");
          await newVersion(broken);
          expect((await latest())?.state).toBe("running");
          expect(await sweepRuns(runner)).toBe(0);
          await db
            .update(schema.files)
            .set({ analysisStatus: "failed" })
            .where(eq(schema.files.id, broken));
          expect(await sweepRuns(runner)).toBe(1);
          run = await latest();
          expect(run).toMatchObject({ state: "finished", status: "Rejected" });
          expect(run?.steps.at(-1)).toMatchObject({ nodeId: "qa", outcome: "failed" });
        });

        it("reads a version's edit decision list and says which take each edit comes from (#56)", async () => {
          const s = await studio();
          const upload = async (name: string, body: string, mediaInfo?: unknown) => {
            const blob = await storage.put(s.organisationId, Buffer.from(body));
            const [row] = await db
              .insert(schema.files)
              .values({
                organisationId: s.organisationId,
                projectId: s.projectId,
                name,
                kind: mediaInfo ? "audio" : "document",
                blobId: blob.id,
                contentType: mediaInfo ? "audio/wav" : "text/plain",
                byteSize: blob.byteSize,
                ...(mediaInfo ? { mediaInfo: mediaInfo as never } : {}),
              })
              .returning();
            return row?.id ?? "";
          };
          const url = `/api/tracks/${s.trackId}/edit-decisions`;
          type Read = {
            decisions: {
              version: { number: number };
              fps: number;
              uses: { takeId: string | null; from: number | null; bars: number[] | null }[];
            } | null;
          };
          // No list yet: nothing to say.
          expect(((await (await getAs(url, s.composer)).json()) as Read).decisions).toBeNull();

          // Take 12 starts at 10:00:00:00 (its time reference, at 48 kHz), and has bars 1 to 30.
          const twelve = await upload("Take 12.wav", "pcm", {
            duration: 60,
            audio: { sampleRate: 48_000 },
            metadata: { bext: { timeReference: 36_000 * 48_000 } },
          });
          const added = (await (
            await app.request(
              `/api/tracks/${s.trackId}/takes`,
              json({ fileIds: [twelve] }, s.engineer),
            )
          ).json()) as { takes: { id: string }[] };
          const takeId = added.takes[0]?.id ?? "";
          await app.request(`/api/takes/${takeId}`, {
            ...json({ barFrom: 1, barTo: 30 }, s.engineer),
            method: "PATCH",
          });
          const list = await upload(
            "V2.edl",
            [
              "TITLE: V2",
              "FCM: NON-DROP FRAME",
              "001  TAKE12   AA     C        10:00:10:00 10:00:20:00 01:00:00:00 01:00:10:00",
              "* FROM CLIP NAME: Take 12.wav",
              "002  ELSEWHER AA     C        00:00:00:00 00:00:02:00 01:00:10:00 01:00:12:00",
            ].join("\n"),
          );
          // Given to the latest version after it was made, by someone who may organise.
          const [latest] = await db
            .select({ id: schema.versions.id })
            .from(schema.versions)
            .where(eq(schema.versions.trackId, s.trackId))
            .orderBy(desc(schema.versions.number))
            .limit(1);
          const attach = (fileId: string | null, cookie = s.owner) =>
            app.request(`/api/versions/${latest?.id}/edl`, {
              ...json({ fileId }, cookie),
              method: "PUT",
            });
          expect((await attach(list, s.composer)).status).toBe(403);
          expect((await attach(twelve)).status).toBe(422);
          expect((await attach(list)).status).toBe(200);

          const read = (await (await getAs(url, s.composer)).json()) as Read;
          expect(read.decisions).toMatchObject({ fps: 25 });
          // Ten seconds into a minute of 30 bars, for ten seconds: bars 6 to 10.
          expect(read.decisions?.uses).toEqual([
            expect.objectContaining({ takeId, from: 10, bars: [6, 10] }),
            expect.objectContaining({ takeId: null }),
          ]);
          // At a rate asked for; one it cannot be is refused.
          expect(
            ((await (await getAs(`${url}?rate=30`, s.composer)).json()) as Read).decisions?.fps,
          ).toBe(30);
          expect((await getAs(`${url}?rate=26`, s.composer)).status).toBe(400);
          // Taken off again, there is nothing to say.
          expect((await attach(null)).status).toBe(200);
          expect(((await (await getAs(url, s.composer)).json()) as Read).decisions).toBeNull();
          expect((await attach(list)).status).toBe(200);

          // A member outside the project finds nothing, nor as the owner of another workspace.
          const outsider = await joinAs(s.owner, "outsider-edl@example.test");
          expect((await getAs(url, outsider)).status).toBe(404);
          const [other] = await db
            .insert(schema.organisations)
            .values({ name: "Saltmarsh Films", slug: "saltmarsh-edl" })
            .returning({ id: schema.organisations.id });
          const outsiderId = (
            (await (await getAs("/api/me", outsider)).json()) as { user: { id: string } }
          ).user.id;
          await db
            .insert(schema.members)
            .values({ organisationId: other?.id ?? "", userId: outsiderId, role: "owner" });
          expect(
            (
              await app.request("/api/me/organisation", {
                ...json({ organisationId: other?.id }, outsider),
                method: "PUT",
              })
            ).status,
          ).toBe(200);
          expect((await getAs(url, outsider)).status).toBe(404);
        });

        it("tells a track's followers of new versions, if they can still see it", async () => {
          const s = await studio();
          // The owner made the track, so follows it; the composer chooses to.
          expect(
            (
              await app.request(
                "/api/notifications/follows",
                json({ trackId: s.trackId }, s.composer),
              )
            ).status,
          ).toBe(204);
          // A member without a role in the project cannot follow what they cannot see.
          const newcomer = await joinAs(s.owner, "newcomer@example.test");
          expect(
            (
              await app.request(
                "/api/notifications/follows",
                json({ trackId: s.trackId }, newcomer),
              )
            ).status,
          ).toBe(404);
          const follows = (await (
            await getAs("/api/notifications/follows", s.composer)
          ).json()) as {
            follows: { id: string; name: string; projectName: string }[];
          };
          expect(follows.follows).toMatchObject([{ name: "Maple Leaf Rag" }]);

          await app.request(
            `/api/tracks/${s.trackId}/versions`,
            json({ variations: [{ fileId: s.artwork, name: "Mix" }] }, s.engineer),
          );
          for (const cookie of [s.owner, s.composer]) {
            expect((await inbox(cookie)).notifications[0]).toMatchObject({
              kind: "version",
              actorName: "engineer",
              text: "added version 2 of Maple Leaf Rag",
            });
          }
          expect((await inbox(newcomer)).notifications).toEqual([]);

          // A follow outlives the composer's access to the project, but no longer shows it.
          const composerId = s.ids.composer;
          await db
            .delete(schema.projectMembers)
            .where(
              and(
                eq(schema.projectMembers.projectId, s.projectId),
                eq(schema.projectMembers.userId, composerId),
              ),
            );
          const hidden = (await (await getAs("/api/notifications/follows", s.composer)).json()) as {
            follows: unknown[];
          };
          expect(hidden.follows).toEqual([]);

          const id = follows.follows[0]?.id;
          expect(
            (
              await app.request(`/api/notifications/follows/${id}`, {
                method: "DELETE",
                headers: { cookie: s.owner },
              })
            ).status,
          ).toBe(404);
          expect(
            (
              await app.request(`/api/notifications/follows/${id}`, {
                method: "DELETE",
                headers: { cookie: s.composer },
              })
            ).status,
          ).toBe(204);
        });

        it("tells an uploader once when processing fails", async () => {
          const s = await studio();
          const ownerId = (
            await db
              .select({ id: schema.users.id })
              .from(schema.users)
              .where(eq(schema.users.email, "producer@example.test"))
          )[0]?.id;
          await db
            .update(schema.files)
            .set({ uploadedBy: ownerId ?? null })
            .where(eq(schema.files.id, s.mix));
          // Two jobs failing on the same file at once still tell the uploader once.
          await Promise.all([
            tellProcessingFailed(db, s.organisationId, s.mix),
            tellProcessingFailed(db, s.organisationId, s.mix),
          ]);
          await tellProcessingFailed(db, s.organisationId, s.mix);
          const failed = (await inbox(s.owner)).notifications.filter(
            (n) => n.kind === "processing_failed",
          );
          expect(failed).toHaveLength(1);
          expect(failed[0]).toMatchObject({
            actorName: null,
            text: "Mix v1.wav could not be processed",
          });
        });

        it("gathers digests and sends instant mail once", async () => {
          const s = await studio();
          await put(
            "/api/notifications/preferences",
            { mailMode: "digest", digest: "hourly", kinds: {} },
            s.composer,
          );
          mailer.sent.length = 0;
          for (const title of ["Digest one", "Digest two"]) {
            await request(s.owner, s.projectId, {
              kind: "feedback",
              title,
              items: [{ trackId: s.trackId }],
              reviewers: [s.ids.composer],
            });
          }
          expect(mailer.sent).toEqual([]);
          const later = new Date(Date.now() + 60_000);
          expect(await deliverDigests(db, mailer, "http://localhost:3000", later)).toBe(1);
          expect(mailer.sent).toHaveLength(1);
          expect(mailer.sent[0]).toMatchObject({
            to: "composer@example.test",
            subject: "2 updates in Studio",
          });
          expect(mailer.sent[0]?.text).toContain(
            'Producer asks you to give feedback on "Digest two"',
          );
          expect(await deliverDigests(db, mailer, "http://localhost:3000", later)).toBe(0);

          // An instant mail that could not go at once goes on the next run, and only once.
          await db.insert(schema.notifications).values({
            organisationId: s.organisationId,
            userId: s.ids.accompanist,
            kind: "decision",
            actorName: "Producer",
            text: "approved something",
            link: "/reviews/x",
            mailMode: "instant",
          });
          mailer.sent.length = 0;
          // Two runs at once send it once between them.
          const [a, b] = await Promise.all([
            deliverInstant(db, mailer, "http://localhost:3000", later),
            deliverInstant(db, mailer, "http://localhost:3000", later),
          ]);
          expect(a + b).toBe(1);
          expect(await deliverInstant(db, mailer, "http://localhost:3000", later)).toBe(0);
          expect(mailer.sent.map((m) => m.to)).toEqual(["accompanist@example.test"]);
        });
      });

      it("asks reviewers in turn, logs every decision, and settles under the all rule", async () => {
        const s = await studio();
        mailer.sent.length = 0;
        const created = await request(s.owner, s.projectId, {
          kind: "approval",
          title: "Album master",
          message: "Final masters, please.",
          order: "sequence",
          items: [{ trackId: s.trackId }, { fileId: s.artwork }],
          reviewers: [s.ids.composer, s.ids.accompanist],
        });
        expect(created.status).toBe(201);
        const review = await reviewOf(created);
        expect(review.items.map((i) => i.kind)).toEqual(["track", "file"]);
        expect(review.items[0]?.fileId).toBe(s.mix);
        expect(review.items[0]?.version?.number).toBe(1);
        expect(review.reviewers.map((r) => r.state)).toEqual(["invited", "waiting"]);
        // Only the first in the sequence is asked.
        expect(mailer.sent.map((m) => m.to)).toEqual(["composer@example.test"]);
        expect(mailer.sent[0]?.text).toContain(`/reviews/${review.id}`);

        const path = `/api/reviews/${review.id}`;
        // Not the accompanist's turn yet.
        expect(
          (await app.request(`${path}/decisions`, json({ decision: "approved" }, s.accompanist)))
            .status,
        ).toBe(409);
        const viewed = await reviewOf(await app.request(`${path}/viewed`, json({}, s.composer)));
        expect(viewed.reviewers[0]?.state).toBe("viewed");
        mailer.sent.length = 0;
        const approved = await reviewOf(
          await app.request(`${path}/decisions`, json({ decision: "approved" }, s.composer)),
        );
        expect(approved.reviewers.map((r) => r.state)).toEqual(["submitted", "invited"]);
        // The next reviewer is asked, and whoever asked hears of the decision.
        expect(mailer.sent.map((m) => m.to)).toEqual([
          "accompanist@example.test",
          "producer@example.test",
        ]);
        // The workspace's subject line for a decision, and who decided at the top.
        expect(mailer.sent[1]?.subject).toBe("Album master: approved");
        expect(mailer.sent[1]?.text).toContain('composer approved "Album master"');
        expect(mailer.sent[1]?.html).toContain("See the review");
        const done = await reviewOf(
          await app.request(
            `${path}/decisions`,
            json({ decision: "changes_requested", note: "Bar 32 is clipped" }, s.accompanist),
          ),
        );
        expect(done).toMatchObject({ status: "completed", outcome: "changes_requested" });
        expect(done.decisions.map((d) => d.decision)).toEqual(["changes_requested", "approved"]);
        expect(
          (await app.request(`${path}/decisions`, json({ decision: "approved" }, s.composer)))
            .status,
        ).toBe(409);
        // The access log has both decisions; the decision log refuses to be rewritten.
        const logged = await audit.query(s.organisationId, {
          action: "review.decision",
          limit: 10,
        });
        expect(logged.events).toHaveLength(2);
        await expect(
          db.execute(sql`update review_decisions set decision = 'approved'`),
        ).rejects.toThrow();
        await expect(db.execute(sql`delete from review_decisions`)).rejects.toThrow();
        // Decisions leave only with their review.
        await db.delete(schema.reviews).where(eq(schema.reviews.organisationId, s.organisationId));
        expect(
          await db
            .select()
            .from(schema.reviewDecisionLog)
            .where(eq(schema.reviewDecisionLog.organisationId, s.organisationId)),
        ).toEqual([]);
      });

      it("settles on one approval under the any rule, and lets a reviewer change their mind", async () => {
        const s = await studio();
        const review = await reviewOf(
          await request(s.owner, s.projectId, {
            kind: "approval",
            title: "Mix",
            rule: "any",
            items: [{ trackId: s.trackId }],
            reviewers: [s.ids.composer, s.ids.accompanist],
          }),
        );
        const path = `/api/reviews/${review.id}/decisions`;
        const first = await reviewOf(
          await app.request(path, json({ decision: "changes_requested" }, s.composer)),
        );
        expect(first.status).toBe("open");
        // Changing a decision adds to the record; it does not replace it.
        const changed = await reviewOf(
          await app.request(path, json({ decision: "approved" }, s.composer)),
        );
        expect(changed).toMatchObject({ status: "completed", outcome: "approved" });
        expect(changed.decisions).toHaveLength(2);
      });

      it("categorises, defers, assigns and resolves threads in triage, and sends the list", async () => {
        const s = await studio();
        type Category = { id: string; name: string; handling: string; stage: string | null };
        const categories = async (cookie = s.owner) =>
          (
            (await (await getAs(`/api/projects/${s.projectId}/categories`, cookie)).json()) as {
              categories: Category[];
            }
          ).categories;
        // A project has the defaults, once, whoever reads them first.
        const first = await categories(s.composer);
        expect(first.map((c) => c.name)).toEqual([
          "Noise",
          "Edit",
          "Balance",
          "Performance",
          "Information",
        ]);
        expect(await categories()).toHaveLength(5);
        const noise = first.find((c) => c.name === "Noise");
        expect(noise).toMatchObject({ handling: "deferred", stage: "Noise reduction" });
        // Adding one is for those who edit workflows, and names are the project's own.
        const add = (body: unknown, cookie: string) =>
          app.request(`/api/projects/${s.projectId}/categories`, json(body, cookie));
        expect((await add({ name: "Pitch", handling: "normal" }, s.engineer)).status).toBe(403);
        const pitch = await add({ name: "Pitch", handling: "normal" }, s.owner);
        expect(pitch.status).toBe(201);
        const pitchId = ((await pitch.json()) as { category: { id: string } }).category.id;
        expect((await add({ name: "pitch", handling: "normal" }, s.owner)).status).toBe(409);
        // Changing or removing one is theirs too.
        const change = (method: string, id: string, cookie: string, body?: unknown) =>
          app.request(`/api/categories/${id}`, {
            ...(body === undefined ? { headers: { cookie } } : json(body, cookie)),
            method,
          });
        const tuning = { name: "Tuning", handling: "information" };
        expect((await change("PATCH", pitchId, s.engineer, tuning)).status).toBe(403);
        expect((await change("PATCH", pitchId, s.owner, tuning)).status).toBe(200);
        expect((await change("DELETE", pitchId, s.engineer)).status).toBe(403);
        expect((await change("DELETE", pitchId, s.owner)).status).toBe(204);
        expect(await categories()).toHaveLength(5);

        const thread = async (body: string, fileId = s.mix) =>
          (
            (await (
              await app.request(`/api/files/${fileId}/comments`, json({ body }, s.owner))
            ).json()) as {
              comment: { id: string };
            }
          ).comment.id;
        const hiss = await thread("Hiss under the intro.");
        const late = await thread("The left hand is late at bar 9.");
        const elsewhere = await thread("The cover is too dark.", s.artwork);
        type Thread = {
          id: string;
          categoryId: string | null;
          deferredTo: string | null;
          assigneeId: string | null;
          resolvedAt: string | null;
        };
        const triage = (body: Record<string, unknown>, cookie = s.engineer) =>
          app.request(`/api/files/${s.mix}/comments/triage`, json(body, cookie));
        const threads = async (res: Response) => {
          expect(res.status).toBe(200);
          return ((await res.json()) as { comments: Thread[] }).comments;
        };
        // A reviewer may not triage; a thread from another file is not this file's to triage.
        expect((await triage({ commentIds: [hiss], resolved: true }, s.composer)).status).toBe(403);
        expect((await triage({ commentIds: [elsewhere], resolved: true })).status).toBe(422);
        expect(
          (await triage({ commentIds: [hiss], categoryId: "0190a6f0-0000-7000-8000-00000000000a" }))
            .status,
        ).toBe(422);
        // Noise defers to its stage; a selection is assigned together.
        let now = await threads(await triage({ commentIds: [hiss], categoryId: noise?.id }));
        expect(now.find((t) => t.id === hiss)).toMatchObject({
          categoryId: noise?.id,
          deferredTo: "Noise reduction",
        });
        now = await threads(await triage({ commentIds: [hiss, late], assigneeId: s.ids.engineer }));
        expect(
          now
            .filter((t) => t.assigneeId === s.ids.engineer)
            .map((t) => t.id)
            .sort(),
        ).toEqual([hiss, late].sort());
        expect((await triage({ commentIds: [late], assigneeId: "someone-else" })).status).toBe(422);
        // Undeferred by hand, and the list sent to whoever it is assigned to.
        now = await threads(await triage({ commentIds: [hiss], deferredTo: null }));
        expect(now.find((t) => t.id === hiss)?.deferredTo).toBeNull();
        const sent = await app.request(
          `/api/files/${s.mix}/comments/send-list`,
          json({ userId: s.ids.engineer }, s.owner),
        );
        expect(await sent.json()).toEqual({ sent: 2 });
        const told = await db
          .select({ text: schema.notifications.text, detail: schema.notifications.detail })
          .from(schema.notifications)
          .where(
            and(
              eq(schema.notifications.kind, "assigned"),
              eq(schema.notifications.userId, s.ids.engineer),
            ),
          );
        expect(told[0]?.text).toBe("sent you 2 comments to act on, on Mix v1.wav");
        expect(told[0]?.detail).toContain("- Hiss under the intro.");
        // A list sent to yourself would never arrive: it is refused.
        expect(
          (
            await app.request(
              `/api/files/${s.mix}/comments/send-list`,
              json({ userId: await idOf(s.owner) }, s.owner),
            )
          ).status,
        ).toBe(422);
        // Resolved threads leave the list.
        await triage({ commentIds: [hiss, late], resolved: true });
        expect(
          (
            await app.request(
              `/api/files/${s.mix}/comments/send-list`,
              json({ userId: s.ids.engineer }, s.owner),
            )
          ).status,
        ).toBe(422);

        // Another workspace's project, categories and files do not exist from here.
        const [other] = await db
          .insert(schema.organisations)
          .values({ name: "Elsewhere", slug: "elsewhere-categories" })
          .returning();
        const otherOrg = other?.id ?? "";
        const [theirProject] = await db
          .insert(schema.projects)
          .values({ organisationId: otherOrg, name: "Theirs", profile: "music" })
          .returning();
        const [theirCategory] = await db
          .insert(schema.commentCategories)
          .values({ organisationId: otherOrg, projectId: theirProject?.id ?? "", name: "Noise" })
          .returning();
        const blob = await storage.put(otherOrg, Buffer.from("theirs"));
        const [theirFile] = await db
          .insert(schema.files)
          .values({
            organisationId: otherOrg,
            projectId: theirProject?.id ?? "",
            name: "Theirs.wav",
            kind: "audio",
            blobId: blob.id,
            contentType: "audio/wav",
            byteSize: blob.byteSize,
          })
          .returning();
        expect((await getAs(`/api/projects/${theirProject?.id}/categories`, s.owner)).status).toBe(
          404,
        );
        expect((await change("PATCH", theirCategory?.id ?? "", s.owner, tuning)).status).toBe(404);
        expect((await change("DELETE", theirCategory?.id ?? "", s.owner)).status).toBe(404);
        expect(
          (
            await app.request(
              `/api/files/${theirFile?.id}/comments/triage`,
              json({ commentIds: [hiss], resolved: true }, s.owner),
            )
          ).status,
        ).toBe(404);

        // A thread can take its category as it is made (#43), as when a finding becomes a
        // comment: for those who triage, from this project, and never on a reply.
        const create = (body: Record<string, unknown>, cookie: string) =>
          app.request(`/api/files/${s.mix}/comments`, json(body, cookie));
        const made = await create({ body: "Clipped at 0:12.", categoryId: noise?.id }, s.engineer);
        expect(made.status).toBe(201);
        expect(((await made.json()) as { comment: Thread }).comment).toMatchObject({
          categoryId: noise?.id,
          deferredTo: "Noise reduction",
        });
        expect((await create({ body: "Hiss.", categoryId: noise?.id }, s.composer)).status).toBe(
          403,
        );
        expect(
          (await create({ body: "Hiss.", categoryId: theirCategory?.id }, s.engineer)).status,
        ).toBe(422);
        expect(
          (await create({ body: "Hiss.", parentId: hiss, categoryId: noise?.id }, s.engineer))
            .status,
        ).toBe(400);
        // Without one, it is as it always was.
        expect((await create({ body: "Hiss.", categoryId: null }, s.composer)).status).toBe(201);

        // A thread can be about one channel (#74): one the recording has, never on a reply.
        await db
          .update(schema.files)
          .set({
            mediaInfo: { duration: 40, audio: { channels: 2, channelLayout: "stereo" } } as never,
          })
          .where(eq(schema.files.id, s.mix));
        const left = await create({ body: "Pedal noise on the left.", channel: 0 }, s.composer);
        expect(left.status).toBe(201);
        expect(
          ((await left.json()) as { comment: { channel: number | null } }).comment.channel,
        ).toBe(0);
        expect((await create({ body: "On the third?", channel: 2 }, s.composer)).status).toBe(422);
        expect(
          (await create({ body: "And here.", parentId: hiss, channel: 1 }, s.composer)).status,
        ).toBe(400);
        const listed = (await (await getAs(`/api/files/${s.mix}/comments`, s.composer)).json()) as {
          comments: { id: string; body: string; channel: number | null }[];
        };
        expect(listed.comments.find((t) => t.body === "Pedal noise on the left.")?.channel).toBe(0);
        // An export names it.
        const sheet = await (
          await getAs(`/api/files/${s.mix}/comments/export?target=csv&threads=all`, s.owner)
        ).text();
        expect(sheet).toMatch(/\[L\] [^,]+: Pedal noise on the left\.,.*,Whole file,Open,L\r\n/);
        // Carried to a version laid out the other way round, it is about the same speaker; to a
        // mono one, about every channel.
        const leftId = listed.comments.find((t) => t.body === "Pedal noise on the left.")?.id ?? "";
        await db.insert(schema.commentCarries).values({
          organisationId: s.organisationId,
          commentId: leftId,
          fileId: s.artwork,
        });
        const carriedChannel = async (audio: Record<string, unknown>) => {
          await db
            .update(schema.files)
            .set({ mediaInfo: { duration: 40, audio } as never })
            .where(eq(schema.files.id, s.artwork));
          const there = (await (
            await getAs(`/api/files/${s.artwork}/comments`, s.composer)
          ).json()) as { comments: { id: string; channel: number | null }[] };
          return there.comments.find((t) => t.id === leftId)?.channel;
        };
        expect(await carriedChannel({ channels: 2, channelLayout: "FR+FL" })).toBe(1);
        expect(await carriedChannel({ channels: 1, channelLayout: "mono" })).toBeNull();
        // A mono recording has no channel to be about.
        await db
          .update(schema.files)
          .set({ mediaInfo: { duration: 40, audio: { channels: 1 } } as never })
          .where(eq(schema.files.id, s.mix));
        expect((await create({ body: "On the left?", channel: 0 }, s.composer)).status).toBe(422);
      });

      it("imports a marker list as comments, for those who triage, saying where they came from", async () => {
        const s = await studio();
        const categories = (
          (await (await getAs(`/api/projects/${s.projectId}/categories`, s.owner)).json()) as {
            categories: { id: string; name: string }[];
          }
        ).categories;
        const noise = categories.find((k) => k.name === "Noise")?.id;
        const send = (body: unknown, cookie = s.owner, fileId = s.mix) =>
          app.request(`/api/files/${fileId}/comments/import`, json(body, cookie));
        const list = {
          listName: "Maple V2 markers.txt",
          authorId: s.ids.composer,
          markers: [
            { start: 6.2, end: null, body: "Pedal noise", categoryId: noise },
            { start: 17.6, end: 19.6, body: "Keep the rubato" },
            { start: null, end: null, body: "Lovely overall" },
          ],
        };
        // Reviewers may comment, but importing is triage's.
        expect((await send(list, s.composer)).status).toBe(403);
        // Times past the end, and authors and categories from elsewhere, are refused.
        const past = await send({
          ...list,
          markers: [{ start: 75, end: null, body: "Too late" }],
        });
        expect(past.status).toBe(422);
        expect(await past.text()).toContain("Marker 1");
        expect((await send({ ...list, authorId: "someone-else" })).status).toBe(422);
        expect(
          (
            await send({
              ...list,
              markers: [{ start: 1, end: null, body: "Hiss", categoryId: crypto.randomUUID() }],
            })
          ).status,
        ).toBe(422);
        expect(
          (await send({ ...list, markers: [{ start: 5, end: 4, body: "Backwards" }] })).status,
        ).toBe(400);

        const done = await send(list);
        expect(done.status).toBe(201);
        expect(await done.json()).toEqual({ imported: 3 });
        const listed = (await (await getAs(`/api/files/${s.mix}/comments`, s.owner)).json()) as {
          comments: {
            body: string;
            authorId: string | null;
            anchor: unknown;
            categoryId: string | null;
            importedFrom: string | null;
            importedByName: string | null;
          }[];
        };
        const pedal = listed.comments.find((t) => t.body === "Pedal noise");
        expect(pedal).toMatchObject({
          authorId: s.ids.composer,
          anchor: { kind: "time", start: 6.2, end: 6.2 },
          categoryId: noise,
          importedFrom: "Maple V2 markers.txt",
          importedByName: expect.any(String),
        });
        expect(listed.comments.find((t) => t.body === "Keep the rubato")?.anchor).toEqual({
          kind: "time",
          start: 17.6,
          end: 19.6,
        });
        expect(listed.comments.find((t) => t.body === "Lovely overall")?.anchor).toBeNull();
        const logged = await audit.query(s.organisationId, { action: "comment.import", limit: 5 });
        expect(logged.events[0]?.details).toMatchObject({
          list: "Maple V2 markers.txt",
          comments: 3,
        });
        // A member outside the project finds nothing; nor does the owner of another workspace.
        const outsider = await joinAs(s.owner, "outsider-marker-import@example.test");
        expect([403, 404]).toContain((await send(list, outsider)).status);
        const [other] = await db
          .insert(schema.organisations)
          .values({ name: "Saltmarsh Films", slug: "saltmarsh-marker-import" })
          .returning({ id: schema.organisations.id });
        const outsiderId = (
          (await (await getAs("/api/me", outsider)).json()) as { user: { id: string } }
        ).user.id;
        await db
          .insert(schema.members)
          .values({ organisationId: other?.id ?? "", userId: outsiderId, role: "owner" });
        await app.request("/api/me/organisation", {
          ...json({ organisationId: other?.id }, outsider),
          method: "PUT",
        });
        expect((await send(list, outsider)).status).toBe(404);
      });

      it("checks a new version before it lands, carries as chosen, and replaces a file keeping its threads", async () => {
        const s = await studio();
        const send = (method: string, url: string, body: unknown, cookie: string) =>
          app.request(url, { ...json(body, cookie), method });
        const audioFile = async (
          name: string,
          analysisStatus: "pending" | "ready" = "ready",
          content = name,
        ) => {
          const blob = await storage.put(s.organisationId, Buffer.from(content));
          const [row] = await db
            .insert(schema.files)
            .values({
              organisationId: s.organisationId,
              projectId: s.projectId,
              name,
              kind: name.endsWith(".edl") || name.endsWith(".txt") ? "document" : "audio",
              blobId: blob.id,
              contentType: "application/octet-stream",
              byteSize: blob.byteSize,
              analysisStatus,
              mediaInfo: name.endsWith(".wav")
                ? { duration: 60, audio: { codec: "pcm_s24le", channels: 2, sampleRate: 48000 } }
                : null,
            })
            .returning();
          return row?.id ?? "";
        };
        const measure = async (fileId: string, truePeak: number) => {
          const blob = await storage.put(s.organisationId, Buffer.from("series"));
          await db.insert(schema.loudness).values({
            organisationId: s.organisationId,
            fileId,
            summary: {
              integrated: -14,
              range: 6,
              momentaryMax: -8,
              shortTermMax: -10,
              truePeak,
              channels: [],
            },
            channels: 2,
            sampleRate: 48000,
            samplesPerFrame: 4800,
            frameCount: 600,
            blobId: blob.id,
          });
        };
        // Two threads on version 1, for the new version to carry as chosen.
        const thread = async (body: string) =>
          (
            (await (
              await app.request(`/api/files/${s.mix}/comments`, json({ body }, s.owner))
            ).json()) as {
              comment: { id: string };
            }
          ).comment.id;
        const hide = await thread("Hiss under the intro.");
        const fixed = await thread("Clipped at 1:12.");
        const carry = (await (
          await getAs(`/api/tracks/${s.trackId}/carry`, s.engineer)
        ).json()) as {
          threads: { commentId: string; variation: string; authorName: string }[];
        };
        expect(carry.threads.map((t) => t.commentId).sort()).toEqual([hide, fixed].sort());
        expect(carry.threads[0]?.variation).toBe("Mix");
        expect(carry.threads[0]?.authorName).toEqual(expect.any(String));
        expect((await getAs(`/api/tracks/${s.trackId}/carry`, s.composer)).status).toBe(403);

        expect(
          (
            await send(
              "PATCH",
              `/api/projects/${s.projectId}`,
              { checkTruePeak: true, requireEdl: true, deliveryProfile: "apple-digital-masters" },
              s.owner,
            )
          ).status,
        ).toBe(200);
        const v2 = await audioFile("Mix v2.wav", "pending");
        const add = (body: Record<string, unknown>, cookie = s.engineer) =>
          app.request(
            `/api/tracks/${s.trackId}/versions`,
            json({ variations: [{ fileId: v2, name: "Mix" }], ...body }, cookie),
          );
        // One edit, from the start of the timeline to a given timecode.
        const cut = (end: string) =>
          `TITLE: CUT\n001  T3       AA     C        00:00:00:00 ${end.replace("01:", "00:")} 01:00:00:00 ${end}\n`;
        // Still being measured: try again shortly.
        const edl = await audioFile("Cut.edl", "ready", cut("01:00:50:00"));
        const early = await add({ edlFileId: edl });
        expect(early.status).toBe(409);
        expect(((await early.json()) as { error: { code: string } }).error.code).toBe(
          "version_measuring",
        );
        // Measured, and over the ceiling, with no EDL: refused, saying why.
        await measure(v2, 0.2);
        const refused = await add({});
        expect(refused.status).toBe(422);
        const why = ((await refused.json()) as { error: { code: string; message: string } }).error;
        expect(why.code).toBe("version_refused");
        expect(why.message).toContain(
          "true peak +0.2 dBTP is over the \u22121.0 dBTP ceiling of Apple Digital Masters",
        );
        expect(why.message).toContain("asks for an edit decision list");
        // The list is read too (#56): one with no edits, or one running past the end of the
        // version (60 seconds here), is refused, saying which.
        const reasonFor = async (edlFileId: string) =>
          ((await (await add({ edlFileId })).json()) as { error: { message: string } }).error
            .message;
        expect(await reasonFor(await audioFile("Empty.edl"))).toContain(
          "could not read any edits in Empty.edl",
        );
        expect(await reasonFor(await audioFile("V3.edl", "ready", cut("01:01:30:00")))).toContain(
          "its edits run to 1:30, past the end of this version at 1:00",
        );
        expect(await reasonFor(edl)).not.toContain("edit decision list");
        // An engineer cannot let it through; an EDL must be an .edl file.
        expect((await add({ letThrough: true })).status).toBe(403);
        const notes = await audioFile("Cut.txt");
        expect((await add({ edlFileId: notes, letThrough: true }, s.owner)).status).toBe(422);
        // A producer can, on the record, with the EDL attached.
        const landed = await add(
          { edlFileId: edl, letThrough: true, carry: { [hide]: "hidden", [fixed]: "fixed" } },
          s.owner,
        );
        expect(landed.status).toBe(201);
        const [version] = await db
          .select()
          .from(schema.versions)
          .where(and(eq(schema.versions.trackId, s.trackId), eq(schema.versions.number, 2)));
        expect(version).toMatchObject({ edlFileId: edl, letThroughBy: s.ids.owner });
        const logged = await audit.query(s.organisationId, {
          action: "version.let_through",
          limit: 5,
        });
        expect(logged.events[0]?.details).toMatchObject({ checks: ["true_peak"] });
        // The carries: one hidden, one settled (and its thread resolved).
        const carried = await db
          .select()
          .from(schema.commentCarries)
          .where(eq(schema.commentCarries.fileId, v2));
        expect(carried.find((c) => c.commentId === hide)).toMatchObject({
          visible: false,
          status: "open",
        });
        expect(carried.find((c) => c.commentId === fixed)).toMatchObject({ status: "fixed" });
        const [settled] = await db
          .select()
          .from(schema.comments)
          .where(eq(schema.comments.id, fixed));
        expect(settled?.resolvedAt).not.toBeNull();

        // A corrected export replaces version 2's file; its threads move with it.
        const variation = (
          await db.select().from(schema.variations).where(eq(schema.variations.fileId, v2))
        )[0];
        const corrected = await audioFile("Mix v2 fixed.wav");
        const replace = (fileId: string, cookie = s.engineer) =>
          app.request(`/api/variations/${variation?.id}/replace`, json({ fileId }, cookie));
        expect((await replace(corrected, s.composer)).status).toBe(403);
        expect((await replace(notes)).status).toBe(422);
        expect((await replace(corrected)).status).toBe(200);
        expect(
          (
            await db
              .select()
              .from(schema.commentCarries)
              .where(eq(schema.commentCarries.fileId, corrected))
          ).length,
        ).toBe(2);
        const replaced = await audit.query(s.organisationId, {
          action: "variation.replace",
          limit: 5,
        });
        expect(replaced.events[0]?.details).toMatchObject({ replaced: v2 });

        // Changing the primary is for those who organise the project.
        const primary = (id: string, cookie: string) =>
          app.request(`/api/variations/${id}/primary`, json({}, cookie));
        expect((await primary(variation?.id ?? "", s.composer)).status).toBe(403);
        expect((await primary(variation?.id ?? "", s.owner)).status).toBe(200);

        // Another workspace's track and variations do not exist from here.
        const [elsewhere] = await db
          .insert(schema.organisations)
          .values({ name: "Elsewhere", slug: "elsewhere-versions" })
          .returning();
        const theirOrg = elsewhere?.id ?? "";
        const [theirProject] = await db
          .insert(schema.projects)
          .values({ organisationId: theirOrg, name: "Theirs", profile: "music" })
          .returning();
        const blob = await storage.put(theirOrg, Buffer.from("theirs"));
        const [theirFile] = await db
          .insert(schema.files)
          .values({
            organisationId: theirOrg,
            projectId: theirProject?.id ?? "",
            name: "Theirs.wav",
            kind: "audio",
            blobId: blob.id,
            contentType: "audio/wav",
            byteSize: blob.byteSize,
          })
          .returning();
        const [theirTrack] = await db
          .insert(schema.tracks)
          .values({ organisationId: theirOrg, projectId: theirProject?.id ?? "", name: "Theirs" })
          .returning();
        const [theirVersion] = await db
          .insert(schema.versions)
          .values({ organisationId: theirOrg, trackId: theirTrack?.id ?? "", number: 1 })
          .returning();
        const [theirVariation] = await db
          .insert(schema.variations)
          .values({
            organisationId: theirOrg,
            versionId: theirVersion?.id ?? "",
            fileId: theirFile?.id ?? "",
            name: "Mix",
            isPrimary: true,
          })
          .returning();
        expect((await getAs(`/api/tracks/${theirTrack?.id}/carry`, s.owner)).status).toBe(404);
        expect((await primary(theirVariation?.id ?? "", s.owner)).status).toBe(404);
        expect(
          (
            await app.request(
              `/api/variations/${theirVariation?.id}/replace`,
              json({ fileId: corrected }, s.owner),
            )
          ).status,
        ).toBe(404);
      });

      it("asks a step of several together, names itself, settles on a share, and keeps overrides", async () => {
        const s = await studio();
        const conductor = { name: "Mira Solberg", email: "conductor@example.test" };
        type Detailed = Omit<ReviewBody, "reviewers"> & {
          title: string;
          rule: string;
          share: number;
          remind: boolean;
          reviewers: (ReviewBody["reviewers"][number] & {
            step: number;
            permissions: { comments: string } | null;
          })[];
        };
        const created = await request(s.owner, s.projectId, {
          kind: "approval",
          order: "sequence",
          rule: "share",
          share: 66,
          remind: false,
          items: [{ trackId: s.trackId }, { fileId: s.artwork }],
          reviewers: [[s.ids.composer, s.ids.accompanist], conductor],
          overrides: { "guest:conductor@example.test": { comments: "own" } },
        });
        expect(created.status).toBe(201);
        const review = (await reviewOf(created)) as Detailed;
        // No title given: it is named after what it asks about.
        expect(review.title).toBe("Maple Leaf Rag and 1 more");
        expect(review).toMatchObject({ rule: "share", share: 66, remind: false });
        // The first step's two are asked together; the guest waits their turn.
        expect(review.reviewers.map((r) => [r.step, r.state])).toEqual([
          [0, "invited"],
          [0, "invited"],
          [1, "waiting"],
        ]);
        expect(review.reviewers.map((r) => r.permissions?.comments)).toEqual(["all", "all", "own"]);
        // The guest can be asked again from the project's list, by those who may ask.
        const known = await getAs(`/api/projects/${s.projectId}/guests`, s.owner);
        expect(((await known.json()) as { guests: { email: string }[] }).guests).toEqual([
          expect.objectContaining({ email: "conductor@example.test" }),
        ]);
        // A role that neither sees the people nor asks for reviews cannot list them.
        const listener = await app.request(
          `/api/projects/${s.projectId}/roles`,
          json({ name: "Listener", levels: levelsOf(["view"]) }, s.owner),
        );
        expect(listener.status).toBe(201);
        await grantRole(s.owner, s.projectId, s.composer, "Listener");
        expect((await getAs(`/api/projects/${s.projectId}/guests`, s.composer)).status).toBe(403);
        await grantRole(s.owner, s.projectId, s.composer, "Reviewer");
        // Another workspace's project does not exist from here.
        const [elsewhere] = await db
          .insert(schema.organisations)
          .values({ name: "Elsewhere", slug: "elsewhere-asked" })
          .returning();
        const [theirs] = await db
          .insert(schema.projects)
          .values({ organisationId: elsewhere?.id ?? "", name: "Theirs", profile: "music" })
          .returning();
        expect((await getAs(`/api/projects/${theirs?.id}/guests`, s.owner)).status).toBe(404);
        // Two of three is the share: both in the first step approving settles it.
        const path = `/api/reviews/${review.id}/decisions`;
        const one = await reviewOf(
          await app.request(path, json({ decision: "approved" }, s.composer)),
        );
        expect(one.status).toBe("open");
        const two = await reviewOf(
          await app.request(path, json({ decision: "approved" }, s.accompanist)),
        );
        expect(two).toMatchObject({ status: "completed", outcome: "approved" });
        // A share must be given with the rule, and an override must fit together.
        const refused = await request(s.owner, s.projectId, {
          kind: "approval",
          rule: "share",
          items: [{ trackId: s.trackId }],
          reviewers: [s.ids.composer],
        });
        expect(refused.status).toBe(400);
        const backwards = await request(s.owner, s.projectId, {
          kind: "feedback",
          items: [{ trackId: s.trackId }],
          reviewers: [s.ids.composer],
          overrides: {
            [`member:${s.ids.composer}`]: {
              startsAt: "2030-01-02T00:00:00Z",
              expiresAt: "2030-01-01T00:00:00Z",
            },
          },
        });
        expect(backwards.status).toBe(422);
        // Overrides that leave an approval nobody who may decide are refused.
        const undecided = await request(s.owner, s.projectId, {
          kind: "approval",
          items: [{ trackId: s.trackId }],
          reviewers: [s.ids.composer],
          overrides: { [`member:${s.ids.composer}`]: { decide: false } },
        });
        expect(undecided.status).toBe(422);
        // A guest who only follows an approval still gets the link they need to follow it.
        mailer.sent.length = 0;
        const followed = await request(s.owner, s.projectId, {
          kind: "approval",
          items: [{ trackId: s.trackId }],
          reviewers: [s.ids.composer, { name: "Tomas Varga", email: "follower@example.test" }],
          overrides: { "guest:follower@example.test": { decide: false } },
        });
        expect(followed.status).toBe(201);
        expect(((await reviewOf(followed)) as Detailed).reviewers.map((r) => r.state)).toEqual([
          "invited",
          "observing",
        ]);
        expect(mailer.sent.some((m) => m.to === "follower@example.test")).toBe(true);
      });

      it("starts each person on what the project's People page says for them (#55)", async () => {
        const s = await studio();
        const put = (path: string, body: unknown, cookie = s.owner) =>
          app.request(`/api/projects/${s.projectId}/reviewer-grants/${path}`, {
            ...json(body, cookie),
            method: "PUT",
          });
        const grants = async (cookie = s.owner) =>
          getAs(`/api/projects/${s.projectId}/reviewer-grants`, cookie);
        type Asked = {
          reviewers: { name: string; permissions: Record<string, unknown> | null }[];
        };
        // A guest first known through a review, which starts them on the defaults.
        const conductor = { name: "Mira Solberg", email: "conductor@example.test" };
        const first = await request(s.owner, s.projectId, {
          kind: "feedback",
          items: [{ trackId: s.trackId }],
          reviewers: [conductor],
        });
        expect(first.status).toBe(201);
        const known = (await (
          await getAs(`/api/projects/${s.projectId}/guests`, s.owner)
        ).json()) as {
          guests: { id: string }[];
        };
        const guestId = known.guests[0]?.id ?? "";

        // Only those who manage reviewers set it; nothing empty, nothing with dates.
        expect((await put(`guest/${guestId}`, { download: "proxy" }, s.composer)).status).toBe(403);
        expect((await grants(s.composer)).status).toBe(403);
        expect((await put(`guest/${guestId}`, {})).status).toBe(400);
        expect((await put(`guest/${guestId}`, { expiresAt: "2030-01-01T00:00:00Z" })).status).toBe(
          400,
        );
        // Nobody the workspace does not know, and no guest this project has not asked.
        expect((await put("member/nobody", { decide: false })).status).toBe(404);
        const [stranger] = await db
          .insert(schema.guests)
          .values({
            organisationId: s.organisationId,
            name: "Tomas Varga",
            email: "x@example.test",
          })
          .returning();
        expect((await put(`guest/${stranger?.id}`, { download: "proxy" })).status).toBe(404);

        expect(
          (await put(`guest/${guestId}`, { download: "proxy", tools: ["score"], maxPlays: 3 }))
            .status,
        ).toBe(204);
        expect((await put(`member/${s.ids.composer}`, { decide: false })).status).toBe(204);
        // Set again, it replaces what was there.
        expect(
          (await put(`guest/${guestId}`, { download: "proxy", tools: ["score", "loops"] })).status,
        ).toBe(204);
        expect(((await (await grants()).json()) as { grants: unknown[] }).grants).toHaveLength(2);

        // A new review starts each on theirs; the request's own override still wins.
        const second = await request(s.owner, s.projectId, {
          kind: "approval",
          items: [{ trackId: s.trackId }],
          reviewers: [s.ids.composer, s.ids.accompanist, conductor],
          overrides: { "guest:conductor@example.test": { tools: ["loops"] } },
        });
        expect(second.status).toBe(201);
        const asked = (await reviewOf(second)) as unknown as Asked & { id: string };
        const [composer, accompanist, guest] = asked.reviewers.map((r) => r.permissions);
        expect(composer).toMatchObject({ decide: false });
        expect(accompanist).toMatchObject({ decide: true });
        expect(guest).toMatchObject({ download: "proxy", tools: ["loops"], maxPlays: null });
        // Someone added later starts on theirs too.
        const singer = await joinAs(s.owner, "singer@example.test");
        await grantRole(s.owner, s.projectId, singer, "Reviewer");
        const singerId = await idOf(singer);
        expect((await put(`member/${singerId}`, { invite: true })).status).toBe(204);
        const added = await app.request(
          `/api/reviews/${asked.id}/reviewers`,
          json({ userId: singerId }, s.owner),
        );
        expect(added.status).toBeLessThan(300);
        const after = (await reviewOf(
          await getAs(`/api/reviews/${asked.id}`, s.owner),
        )) as unknown as Asked;
        expect(after.reviewers.at(-1)?.permissions).toMatchObject({ invite: true, decide: true });
        // Cleared, the defaults again; and the access log says who set what.
        expect(
          (
            await app.request(`/api/projects/${s.projectId}/reviewer-grants/guest/${guestId}`, {
              method: "DELETE",
              headers: { cookie: s.owner },
            })
          ).status,
        ).toBe(204);
        const third = await reviewOf(
          await request(s.owner, s.projectId, {
            kind: "feedback",
            items: [{ trackId: s.trackId }],
            reviewers: [conductor],
          }),
        );
        expect((third as unknown as Asked).reviewers[0]?.permissions).toMatchObject({
          download: "none",
        });
        const logged = (await (
          await getAs("/api/organisation/audit?action=project.reviewer_grant", s.owner)
        ).json()) as { events: { details: { grant: unknown } }[] };
        expect(logged.events.map((e) => e.details.grant)).toEqual([
          null,
          { invite: true },
          { download: "proxy", tools: ["score", "loops"] },
          { decide: false },
          { download: "proxy", tools: ["score"], maxPlays: 3 },
        ]);

        // Where the workspace lets nobody decide, the People page may let someone.
        expect(
          (
            await app.request("/api/organisation/settings", {
              ...json({ reviewer: { decide: false } }, s.owner),
              method: "PATCH",
            })
          ).status,
        ).toBe(200);
        const approval = (reviewers: string[]) =>
          request(s.owner, s.projectId, {
            kind: "approval",
            items: [{ trackId: s.trackId }],
            reviewers,
          });
        expect((await approval([s.ids.accompanist])).status).toBe(422);
        expect((await put(`member/${s.ids.accompanist}`, { decide: true })).status).toBe(204);
        const decided = await approval([s.ids.accompanist]);
        expect(decided.status).toBe(201);
        expect(
          ((await reviewOf(decided)) as unknown as Asked).reviewers[0]?.permissions,
        ).toMatchObject({ decide: true });

        // Another workspace's project has none to read or set.
        const [elsewhere] = await db
          .insert(schema.organisations)
          .values({ name: "Elsewhere", slug: "elsewhere-grants" })
          .returning();
        const [theirs] = await db
          .insert(schema.projects)
          .values({ organisationId: elsewhere?.id ?? "", name: "Theirs", profile: "music" })
          .returning();
        expect((await getAs(`/api/projects/${theirs?.id}/reviewer-grants`, s.owner)).status).toBe(
          404,
        );
        expect(
          (
            await app.request(
              `/api/projects/${theirs?.id}/reviewer-grants/member/${s.ids.composer}`,
              { ...json({ decide: false }, s.owner), method: "PUT" },
            )
          ).status,
        ).toBe(404);
      });

      it("completes feedback when everyone has submitted", async () => {
        const s = await studio();
        const review = await reviewOf(
          await request(s.owner, s.projectId, {
            kind: "feedback",
            title: "Rough mix",
            items: [{ fileId: s.mix }],
            reviewers: [s.ids.composer, s.ids.engineer],
          }),
        );
        const path = `/api/reviews/${review.id}`;
        expect(
          (await app.request(`${path}/decisions`, json({ decision: "approved" }, s.composer)))
            .status,
        ).toBe(409);
        const one = await reviewOf(await app.request(`${path}/submit`, json({}, s.composer)));
        expect(one.status).toBe("open");
        expect((await app.request(`${path}/submit`, json({}, s.composer))).status).toBe(409);
        const both = await reviewOf(await app.request(`${path}/submit`, json({}, s.engineer)));
        expect(both).toMatchObject({ status: "completed", outcome: "submitted" });
      });

      it("keeps reviews to those whose role allows them", async () => {
        const s = await studio();
        const base = { kind: "approval", title: "Mix", items: [{ trackId: s.trackId }] };
        // Engineers cannot request reviews; producers can.
        expect(
          (await request(s.engineer, s.projectId, { ...base, reviewers: [s.ids.composer] })).status,
        ).toBe(403);
        // Every reviewer must see the project.
        const outsider = await joinAs(s.owner, "outsider@example.test");
        expect(
          (await request(s.owner, s.projectId, { ...base, reviewers: [await idOf(outsider)] }))
            .status,
        ).toBe(422);
        // Items must come from this project.
        const other = await app.request(
          "/api/projects",
          json({ name: "Elite", profile: "music" }, s.owner),
        );
        const otherId = ((await other.json()) as { project: { id: string } }).project.id;
        expect(
          (await request(s.owner, otherId, { ...base, reviewers: [s.ids.composer] })).status,
        ).toBe(422);

        // An engineer may give feedback but cannot record a decision, so cannot review an approval.
        expect(
          (
            await request(s.owner, s.projectId, {
              ...base,
              reviewers: [s.ids.engineer, s.ids.composer],
            })
          ).status,
        ).toBe(422);
        const review = await reviewOf(
          await request(s.owner, s.projectId, { ...base, reviewers: [s.ids.composer] }),
        );
        const path = `/api/reviews/${review.id}`;
        expect(
          (await app.request(`${path}/reviewers`, json({ userId: s.ids.engineer }, s.owner)))
            .status,
        ).toBe(422);
        // Someone who is not a reviewer cannot decide; someone who cannot see the project cannot see it.
        expect(
          (await app.request(`${path}/decisions`, json({ decision: "approved" }, s.engineer)))
            .status,
        ).toBe(403);
        expect(
          (await app.request(`${path}/decisions`, json({ decision: "approved" }, s.accompanist)))
            .status,
        ).toBe(403);
        expect((await getAs(path, outsider)).status).toBe(404);
        // Managing reviewers: the producer adds one, an engineer may not.
        expect(
          (await app.request(`${path}/reviewers`, json({ userId: s.ids.accompanist }, s.engineer)))
            .status,
        ).toBe(403);
        const added = await reviewOf(
          await app.request(`${path}/reviewers`, json({ userId: s.ids.accompanist }, s.owner)),
        );
        expect(added.reviewers).toHaveLength(2);
        // Cancelling ends it.
        expect((await app.request(`${path}/cancel`, json({}, s.engineer))).status).toBe(403);
        const cancelled = await reviewOf(await app.request(`${path}/cancel`, json({}, s.owner)));
        expect(cancelled.status).toBe("cancelled");

        // Another organisation's reviews do not exist from here.
        const [elsewhere] = await db
          .insert(schema.organisations)
          .values({ name: "Elsewhere", slug: "elsewhere-reviews" })
          .returning();
        const [foreignProject] = await db
          .insert(schema.projects)
          .values({ organisationId: elsewhere?.id ?? "", name: "Theirs", profile: "music" })
          .returning();
        const [foreign] = await db
          .insert(schema.reviews)
          .values({
            organisationId: elsewhere?.id ?? "",
            projectId: foreignProject?.id ?? "",
            kind: "feedback",
            title: "Theirs",
          })
          .returning();
        expect((await getAs(`/api/reviews/${foreign?.id}`, s.owner)).status).toBe(404);
        expect(
          (await app.request(`/api/reviews/${foreign?.id}/cancel`, json({}, s.owner))).status,
        ).toBe(404);
      });

      it("hands the turn on when the reviewer who is up is removed", async () => {
        const s = await studio();
        const review = await reviewOf(
          await request(s.owner, s.projectId, {
            kind: "feedback",
            title: "Edit",
            order: "sequence",
            items: [{ fileId: s.mix }],
            reviewers: [s.ids.composer, s.ids.accompanist],
          }),
        );
        mailer.sent.length = 0;
        const first = review.reviewers[0]?.id;
        const after = await reviewOf(
          await app.request(`/api/reviews/${review.id}/reviewers/${first}`, {
            ...json({}, s.owner),
            method: "DELETE",
          }),
        );
        expect(after.reviewers.map((r) => r.state)).toEqual(["invited"]);
        expect(mailer.sent.map((m) => m.to)).toEqual(["accompanist@example.test"]);
        // The last reviewer cannot be removed: cancel the review instead.
        expect(
          (
            await app.request(`/api/reviews/${review.id}/reviewers/${after.reviewers[0]?.id}`, {
              ...json({}, s.owner),
              method: "DELETE",
            })
          ).status,
        ).toBe(409);
      });

      describe("guests", () => {
        const guest = { name: "Mira Solberg", email: "Conductor@Example.test", label: "Conductor" };
        /** The magic link token in the last email to an address. */
        const linkFor = (to: string) => {
          const mail = [...mailer.sent].reverse().find((m) => m.to === to);
          return mail?.text.match(/\/guest\/([A-Za-z0-9_-]+)/)?.[1] ?? "";
        };
        const signIn = (token: string) => app.request("/api/guest/sessions", json({ token }));

        /** A review with the composer and a guest, and the guest signed in. */
        const invited = async (kind: "approval" | "feedback" = "approval") => {
          const s = await studio();
          mailer.sent.length = 0;
          const review = await reviewOf(
            await request(s.owner, s.projectId, {
              kind,
              title: "Album master",
              items: [{ trackId: s.trackId }],
              reviewers: [s.ids.composer, guest],
            }),
          );
          const token = linkFor("conductor@example.test");
          expect(token).not.toBe("");
          const res = await signIn(token);
          expect(res.status).toBe(201);
          return { ...s, review, token, cookie: cookieOf(res) };
        };

        it("shares without asking anything, until it ends and only so many plays (#138)", async () => {
          const s = await studio();
          await db
            .update(schema.files)
            .set({ streamStatus: "ready" })
            .where(eq(schema.files.id, s.mix));
          // Someone who may only review cannot share.
          const body = {
            kind: "share",
            title: "Rehearsal takes",
            message: "For the train.",
            items: [{ trackId: s.trackId }],
            reviewers: [s.ids.composer, guest],
            // Asking for decisions, comments or invitations changes nothing: a share only shares.
            permissions: {
              decide: true,
              comment: true,
              invite: true,
              download: "proxy",
              maxPlays: 1,
              expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
            },
            overrides: { [`member:${s.ids.composer}`]: { comment: true, decide: true } },
          };
          expect((await request(s.composer, s.projectId, body)).status).toBe(403);
          mailer.sent.length = 0;
          const res = await request(s.owner, s.projectId, body);
          expect(res.status).toBe(201);
          type Shared = Omit<ReviewBody, "reviewers"> & {
            kind: string;
            rule: string | null;
            dueAt: string | null;
            reviewers: (ReviewBody["reviewers"][number] & {
              permissions: Record<string, unknown> | null;
              usage: { plays: number; downloads: number } | null;
            })[];
          };
          const share = (await reviewOf(res)) as Shared;
          expect(share).toMatchObject({ kind: "share", rule: null, dueAt: null });
          for (const r of share.reviewers) {
            expect(r.permissions).toMatchObject({
              comment: false,
              decide: false,
              invite: false,
              download: "proxy",
              maxPlays: 1,
            });
          }

          // Told it is theirs: the guest by mail with a link, the member in the app.
          const mail = [...mailer.sent].reverse().find((m) => m.to === "conductor@example.test");
          expect(mail?.subject).toMatch(/ shared Rehearsal takes with you$/);
          expect(mail?.text).toContain("Nothing is asked of you");
          expect(mail?.text).toContain("up to 1 play of each file");
          const told = await db
            .select({ text: schema.notifications.text, detail: schema.notifications.detail })
            .from(schema.notifications)
            .where(
              and(
                eq(schema.notifications.userId, s.ids.composer),
                eq(schema.notifications.reviewId, share.id),
              ),
            );
          expect(told.map((n) => n.text)).toEqual(['shared "Rehearsal takes" with you']);
          // In the share's own words, as the guest's mail: how often, and what to keep.
          expect(told[0]?.detail).toContain("up to 1 play of each file");
          expect(told[0]?.detail).toContain("You may download the proxy");

          // Nothing to answer, remind of, or wait for: never anyone's turn, and never due.
          const theirs = (await reviewOf(await getAs(`/api/reviews/${share.id}`, s.composer))).you;
          expect(theirs).toMatchObject({ canDecide: false, canSubmit: false, active: false });
          expect(
            (
              await app.request(
                `/api/reviews/${share.id}/decisions`,
                json({ decision: "approved" }, s.composer),
              )
            ).status,
          ).toBeGreaterThanOrEqual(400);
          expect(
            (await app.request(`/api/reviews/${share.id}/submit`, json({}, s.composer))).status,
          ).toBeGreaterThanOrEqual(400);
          expect(
            (await app.request(`/api/reviews/${share.id}/remind`, json({}, s.owner))).status,
          ).toBe(409);
          expect(
            (
              await app.request(`/api/reviews/${share.id}`, {
                ...json({ dueAt: new Date(Date.now() + 86_400_000).toISOString() }, s.owner),
                method: "PATCH",
              })
            ).status,
          ).toBe(422);
          const listed = (
            (await (await getAs("/api/reviews", s.composer)).json()) as {
              reviews: { id: string; yourTurn: boolean }[];
            }
          ).reviews.find((r) => r.id === share.id);
          expect(listed?.yourTurn).toBe(false);
          // A change cannot make a share ask for comments either.
          const guestRow = share.reviewers.find((r) => r.guest);
          expect(
            (
              await app.request(`/api/reviews/${share.id}/reviewers/${guestRow?.id}`, {
                ...json({ permissions: { comment: true } }, s.owner),
                method: "PATCH",
              })
            ).status,
          ).toBe(200);

          // The guest plays what was shared once, as the share allows, and no more.
          const signed = await signIn(linkFor("conductor@example.test"));
          expect(signed.status).toBe(201);
          const cookie = cookieOf(signed);
          const opened = (await reviewOf(
            await getAs(`/api/reviews/${share.id}`, cookie),
          )) as Shared;
          expect(opened.reviewers.find((r) => r.guest)?.permissions).toMatchObject({
            comment: false,
          });
          // Those shared with see nobody's plays; those who run it see each person's.
          expect(opened.reviewers.every((r) => r.usage === null)).toBe(true);
          const play = () => app.request(`/api/files/${s.mix}/playback`, json({}, cookie));
          expect((await play()).status).toBe(201);
          const again = await play();
          expect(again.status).toBe(403);
          expect(((await again.json()) as { error: { code: string } }).error.code).toBe(
            "plays_used",
          );
          const run = (await reviewOf(await getAs(`/api/reviews/${share.id}`, s.owner))) as Shared;
          expect(run.reviewers.map((r) => [r.guest ?? false, r.usage])).toEqual([
            [false, { plays: 0, downloads: 0 }],
            [true, { plays: 1, downloads: 0 }],
          ]);

          // Once it has ended for them, the guest finds nothing.
          const [row] = await db
            .select({ permissions: schema.reviewReviewers.permissions })
            .from(schema.reviewReviewers)
            .where(eq(schema.reviewReviewers.id, guestRow?.id ?? ""));
          await db
            .update(schema.reviewReviewers)
            .set({
              permissions: {
                ...(row?.permissions as Record<string, unknown>),
                startsAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
                expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
              } as typeof schema.reviewReviewers.$inferInsert.permissions,
            })
            .where(eq(schema.reviewReviewers.id, guestRow?.id ?? ""));
          expect((await getAs(`/api/reviews/${share.id}`, cookie)).status).toBe(404);
          expect((await play()).status).toBeGreaterThanOrEqual(403);
        });

        it("tells those who only follow an approval, asking them to follow it rather than approve (#221)", async () => {
          const s = await studio();
          mailer.sent.length = 0;
          const review = await reviewOf(
            await request(s.owner, s.projectId, {
              kind: "approval",
              title: "Album master",
              items: [{ trackId: s.trackId }],
              order: "sequence",
              reviewers: [s.ids.composer, s.ids.accompanist, guest],
              overrides: { "guest:conductor@example.test": { decide: false } },
            }),
          );
          const told = async (userId: string) =>
            (
              await db
                .select({ text: schema.notifications.text })
                .from(schema.notifications)
                .where(
                  and(
                    eq(schema.notifications.userId, userId),
                    eq(schema.notifications.reviewId, review.id),
                  ),
                )
            ).map((n) => n.text);

          // Last in the sequence, but nothing waits on a follower: told at once, with a link
          // that works, and asked to follow.
          const mail = [...mailer.sent].reverse().find((m) => m.to === "conductor@example.test");
          expect(mail?.subject).toBe("Album master: your feedback is asked");
          expect(mail?.text).toContain("asks you to follow an approval");
          expect(mail?.text).toContain("the decision rests with others");
          expect(mail?.text).not.toContain("Approved or Changes requested");
          expect((await signIn(linkFor("conductor@example.test"))).status).toBe(201);
          // The accompanist decides, so waits their turn untold.
          expect(await told(s.ids.composer)).toEqual(['asks you to approve "Album master"']);
          expect(await told(s.ids.accompanist)).toEqual([]);

          // Added later, a producer decides too, and waits untold at the end of the sequence;
          // their decision taken away, they only follow, and hear of it now.
          const joined = await joinAs(s.owner, "second-producer@example.test");
          await grantRole(s.owner, s.projectId, joined, "Reviewer");
          const producer = await idOf(joined);
          const added = await app.request(
            `/api/reviews/${review.id}/reviewers`,
            json({ userId: producer }, s.owner),
          );
          expect(added.status).toBe(201);
          expect(await told(producer)).toEqual([]);
          const later = (
            (await added.json()) as { review: { reviewers: { id: string }[] } }
          ).review.reviewers.at(-1)?.id;
          const changed = await app.request(`/api/reviews/${review.id}/reviewers/${later}`, {
            ...json({ permissions: { decide: false } }, s.owner),
            method: "PATCH",
          });
          expect(changed.status).toBe(200);
          expect(await told(producer)).toEqual(['asks you to follow "Album master"']);
          // No one else is told anything new.
          expect(await told(s.ids.accompanist)).toEqual([]);
          expect(await told(s.ids.composer)).toHaveLength(1);
        });

        it("lets a reviewer invite others when their grant allows, as guests beside them (#55)", async () => {
          const s = await invited("approval");
          const reviewer = s.review.reviewers.find((r) => r.guest);
          const invite = (body: Record<string, unknown>, cookie: string) =>
            app.request(`/api/reviews/${s.review.id}/invite`, json(body, cookie));
          const extra = { name: "Tomas Varga", email: "tomas@example.test", label: "Viola" };
          // Nobody's grant allows it until someone says so.
          expect((await invite(extra, s.cookie)).status).toBe(403);
          const you = async (cookie: string) =>
            (
              (await (await getAs(`/api/reviews/${s.review.id}`, cookie)).json()) as {
                review: { you: { canInvite: boolean } };
              }
            ).review.you.canInvite;
          expect(await you(s.cookie)).toBe(false);
          expect(
            (
              await app.request(`/api/reviews/${s.review.id}/reviewers/${reviewer?.id}`, {
                ...json({ permissions: { invite: true, tools: ["loops"] } }, s.owner),
                method: "PATCH",
              })
            ).status,
          ).toBe(200);
          expect(await you(s.cookie)).toBe(true);
          // Having decided already, the guest is no longer waited on; their invitation still goes.
          expect(
            (
              await app.request(
                `/api/reviews/${s.review.id}/decisions`,
                json({ decision: "approved" }, s.cookie),
              )
            ).status,
          ).toBe(200);
          mailer.sent.length = 0;
          const made = await invite(extra, s.cookie);
          expect(made.status).toBe(201);
          // From the guest who invited them, not from whoever asked for the review.
          const mail = mailer.sent.find((m) => m.to === "tomas@example.test");
          expect(mail?.text).toContain("Mira Solberg");
          // They join beside the guest who asked, with what that guest may do, but no decision
          // (the approval stays with those the requester asked) and no inviting of their own.
          const rows = await db
            .select({
              guestId: schema.reviewReviewers.guestId,
              position: schema.reviewReviewers.position,
              permissions: schema.reviewReviewers.permissions,
            })
            .from(schema.reviewReviewers)
            .where(eq(schema.reviewReviewers.reviewId, s.review.id));
          const inviter = rows.find((r) => r.permissions.invite);
          const joined = rows.find((r) => r.guestId && r !== inviter && !r.permissions.invite);
          expect(joined?.position).toBe(inviter?.position);
          expect(joined?.permissions).toMatchObject({
            decide: false,
            invite: false,
            tools: ["loops"],
          });
          // Asked by email, with a link of their own.
          expect(linkFor("tomas@example.test")).not.toBe("");
          // Once only; and the invited may not invite in turn.
          expect((await invite(extra, s.cookie)).status).toBe(409);
          const theirs = cookieOf(await signIn(linkFor("tomas@example.test")));
          expect(
            (await invite({ name: "Ines Arlow", email: "ines@example.test" }, theirs)).status,
          ).toBe(403);
          // A member whose grant does not say so may not either, unless their role manages it.
          const composer = s.review.reviewers.find((r) => !r.guest);
          expect(composer).toBeDefined();
          expect(
            (await invite({ name: "Ines Arlow", email: "ines@example.test" }, s.composer)).status,
          ).toBe(403);
          // Logged as who asked, naming who invited them.
          const logged = await audit.query(s.organisationId, {
            action: "review.reviewer_add",
            limit: 10,
          });
          expect(logged.events[0]?.details).toMatchObject({ name: "Tomas Varga" });
          // A review elsewhere does not exist for them.
          expect(
            (
              await app.request(
                "/api/reviews/0190a6f0-0000-7000-8000-0000000000ff/invite",
                json(extra, s.cookie),
              )
            ).status,
          ).toBe(404);
        });

        it("lets a guest download what a thread carries, and attach to their own (#133)", async () => {
          const s = await invited();
          const attach = (commentId: string, cookie: string) =>
            app.request(`/api/files/${s.mix}/comments/${commentId}/attachments`, {
              method: "POST",
              headers: {
                cookie,
                origin: "http://localhost:3000",
                "content-type": "application/pdf",
                "x-file-name": encodeURIComponent("Bowings.pdf"),
              },
              body: new Uint8Array(Buffer.from("%PDF-1.4 bowings")),
            });
          const theirs = async (body: string, cookie: string) =>
            (
              (await (
                await app.request(`/api/files/${s.mix}/comments`, json({ body }, cookie))
              ).json()) as { comment: { id: string } }
            ).comment.id;
          const owners = await theirs("The bowings for the second page", s.owner);
          const added = (await (await attach(owners, s.owner)).json()) as {
            attachment: { id: string };
          };
          // The guest sees the thread, so may download what it carries, but not add to it.
          const made = await app.request(
            `/api/files/${s.mix}/attachments/${added.attachment.id}/download`,
            json({}, s.cookie),
          );
          expect(made.status).toBe(201);
          const { url } = (await made.json()) as { url: string };
          const fetched = await getAs(url, s.cookie);
          expect(fetched.status).toBe(200);
          expect(await fetched.text()).toBe("%PDF-1.4 bowings");
          expect((await attach(owners, s.cookie)).status).toBe(403);
          const mine = await theirs("Mine, marked", s.cookie);
          expect((await attach(mine, s.cookie)).status).toBe(201);
          // Which comments are theirs is said outright, since a guest's author is not shown.
          const listed = (await (await getAs(`/api/files/${s.mix}/comments`, s.cookie)).json()) as {
            comments: { id: string; mine: boolean; authorId: string | null }[];
          };
          const flag = (id: string) => listed.comments.find((c) => c.id === id);
          expect(flag(mine)).toMatchObject({ mine: true, authorId: null });
          expect(flag(owners)?.mine).toBe(false);
        });

        it("shares takes on a thread, which a guest then hears and nothing more (#133)", async () => {
          const s = await invited();
          const recording = async (name: string) => {
            const blob = await storage.put(s.organisationId, Buffer.from(name));
            const [row] = await db
              .insert(schema.files)
              .values({
                organisationId: s.organisationId,
                projectId: s.projectId,
                name,
                kind: "audio",
                blobId: blob.id,
                contentType: "audio/wav",
                byteSize: blob.byteSize,
                mediaInfo: { duration: 41 } as never,
              })
              .returning();
            return row?.id ?? "";
          };
          const t1 = await recording("Take 1.wav");
          const t2 = await recording("Take 2.wav");
          const made = await app.request(
            `/api/tracks/${s.trackId}/takes`,
            json({ fileIds: [t1, t2] }, s.engineer),
          );
          const { takes } = (await made.json()) as { takes: { id: string }[] };
          const [one, two] = takes;
          // A thread on the bars, by the guest.
          const thread = (
            (await (
              await app.request(
                `/api/files/${s.mix}/comments`,
                json(
                  {
                    body: "Any other options for bar 9?",
                    anchor: { kind: "bar", from: { bar: 9 } },
                  },
                  s.cookie,
                ),
              )
            ).json()) as { comment: { id: string } }
          ).comment.id;
          const share = (takeIds: string[], cookie: string) =>
            app.request(`/api/comments/${thread}/takes`, json({ takeIds }, cookie));

          // Before any share the guest cannot open a take.
          expect((await getAs(`/api/files/${t1}`, s.cookie)).status).toBe(404);
          // Sharing needs triage: a reviewer is refused, and a guest never reaches the route.
          expect((await share([one?.id ?? ""], s.composer)).status).toBe(403);
          expect((await share([one?.id ?? ""], s.cookie)).status).toBe(401);
          const shared = await share([one?.id ?? ""], s.engineer);
          expect(shared.status).toBe(201);
          expect(((await shared.json()) as { takes: { id: string }[] }).takes).toMatchObject([
            { id: one?.id, file: { id: t1 } },
          ]);
          // A take this project does not hold is not this thread's to share.
          expect((await share(["01890000-0000-7000-8000-000000000000"], s.engineer)).status).toBe(
            404,
          );

          // The thread shows its takes to the guest, who may now hear that take and only it.
          type Listed = { comments: { id: string; takes: { id: string }[] }[] };
          const seen = (await (
            await getAs(`/api/files/${s.mix}/comments`, s.cookie)
          ).json()) as Listed;
          expect(seen.comments.find((c) => c.id === thread)?.takes.map((t) => t.id)).toEqual([
            one?.id,
          ]);
          expect((await getAs(`/api/files/${t1}`, s.cookie)).status).toBe(200);
          expect((await getAs(`/api/files/${t2}`, s.cookie)).status).toBe(404);
          // Listening only: no comment on the take, none of its own comments shown.
          await app.request(
            `/api/files/${t1}/comments`,
            json({ body: "Producer's note: edit point at 0:12" }, s.owner),
          );
          expect(
            (await app.request(`/api/files/${t1}/comments`, json({ body: "Lovely" }, s.cookie)))
              .status,
          ).toBe(403);
          expect((await getAs(`/api/files/${t1}/comments`, s.cookie)).status).toBe(403);
          // Sharing it again changes nothing, and logs nothing.
          expect((await share([one?.id ?? ""], s.engineer)).status).toBe(201);

          // Each share and unshare is in the access log; unshared, the take is closed again.
          const unshare = await app.request(`/api/comments/${thread}/takes/${one?.id}`, {
            method: "DELETE",
            headers: { cookie: s.engineer, origin: "http://localhost:3000" },
          });
          expect(unshare.status).toBe(204);
          expect((await getAs(`/api/files/${t1}`, s.cookie)).status).toBe(404);
          const logged = await db
            .select({ action: schema.accessEvents.action })
            .from(schema.accessEvents)
            .where(
              and(
                eq(schema.accessEvents.organisationId, s.organisationId),
                sql`${schema.accessEvents.action} in ('comment.takes_share', 'comment.takes_unshare')`,
              ),
            )
            .orderBy(schema.accessEvents.occurredAt);
          expect(logged.map((e) => e.action)).toEqual([
            "comment.takes_share",
            "comment.takes_unshare",
          ]);
          // On someone else's thread, a share reaches the guest only while their review shows
          // them every thread.
          const owners = (
            (await (
              await app.request(
                `/api/files/${s.mix}/comments`,
                json({ body: "Bar 9 again" }, s.owner),
              )
            ).json()) as { comment: { id: string } }
          ).comment.id;
          expect(
            (
              await app.request(
                `/api/comments/${owners}/takes`,
                json({ takeIds: [two?.id] }, s.engineer),
              )
            ).status,
          ).toBe(201);
          expect((await getAs(`/api/files/${t2}`, s.cookie)).status).toBe(200);
          const [mine] = await db
            .select({
              id: schema.reviewReviewers.id,
              permissions: schema.reviewReviewers.permissions,
            })
            .from(schema.reviewReviewers)
            .where(
              and(
                eq(schema.reviewReviewers.reviewId, s.review.id),
                isNotNull(schema.reviewReviewers.guestId),
              ),
            );
          await db
            .update(schema.reviewReviewers)
            .set({ permissions: { ...(mine?.permissions as object), comments: "own" } as never })
            .where(eq(schema.reviewReviewers.id, mine?.id ?? ""));
          expect((await getAs(`/api/files/${t2}`, s.cookie)).status).toBe(404);

          // A reply is not a thread to share on.
          expect(
            (
              await app.request(
                `/api/comments/${
                  (
                    (await (
                      await app.request(
                        `/api/files/${s.mix}/comments`,
                        json({ body: "Take 2 too?", parentId: thread }, s.owner),
                      )
                    ).json()) as { comment: { id: string } }
                  ).comment.id
                }/takes`,
                json({ takeIds: [two?.id] }, s.engineer),
              )
            ).status,
          ).toBe(404);
        });

        it("lets a guest mention nobody, and keeps tasks from them (#133)", async () => {
          const s = await invited();
          expect(await (await getAs(`/api/files/${s.mix}/mentionable`, s.cookie)).json()).toEqual({
            people: [],
          });
          const refused = await app.request(
            `/api/files/${s.mix}/comments`,
            json({ body: "Thank you, @composer", mentions: [s.ids.composer] }, s.cookie),
          );
          expect(refused.status).toBe(422);
          expect(await refused.json()).toMatchObject({ error: { code: "mention_refused" } });
          // A task on the owner's thread is the team's business.
          const made = await app.request(
            `/api/files/${s.mix}/comments`,
            json({ body: "Tidy the fade" }, s.owner),
          );
          const { comment } = (await made.json()) as { comment: { id: string } };
          await app.request(`/api/comments/${comment.id}/todo`, json({ todo: true }, s.owner));
          const seen = (await (await getAs(`/api/files/${s.mix}/comments`, s.cookie)).json()) as {
            comments: { id: string; todo: boolean }[];
          };
          expect(seen.comments.find((c) => c.id === comment.id)?.todo).toBe(false);
        });

        it("asks for a code sent to the guest's address where the workspace says so", async () => {
          const s = await studio();
          const changed = await app.request("/api/organisation/settings", {
            ...json({ guestVerification: "code" }, s.owner),
            method: "PATCH",
          });
          expect(changed.status).toBe(200);
          mailer.sent.length = 0;
          await request(s.owner, s.projectId, {
            kind: "feedback",
            title: "Album master",
            items: [{ trackId: s.trackId }],
            reviewers: [guest],
          });
          const token = linkFor("conductor@example.test");
          const codeFor = () =>
            [...mailer.sent]
              .reverse()
              .find((m) => m.to === "conductor@example.test")
              ?.subject.match(/^(\d{6}) /)?.[1] ?? "";
          const verify = (code: string) =>
            app.request("/api/guest/sessions/verify", json({ token, code }));
          const errorOf = async (res: Response) =>
            ((await res.json()) as { error: { code: string } }).error.code;
          const sendAnother = async () => {
            // Half a minute between codes.
            await db
              .update(schema.guestLinks)
              .set({ codeSentAt: new Date(Date.now() - 60_000) })
              .where(eq(schema.guestLinks.organisationId, s.organisationId));
            return app.request("/api/guest/sessions/code", json({ token }));
          };

          // The link alone opens nothing: whoever opens it, the code goes to the guest's address.
          mailer.sent.length = 0;
          const opened = await signIn(token);
          expect(opened.status).toBe(202);
          expect(await opened.json()).toEqual({ verify: "code", sentTo: "c•••@example.test" });
          expect(cookieOf(opened)).not.toContain("hekate_guest=");
          expect(mailer.sent.map((m) => m.to)).toEqual(["conductor@example.test"]);
          const first = codeFor();
          expect(first).toMatch(/^\d{6}$/);
          // Someone the mail was forwarded to has the link but not the code.
          const wrong = first === "000000" ? "111111" : "000000";
          const guessed = await verify(wrong);
          expect(guessed.status).toBe(400);
          expect(await errorOf(guessed)).toBe("code_wrong");
          // Another code cannot be had at once.
          const hurried = await app.request("/api/guest/sessions/code", json({ token }));
          expect(hurried.status).toBe(429);
          expect(await errorOf(hurried)).toBe("code_wait");

          // A code runs out after ten minutes.
          await db
            .update(schema.guestLinks)
            .set({ codeExpiresAt: new Date(Date.now() - 1000) })
            .where(eq(schema.guestLinks.organisationId, s.organisationId));
          const late = await verify(first);
          expect(late.status).toBe(410);
          expect(await errorOf(late)).toBe("code_expired");

          // A code that cannot be mailed is not issued, logged or counted against the five.
          const sentSoFar = async () =>
            (
              await db
                .select({ sent: schema.guestLinks.codesSent })
                .from(schema.guestLinks)
                .where(eq(schema.guestLinks.organisationId, s.organisationId))
            )[0]?.sent;
          const before = await sentSoFar();
          const send = mailer.send;
          mailer.send = async () => {
            throw new Error("The mail server refused the message");
          };
          expect((await sendAnother()).status).toBe(500);
          mailer.send = send;
          expect(await sentSoFar()).toBe(before);

          // Five wrong tries spend a code, even the right one after them.
          expect((await sendAnother()).status).toBe(202);
          const second = codeFor();
          expect(second).not.toBe("");
          const miss = second === "000000" ? "111111" : "000000";
          for (let i = 0; i < 5; i++) expect((await verify(miss)).status).toBe(400);
          const spent = await verify(second);
          expect(spent.status).toBe(429);
          expect(await errorOf(spent)).toBe("code_tries");

          // A fresh code opens the review, once.
          expect((await sendAnother()).status).toBe(202);
          const opens = await verify(codeFor().replace(/(\d{3})/, "$1 "));
          expect(opens.status).toBe(201);
          const me = await app.request("/api/guest/me", {
            headers: { cookie: cookieOf(opens) },
          });
          expect(me.status).toBe(200);
          expect((await signIn(token)).status).toBe(410);
          expect((await verify(codeFor())).status).toBe(410);

          // Every try is in the access log, with why it failed.
          const events = await db
            .select({ action: schema.accessEvents.action, details: schema.accessEvents.details })
            .from(schema.accessEvents)
            .where(eq(schema.accessEvents.organisationId, s.organisationId));
          const failed = events
            .filter((e) => e.action === "guest.code_failed")
            .map((e) => (e.details as { reason: string }).reason);
          expect(failed).toEqual([
            "wrong",
            "expired",
            "wrong",
            "wrong",
            "wrong",
            "wrong",
            "wrong",
            "too_many",
          ]);
          expect(events.filter((e) => e.action === "guest.code_sent")).toHaveLength(3);
          expect(events.filter((e) => e.action === "guest.sign_in")).toHaveLength(1);
        });

        it("gives new reviews and guest links the workspace's settings", async () => {
          const s = await studio();
          const settings = (body: Record<string, unknown>, cookie: string) =>
            app.request("/api/organisation/settings", { ...json(body, cookie), method: "PATCH" });
          expect(
            (
              await settings(
                {
                  guestLinkDays: 14,
                  reviewer: {
                    decide: false,
                    comments: "own",
                    history: true,
                    download: "proxy",
                    windowDays: 30,
                  },
                },
                s.owner,
              )
            ).status,
          ).toBe(200);
          mailer.sent.length = 0;
          const before = Date.now();
          const review = await reviewOf(
            await request(s.owner, s.projectId, {
              kind: "feedback",
              title: "Album master",
              items: [{ trackId: s.trackId }],
              // The request may still say otherwise for what it names.
              permissions: { comments: "all" },
              reviewers: [s.ids.composer, guest],
            }),
          );
          const day = 24 * 60 * 60 * 1000;
          const granted = await db
            .select({ permissions: schema.reviewReviewers.permissions })
            .from(schema.reviewReviewers)
            .where(eq(schema.reviewReviewers.reviewId, review.id));
          expect(granted).toHaveLength(2);
          for (const { permissions } of granted) {
            expect(permissions).toMatchObject({
              comment: true,
              decide: false,
              comments: "all",
              history: true,
              download: "proxy",
            });
            const ends = Date.parse(permissions.expiresAt ?? "");
            expect(ends).toBeGreaterThanOrEqual(before + 30 * day);
            expect(ends).toBeLessThan(Date.now() + 30 * day + 1000);
          }
          // The guest's link lasts a fortnight, and the email says so.
          const [link] = await db
            .select({ expiresAt: schema.guestLinks.expiresAt, at: schema.guestLinks.createdAt })
            .from(schema.guestLinks)
            .where(eq(schema.guestLinks.organisationId, s.organisationId));
          expect((link?.expiresAt.getTime() ?? 0) - before).toBeGreaterThanOrEqual(14 * day);
          expect((link?.expiresAt.getTime() ?? 0) - Date.now()).toBeLessThanOrEqual(14 * day);
          const mail = mailer.sent.find((m) => m.to === "conductor@example.test");
          expect(mail?.text.replace(/\s+/g, " ")).toContain("works once, for 14 days.");

          // An approval nobody may decide would never end: refused, unless the request says
          // that its reviewers may decide.
          const approval = (permissions?: Record<string, unknown>) =>
            request(s.owner, s.projectId, {
              kind: "approval",
              title: "Album master, signed off",
              items: [{ trackId: s.trackId }],
              reviewers: [s.ids.composer],
              ...(permissions ? { permissions } : {}),
            });
          const refused = await approval();
          expect(refused.status).toBe(422);
          expect(
            ((await refused.json()) as { error: { message: string } }).error.message,
          ).toContain("may decide");
          expect((await approval({ decide: true })).status).toBe(201);
        });

        it("reminds those it still waits on the day before a review is due, once", async () => {
          const s = await studio();
          const hours = (n: number) => new Date(Date.now() + n * 60 * 60 * 1000).toISOString();
          const ask = async (title: string, dueAt: string, reviewers: unknown[]) =>
            reviewOf(
              await request(s.owner, s.projectId, {
                kind: "feedback",
                title,
                items: [{ trackId: s.trackId }],
                reviewers,
                dueAt,
              }),
            );
          const soon = await ask("Album master", hours(12), [
            s.ids.composer,
            s.ids.accompanist,
            guest,
          ]);
          const also = await ask("Sleeve notes", hours(20), [s.ids.composer, guest]);
          await ask("Liner notes", hours(72), [s.ids.composer, guest]);
          // One whose requester turned the reminder off is left alone.
          await reviewOf(
            await request(s.owner, s.projectId, {
              kind: "feedback",
              title: "Cover art",
              items: [{ trackId: s.trackId }],
              reviewers: [s.ids.composer],
              dueAt: hours(10),
              remind: false,
            }),
          );
          // One reviewer has already sent their feedback; they are not reminded.
          expect(
            (await app.request(`/api/reviews/${soon.id}/submit`, json({}, s.accompanist))).status,
          ).toBe(200);
          mailer.sent.length = 0;
          const deps = { db, mailer, audit, publicUrl: "http://localhost:3000" };
          expect(await remindDue(deps)).toBe(4);
          const told = await db
            .select({ userId: schema.notifications.userId, text: schema.notifications.text })
            .from(schema.notifications)
            .where(eq(schema.notifications.kind, "due_soon"));
          expect(told.map((t) => t.text).sort()).toEqual([
            'your feedback on "Album master" is due tomorrow',
            'your feedback on "Sleeve notes" is due tomorrow',
          ]);
          expect(told.every((t) => t.userId === s.ids.composer)).toBe(true);
          // The guest gets one mail, with one link that opens both.
          const mails = mailer.sent.filter((m) => m.to === "conductor@example.test");
          expect(mails).toHaveLength(1);
          expect(mails[0]?.subject).toMatch(/is due tomorrow$/);
          expect(mails[0]?.text).toContain("- Sleeve notes");
          const token = mails[0]?.text.match(/\/guest\/([A-Za-z0-9_-]+)/)?.[1] ?? "";
          const signedIn = await signIn(token);
          expect(signedIn.status).toBe(201);
          const mine = (await (await getAs("/api/guest/me", cookieOf(signedIn))).json()) as {
            reviews: { id: string }[];
          };
          expect(mine.reviews.map((r) => r.id)).toEqual(expect.arrayContaining([soon.id, also.id]));
          // Never twice.
          expect(await remindDue(deps)).toBe(0);
        });

        it("signs a guest in once from a magic link, and keeps them to their reviews", async () => {
          const s = await invited();
          // The link was single-use.
          expect((await signIn(s.token)).status).toBe(410);
          const me = (await (await getAs("/api/guest/me", s.cookie)).json()) as {
            guest: { name: string; label: string };
            reviews: { id: string }[];
          };
          expect(me.guest).toMatchObject({ name: "Mira Solberg", label: "Conductor" });
          expect(me.reviews.map((r) => r.id)).toEqual([s.review.id]);

          // The review, with other reviewers' addresses withheld.
          const seen = (await (await getAs(`/api/reviews/${s.review.id}`, s.cookie)).json()) as {
            review: ReviewBody & { you: { guest: boolean }; reviewers: { email: string | null }[] };
          };
          expect(seen.review.you).toMatchObject({ guest: true, canDecide: true });
          expect(seen.review.reviewers.every((r) => r.email === null)).toBe(true);

          // The file under review, and nothing else.
          expect((await getAs(`/api/files/${s.mix}`, s.cookie)).status).toBe(200);
          expect((await getAs(`/api/files/${s.mix}/comments`, s.cookie)).status).toBe(200);
          expect((await getAs(`/api/files/${s.artwork}`, s.cookie)).status).toBe(404);
          expect((await getAs(`/api/projects/${s.projectId}`, s.cookie)).status).toBe(401);
          expect((await getAs("/api/projects", s.cookie)).status).toBe(401);
          // Nor managing the review.
          expect(
            (await app.request(`/api/reviews/${s.review.id}/cancel`, json({}, s.cookie))).status,
          ).toBe(403);
          expect(
            (
              await app.request(
                `/api/reviews/${s.review.id}/reviewers`,
                json({ userId: s.ids.engineer }, s.cookie),
              )
            ).status,
          ).toBe(403);
        });

        it("lists the workspace's guests for admins, and revokes a guest everywhere", async () => {
          const s = await invited();
          const list = async (cookie: string) => {
            const res = await getAs("/api/organisation/guests", cookie);
            return { status: res.status, body: (await res.json()) as { guests: GuestRow[] } };
          };
          type GuestRow = {
            id: string;
            name: string;
            email: string;
            label: string | null;
            lastLinkAt: string | null;
            live: boolean;
          };
          const before = await list(s.owner);
          expect(before.status).toBe(200);
          expect(before.body.guests).toHaveLength(1);
          const [mira] = before.body.guests;
          expect(mira).toMatchObject({
            name: "Mira Solberg",
            email: "conductor@example.test",
            label: "Conductor",
            live: true,
          });
          expect(mira?.lastLinkAt).not.toBeNull();

          // A member sees no guest list and revokes nobody.
          expect((await list(s.composer)).status).toBe(403);
          const revoke = (id: string, cookie: string) =>
            app.request(`/api/organisation/guests/${id}/revoke`, json({}, cookie));
          expect((await revoke(mira?.id ?? "", s.composer)).status).toBe(403);
          expect((await revoke("01a141dd-0000-7000-8000-000000000000", s.owner)).status).toBe(404);

          expect((await revoke(mira?.id ?? "", s.owner)).status).toBe(204);
          expect((await getAs("/api/guest/me", s.cookie)).status).toBe(401);
          expect((await list(s.owner)).body.guests[0]?.live).toBe(false);
          const logged = await audit.query(s.organisationId, { action: "guest.revoke", limit: 5 });
          expect(logged.events.some((e) => e.details?.guestId === mira?.id)).toBe(true);
        });

        it("lets a guest comment and decide, all of it logged", async () => {
          const s = await invited();
          await app.request(`/api/reviews/${s.review.id}/viewed`, json({}, s.cookie));
          const comment = await app.request(
            `/api/files/${s.mix}/comments`,
            json({ body: "The tempo drags at bar 40." }, s.cookie),
          );
          expect(comment.status).toBe(201);
          const written = (
            (await comment.json()) as {
              comment: { authorName: string; authorGuest: boolean; authorLabel: string };
            }
          ).comment;
          expect(written).toMatchObject({
            authorName: "Mira Solberg",
            authorGuest: true,
            authorLabel: "Conductor",
          });
          const decided = await reviewOf(
            await app.request(
              `/api/reviews/${s.review.id}/decisions`,
              json({ decision: "changes_requested", note: "Bar 40" }, s.cookie),
            ),
          );
          expect(decided.reviewers.find((r) => r.state === "submitted")).toBeTruthy();
          for (const action of [
            "guest.link",
            "guest.sign_in",
            "guest.view",
            "comment.create",
            "review.decision",
          ] as const) {
            const logged = await audit.query(s.organisationId, { action, limit: 10 });
            expect(
              logged.events.some((e) => e.actorType === "guest"),
              action,
            ).toBe(true);
          }
          // A guest cannot edit or resolve through the member routes.
          const id =
            ((await getAs(`/api/files/${s.mix}/comments`, s.cookie)).json as unknown) && written;
          expect(id).toBeTruthy();
        });

        it("holds a guest to the items, versions, tools and plays their review gives", async () => {
          const s = await invited();
          const reviewer = s.review.reviewers.find((r) => r.guest);
          const grant = (permissions: Record<string, unknown>) =>
            app.request(`/api/reviews/${s.review.id}/reviewers/${reviewer?.id}`, {
              ...json({ permissions }, s.owner),
              method: "PATCH",
            });
          const sees = async (fileId: string) =>
            (await getAs(`/api/files/${fileId}`, s.cookie)).status;
          // A second version: the guest is shown the latest, and the first only with history.
          const blob = await storage.put(s.organisationId, Buffer.from("v2"));
          const [v2] = await db
            .insert(schema.files)
            .values({
              organisationId: s.organisationId,
              projectId: s.projectId,
              name: "Mix v2.wav",
              kind: "audio",
              blobId: blob.id,
              contentType: "audio/wav",
              byteSize: blob.byteSize,
              streamStatus: "ready",
              mediaInfo: {
                duration: 60,
                audio: { codec: "pcm_s24le", channels: 2, sampleRate: 48000 },
              },
            })
            .returning();
          const second = await app.request(
            `/api/tracks/${s.trackId}/versions`,
            json({ variations: [{ fileId: v2?.id, name: "Mix" }] }, s.owner),
          );
          expect(second.status).toBe(201);
          expect(await sees(v2?.id ?? "")).toBe(200);
          expect(await sees(s.mix)).toBe(404);
          expect((await grant({ history: true })).status).toBe(200);
          expect(await sees(s.mix)).toBe(200);
          // A review that names version 1 shows it and those before it, never a later one.
          const [v1] = await db
            .select({ id: schema.versions.id })
            .from(schema.versions)
            .where(and(eq(schema.versions.trackId, s.trackId), eq(schema.versions.number, 1)));
          await db
            .update(schema.reviewItems)
            .set({ versionId: v1?.id ?? null })
            .where(eq(schema.reviewItems.reviewId, s.review.id));
          expect(await sees(s.mix)).toBe(200);
          expect(await sees(v2?.id ?? "")).toBe(404);
          await db
            .update(schema.reviewItems)
            .set({ versionId: null })
            .where(eq(schema.reviewItems.reviewId, s.review.id));

          // The score beside the recording, only with the score tool.
          await db
            .update(schema.tracks)
            .set({ scoreFileId: s.artwork })
            .where(eq(schema.tracks.id, s.trackId));
          expect((await grant({ tools: ["loops"] })).status).toBe(200);
          expect(await sees(s.artwork)).toBe(404);
          // QA is a tool of its own now, apart from the meters.
          expect((await getAs(`/api/files/${v2?.id}/qa`, s.cookie)).status).toBe(403);
          expect((await grant({ tools: ["loops", "score", "qa"] })).status).toBe(200);
          expect(await sees(s.artwork)).toBe(200);
          expect((await getAs(`/api/files/${v2?.id}/qa`, s.cookie)).status).not.toBe(403);

          // Compare (#44, #55): refused without the tool; with it, only what they may open.
          await db.insert(schema.alignments).values({
            organisationId: s.organisationId,
            fromFileId: v2?.id ?? "",
            toFileId: s.mix,
            status: "ready",
            points: [
              [0, 0],
              [60, 61],
            ],
            quality: 0.9,
          });
          type Family = { versions: { number: number; variations: { fileId: string }[] }[] };
          const family = async (cookie: string) => {
            const res = await getAs(`/api/files/${v2?.id}/compare`, cookie);
            return res.status === 200 ? ((await res.json()) as Family) : res.status;
          };
          const aligned = async () =>
            (
              (await (await getAs(`/api/files/${v2?.id}/alignments`, s.cookie)).json()) as {
                alignments: { fileId: string }[];
              }
            ).alignments.map((a) => a.fileId);
          expect(await family(s.cookie)).toBe(403);
          expect((await getAs(`/api/files/${v2?.id}/alignments`, s.cookie)).status).toBe(403);
          expect((await grant({ tools: ["loops", "compare"], history: false })).status).toBe(200);
          expect(await family(s.cookie)).toEqual({
            versions: [expect.objectContaining({ number: 2 })],
          });
          expect(await aligned()).toEqual([]);
          // With history, the earlier version as well, and where the music sits in it.
          expect((await grant({ history: true })).status).toBe(200);
          expect(
            ((await family(s.cookie)) as Family).versions.map((v) => [
              v.number,
              v.variations.map((x) => x.fileId),
            ]),
          ).toEqual([
            [1, [s.mix]],
            [2, [v2?.id]],
          ]);
          expect(await aligned()).toEqual([s.mix]);
          // A member sees the whole track, as their role allows.
          expect(((await family(s.owner)) as Family).versions).toHaveLength(2);
          expect((await grant({ tools: ["loops", "score", "qa"] })).status).toBe(200);

          // At most two plays of each file; a third start is refused. Plays through another
          // review do not count against this one.
          const [mine] = await db
            .select({ guestId: schema.reviewReviewers.guestId })
            .from(schema.reviewReviewers)
            .where(eq(schema.reviewReviewers.id, reviewer?.id ?? ""));
          await db.insert(schema.accessEvents).values(
            [1, 2].map(() => ({
              organisationId: s.organisationId,
              action: "stream.session" as const,
              actorType: "guest" as const,
              guestId: mine?.guestId ?? null,
              actorLabel: "An earlier review",
              projectId: s.projectId,
              fileId: v2?.id ?? null,
              reviewId: null,
            })),
          );
          expect((await grant({ maxPlays: 2 })).status).toBe(200);
          const play = () => app.request(`/api/files/${v2?.id}/playback`, json({}, s.cookie));
          expect((await play()).status).toBe(201);
          expect((await play()).status).toBe(201);
          const third = await play();
          expect(third.status).toBe(403);
          expect(((await third.json()) as { error: { code: string } }).error.code).toBe(
            "plays_used",
          );
          // Members are not counted.
          expect(
            (await app.request(`/api/files/${v2?.id}/playback`, json({}, s.owner))).status,
          ).toBe(201);
        });

        it("shows a guest only the items their review names, which must be its own", async () => {
          const s = await studio();
          mailer.sent.length = 0;
          const review = await reviewOf(
            await request(s.owner, s.projectId, {
              kind: "feedback",
              title: "Album master",
              items: [{ trackId: s.trackId }, { fileId: s.artwork }],
              reviewers: [guest],
            }),
          );
          const res = await signIn(linkFor("conductor@example.test"));
          const cookie = cookieOf(res);
          const reviewer = review.reviewers.find((r) => r.guest);
          const trackItem = review.items.find((i) => i.kind === "track")?.id;
          const grant = (permissions: Record<string, unknown>) =>
            app.request(`/api/reviews/${review.id}/reviewers/${reviewer?.id}`, {
              ...json({ permissions }, s.owner),
              method: "PATCH",
            });
          expect((await getAs(`/api/files/${s.artwork}`, cookie)).status).toBe(200);
          // Not another review's item, and not none.
          expect((await grant({ items: ["01890000-0000-7000-8000-000000000000"] })).status).toBe(
            422,
          );
          expect((await grant({ items: [] })).status).toBe(422);
          expect((await grant({ items: [trackItem] })).status).toBe(200);
          expect((await getAs(`/api/files/${s.artwork}`, cookie)).status).toBe(404);
          expect((await getAs(`/api/files/${s.mix}`, cookie)).status).toBe(200);
          const theirs = (await (await getAs(`/api/reviews/${review.id}`, cookie)).json()) as {
            review: { items: { id: string }[] };
          };
          expect(theirs.review.items.map((i) => i.id)).toEqual([trackItem]);
          // The owner still sees both.
          const ours = (await (await getAs(`/api/reviews/${review.id}`, s.owner)).json()) as {
            review: { items: unknown[] };
          };
          expect(ours.review.items).toHaveLength(2);
        });

        it("lets a guest download only what their review grants", async () => {
          const s = await invited();
          const reviewer = s.review.reviewers.find((r) => r.guest);
          const downloads = `/api/files/${s.mix}/downloads`;
          const ask = (cookie: string) =>
            app.request(downloads, json({ kind: "original" }, cookie));
          // Nothing unless the review says so.
          const none = (await (await getAs(downloads, s.cookie)).json()) as { level: string };
          expect(none.level).toBe("none");
          expect((await ask(s.cookie)).status).toBe(403);
          const granted = await app.request(
            `/api/reviews/${s.review.id}/reviewers/${reviewer?.id}`,
            { ...json({ permissions: { download: "original" } }, s.owner), method: "PATCH" },
          );
          expect(granted.status).toBe(200);
          const asked = await ask(s.cookie);
          expect(asked.status).toBe(201);
          const { url } = (await asked.json()) as { url: string };
          // Not the owner's to open: the link belongs to the guest's session.
          expect((await getAs(url, s.owner)).status).toBe(410);
          const got = await getAs(url, s.cookie);
          expect(got.status).toBe(200);
          expect(got.headers.get("content-disposition")).toContain("attachment");
          // The access log names the review that granted it.
          const [logged] = await db
            .select({ reviewId: schema.accessEvents.reviewId })
            .from(schema.accessEvents)
            .where(
              and(
                eq(schema.accessEvents.action, "download"),
                eq(schema.accessEvents.fileId, s.mix),
              ),
            );
          expect(logged?.reviewId).toBe(s.review.id);
        });

        it("holds each reviewer to what the review grants them", async () => {
          const s = await invited();
          const reviewer = s.review.reviewers.find((r) => r.guest);
          const base = `/api/reviews/${s.review.id}/reviewers/${reviewer?.id}`;
          const patch = (cookie: string, permissions: Record<string, unknown>, path = base) =>
            app.request(path, { ...json({ permissions }, cookie), method: "PATCH" });
          const post = (path: string, body: unknown, cookie: string) =>
            app.request(path, json(body, cookie));
          const comments = `/api/files/${s.mix}/comments`;
          const theirs = (
            (await (await post(comments, { body: "Owner's note" }, s.owner)).json()) as {
              comment: { id: string };
            }
          ).comment.id;
          const mine = (
            (await (await post(comments, { body: "Guest's note" }, s.cookie)).json()) as {
              comment: { id: string };
            }
          ).comment.id;
          await post(comments, { body: "Owner answers", parentId: mine }, s.owner);

          // Only those who manage reviewers adjust them; the guest cannot.
          expect((await patch(s.cookie, { decide: false })).status).toBe(403);
          expect((await patch(s.composer, { decide: false })).status).toBe(403);
          const adjusted = await patch(s.owner, {
            decide: false,
            comments: "own_and_replies",
            tools: ["loops"],
          });
          expect(adjusted.status).toBe(200);
          const shown = (await adjusted.json()) as {
            review: { reviewers: { id: string; permissions: Record<string, unknown> | null }[] };
          };
          expect(
            shown.review.reviewers.find((r) => r.id === reviewer?.id)?.permissions,
          ).toMatchObject({ decide: false, comments: "own_and_replies", tools: ["loops"] });

          // Their own thread and its replies, nothing else; no reply into what they cannot see.
          const seen = (
            (await (await getAs(comments, s.cookie)).json()) as { comments: { body: string }[] }
          ).comments.map((c) => c.body);
          expect(seen).toEqual(["Guest's note", "Owner answers"]);
          expect(
            JSON.stringify(await (await getAs(comments, s.cookie)).json()).includes(
              "guestAuthorId",
            ),
          ).toBe(false);
          expect(
            (await post(comments, { body: "Sneaky", parentId: theirs }, s.cookie)).status,
          ).toBe(422);
          // The owner still sees everything.
          expect(
            ((await (await getAs(comments, s.owner)).json()) as { comments: unknown[] }).comments,
          ).toHaveLength(3);

          // Tools left out are refused, not only hidden; the file says what they have.
          expect((await getAs(`/api/files/${s.mix}/loudness`, s.cookie)).status).toBe(403);
          expect((await getAs(`/api/files/${s.mix}/spectrograms`, s.cookie)).status).toBe(403);
          expect((await getAs(`/api/files/${s.mix}/loudness`, s.owner)).status).not.toBe(403);
          const detail = (await (await getAs(`/api/files/${s.mix}`, s.cookie)).json()) as {
            file: { grant: { tools: string[]; comment: boolean } };
          };
          expect(detail.file.grant).toMatchObject({ tools: ["loops"], comment: true });

          // No decision asked of them.
          const view = (await (await getAs(`/api/reviews/${s.review.id}`, s.cookie)).json()) as {
            review: { you: { canDecide: boolean; permissions: { decide: boolean } } };
          };
          expect(view.review.you).toMatchObject({
            canDecide: false,
            permissions: { decide: false },
          });
          expect(
            (
              await post(
                `/api/reviews/${s.review.id}/decisions`,
                { decision: "approved" },
                s.cookie,
              )
            ).status,
          ).toBe(403);

          // Without comment, writing is refused.
          await patch(s.owner, { comment: false });
          expect((await post(comments, { body: "One more" }, s.cookie)).status).toBe(403);

          // An access window must end after it starts; outside it, the review is closed to them.
          expect(
            (
              await patch(s.owner, {
                startsAt: "2030-01-02T00:00:00Z",
                expiresAt: "2030-01-01T00:00:00Z",
              })
            ).status,
          ).toBe(422);
          await patch(s.owner, { startsAt: "2099-01-01T09:00:00Z" });
          expect((await getAs(`/api/files/${s.mix}`, s.cookie)).status).toBe(404);
          expect((await getAs(`/api/reviews/${s.review.id}`, s.cookie)).status).toBe(404);
          const listed = (await (await getAs("/api/guest/me", s.cookie)).json()) as {
            reviews: { accessOpen: boolean; opensAt: string | null }[];
          };
          expect(listed.reviews[0]).toMatchObject({
            accessOpen: false,
            opensAt: "2099-01-01T09:00:00Z",
          });
          await patch(s.owner, {
            startsAt: null,
            expiresAt: new Date(Date.now() - 1000).toISOString(),
          });
          expect((await getAs(`/api/files/${s.mix}`, s.cookie)).status).toBe(404);
          await patch(s.owner, { expiresAt: null });
          expect((await getAs(`/api/files/${s.mix}`, s.cookie)).status).toBe(200);

          // A member's role is the ceiling, and the review can lower it.
          const composer = s.review.reviewers.find((r) => r.userId === s.ids.composer);
          await patch(
            s.owner,
            { decide: false },
            `/api/reviews/${s.review.id}/reviewers/${composer?.id}`,
          );
          expect(
            (
              await post(
                `/api/reviews/${s.review.id}/decisions`,
                { decision: "approved" },
                s.composer,
              )
            ).status,
          ).toBe(403);

          // Asked for no decision, they follow along: the approval goes on without them.
          const inTurn = await reviewOf(
            await request(s.owner, s.projectId, {
              kind: "approval",
              order: "sequence",
              title: "Final mix",
              items: [{ trackId: s.trackId }],
              reviewers: [s.ids.composer, s.ids.accompanist],
            }),
          );
          expect(inTurn.reviewers.map((r) => r.state)).toEqual(["invited", "waiting"]);
          const first = inTurn.reviewers[0]?.id;
          const moved = await reviewOf(
            await patch(s.owner, { decide: false }, `/api/reviews/${inTurn.id}/reviewers/${first}`),
          );
          expect(moved.reviewers.map((r) => r.state)).toEqual(["observing", "invited"]);
          const settled = await reviewOf(
            await post(
              `/api/reviews/${inTurn.id}/decisions`,
              { decision: "approved" },
              s.accompanist,
            ),
          );
          expect(settled).toMatchObject({ status: "completed", outcome: "approved" });

          // A review can set everyone's permissions when it is asked.
          const restricted = await reviewOf(
            await request(s.owner, s.projectId, {
              kind: "feedback",
              title: "Rough mix",
              items: [{ trackId: s.trackId }],
              reviewers: [s.ids.accompanist],
              permissions: { tools: [], comments: "own" },
            }),
          );
          expect(
            (restricted.reviewers[0] as unknown as { permissions: Record<string, unknown> })
              .permissions,
          ).toMatchObject({ tools: [], comments: "own", comment: true });
          expect(
            (
              await request(s.owner, s.projectId, {
                kind: "feedback",
                title: "Bad window",
                items: [{ trackId: s.trackId }],
                reviewers: [s.ids.accompanist],
                permissions: {
                  startsAt: "2030-01-02T00:00:00Z",
                  expiresAt: "2030-01-01T00:00:00Z",
                },
              })
            ).status,
          ).toBe(422);
        });

        it.runIf(spawnSync("ffmpeg", ["-version"]).status === 0 || process.env.CI)(
          "makes a picture's download for its recipient, with their name drawn across it",
          async () => {
            const s = await invited();
            const drawn = join(mkdtempSync(join(tmpdir(), "hekate-page-")), "white.webp");
            await run("ffmpeg", [
              ...["-hide_banner", "-nostdin", "-v", "error", "-f", "lavfi"],
              ...["-i", "color=white:s=400x560", "-frames:v", "1", "-c:v", "libwebp", drawn],
            ]);
            const white = readFileSync(drawn);
            rmSync(dirname(drawn), { recursive: true, force: true });
            const view = await storage.put(s.organisationId, white);
            await db
              .update(schema.files)
              .set({ kind: "image", contentType: "image/png", streamStatus: "ready", pageCount: 1 })
              .where(eq(schema.files.id, s.mix));
            await db.insert(schema.filePages).values({
              organisationId: s.organisationId,
              fileId: s.mix,
              page: 1,
              width: 400,
              height: 560,
              blobId: view.id,
              thumbBlobId: view.id,
            });
            const reviewer = s.review.reviewers.find((r) => r.guest);
            await app.request(`/api/reviews/${s.review.id}/reviewers/${reviewer?.id}`, {
              ...json({ permissions: { download: "proxy" } }, s.owner),
              method: "PATCH",
            });
            const downloads = `/api/files/${s.mix}/downloads`;
            // The review gives this guest the picture as reviewed, not its original.
            expect(
              (await app.request(downloads, json({ kind: "original" }, s.cookie))).status,
            ).toBe(403);
            const asked = await app.request(downloads, json({ kind: "proxy" }, s.cookie));
            expect(asked.status).toBe(201);
            const { url } = (await asked.json()) as { url: string };
            const got = await getAs(url, s.cookie);
            expect(got.status).toBe(200);
            expect(got.headers.get("content-disposition")).toContain(".webp");
            const served = Buffer.from(await got.arrayBuffer());
            expect(webpComplete(served)).toBe(true);
            expect(served.equals(white)).toBe(false);
          },
        );

        it.runIf(spawnSync("ffmpeg", ["-version"]).status === 0 || process.env.CI)(
          "burns the guest's name into every page they are shown, and only theirs",
          async () => {
            const s = await invited();
            // The review's file, drawn as one white page.
            const drawn = join(mkdtempSync(join(tmpdir(), "hekate-page-")), "white.webp");
            await run("ffmpeg", [
              ...["-hide_banner", "-nostdin", "-v", "error", "-f", "lavfi"],
              ...["-i", "color=white:s=400x560", "-frames:v", "1", "-c:v", "libwebp", drawn],
            ]);
            const white = readFileSync(drawn);
            rmSync(dirname(drawn), { recursive: true, force: true });
            const view = await storage.put(s.organisationId, white);
            const thumb = await storage.put(s.organisationId, white);
            await db
              .update(schema.files)
              .set({
                kind: "document",
                contentType: "application/pdf",
                streamStatus: "ready",
                pageCount: 1,
              })
              .where(eq(schema.files.id, s.mix));
            await db.insert(schema.filePages).values({
              organisationId: s.organisationId,
              fileId: s.mix,
              page: 1,
              width: 400,
              height: 560,
              blobId: view.id,
              thumbBlobId: thumb.id,
            });
            const pagesFor = async (cookie: string) => {
              const res = await app.request(`/api/files/${s.mix}/view`, json({}, cookie));
              expect(res.status).toBe(201);
              return ((await res.json()) as { pages: { url: string; thumbUrl: string }[] })
                .pages[0];
            };
            const theirs = await pagesFor(s.cookie);
            for (const url of [theirs?.url ?? "", theirs?.thumbUrl ?? ""]) {
              const served = Buffer.from(await (await getAs(url, s.cookie)).arrayBuffer());
              expect(webpComplete(served)).toBe(true);
              // Not the stored page: their mark is on it.
              expect(served.equals(white)).toBe(false);
            }
            // A member sees the page as it was drawn.
            const ours = await pagesFor(s.owner);
            const plain = Buffer.from(await (await getAs(ours?.url ?? "", s.owner)).arrayBuffer());
            expect(plain.equals(white)).toBe(true);

            // The project chooses whom it marks (#31): everyone, members too; then no one.
            const [file] = await db
              .select({ projectId: schema.files.projectId })
              .from(schema.files)
              .where(eq(schema.files.id, s.mix));
            const choose = (watermark: object) =>
              app.request(`/api/projects/${file?.projectId}`, {
                ...json({ watermark }, s.owner),
                method: "PATCH",
              });
            expect(
              (await choose({ scope: "everyone", position: "corner", opacity: 50 })).status,
            ).toBe(200);
            const marked = await pagesFor(s.owner);
            const mine = Buffer.from(await (await getAs(marked?.url ?? "", s.owner)).arrayBuffer());
            expect(webpComplete(mine)).toBe(true);
            expect(mine.equals(white)).toBe(false);
            expect((await choose({ scope: "off", position: "tiled", opacity: 30 })).status).toBe(
              200,
            );
            const unmarked = await pagesFor(s.cookie);
            const guestPlain = Buffer.from(
              await (await getAs(unmarked?.url ?? "", s.cookie)).arrayBuffer(),
            );
            expect(guestPlain.equals(white)).toBe(true);
          },
        );

        it("lays the viewer's mark over a video where the project marks them (#31)", async () => {
          const s = await invited();
          await db
            .update(schema.files)
            .set({
              kind: "video",
              mediaInfo: {
                duration: 60,
                video: { codec: "h264", width: 1920, height: 1080, fps: 25 },
              },
            })
            .where(eq(schema.files.id, s.mix));
          const [file] = await db
            .select({ projectId: schema.files.projectId })
            .from(schema.files)
            .where(eq(schema.files.id, s.mix));
          const markOf = async (cookie: string) =>
            (
              (await (await getAs(`/api/files/${s.mix}`, cookie)).json()) as {
                file: { watermark: { text: string; position: string; opacity: number } | null };
              }
            ).file.watermark;
          const choose = (watermark: object, cookie = s.owner) =>
            app.request(`/api/projects/${file?.projectId}`, {
              ...json({ watermark }, cookie),
              method: "PATCH",
            });

          // By default the guest is marked, with their own name; the member is not.
          const guests = await markOf(s.cookie);
          expect(guests).toMatchObject({ position: "tiled", opacity: 30 });
          expect(guests?.text).toMatch(/@example\.test/);
          expect(await markOf(s.owner)).toBeNull();

          // Everyone: the member too. The project's view says what it chose.
          expect(
            (await choose({ scope: "everyone", position: "centre", opacity: 60 })).status,
          ).toBe(200);
          expect(await markOf(s.owner)).toMatchObject({ position: "centre", opacity: 60 });
          const project = (await (
            await getAs(`/api/projects/${file?.projectId}`, s.owner)
          ).json()) as { project: { watermark: unknown } };
          expect(project.project.watermark).toEqual({
            scope: "everyone",
            position: "centre",
            opacity: 60,
          });
          // Off: no one.
          expect((await choose({ scope: "off", position: "tiled", opacity: 30 })).status).toBe(200);
          expect(await markOf(s.cookie)).toBeNull();
          // Out of range, refused; and only those who edit the project choose.
          expect((await choose({ scope: "guests", position: "tiled", opacity: 5 })).status).toBe(
            400,
          );
          const reviewer = await joinAs(s.owner, "reviewer@example.test", "member");
          await grantRole(s.owner, file?.projectId ?? "", reviewer, "Reviewer");
          expect(
            (await choose({ scope: "off", position: "tiled", opacity: 30 }, reviewer)).status,
          ).toBe(403);
        });

        it("keeps a drawing on a video's frame with its comment (#146)", async () => {
          const s = await invited();
          await db
            .update(schema.files)
            .set({
              kind: "video",
              mediaInfo: {
                duration: 60,
                video: { codec: "h264", width: 1920, height: 1080, fps: 25 },
              },
            })
            .where(eq(schema.files.id, s.mix));
          const commented = `/api/files/${s.mix}/comments`;
          const drawn = (at: number, end?: number) => ({
            body: "Lose the boom in the top corner",
            anchor: {
              kind: "region",
              x: 0.6,
              y: 0.05,
              width: 0.3,
              height: 0.2,
              at,
              ...(end === undefined ? {} : { end }),
              drawing: {
                tool: "box",
                colour: "signal",
                points: [
                  [0.6, 0.05],
                  [0.9, 0.25],
                ],
              },
            },
          });
          const posted = await app.request(commented, json(drawn(12.5, 14), s.owner));
          expect(posted.status).toBe(201);
          const { comment } = (await posted.json()) as { comment: { id: string } };
          type Listed = { comments: { id: string; anchor: unknown }[] };
          const listed = ((await (await getAs(commented, s.owner)).json()) as Listed).comments;
          expect(listed.find((c) => c.id === comment.id)?.anchor).toEqual(drawn(12.5, 14).anchor);
          // Past the end of the video, or ending before it starts, is refused.
          expect((await app.request(commented, json(drawn(12.5, 61), s.owner))).status).toBe(422);
          expect((await app.request(commented, json(drawn(14, 12.5), s.owner))).status).toBe(400);
        });

        it("binds a guest's playback to their browser", async () => {
          const s = await invited();
          await db
            .update(schema.files)
            .set({ streamStatus: "ready" })
            .where(eq(schema.files.id, s.mix));
          const started = await app.request(`/api/files/${s.mix}/playback`, json({}, s.cookie));
          expect(started.status).toBe(201);
          const { url } = (await started.json()) as { url: string };
          // Their own browser gets past the link check (there is no rendition yet, so 404).
          expect((await getAs(url, s.cookie)).status).toBe(404);
          // A member's browser cannot use the guest's link.
          expect((await getAs(url, s.owner)).status).toBe(403);
          // The log names the review the guest came through.
          const logged = await audit.query(s.organisationId, {
            action: "stream.session",
            limit: 5,
          });
          expect(logged.events[0]).toMatchObject({ actorType: "guest", reviewId: s.review.id });
          // Once the review closes, the link stops working.
          await app.request(`/api/reviews/${s.review.id}/cancel`, json({}, s.owner));
          expect((await getAs(url, s.cookie)).status).toBe(403);
        });

        it("re-sends and revokes links, and closes access with the review", async () => {
          const s = await invited("feedback");
          const reviewer = s.review.reviewers.find((r) => r.guest);
          const base = `/api/reviews/${s.review.id}/reviewers/${reviewer?.id}`;
          // A fresh link replaces any unused one.
          await app.request(`${base}/link`, json({}, s.owner));
          const first = linkFor("conductor@example.test");
          await app.request(`${base}/link`, json({}, s.owner));
          const second = linkFor("conductor@example.test");
          expect(first).not.toBe(second);
          expect((await signIn(first)).status).toBe(410);
          // An expired link fails too.
          await db.update(schema.guestLinks).set({ expiresAt: new Date(Date.now() - 1000) });
          expect((await signIn(second)).status).toBe(410);

          // Revoking signs every browser out.
          expect((await app.request(`${base}/revoke`, json({}, s.owner))).status).toBe(204);
          expect((await getAs("/api/guest/me", s.cookie)).status).toBe(401);
          expect((await getAs(`/api/reviews/${s.review.id}`, s.cookie)).status).toBe(401);

          // Signed in again, the guest loses the files once the review closes.
          await app.request(`${base}/link`, json({}, s.owner));
          const again = cookieOf(await signIn(linkFor("conductor@example.test")));
          expect((await getAs(`/api/files/${s.mix}`, again)).status).toBe(200);
          await app.request(`/api/reviews/${s.review.id}/cancel`, json({}, s.owner));
          expect((await getAs(`/api/files/${s.mix}`, again)).status).toBe(404);
          // The review itself stays readable, as a record of what they were asked.
          expect((await getAs(`/api/reviews/${s.review.id}`, again)).status).toBe(200);
        });

        it("lists a project's guests on its People page, and acts on them from there", async () => {
          const s = await invited();
          const known = (await (
            await getAs(`/api/projects/${s.projectId}/guests`, s.composer)
          ).json()) as {
            guests: {
              id: string;
              label: string | null;
              reviews: number;
              openReviews: number;
              lastLinkAt: string | null;
              live: boolean;
            }[];
          };
          // Seeing the people is enough to see them, with what this project asks of them.
          const conductor = known.guests[0];
          expect(conductor).toMatchObject({ reviews: 1, openReviews: 1, live: true });
          expect(conductor?.lastLinkAt).not.toBeNull();
          const base = `/api/projects/${s.projectId}/guests/${conductor?.id}`;
          // Acting on them is for whoever manages reviewers.
          expect((await app.request(`${base}/link`, json({}, s.engineer))).status).toBe(403);
          mailer.sent.length = 0;
          expect((await app.request(`${base}/link`, json({}, s.owner))).status).toBe(204);
          expect(linkFor("conductor@example.test")).not.toBe(s.token);
          const relabel = (label: string | null, cookie: string) =>
            app.request(base, { ...json({ label }, cookie), method: "PATCH" });
          expect((await relabel("Soloist", s.engineer)).status).toBe(403);
          expect((await relabel("Soloist", s.owner)).status).toBe(204);
          const [row] = await db
            .select({ label: schema.guests.label })
            .from(schema.guests)
            .where(eq(schema.guests.id, conductor?.id ?? ""));
          expect(row?.label).toBe("Soloist");
          // Another project does not know them.
          const other = (
            (await (
              await app.request(
                "/api/projects",
                json({ name: "Opening titles", profile: "video" }, s.owner),
              )
            ).json()) as { project: { id: string } }
          ).project.id;
          expect(
            (
              await app.request(
                `/api/projects/${other}/guests/${conductor?.id}/revoke`,
                json({}, s.owner),
              )
            ).status,
          ).toBe(404);
          // Revoking signs them out everywhere, and is logged against the project.
          expect((await app.request(`${base}/revoke`, json({}, s.owner))).status).toBe(204);
          expect((await getAs("/api/guest/me", s.cookie)).status).toBe(401);
          const logged = await audit.query(s.organisationId, { action: "guest.revoke", limit: 1 });
          expect(logged.events[0]).toMatchObject({ projectId: s.projectId });
          // With the review closed, no review asks them, so there is no link to send.
          await app.request(`/api/reviews/${s.review.id}/cancel`, json({}, s.owner));
          expect((await app.request(`${base}/link`, json({}, s.owner))).status).toBe(409);
        });

        it("keeps a guest to their own organisation", async () => {
          const s = await invited();
          const [elsewhere] = await db
            .insert(schema.organisations)
            .values({ name: "Elsewhere", slug: "elsewhere-guests" })
            .returning();
          const [project] = await db
            .insert(schema.projects)
            .values({ organisationId: elsewhere?.id ?? "", name: "Theirs", profile: "music" })
            .returning();
          const [foreign] = await db
            .insert(schema.reviews)
            .values({
              organisationId: elsewhere?.id ?? "",
              projectId: project?.id ?? "",
              kind: "feedback",
              title: "Theirs",
            })
            .returning();
          expect((await getAs(`/api/reviews/${foreign?.id}`, s.cookie)).status).toBe(404);
        });
      });

      it("lists a member's reviews, open first, saying whose turn it is", async () => {
        const s = await studio();
        const make = (title: string) =>
          request(s.owner, s.projectId, {
            kind: "approval",
            title,
            order: "sequence",
            items: [{ trackId: s.trackId }],
            reviewers: [s.ids.composer, s.ids.accompanist],
          });
        const first = await reviewOf(await make("Album master"));
        const second = await reviewOf(await make("Single edit"));
        await app.request(`/api/reviews/${second.id}/cancel`, json({}, s.owner));
        const mine = async (cookie: string) =>
          (
            (await (await getAs("/api/reviews", cookie)).json()) as {
              reviews: {
                id: string;
                title: string;
                status: string;
                yourTurn: boolean;
                projectName: string;
              }[];
            }
          ).reviews;
        const composer = await mine(s.composer);
        expect(composer.map((r) => [r.title, r.status, r.yourTurn])).toEqual([
          ["Album master", "open", true],
          ["Single edit", "cancelled", false],
        ]);
        expect(composer[0]?.projectName).toBe("Rags");
        // The accompanist is second in turn: listed, but not yet theirs.
        expect((await mine(s.accompanist)).find((r) => r.id === first.id)?.yourTurn).toBe(false);
        // Someone who reviews nothing sees nothing; losing the project hides its reviews.
        expect(await mine(s.engineer)).toEqual([]);
        await db
          .delete(schema.projectMembers)
          .where(eq(schema.projectMembers.organisationId, s.organisationId));
        expect(await mine(s.composer)).toEqual([]);
      });

      describe("groups", () => {
        interface GroupBody {
          id: string;
          name: string;
          members: { userId: string | null; name: string; guest: boolean; label: string | null }[];
        }
        const conductor = {
          name: "Ines Arlow",
          email: "conductor@example.test",
          label: "Conductor",
        };
        const makeGroup = (cookie: string, projectId: string, body: Record<string, unknown>) =>
          app.request(`/api/projects/${projectId}/groups`, json(body, cookie));
        const groupOf = async (res: Response) => ((await res.json()) as { group: GroupBody }).group;

        it("keeps named sets of members and guests, for those who manage reviewers", async () => {
          const s = await studio();
          const made = await makeGroup(s.owner, s.projectId, {
            name: "Soloists",
            members: [s.ids.composer, conductor],
          });
          expect(made.status).toBe(201);
          const soloists = await groupOf(made);
          expect(soloists.members).toMatchObject([
            { userId: s.ids.composer, guest: false },
            { userId: null, name: "Ines Arlow", guest: true, label: "Conductor" },
          ]);
          // Anyone who can see the project sees its groups; only some may change them.
          const listed = (await (
            await getAs(`/api/projects/${s.projectId}/groups`, s.engineer)
          ).json()) as { groups: GroupBody[] };
          expect(listed.groups.map((g) => g.name)).toEqual(["Soloists"]);
          expect(
            (await makeGroup(s.engineer, s.projectId, { name: "Mine", members: [s.ids.composer] }))
              .status,
          ).toBe(403);
          expect(
            (await makeGroup(s.owner, s.projectId, { name: "Soloists", members: [s.ids.composer] }))
              .status,
          ).toBe(409);
          // Members must be able to see the project.
          const stranger = await joinAs(s.owner, "stranger@example.test");
          expect(
            (
              await makeGroup(s.owner, s.projectId, {
                name: "Strangers",
                members: [await idOf(stranger)],
              })
            ).status,
          ).toBe(422);
          // Editing replaces the people; deleting goes.
          const edited = await groupOf(
            await app.request(`/api/projects/${s.projectId}/groups/${soloists.id}`, {
              ...json({ name: "Principals", members: [s.ids.accompanist] }, s.owner),
              method: "PUT",
            }),
          );
          expect(edited).toMatchObject({
            name: "Principals",
            members: [{ userId: s.ids.accompanist }],
          });
          expect(
            (
              await app.request(`/api/projects/${s.projectId}/groups/${soloists.id}`, {
                method: "DELETE",
                headers: { cookie: s.engineer },
              })
            ).status,
          ).toBe(403);
          expect(
            (
              await app.request(`/api/projects/${s.projectId}/groups/${soloists.id}`, {
                method: "DELETE",
                headers: { cookie: s.owner },
              })
            ).status,
          ).toBe(204);
          // Someone without a role in the project cannot reach them.
          expect((await getAs(`/api/projects/${s.projectId}/groups`, stranger)).status).toBe(404);

          // Another organisation's groups do not exist from here, nor can they be asked.
          const [elsewhere] = await db
            .insert(schema.organisations)
            .values({ name: "Elsewhere", slug: "elsewhere-groups" })
            .returning();
          const [theirProject] = await db
            .insert(schema.projects)
            .values({ organisationId: elsewhere?.id ?? "", name: "Theirs", profile: "music" })
            .returning();
          const [theirGroup] = await db
            .insert(schema.groups)
            .values({
              organisationId: elsewhere?.id ?? "",
              projectId: theirProject?.id ?? "",
              name: "Their soloists",
            })
            .returning();
          const theirs = `/api/projects/${theirProject?.id}/groups`;
          expect((await getAs(theirs, s.owner)).status).toBe(404);
          expect(
            (
              await makeGroup(s.owner, theirProject?.id ?? "", {
                name: "Mine",
                members: [s.ids.composer],
              })
            ).status,
          ).toBe(404);
          for (const path of [
            `${theirs}/${theirGroup?.id}`,
            `/api/projects/${s.projectId}/groups/${theirGroup?.id}`,
          ]) {
            expect(
              (
                await app.request(path, {
                  ...json({ name: "Taken", members: [s.ids.composer] }, s.owner),
                  method: "PUT",
                })
              ).status,
            ).toBe(404);
            expect(
              (await app.request(path, { method: "DELETE", headers: { cookie: s.owner } })).status,
            ).toBe(404);
          }
          expect(
            (
              await request(s.owner, s.projectId, {
                kind: "feedback",
                title: "Mix",
                items: [{ trackId: s.trackId }],
                reviewers: [{ groupId: theirGroup?.id }],
              })
            ).status,
          ).toBe(422);
          const [still] = await db
            .select()
            .from(schema.groups)
            .where(eq(schema.groups.id, theirGroup?.id ?? ""));
          expect(still?.name).toBe("Their soloists");
        });

        it("asks a group as one step of a sequence", async () => {
          const s = await studio();
          const soloists = await groupOf(
            await makeGroup(s.owner, s.projectId, {
              name: "Soloists",
              members: [s.ids.composer, conductor],
            }),
          );
          mailer.sent.length = 0;
          const review = await reviewOf(
            await request(s.owner, s.projectId, {
              kind: "approval",
              title: "Album master",
              order: "sequence",
              items: [{ trackId: s.trackId }],
              // The composer, named again, is asked once: with the group.
              reviewers: [{ groupId: soloists.id }, s.ids.accompanist, s.ids.composer],
            }),
          );
          const reviewers = review.reviewers as (ReviewBody["reviewers"][number] & {
            group: { name: string } | null;
            step: number;
          })[];
          expect(reviewers.map((r) => [r.group?.name ?? null, r.step, r.state])).toEqual([
            ["Soloists", 0, "invited"],
            ["Soloists", 0, "invited"],
            [null, 1, "waiting"],
          ]);
          // Both of the group are asked at once; the accompanist waits.
          expect(mailer.sent.map((m) => m.to).sort()).toEqual([
            "composer@example.test",
            "conductor@example.test",
          ]);
          const path = `/api/reviews/${review.id}`;
          const afterOne = await reviewOf(
            await app.request(`${path}/decisions`, json({ decision: "approved" }, s.composer)),
          );
          expect(afterOne.reviewers.map((r) => r.state)).toEqual([
            "submitted",
            "invited",
            "waiting",
          ]);
          // The guest completes the group's step, and the accompanist's turn comes.
          const token =
            [...mailer.sent]
              .reverse()
              .find((m) => m.to === "conductor@example.test")
              ?.text.match(/\/guest\/([A-Za-z0-9_-]+)/)?.[1] ?? "";
          const guest = cookieOf(await app.request("/api/guest/sessions", json({ token })));
          mailer.sent.length = 0;
          const afterGroup = await reviewOf(
            await app.request(`${path}/decisions`, json({ decision: "approved" }, guest)),
          );
          expect(afterGroup.reviewers.map((r) => r.state)).toEqual([
            "submitted",
            "submitted",
            "invited",
          ]);
          expect(mailer.sent.map((m) => m.to)).toEqual([
            "accompanist@example.test",
            "producer@example.test",
          ]);
        });

        it("checks a group's people when it is asked, and adds a group as a later step", async () => {
          const s = await studio();
          const crew = await groupOf(
            await makeGroup(s.owner, s.projectId, {
              name: "Crew",
              members: [s.ids.engineer, s.ids.accompanist],
            }),
          );
          const base = { title: "Mix", items: [{ trackId: s.trackId }] };
          // An engineer cannot decide, so the crew cannot review an approval; feedback is fine.
          const refused = await request(s.owner, s.projectId, {
            ...base,
            kind: "approval",
            reviewers: [{ groupId: crew.id }],
          });
          expect(refused.status).toBe(422);
          expect(
            ((await refused.json()) as { error: { message: string } }).error.message,
          ).toContain("In Crew:");
          const review = await reviewOf(
            await request(s.owner, s.projectId, {
              ...base,
              kind: "feedback",
              order: "sequence",
              reviewers: [s.ids.composer],
            }),
          );
          const path = `/api/reviews/${review.id}`;
          const added = await reviewOf(
            await app.request(`${path}/reviewers`, json({ groupId: crew.id }, s.owner)),
          );
          expect(added.reviewers.map((r) => r.state)).toEqual(["invited", "waiting", "waiting"]);
          expect(
            (await app.request(`${path}/reviewers`, json({ groupId: crew.id }, s.owner))).status,
          ).toBe(409);
          // A group from another project is refused.
          const other = await app.request(
            "/api/projects",
            json({ name: "Elite", profile: "music" }, s.owner),
          );
          const otherId = ((await other.json()) as { project: { id: string } }).project.id;
          const elsewhere = await groupOf(
            await makeGroup(s.owner, otherId, { name: "Crew", members: [conductor] }),
          );
          expect(
            (
              await request(s.owner, s.projectId, {
                ...base,
                kind: "feedback",
                reviewers: [{ groupId: elsewhere.id }],
              })
            ).status,
          ).toBe(422);
          // Deleting the group leaves the review's reviewers in place.
          await app.request(`/api/projects/${s.projectId}/groups/${crew.id}`, {
            method: "DELETE",
            headers: { cookie: s.owner },
          });
          const after = (await (await getAs(path, s.owner)).json()) as {
            review: { reviewers: { group: unknown }[] };
          };
          expect(after.review.reviewers.map((r) => r.group)).toEqual([null, null, null]);
        });
      });
    });

    describe("folders", () => {
      const send = (method: string, path: string, body: unknown, cookie: string) =>
        app.request(path, { ...json(body, cookie), method });
      const remove = (path: string, cookie: string) =>
        app.request(path, { method: "DELETE", headers: { cookie } });
      interface Folder {
        id: string;
        parentId: string | null;
        name: string;
      }

      /** A project with two loose files, and a colleague with the given role in it. */
      const library = async (role: string) => {
        const owner = cookieOf(await setup());
        const me = (await (
          await app.request("/api/me", { headers: { cookie: owner } })
        ).json()) as {
          activeOrganisationId: string;
        };
        const organisationId = me.activeOrganisationId;
        const made = await app.request(
          "/api/projects",
          json({ name: "Rags", profile: "music" }, owner),
        );
        const projectId = ((await made.json()) as { project: { id: string } }).project.id;
        const file = async (name: string) => {
          const blob = await storage.put(organisationId, Buffer.from(name));
          const [row] = await db
            .insert(schema.files)
            .values({
              organisationId,
              projectId,
              name,
              kind: "audio",
              blobId: blob.id,
              contentType: "audio/wav",
              byteSize: blob.byteSize,
            })
            .returning();
          return row?.id ?? "";
        };
        const { body } = await invite(owner, "colleague@example.test", "member");
        const colleague = cookieOf(
          await app.request(
            `/api/invitations/${tokenFrom(body.link)}/accept`,
            json({ name: "Colleague", password: "correct horse battery" }),
          ),
        );
        await grantRole(owner, projectId, colleague, role);
        return {
          owner,
          colleague,
          organisationId,
          projectId,
          mix: await file("Mix v3.wav"),
          stem: await file("Drums.wav"),
        };
      };
      const folderOf = async (res: Response) => ((await res.json()) as { folder: Folder }).folder;

      it("nests, renames and moves folders, never into themselves", async () => {
        const s = await library("Reviewer");
        const base = `/api/projects/${s.projectId}/folders`;
        const mixes = await folderOf(await app.request(base, json({ name: "Mixes" }, s.owner)));
        const stems = await folderOf(
          await app.request(base, json({ name: "Stems", parentId: mixes.id }, s.owner)),
        );
        expect(stems.parentId).toBe(mixes.id);
        // One name per place, at the top as below.
        expect((await app.request(base, json({ name: "Mixes" }, s.owner))).status).toBe(409);
        expect(
          (await app.request(base, json({ name: "Stems", parentId: mixes.id }, s.owner))).status,
        ).toBe(409);
        expect((await app.request(base, json({ name: "Stems" }, s.owner))).status).toBe(201);
        // A folder cannot go inside itself or below itself.
        expect(
          (await send("PATCH", `/api/folders/${mixes.id}`, { parentId: stems.id }, s.owner)).status,
        ).toBe(422);
        expect(
          (await send("PATCH", `/api/folders/${mixes.id}`, { parentId: mixes.id }, s.owner)).status,
        ).toBe(422);
        const renamed = await folderOf(
          await send(
            "PATCH",
            `/api/folders/${stems.id}`,
            { name: "Stems (final)", parentId: null },
            s.owner,
          ),
        );
        expect(renamed).toMatchObject({ name: "Stems (final)", parentId: null });
        // A Reviewer sees folders but cannot organise them.
        const seen = (await (
          await app.request(base, { headers: { cookie: s.colleague } })
        ).json()) as { folders: Folder[] };
        expect(seen.folders.map((f) => f.name)).toEqual(["Mixes", "Stems", "Stems (final)"]);
        expect((await app.request(base, json({ name: "Mine" }, s.colleague))).status).toBe(403);
        expect(
          (await send("PATCH", `/api/folders/${mixes.id}`, { name: "Theirs" }, s.colleague)).status,
        ).toBe(403);
        expect((await remove(`/api/folders/${mixes.id}`, s.colleague)).status).toBe(403);
        // Another project's folder is not a place to put things.
        const other = await app.request(
          "/api/projects",
          json({ name: "Elite", profile: "music" }, s.owner),
        );
        const otherId = ((await other.json()) as { project: { id: string } }).project.id;
        const elsewhere = await folderOf(
          await app.request(`/api/projects/${otherId}/folders`, json({ name: "Theirs" }, s.owner)),
        );
        expect(
          (await send("PATCH", `/api/folders/${mixes.id}`, { parentId: elsewhere.id }, s.owner))
            .status,
        ).toBe(422);
        expect(
          (await send("PATCH", `/api/files/${s.mix}`, { folderId: elsewhere.id }, s.owner)).status,
        ).toBe(422);
      });

      it("moves and renames files, and keeps them when their folder goes", async () => {
        const s = await library("Engineer");
        const base = `/api/projects/${s.projectId}/folders`;
        const mixes = await folderOf(await app.request(base, json({ name: "Mixes" }, s.owner)));
        const stems = await folderOf(
          await app.request(base, json({ name: "Stems", parentId: mixes.id }, s.owner)),
        );
        // An Engineer organises.
        const moved = (await (
          await send(
            "PATCH",
            `/api/files/${s.stem}`,
            { folderId: stems.id, name: "Kit.wav" },
            s.colleague,
          )
        ).json()) as { file: { folderId: string; name: string } };
        expect(moved.file).toMatchObject({ folderId: stems.id, name: "Kit.wav" });
        await send("PATCH", `/api/files/${s.mix}`, { folderId: mixes.id }, s.colleague);
        // Deleting Mixes takes Stems with it, and both files move up to the top.
        const gone = (await (await remove(`/api/folders/${mixes.id}`, s.owner)).json()) as {
          moved: number;
        };
        expect(gone.moved).toBe(2);
        const listed = (await (
          await app.request(`/api/projects/${s.projectId}/files`, { headers: { cookie: s.owner } })
        ).json()) as { files: { id: string; folderId: string | null }[] };
        expect(listed.files.map((f) => f.folderId)).toEqual([null, null]);
        const left = (await (await app.request(base, { headers: { cookie: s.owner } })).json()) as {
          folders: Folder[];
        };
        expect(left.folders).toEqual([]);

        // Tracks sit in folders too: made in one, moved out, and moved up with a deleted folder.
        const scores = await folderOf(await app.request(base, json({ name: "Rags" }, s.owner)));
        const made = await app.request(
          `/api/projects/${s.projectId}/tracks`,
          json({ name: "Maple Leaf Rag", folderId: scores.id }, s.owner),
        );
        const track = ((await made.json()) as { track: { id: string; folderId: string } }).track;
        expect(track.folderId).toBe(scores.id);
        const other = await app.request(
          "/api/projects",
          json({ name: "Elite", profile: "music" }, s.owner),
        );
        const otherId = ((await other.json()) as { project: { id: string } }).project.id;
        const elsewhere = await folderOf(
          await app.request(`/api/projects/${otherId}/folders`, json({ name: "Theirs" }, s.owner)),
        );
        expect(
          (await send("PATCH", `/api/tracks/${track.id}`, { folderId: elsewhere.id }, s.owner))
            .status,
        ).toBe(422);
        await remove(`/api/folders/${scores.id}`, s.owner);
        const after = (await (
          await app.request(`/api/tracks/${track.id}`, { headers: { cookie: s.owner } })
        ).json()) as { track: { folderId: string | null } };
        expect(after.track.folderId).toBeNull();
      });

      it("deletes a loose file, logged, but not one in a version or a review", async () => {
        const s = await library("Reviewer");
        // A Reviewer cannot delete.
        expect((await remove(`/api/files/${s.stem}`, s.colleague)).status).toBe(403);
        // In a track's version: refused.
        const track = await app.request(
          `/api/projects/${s.projectId}/tracks`,
          json({ name: "Maple Leaf Rag" }, s.owner),
        );
        const trackId = ((await track.json()) as { track: { id: string } }).track.id;
        await app.request(
          `/api/tracks/${trackId}/versions`,
          json({ variations: [{ fileId: s.mix, name: "Mix" }] }, s.owner),
        );
        const inVersion = await remove(`/api/files/${s.mix}`, s.owner);
        expect(inVersion.status).toBe(409);
        // In a review: refused.
        const [review] = await db
          .insert(schema.reviews)
          .values({
            organisationId: s.organisationId,
            projectId: s.projectId,
            kind: "feedback",
            title: "Stems",
          })
          .returning();
        await db.insert(schema.reviewItems).values({
          organisationId: s.organisationId,
          reviewId: review?.id ?? "",
          fileId: s.stem,
        });
        expect((await remove(`/api/files/${s.stem}`, s.owner)).status).toBe(409);
        await db.delete(schema.reviews).where(eq(schema.reviews.id, review?.id ?? ""));
        // Loose: deleted, and in the log.
        expect((await remove(`/api/files/${s.stem}`, s.owner)).status).toBe(204);
        expect(
          (await app.request(`/api/files/${s.stem}`, { headers: { cookie: s.owner } })).status,
        ).toBe(404);
        const logged = await audit.query(s.organisationId, { action: "file.delete", limit: 5 });
        expect(logged.events[0]?.details).toMatchObject({ fileId: s.stem, name: "Drums.wav" });
      });
    });

    describe("comments", () => {
      const joinAs = async (owner: string, email: string, role: string) => {
        const { body } = await invite(owner, email, role);
        const res = await app.request(
          `/api/invitations/${tokenFrom(body.link)}/accept`,
          json({ name: "Colleague", password: "correct horse battery" }),
        );
        return cookieOf(res);
      };
      const send = (method: string, path: string, body: unknown, cookie?: string) =>
        app.request(path, { ...json(body, cookie), method });
      const list = async (fileId: string, cookie: string) =>
        (
          (await (
            await app.request(`/api/files/${fileId}/comments`, { headers: { cookie } })
          ).json()) as {
            comments: { id: string; parentId: string | null; body: string; authorName: string }[];
          }
        ).comments;

      /** A minute-long recording in a new project of the given organisation. */
      const recording = async (organisationId: string, profile: "music" | "video" = "music") => {
        const [project] = await db
          .insert(schema.projects)
          .values({ organisationId, name: "Rags", profile })
          .returning();
        const blob = await storage.put(organisationId, Buffer.from("not really audio"));
        const [file] = await db
          .insert(schema.files)
          .values({
            organisationId,
            projectId: project?.id ?? "",
            name: "Mix v3.wav",
            kind: "audio",
            blobId: blob.id,
            contentType: "audio/wav",
            byteSize: blob.byteSize,
            mediaInfo: {
              duration: 60,
              audio: { codec: "pcm_s24le", channels: 2, sampleRate: 48000 },
            },
          })
          .returning();
        return file?.id ?? "";
      };
      const organisationOf = async (cookie: string) =>
        (
          (await (await app.request("/api/me", { headers: { cookie } })).json()) as {
            activeOrganisationId: string;
          }
        ).activeOrganisationId;

      it("keeps threads on a file, anchored where the file has a timeline", async () => {
        const owner = cookieOf(await setup());
        const fileId = await recording(await organisationOf(owner));
        const path = `/api/files/${fileId}/comments`;

        const started = await app.request(
          path,
          json({ body: "Pedal noise here", anchor: { kind: "time", start: 10, end: 12 } }, owner),
        );
        expect(started.status).toBe(201);
        const thread = ((await started.json()) as { comment: { id: string; authorName: string } })
          .comment;
        expect(thread.authorName).toBe("Producer");

        // Past the end of the recording, or a page on audio: refused.
        expect(
          (
            await app.request(
              path,
              json({ body: "x", anchor: { kind: "time", start: 90, end: 91 } }, owner),
            )
          ).status,
        ).toBe(422);
        expect(
          (
            await app.request(
              path,
              json(
                { body: "x", anchor: { kind: "region", page: 1, x: 0, y: 0, width: 1, height: 1 } },
                owner,
              ),
            )
          ).status,
        ).toBe(422);

        const reply = await app.request(
          path,
          json({ body: "Fixed in v4", parentId: thread.id }, owner),
        );
        expect(reply.status).toBe(201);
        const replyId = ((await reply.json()) as { comment: { id: string } }).comment.id;
        // Threads are one level deep, and replies take the thread's anchor.
        expect(
          (await app.request(path, json({ body: "x", parentId: replyId }, owner))).status,
        ).toBe(422);
        expect(
          (
            await app.request(
              path,
              json(
                { body: "x", parentId: thread.id, anchor: { kind: "time", start: 1, end: 1 } },
                owner,
              ),
            )
          ).status,
        ).toBe(400);
        // A whole-file comment needs no anchor.
        expect(
          (await app.request(path, json({ body: "Lovely balance overall" }, owner))).status,
        ).toBe(201);

        expect((await list(fileId, owner)).map((c) => [c.body, c.parentId === thread.id])).toEqual([
          ["Pedal noise here", false],
          ["Fixed in v4", true],
          ["Lovely balance overall", false],
        ]);
      });

      it("points at bars in music projects only, from the upbeat on", async () => {
        const owner = cookieOf(await setup());
        const organisationId = await organisationOf(owner);
        const music = await recording(organisationId);
        const film = await recording(organisationId, "video");
        const bars = (from: number, to?: number) => ({
          kind: "bar",
          from: { bar: from },
          ...(to === undefined ? {} : { to: { bar: to } }),
        });

        // An upbeat is bar 0, and a range covers a passage.
        for (const anchor of [bars(0), bars(9, 12)]) {
          const res = await send(
            "POST",
            `/api/files/${music}/comments`,
            { body: "x", anchor },
            owner,
          );
          expect(res.status).toBe(201);
        }
        expect(
          (
            await send(
              "POST",
              `/api/files/${music}/comments`,
              { body: "x", anchor: bars(12, 9) },
              owner,
            )
          ).status,
        ).toBe(400);
        // A video project has no bars.
        const refused = await send(
          "POST",
          `/api/files/${film}/comments`,
          { body: "x", anchor: bars(3) },
          owner,
        );
        expect(refused.status).toBe(422);
        expect(await refused.text()).toMatch(/no bar references/);

        // The file page learns the profile, so it offers bars only where they belong.
        const profileOf = async (id: string) =>
          (
            (await (
              await app.request(`/api/files/${id}`, { headers: { cookie: owner } })
            ).json()) as {
              file: { profile: string };
            }
          ).file.profile;
        expect(await profileOf(music)).toBe("music");
        expect(await profileOf(film)).toBe("video");
      });

      it("takes the pages, bars and beats its project chooses, set by those who edit it (#240)", async () => {
        const owner = cookieOf(await setup());
        const organisationId = await organisationOf(owner);
        const music = await recording(organisationId);
        const film = await recording(organisationId, "video");
        const comment = (fileId: string, anchor: object) =>
          send("POST", `/api/files/${fileId}/comments`, { body: "x", anchor }, owner);
        const referencesOf = async (fileId: string) =>
          (
            (await (
              await app.request(`/api/files/${fileId}`, { headers: { cookie: owner } })
            ).json()) as { file: { references: unknown } }
          ).file.references;
        const onPage = { kind: "bar", from: { bar: 9, beat: 3 }, page: 2 };

        // A music project takes them all until it chooses; a video project, none.
        expect(await referencesOf(music)).toEqual({ page: true, bar: true, beat: true });
        expect(await referencesOf(film)).toEqual({ page: false, bar: false, beat: false });
        expect((await comment(music, onPage)).status).toBe(201);

        // Pages and beats off: bars alone still land.
        const musicProject = await projectOfFile(music);
        const patch = (references: object, who = owner) =>
          send("PATCH", `/api/projects/${musicProject}`, { references }, who);
        const changed = await patch({ page: false, bar: true, beat: false });
        expect(changed.status).toBe(200);
        expect(
          ((await changed.json()) as { project: { references: unknown } }).project.references,
        ).toEqual({ page: false, bar: true, beat: false });
        const noPage = await comment(music, { kind: "bar", from: { bar: 9 }, page: 2 });
        expect(noPage.status).toBe(422);
        expect(await noPage.text()).toMatch(/no page references/);
        const noBeat = await comment(music, { kind: "bar", from: { bar: 9, beat: 3 } });
        expect(noBeat.status).toBe(422);
        expect(await noBeat.text()).toMatch(/no beats/);
        expect((await comment(music, { kind: "bar", from: { bar: 9 } })).status).toBe(201);

        // Bars off: none at all. A video project may take them.
        expect((await patch({ page: false, bar: false, beat: false })).status).toBe(200);
        expect((await comment(music, { kind: "bar", from: { bar: 9 } })).status).toBe(422);
        expect(
          (
            await send(
              "PATCH",
              `/api/projects/${await projectOfFile(film)}`,
              { references: { page: true, bar: true, beat: true } },
              owner,
            )
          ).status,
        ).toBe(200);
        expect((await comment(film, onPage)).status).toBe(201);

        // Only those who edit the project choose; a reviewer is refused.
        const reviewer = await joinAs(owner, "reviewer@example.test", "member");
        await grantRole(owner, musicProject, reviewer, "Reviewer");
        expect((await patch({ page: true, bar: true, beat: true }, reviewer)).status).toBe(403);
        expect(await referencesOf(music)).toEqual({ page: false, bar: false, beat: false });
      });

      it("lets a track choose its own references over its project's, and refuses another organisation (#240)", async () => {
        const owner = cookieOf(await setup());
        const organisationId = await organisationOf(owner);
        const fileId = await recording(organisationId);
        const projectId = await projectOfFile(fileId);
        // The recording is a variation of the track's first version.
        const [track] = await db
          .insert(schema.tracks)
          .values({ organisationId, projectId, name: "Maple Leaf Rag" })
          .returning();
        const [version] = await db
          .insert(schema.versions)
          .values({ organisationId, trackId: track?.id ?? "", number: 1 })
          .returning();
        await db
          .insert(schema.variations)
          .values({ organisationId, versionId: version?.id ?? "", fileId, name: "Dry" });
        const choose = (references: object | null, who = owner, id = track?.id) =>
          send("PUT", `/api/tracks/${id}/references`, { references }, who);
        const bar = (anchor: object) =>
          send("POST", `/api/files/${fileId}/comments`, { body: "x", anchor }, owner);
        const referencesOf = async () =>
          (
            (await (
              await app.request(`/api/files/${fileId}`, { headers: { cookie: owner } })
            ).json()) as { file: { references: unknown } }
          ).file.references;

        // The project takes no bars; the track takes bars without beats.
        expect(
          (
            await send(
              "PATCH",
              `/api/projects/${projectId}`,
              { references: { page: false, bar: false, beat: false } },
              owner,
            )
          ).status,
        ).toBe(200);
        expect((await bar({ kind: "bar", from: { bar: 9 } })).status).toBe(422);
        const chosen = await choose({ page: false, bar: true, beat: false });
        expect(chosen.status).toBe(200);
        expect(
          ((await chosen.json()) as { track: { commentReferences: unknown } }).track
            .commentReferences,
        ).toEqual({ page: false, bar: true, beat: false });
        expect(await referencesOf()).toEqual({ page: false, bar: true, beat: false });
        expect((await bar({ kind: "bar", from: { bar: 9 } })).status).toBe(201);
        expect((await bar({ kind: "bar", from: { bar: 9, beat: 2 } })).status).toBe(422);

        // Back to the project's: no bars again.
        expect((await choose(null)).status).toBe(200);
        expect(await referencesOf()).toEqual({ page: false, bar: false, beat: false });

        // A reviewer may not choose, and another workspace cannot find the track.
        const reviewer = await joinAs(owner, "reviewer@example.test", "member");
        await grantRole(owner, projectId, reviewer, "Reviewer");
        expect((await choose({ page: true, bar: true, beat: true }, reviewer)).status).toBe(403);
        const [other] = await db
          .insert(schema.organisations)
          .values({ name: "Elsewhere", slug: "elsewhere-references" })
          .returning();
        const [foreign] = await db
          .insert(schema.tracks)
          .values({
            organisationId: other?.id ?? "",
            projectId: await projectOfFile(await recording(other?.id ?? "")),
            name: "Theirs",
          })
          .returning();
        expect(
          (await choose({ page: true, bar: true, beat: true }, owner, foreign?.id)).status,
        ).toBe(404);
      });

      it("plays recordings normalised as the project says, and only the volume reaches the browser (#240)", async () => {
        const owner = cookieOf(await setup());
        const organisationId = await organisationOf(owner);
        const fileId = await recording(organisationId);
        const projectId = await projectOfFile(fileId);
        // Measured at -8 LUFS, delivered for streaming at -14: 6 dB down.
        const blob = await storage.put(organisationId, Buffer.from("not really loudness"));
        await db.insert(schema.loudness).values({
          organisationId,
          fileId,
          summary: {
            integrated: -8,
            range: 6,
            momentaryMax: -4,
            shortTermMax: -6,
            truePeak: -1,
            channels: [],
          },
          channels: 2,
          sampleRate: 48000,
          samplesPerFrame: 4800,
          frameCount: 600,
          blobId: blob.id,
        });
        await db
          .update(schema.projects)
          .set({ deliveryProfile: "streaming" })
          .where(eq(schema.projects.id, projectId));
        const normalisationOf = async (cookie: string) =>
          (
            (await (await app.request(`/api/files/${fileId}`, { headers: { cookie } })).json()) as {
              file: { normalisation: { mode: string; target: number; gain: number } | null };
            }
          ).file.normalisation;
        const choose = (normalisation: string, who = owner) =>
          send("PATCH", `/api/projects/${projectId}`, { normalisation }, who);
        const viewer = await joinAs(owner, "viewer@example.test", "member");
        await grantRole(owner, projectId, viewer, "Viewer");
        // As a new project's Viewer: the score, and no normalising.
        await db
          .update(schema.projectRoles)
          .set({ tools: ["score"] })
          .where(
            and(
              eq(schema.projectRoles.projectId, projectId),
              eq(schema.projectRoles.name, "Viewer"),
            ),
          );

        // Off until the project chooses.
        expect(await normalisationOf(owner)).toBeNull();

        // Each person's choice: offered to a role with the tool, not to a Viewer.
        expect((await choose("optional")).status).toBe(200);
        const offered = await normalisationOf(owner);
        expect(offered).toMatchObject({ mode: "optional", target: -14 });
        expect(offered?.gain).toBeCloseTo(0.501, 3);
        expect(offered).not.toHaveProperty("integrated");
        expect(await normalisationOf(viewer)).toBeNull();

        // Always: everyone hears it normalised.
        expect((await choose("forced")).status).toBe(200);
        expect(await normalisationOf(viewer)).toMatchObject({ mode: "forced", target: -14 });

        // A profile without a loudness target leaves the recording as it is.
        await db
          .update(schema.projects)
          .set({ deliveryProfile: "cd" })
          .where(eq(schema.projects.id, projectId));
        expect(await normalisationOf(owner)).toBeNull();

        // Only those who edit the project choose.
        expect((await choose("off", viewer)).status).toBe(403);
        expect(
          (
            (await (
              await app.request(`/api/projects/${projectId}`, { headers: { cookie: owner } })
            ).json()) as { project: { normalisation: string } }
          ).project.normalisation,
        ).toBe("forced");
      });

      it("lets a track play normalised otherwise than its project (#98)", async () => {
        const owner = cookieOf(await setup());
        const organisationId = await organisationOf(owner);
        const fileId = await recording(organisationId);
        const projectId = await projectOfFile(fileId);
        const blob = await storage.put(organisationId, Buffer.from("not really loudness"));
        // A take of the track, measured as the mix is.
        const [takeFile] = await db
          .insert(schema.files)
          .values({
            organisationId,
            projectId,
            name: "Take 1.wav",
            kind: "audio",
            blobId: (await storage.put(organisationId, Buffer.from("take"))).id,
            contentType: "audio/wav",
            byteSize: 4,
            mediaInfo: {
              duration: 60,
              audio: { codec: "pcm_s24le", channels: 2, sampleRate: 48000 },
            },
          })
          .returning({ id: schema.files.id });
        const takeId = takeFile?.id ?? "";
        await db.insert(schema.loudness).values(
          [fileId, takeId].map((id) => ({
            organisationId,
            fileId: id,
            summary: {
              integrated: -8,
              range: 6,
              momentaryMax: -4,
              shortTermMax: -6,
              truePeak: -1,
              channels: [],
            },
            channels: 2,
            sampleRate: 48000,
            samplesPerFrame: 4800,
            frameCount: 600,
            blobId: blob.id,
          })),
        );
        await db
          .update(schema.projects)
          .set({ deliveryProfile: "streaming" })
          .where(eq(schema.projects.id, projectId));
        const made = await app.request(
          `/api/projects/${projectId}/tracks`,
          json({ name: "Maple Leaf Rag" }, owner),
        );
        const trackId = ((await made.json()) as { track: { id: string } }).track.id;
        expect(
          (
            await app.request(
              `/api/tracks/${trackId}/versions`,
              json({ variations: [{ fileId, name: "Mix" }] }, owner),
            )
          ).status,
        ).toBe(201);
        const heard = async (cookie: string, id = fileId) =>
          (
            (await (await app.request(`/api/files/${id}`, { headers: { cookie } })).json()) as {
              file: { normalisation: { mode: string } | null; variation: Record<string, unknown> };
            }
          ).file;
        const choose = (normalisation: string | null, who = owner) =>
          send("PUT", `/api/tracks/${trackId}/normalisation`, { normalisation }, who);
        const viewer = await joinAs(owner, "viewer@example.test", "member");
        await grantRole(owner, projectId, viewer, "Viewer");

        // The project has it off; the track plays it always, so everyone hears it normalised.
        expect((await heard(viewer)).normalisation).toBeNull();
        const chosen = await choose("forced");
        expect(chosen.status).toBe(200);
        expect(
          ((await chosen.json()) as { track: { normalisation: string } }).track.normalisation,
        ).toBe("forced");
        const file = await heard(viewer);
        expect(file.normalisation).toMatchObject({ mode: "forced", target: -14 });
        // The track's takes play as it does.
        expect(
          (await app.request(`/api/tracks/${trackId}/takes`, json({ fileIds: [takeId] }, owner)))
            .status,
        ).toBe(201);
        expect((await heard(viewer, takeId)).normalisation).toMatchObject({ mode: "forced" });
        // The track's setting stays on the server.
        expect(file.variation).not.toHaveProperty("trackNormalisation");

        // A track can also turn it off where the project has it always.
        await send("PATCH", `/api/projects/${projectId}`, { normalisation: "forced" }, owner);
        expect((await choose("off")).status).toBe(200);
        expect((await heard(owner)).normalisation).toBeNull();
        // Back to the project's.
        expect((await choose(null)).status).toBe(200);
        expect((await heard(owner)).normalisation).toMatchObject({ mode: "forced" });

        // Only those who edit the project choose; nothing else is accepted.
        expect((await choose("forced", viewer)).status).toBe(403);
        expect((await choose("loud")).status).toBe(400);
        expect(
          (
            await send(
              "PUT",
              "/api/tracks/0190a6f0-0000-7000-8000-0000000000ff/normalisation",
              { normalisation: "off" },
              owner,
            )
          ).status,
        ).toBe(404);
      });

      it("lets only the author edit, anyone who triages resolve, and no one reach another organisation", async () => {
        const owner = cookieOf(await setup());
        const organisationId = await organisationOf(owner);
        const fileId = await recording(organisationId);
        const created = await app.request(
          `/api/files/${fileId}/comments`,
          json({ body: "Pedal noise", anchor: { kind: "time", start: 3, end: 3 } }, owner),
        );
        const { id } = ((await created.json()) as { comment: { id: string } }).comment;
        const colleague = await joinAs(owner, "engineer@example.test", "member");
        await grantRole(owner, await projectOfFile(fileId), colleague, "Engineer");

        expect(
          (await send("PATCH", `/api/comments/${id}`, { body: "Mine now" }, colleague)).status,
        ).toBe(403);
        const edited = await send(
          "PATCH",
          `/api/comments/${id}`,
          { body: "Pedal noise, left" },
          owner,
        );
        expect(
          ((await edited.json()) as { comment: { body: string; editedAt: string | null } }).comment,
        ).toMatchObject({
          body: "Pedal noise, left",
          editedAt: expect.any(String),
        });

        const resolved = await app.request(
          `/api/comments/${id}/resolve`,
          json({ resolved: true }, colleague),
        );
        expect(
          ((await resolved.json()) as { comment: { resolvedByName: string } }).comment
            .resolvedByName,
        ).toBe("Colleague");
        const reopened = await app.request(
          `/api/comments/${id}/resolve`,
          json({ resolved: false }, owner),
        );
        expect(
          ((await reopened.json()) as { comment: { resolvedAt: string | null } }).comment
            .resolvedAt,
        ).toBeNull();

        // Another organisation's file and comments do not exist from here.
        const [other] = await db
          .insert(schema.organisations)
          .values({ name: "Elsewhere", slug: "elsewhere-comments" })
          .returning();
        const foreignFile = await recording(other?.id ?? "");
        const [foreign] = await db
          .insert(schema.comments)
          .values({ organisationId: other?.id ?? "", fileId: foreignFile, body: "Theirs" })
          .returning();
        expect(
          (await app.request(`/api/files/${foreignFile}/comments`, { headers: { cookie: owner } }))
            .status,
        ).toBe(404);
        expect(
          (await app.request(`/api/files/${foreignFile}/comments`, json({ body: "x" }, owner)))
            .status,
        ).toBe(404);
        expect(
          (await send("PATCH", `/api/comments/${foreign?.id}`, { body: "x" }, owner)).status,
        ).toBe(404);
        expect(
          (
            await app.request(
              `/api/comments/${foreign?.id}/resolve`,
              json({ resolved: true }, owner),
            )
          ).status,
        ).toBe(404);
        expect((await app.request(`/api/files/${fileId}/comments`)).status).toBe(401);
      });
      it("exports a file's threads as a marker list for those who triage, and logs it", async () => {
        const owner = cookieOf(await setup());
        const organisationId = await organisationOf(owner);
        const fileId = await recording(organisationId);
        const path = `/api/files/${fileId}/comments`;
        const post = async (body: unknown) =>
          (
            (await (await app.request(path, json(body, owner))).json()) as {
              comment: { id: string };
            }
          ).comment.id;
        const late = await post({
          body: "Pedal, again",
          anchor: { kind: "time", start: 30, end: 30 },
        });
        await post({ body: "Fixed now", parentId: late });
        const early = await post({ body: "Too loud", anchor: { kind: "time", start: 5, end: 8 } });
        await app.request(`/api/comments/${early}/resolve`, json({ resolved: true }, owner));
        await post({ body: "Lovely overall" });

        const exported = (query: string, cookie = owner) =>
          app.request(`${path}/export?${query}`, { headers: { cookie } });

        const edl = await exported("target=resolve&time=timecode-hour");
        expect(edl.status).toBe(200);
        expect(edl.headers.get("content-type")).toBe("text/plain; charset=utf-8");
        expect(edl.headers.get("content-disposition")).toBe(
          `attachment; filename="Mix v3 comments.edl"; filename*=UTF-8''Mix%20v3%20comments.edl`,
        );
        expect(edl.headers.get("cache-control")).toBe("no-store");
        const text = await edl.text();
        // Open threads only, by default: the resolved one and the untimed one stay out.
        expect(text).toContain("01:00:30:00 01:00:30:01");
        expect(text).toContain("|M:Producer: Pedal, again |D:1");
        expect(text).not.toContain("Too loud");

        const csv = await (
          await exported("target=csv&threads=all&replies=true&time=seconds")
        ).text();
        expect(csv).toContain(
          "5.000,8.000,Producer: Too loud,Too loud,Producer,00:05.000 – 00:08.000,Resolved",
        );
        expect(csv).toContain('"Pedal, again\nReply from Producer: Fixed now"');
        expect(csv).toContain(",,Producer: Lovely overall,Lovely overall,Producer,Whole file,Open");

        const midi = await exported("target=pro-tools");
        expect(midi.headers.get("content-type")).toBe("audio/midi");
        expect(
          Buffer.from(await midi.arrayBuffer())
            .subarray(0, 4)
            .toString(),
        ).toBe("MThd");

        // Choices are checked; another workspace's file does not exist from here.
        expect((await exported("target=garageband")).status).toBe(400);
        expect((await exported("target=csv&rate=17")).status).toBe(400);
        const [other] = await db
          .insert(schema.organisations)
          .values({ name: "Elsewhere", slug: "elsewhere-export" })
          .returning();
        const foreign = await recording(other?.id ?? "");
        expect(
          (
            await app.request(`/api/files/${foreign}/comments/export?target=csv`, {
              headers: { cookie: owner },
            })
          ).status,
        ).toBe(404);
        expect((await app.request(`${path}/export?target=csv`)).status).toBe(401);

        // A Reviewer comments but does not triage, so the export is refused.
        const reviewer = await joinAs(owner, "reviewer-export@example.test", "member");
        await grantRole(owner, await projectOfFile(fileId), reviewer, "Reviewer");
        expect(
          (await app.request(`${path}/export?target=csv`, { headers: { cookie: reviewer } }))
            .status,
        ).toBe(403);

        const logged = await db
          .select({ details: schema.accessEvents.details })
          .from(schema.accessEvents)
          .where(
            and(
              eq(schema.accessEvents.organisationId, organisationId),
              eq(schema.accessEvents.action, "comment.export"),
            ),
          );
        expect(logged.map((e) => e.details)).toEqual([
          { target: "resolve", threads: 1 },
          { target: "csv", threads: 3 },
          { target: "pro-tools", threads: 1 },
        ]);

        // The same threads as a sheet to print (#134): triage's, a PDF, logged as an export.
        expect(
          (await app.request(`${path}/sheet?threads=all`, { headers: { cookie: reviewer } }))
            .status,
        ).toBe(403);
        const sheet = await app.request(`${path}/sheet?threads=all`, {
          headers: { cookie: owner },
        });
        expect(sheet.status).toBe(200);
        expect(sheet.headers.get("content-type")).toBe("application/pdf");
        expect(sheet.headers.get("content-disposition")).toMatch(/ comments\.pdf/);
        expect(
          Buffer.from(await sheet.arrayBuffer())
            .subarray(0, 5)
            .toString(),
        ).toBe("%PDF-");
        expect(
          (await app.request(`${path}/sheet?threads=some`, { headers: { cookie: owner } })).status,
        ).toBe(400);
        const sheets = await db
          .select({ details: schema.accessEvents.details })
          .from(schema.accessEvents)
          .where(
            and(
              eq(schema.accessEvents.organisationId, organisationId),
              eq(schema.accessEvents.action, "comment.export"),
            ),
          );
        expect(sheets.map((e) => e.details)).toContainEqual({ target: "sheet", threads: 3 });
      });
      it("shows a document only as pages, each one logged, through links bound to the viewer", async () => {
        const owner = cookieOf(await setup());
        const organisationId = await organisationOf(owner);
        const audio = await recording(organisationId);
        const projectId = await projectOfFile(audio);
        const blob = await storage.put(organisationId, Buffer.from("%PDF-1.4 not drawn here"));
        const [doc] = await db
          .insert(schema.files)
          .values({
            organisationId,
            projectId,
            name: "Score.pdf",
            kind: "document",
            blobId: blob.id,
            contentType: "application/pdf",
            byteSize: blob.byteSize,
            streamStatus: "ready",
            pageCount: 2,
          })
          .returning();
        const page = Buffer.from("RIFF0000WEBPVP8 page one");
        for (const n of [1, 2]) {
          const view = await storage.put(organisationId, n === 1 ? page : Buffer.from("two"));
          const thumb = await storage.put(organisationId, Buffer.from(`thumb ${n}`));
          await db.insert(schema.filePages).values({
            organisationId,
            fileId: doc?.id ?? "",
            page: n,
            width: 1414,
            height: 2000,
            blobId: view.id,
            thumbBlobId: thumb.id,
          });
        }
        const opened = await app.request(`/api/files/${doc?.id}/view`, json({}, owner));
        expect(opened.status).toBe(201);
        const view = (await opened.json()) as {
          pageCount: number;
          pages: { page: number; width: number; height: number; url: string; thumbUrl: string }[];
        };
        expect(view.pageCount).toBe(2);
        expect(view.pages.map((p) => [p.page, p.width, p.height])).toEqual([
          [1, 1414, 2000],
          [2, 1414, 2000],
        ]);
        const first = view.pages[0];
        const served = await app.request(first?.url ?? "", { headers: { cookie: owner } });
        expect(served.status).toBe(200);
        expect(served.headers.get("content-type")).toBe("image/webp");
        expect(served.headers.get("cache-control")).toBe("no-store, private");
        expect(Buffer.from(await served.arrayBuffer())).toEqual(page);
        expect(
          (await app.request(first?.thumbUrl ?? "", { headers: { cookie: owner } })).status,
        ).toBe(200);
        // The page at review size is logged; its thumbnail is not.
        const logged = await audit.query(organisationId, { action: "page.render", limit: 10 });
        expect(logged.events).toHaveLength(1);
        expect(logged.events[0]).toMatchObject({ fileId: doc?.id, details: { page: 1 } });

        // Someone else's browser cannot use the link, and there is no page beyond the last.
        const colleague = await joinAs(owner, "viewer@example.test", "member");
        expect(
          (await app.request(first?.url ?? "", { headers: { cookie: colleague } })).status,
        ).toBe(403);
        expect(
          (
            await app.request((first?.url ?? "").replace("/pages/1/", "/pages/9/"), {
              headers: { cookie: owner },
            })
          ).status,
        ).toBe(404);
        // Audio is played, not viewed, and a document is viewed, not played (nor logged as
        // played); the raw file never has a route.
        expect((await app.request(`/api/files/${audio}/view`, json({}, owner))).status).toBe(409);
        expect((await app.request(`/api/files/${doc?.id}/playback`, json({}, owner))).status).toBe(
          409,
        );
        const sessions = await audit.query(organisationId, { action: "stream.session", limit: 10 });
        expect(sessions.events.filter((e) => e.fileId === doc?.id)).toHaveLength(0);
        // A comment can point at part of a page the document has, and no other.
        const region = (page: number) => ({
          body: "Slur missing over the run",
          anchor: { kind: "region", page, x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
        });
        const commented = `/api/files/${doc?.id}/comments`;
        expect((await app.request(commented, json(region(2), owner))).status).toBe(201);
        expect((await app.request(commented, json(region(3), owner))).status).toBe(422);
        // Another organisation's document does not exist from here.
        const [other] = await db
          .insert(schema.organisations)
          .values({ name: "Elsewhere", slug: "elsewhere-pages" })
          .returning();
        const foreign = await storage.put(other?.id ?? "", Buffer.from("%PDF-1.4 theirs"));
        const [theirs] = await db
          .insert(schema.files)
          .values({
            organisationId: other?.id ?? "",
            projectId: await projectOfFile(await recording(other?.id ?? "")),
            name: "Theirs.pdf",
            kind: "document",
            blobId: foreign.id,
            contentType: "application/pdf",
            byteSize: foreign.byteSize,
            streamStatus: "ready",
            pageCount: 1,
          })
          .returning();
        expect((await app.request(`/api/files/${theirs?.id}/view`, json({}, owner))).status).toBe(
          404,
        );
      });

      it("carries open threads to the next version, where triage settles, hides or remaps them", async () => {
        const owner = cookieOf(await setup());
        const organisationId = await organisationOf(owner);
        const [project] = await db
          .insert(schema.projects)
          .values({ organisationId, name: "Rags", profile: "music" })
          .returning();
        const projectId = project?.id ?? "";
        const file = async (name: string) => {
          const blob = await storage.put(organisationId, Buffer.from(name));
          const [row] = await db
            .insert(schema.files)
            .values({
              organisationId,
              projectId,
              name,
              kind: "audio",
              blobId: blob.id,
              contentType: "audio/wav",
              byteSize: blob.byteSize,
              mediaInfo: {
                duration: 60,
                audio: { codec: "pcm_s24le", channels: 2, sampleRate: 48000 },
              },
            })
            .returning();
          return row?.id ?? "";
        };
        const [dry1, wet1, dry2, wet2, dry3] = (await Promise.all(
          ["Dry v1.wav", "Wet v1.wav", "Dry v2.wav", "Wet v2.wav", "Dry v3.wav"].map(file),
        )) as [string, string, string, string, string];
        const track = (
          (await (
            await app.request(`/api/projects/${projectId}/tracks`, json({ name: "Rag" }, owner))
          ).json()) as { track: { id: string } }
        ).track;
        const version = (variations: { fileId: string; name: string }[]) =>
          app.request(`/api/tracks/${track.id}/versions`, json({ variations }, owner));
        type Listed = {
          id: string;
          fileId: string;
          parentId: string | null;
          body: string;
          anchor: unknown;
          resolvedAt: string | null;
          carry: {
            id: string;
            status: string;
            visible: boolean;
            from: { fileId: string; anchor: unknown };
          } | null;
          history: {
            versionNumber: number | null;
            hops: { fileId: string; versionNumber: number; status: string }[];
          } | null;
        };
        const listed = async (fileId: string, cookie = owner) =>
          (
            (await (
              await app.request(`/api/files/${fileId}/comments`, { headers: { cookie } })
            ).json()) as { comments: Listed[] }
          ).comments;
        const comment = async (fileId: string, body: string, start: number, cookie = owner) =>
          (
            (await (
              await app.request(
                `/api/files/${fileId}/comments`,
                json({ body, anchor: { kind: "time", start, end: start + 2 } }, cookie),
              )
            ).json()) as { comment: { id: string } }
          ).comment.id;

        expect(
          (
            await version([
              { fileId: dry1, name: "Dry" },
              { fileId: wet1, name: "Wet" },
            ])
          ).status,
        ).toBe(201);
        const tail = await comment(wet1, "Reverb tail cut short", 40);
        const noise = await comment(dry1, "Chair creak", 12);
        const settled = await comment(dry1, "Already fine", 5);
        await app.request(`/api/comments/${settled}/resolve`, json({ resolved: true }, owner));

        // Version 2: the open threads come along, the wet one to the wet mix.
        expect(
          (
            await version([
              { fileId: dry2, name: "Dry" },
              { fileId: wet2, name: "Wet" },
            ])
          ).status,
        ).toBe(201);
        const onDry2 = await listed(dry2);
        expect(onDry2.map((c) => c.body)).toEqual(["Chair creak"]);
        const creak = onDry2[0];
        expect(creak).toMatchObject({
          id: noise,
          fileId: dry1,
          anchor: { kind: "time", start: 12, end: 14 },
          carry: { status: "open", visible: true, from: { fileId: dry1 } },
          history: { versionNumber: 1, hops: [{ fileId: dry2, versionNumber: 2, status: "open" }] },
        });
        expect((await listed(wet2)).map((c) => c.body)).toEqual(["Reverb tail cut short"]);
        // Each earlier variation is queued for alignment with its counterpart.
        const pairs = await db
          .select({
            id: schema.alignments.id,
            from: schema.alignments.fromFileId,
            to: schema.alignments.toFileId,
          })
          .from(schema.alignments)
          .where(eq(schema.alignments.toFileId, dry2));
        expect(pairs.map((p) => p.from)).toEqual([dry1]);
        expect(
          sent.some(
            (j) =>
              j.name === "media-align" &&
              (j.data as { alignmentId: string }).alignmentId === pairs[0]?.id,
          ),
        ).toBe(true);
        // Once aligned, each side reads it from its own time; a poor match is not offered.
        await db
          .update(schema.alignments)
          .set({
            status: "ready",
            quality: 0.9,
            points: [
              [0, 0],
              [60, 62],
            ],
          })
          .where(eq(schema.alignments.id, pairs[0]?.id ?? ""));
        const alignedFrom = async (fileId: string) =>
          (
            (await (
              await app.request(`/api/files/${fileId}/alignments`, { headers: { cookie: owner } })
            ).json()) as { alignments: { fileId: string; points: [number, number][] }[] }
          ).alignments;
        // Each version's other mixes come along: they share their version's times.
        const fromDry1 = await alignedFrom(dry1);
        expect(fromDry1.map((r) => r.fileId).sort()).toEqual([dry2, wet2].sort());
        expect(fromDry1.find((r) => r.fileId === dry2)?.points).toEqual([
          [0, 0],
          [60, 62],
        ]);
        const fromDry2 = await alignedFrom(dry2);
        expect(fromDry2.map((r) => r.fileId).sort()).toEqual([dry1, wet1].sort());
        expect(fromDry2.find((r) => r.fileId === dry1)?.points).toEqual([
          [0, 0],
          [62, 60],
        ]);
        await db
          .update(schema.alignments)
          .set({ quality: 0.2 })
          .where(eq(schema.alignments.id, pairs[0]?.id ?? ""));
        expect(await alignedFrom(dry2)).toEqual([]);

        // Where it began, the thread knows where it went.
        expect((await listed(dry1)).find((c) => c.id === noise)?.history?.hops).toHaveLength(1);

        // A reply from version 2 joins the thread where it began.
        const reply = await app.request(
          `/api/files/${dry2}/comments`,
          json({ body: "Still there", parentId: noise }, owner),
        );
        expect(reply.status).toBe(201);
        expect((await listed(dry1)).map((c) => c.body)).toContain("Still there");
        expect((await listed(dry2)).map((c) => c.body)).toEqual(["Chair creak", "Still there"]);

        // Triage: someone who only comments cannot; an engineer can, and remaps it.
        const reviewer = await joinAs(owner, "reviewer@example.test", "member");
        await grantRole(owner, projectId, reviewer, "Reviewer");
        const engineer = await joinAs(owner, "engineer@example.test", "member");
        await grantRole(owner, projectId, engineer, "Engineer");
        const carryId = creak?.carry?.id ?? "";
        expect(
          (await send("PATCH", `/api/comment-carries/${carryId}`, { status: "fixed" }, reviewer))
            .status,
        ).toBe(403);
        expect(
          (
            await send(
              "PATCH",
              `/api/comment-carries/${carryId}`,
              { anchor: { kind: "time", start: 70, end: 71 } },
              engineer,
            )
          ).status,
        ).toBe(422);
        expect(
          (
            await send(
              "PATCH",
              `/api/comment-carries/${carryId}`,
              { status: "not_fixed", anchor: { kind: "time", start: 13, end: 15 } },
              engineer,
            )
          ).status,
        ).toBe(204);
        // Placed by hand, alignment will leave it alone.
        expect(
          (
            await db
              .select({ placed: schema.commentCarries.anchorPlaced })
              .from(schema.commentCarries)
              .where(eq(schema.commentCarries.id, carryId))
          )[0]?.placed,
        ).toBe(true);
        expect((await listed(dry2))[0]).toMatchObject({
          anchor: { kind: "time", start: 13, end: 15 },
          carry: { status: "not_fixed", from: { anchor: { kind: "time", start: 12, end: 14 } } },
          resolvedAt: null,
        });

        // Hidden on version 2: gone for the reviewer, still there for triage.
        const wetCarry = (await listed(wet2))[0]?.carry?.id ?? "";
        expect(
          (await send("PATCH", `/api/comment-carries/${wetCarry}`, { visible: false }, engineer))
            .status,
        ).toBe(204);
        expect(await listed(wet2, reviewer)).toEqual([]);
        expect((await listed(wet2, engineer)).map((c) => c.carry?.visible)).toEqual([false]);
        expect(
          (
            await app.request(
              `/api/files/${wet2}/comments`,
              json({ body: "Hidden?", parentId: tail }, reviewer),
            )
          ).status,
        ).toBe(422);

        // Version 3 has only a dry mix: both still-open threads land on it, hidden or not.
        await send("PATCH", `/api/projects/${projectId}`, { carriedCommentsShown: false }, owner);
        expect((await version([{ fileId: dry3, name: "Dry" }])).status).toBe(201);
        const onDry3 = await listed(dry3);
        expect(onDry3.filter((c) => !c.parentId).map((c) => [c.body, c.carry?.visible])).toEqual([
          ["Reverb tail cut short", false],
          ["Chair creak", false],
        ]);
        // Version 3 reaches version 1 through version 2, and each version's other mixes
        // through the one it was aligned on.
        await db
          .update(schema.alignments)
          .set({ quality: 0.9 })
          .where(eq(schema.alignments.id, pairs[0]?.id ?? ""));
        await db
          .update(schema.alignments)
          .set({
            status: "ready",
            quality: 0.8,
            points: [
              [0, 0],
              [62, 60],
            ],
          })
          .where(and(eq(schema.alignments.fromFileId, dry2), eq(schema.alignments.toFileId, dry3)));
        const fromDry3 = await alignedFrom(dry3);
        expect(fromDry3.map((r) => r.fileId).sort()).toEqual([dry1, dry2, wet1, wet2].sort());
        const toDry1 = fromDry3.find((r) => r.fileId === dry1);
        // 30 s of version 3 is 31 s of version 2, which is 30 s of version 1.
        expect(mapTime(toDry1?.points ?? [], 30)).toBeCloseTo(30, 1);
        expect(mapTime(fromDry3.find((r) => r.fileId === dry2)?.points ?? [], 30)).toBeCloseTo(
          31,
          1,
        );

        // An alignment the queue never took is picked up by the sweep once it has waited.
        const swept: unknown[] = [];
        await requeueAlignments(
          db,
          {
            send: async (_name, data) => {
              swept.push(data);
              return "job";
            },
          },
          new Date(Date.now() + 10 * 60_000),
        );
        const [waiting] = await db
          .select({ id: schema.alignments.id })
          .from(schema.alignments)
          .where(and(eq(schema.alignments.fromFileId, wet2), eq(schema.alignments.toFileId, dry3)));
        expect(swept).toContainEqual({ organisationId, alignmentId: waiting?.id });

        // Mapped from where version 2 had it.
        expect(onDry3.find((c) => c.id === noise)?.anchor).toEqual({
          kind: "time",
          start: 13,
          end: 15,
        });

        // Version 2's status is history now: it is settled on version 3, where it went.
        expect(
          (await send("PATCH", `/api/comment-carries/${carryId}`, { status: "fixed" }, engineer))
            .status,
        ).toBe(409);
        expect(
          (await send("PATCH", `/api/comment-carries/${carryId}`, { visible: true }, engineer))
            .status,
        ).toBe(204);

        // Fixed in version 3 settles the thread everywhere.
        const v3Carry = onDry3.find((c) => c.id === noise)?.carry?.id ?? "";
        expect(
          (await send("PATCH", `/api/comment-carries/${v3Carry}`, { status: "fixed" }, engineer))
            .status,
        ).toBe(204);
        const origin = (await listed(dry1)).find((c) => c.id === noise);
        expect(origin?.resolvedAt).not.toBeNull();
        expect(origin?.history?.hops.map((h) => [h.versionNumber, h.status])).toEqual([
          [2, "not_fixed"],
          [3, "fixed"],
        ]);

        // Another organisation's carried thread does not exist from here.
        const [other] = await db
          .insert(schema.organisations)
          .values({ name: "Elsewhere", slug: "elsewhere-carries" })
          .returning();
        const [foreign] = await db
          .insert(schema.commentCarries)
          .values({ organisationId: other?.id ?? "", commentId: noise, fileId: wet1 })
          .returning();
        expect(
          (await send("PATCH", `/api/comment-carries/${foreign?.id}`, { visible: false }, owner))
            .status,
        ).toBe(404);
      });
    });

    describe.runIf(spawnSync("ffmpeg", ["-version"]).status === 0 || process.env.CI)(
      "streaming",
      () => {
        const secret = playbackSecret("test-secret-test-secret-test-secret-0");
        const joinAs = async (owner: string, email: string, role: string) => {
          const { body } = await invite(owner, email, role);
          const res = await app.request(
            `/api/invitations/${tokenFrom(body.link)}/accept`,
            json({ name: "Colleague", password: "correct horse battery" }),
          );
          return cookieOf(res);
        };
        const get = (path: string, cookie?: string) =>
          app.request(path, { headers: cookie ? { cookie } : {} });

        /** A playable file: stored, measured and packaged by the real proxy job. */
        const playableFile = async (owner: string, kind: "audio" | "video" = "audio") => {
          const organisationId = (
            (await (await get("/api/me", owner)).json()) as { activeOrganisationId: string }
          ).activeOrganisationId;
          const res = await app.request(
            "/api/projects",
            json({ name: "Rags", profile: "music" }, owner),
          );
          const projectId = ((await res.json()) as { project: { id: string } }).project.id;
          const wav = join(storageRoot, `source-${Date.now()}.${kind === "audio" ? "wav" : "mov"}`);
          await run(
            "ffmpeg",
            kind === "audio"
              ? [
                  "-hide_banner",
                  "-nostdin",
                  "-v",
                  "error",
                  "-f",
                  "lavfi",
                  "-i",
                  "sine=frequency=440:sample_rate=48000:duration=8",
                  "-ac",
                  "2",
                  "-c:a",
                  "pcm_s24le",
                  wav,
                ]
              : [
                  "-hide_banner",
                  "-nostdin",
                  "-v",
                  "error",
                  "-f",
                  "lavfi",
                  "-i",
                  "testsrc2=size=1920x1080:rate=25:duration=5",
                  "-f",
                  "lavfi",
                  "-i",
                  "sine=duration=5",
                  "-c:v",
                  "libx264",
                  "-preset",
                  "ultrafast",
                  "-pix_fmt",
                  "yuv420p",
                  "-c:a",
                  "pcm_s16le",
                  "-shortest",
                  wav,
                ],
          );
          const blob = await storage.put(organisationId, readFileSync(wav));
          const [file] = await db
            .insert(schema.files)
            .values({
              organisationId,
              projectId,
              name: kind === "audio" ? "Tone.wav" : "Bars.mov",
              kind,
              blobId: blob.id,
              contentType: kind === "audio" ? "audio/wav" : "video/quicktime",
              byteSize: blob.byteSize,
              mediaInfo: await probe(wav),
              streamStatus: "pending",
            })
            .returning();
          await proxyHandler({ db, storage, keyring, jobs, workDir: join(storageRoot, "work") })(
            { organisationId, fileId: file?.id ?? "" },
            { id: "job", signal: new AbortController().signal, retryCount: 0 },
          );
          return { organisationId, projectId, fileId: file?.id ?? "" };
        };
        const start = async (cookie: string, fileId: string) => {
          const res = await app.request(`/api/files/${fileId}/playback`, json({}, cookie));
          const body =
            res.status === 201
              ? ((await res.json()) as {
                  url: string;
                  filmstrip: { url: string; frames: number } | null;
                })
              : null;
          return { res, body, url: body?.url ?? "" };
        };

        it("plays as encrypted HLS that decrypts to the recording, logging the session and key", async () => {
          const owner = cookieOf(await setup());
          const { organisationId, fileId } = await playableFile(owner);
          const { res, url } = await start(owner, fileId);
          expect(res.status).toBe(201);
          expect(url).toMatch(/^\/api\/play\/[\w-]+\.[\w-]+\/master\.m3u8$/);

          const master = await get(url, owner);
          expect(master.status).toBe(200);
          expect(master.headers.get("cache-control")).toContain("no-store");
          expect(master.headers.get("content-type")).toBe("application/vnd.apple.mpegurl");
          const masterText = await master.text();
          expect(masterText).toContain('CODECS="mp4a.40.2"');
          const variant = masterText.split("\n").find((l) => l.startsWith("r/")) ?? "";
          const base = url.replace(/master\.m3u8$/, "");
          const media = await (await get(base + variant, owner)).text();
          expect(media).toContain("#EXT-X-ENDLIST");
          expect(media).toContain('#EXT-X-MAP:URI="init.mp4"');

          const keyRes = await get(`${base + variant.replace(/index\.m3u8$/, "")}key`, owner);
          expect(keyRes.status).toBe(200);
          const key = Buffer.from(await keyRes.arrayBuffer());
          expect(key.length).toBe(16);

          // Walk the playlist as a player would: each key tag's IV applies to what follows.
          const dir = base + variant.replace(/index\.m3u8$/, "");
          let iv = "";
          const parts: Buffer[] = [];
          for (const line of media.split("\n")) {
            const match = line.match(/IV=0x([0-9a-f]{32})/);
            if (match?.[1]) iv = match[1];
            const uri = line.startsWith("#EXT-X-MAP")
              ? "init.mp4"
              : line.startsWith("seg/")
                ? line
                : null;
            if (!uri) continue;
            const body = Buffer.from(await (await get(dir + uri, owner)).arrayBuffer());
            expect(body.includes(Buffer.from("ftyp"))).toBe(false);
            const decipher = createDecipheriv("aes-128-cbc", key, Buffer.from(iv, "hex"));
            parts.push(Buffer.concat([decipher.update(body), decipher.final()]));
          }
          const assembled = join(storageRoot, "assembled.mp4");
          writeFileSync(assembled, Buffer.concat(parts));
          const info = await probe(assembled);
          expect(info.audio).toMatchObject({ codec: "aac", channels: 2, sampleRate: 48000 });
          expect(info.duration).toBeCloseTo(8, 0);

          // The session, the key and every segment served, each attributable.
          const logged = await audit.query(organisationId, { fileId, limit: 50 });
          const actions = logged.events.map((e) => e.action);
          const served = media.split("\n").filter((l) => l.startsWith("seg/")).length;
          expect(actions.filter((a) => a === "stream.segment")).toHaveLength(served);
          expect(new Set(actions)).toEqual(
            new Set(["stream.key", "stream.session", "stream.segment"]),
          );
          expect(logged.events.every((e) => e.projectId)).toBe(true);

          // A wide layout's later channels (#74) play beside the first part, from their own
          // playlist: never offered in the master as a stream to choose instead.
          await db
            .update(schema.renditions)
            .set({ name: "flac-2" })
            .where(and(eq(schema.renditions.fileId, fileId), eq(schema.renditions.name, "flac")));
          const wide = (await (
            await app.request(`/api/files/${fileId}/playback`, json({}, owner))
          ).json()) as { url: string; renditions: { id: string; name: string }[] };
          const part = wide.renditions.find((r) => r.name === "flac-2");
          expect(part).toBeDefined();
          const wideBase = wide.url.replace(/master\.m3u8$/, "");
          const wideMaster = await (await get(wide.url, owner)).text();
          expect(wideMaster).not.toContain(`r/${part?.id}/`);
          expect(wideMaster).toContain('CODECS="mp4a.40.2"');
          const own = await get(`${wideBase}r/${part?.id}/index.m3u8`, owner);
          expect(own.status).toBe(200);
          expect(await own.text()).toContain("#EXT-X-ENDLIST");
        }, 120_000);

        it("plays an ADM master's objects through its render, or its bed where none can be made", async () => {
          const owner = cookieOf(await setup());
          const { organisationId, fileId } = await playableFile(owner);
          const [row] = await db.select().from(schema.files).where(eq(schema.files.id, fileId));
          const workers = { db, storage, keyring, jobs, workDir: join(storageRoot, "work") };
          // Made again from the start, as a file whose streams are gone is.
          const proxy = async (admRenderer: string) => {
            await db.delete(schema.renditions).where(eq(schema.renditions.fileId, fileId));
            await proxyHandler({ ...workers, admRenderer })(
              { organisationId, fileId },
              { id: "job", signal: new AbortController().signal, retryCount: 1 },
            );
          };
          const streams = async () => {
            const [file] = await db.select().from(schema.files).where(eq(schema.files.id, fileId));
            const renditions = await db
              .select({ name: schema.renditions.name })
              .from(schema.renditions)
              .where(eq(schema.renditions.fileId, fileId));
            return {
              rendered: file?.mediaInfo?.metadata?.adm?.rendered,
              names: renditions.map((r) => r.name).sort(),
            };
          };
          // Said to hold an object, with no renderer to be found: its bed plays, as before.
          const info = row?.mediaInfo ?? {};
          const adm = { bytes: 10, bed: 2, layout: "2.0", objects: 1, lfe: [], dolby: false };
          await db
            .update(schema.files)
            .set({ mediaInfo: { ...info, metadata: { tags: {}, ...info.metadata, adm } } })
            .where(eq(schema.files.id, fileId));
          const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
          await proxy(join(storageRoot, "no-renderer"));
          expect(warn).toHaveBeenCalled();
          warn.mockRestore();
          expect(await streams()).toEqual({ rendered: undefined, names: ["aac-256", "flac"] });

          // A real master, where the renderer is installed: its object heard in 7.1.4.
          const renderer = process.env.ADM_RENDERER_PATH;
          if (!renderer) return;
          const meta = join(storageRoot, "object.yaml");
          writeFileSync(
            meta,
            'name: side\nitems:\n  - type: "Objects"\n    channels: [1]\n    blocks:\n      - rtime: 0.0\n        duration: 2.0\n        position: {azimuth: 90.0, elevation: 0.0, distance: 1.0}\n',
          );
          const mono = join(storageRoot, "mono.wav");
          await run("ffmpeg", [
            ...["-hide_banner", "-nostdin", "-v", "error", "-f", "lavfi"],
            ...["-i", "sine=frequency=440:duration=2:sample_rate=48000", "-c:a", "pcm_s24le", mono],
          ]);
          const bwf = join(storageRoot, "master.wav");
          await run(
            "python3",
            [
              "-W",
              "ignore",
              "-m",
              "ear.cmdline.utils",
              "make_test_bwf",
              "-i",
              mono,
              "-m",
              meta,
              bwf,
            ],
            { env: { PYTHONPATH: renderer, PYTHONNOUSERSITE: "1" } },
          );
          const blob = await storage.put(organisationId, readFileSync(bwf));
          await db
            .update(schema.files)
            .set({ blobId: blob.id, mediaInfo: await probe(bwf) })
            .where(eq(schema.files.id, fileId));
          await proxy(renderer);
          expect(await streams()).toEqual({
            rendered: "7.1.4",
            names: ["aac-256", "flac", "flac-2"],
          });
        }, 240_000);

        it("plays video as an encrypted ladder that decrypts to H.264 and AAC, and AV1 and Opus (#148)", async () => {
          const owner = cookieOf(await setup());
          const { fileId } = await playableFile(owner, "video");
          const { url, body } = await start(owner, fileId);
          // Its filmstrip (#16), through the same link: a WebP of every frame side by side.
          const filmstrip = body?.filmstrip;
          expect(filmstrip).toEqual({ url: url.replace(/master\.m3u8$/, "filmstrip"), frames: 12 });
          const strip = await get(filmstrip?.url ?? "", owner);
          expect(strip.status).toBe(200);
          expect(strip.headers.get("content-type")).toBe("image/webp");
          const picture = Buffer.from(await strip.arrayBuffer());
          expect(webpComplete(picture)).toBe(true);
          expect(webpSize(picture)).toEqual({ width: 12 * 160, height: 90 });
          // Bound to the session it was made for, as the streams are.
          const colleague = await joinAs(owner, "filmstrip@example.test", "member");
          expect((await get(filmstrip?.url ?? "", colleague)).status).toBe(403);
          const master = await (await get(url, owner)).text();
          expect(master).toContain("RESOLUTION=1920x1080");
          expect(master).toContain("RESOLUTION=1280x720");
          const lines = master.split("\n");
          // Each rung twice: H.264 with AAC, and AV1 with Opus, each named by its codecs.
          const variantOf = (codec: string) =>
            lines[
              lines.findIndex((l) => l.includes("RESOLUTION=1280x720") && l.includes(codec)) + 1
            ] ?? "";
          const assembled = async (variant: string, name: string) => {
            const dir = url.replace(/master\.m3u8$/, "") + variant.replace(/index\.m3u8$/, "");
            const media = await (await get(`${dir}index.m3u8`, owner)).text();
            const key = Buffer.from(await (await get(`${dir}key`, owner)).arrayBuffer());
            let iv = "";
            const parts: Buffer[] = [];
            for (const line of media.split("\n")) {
              const match = line.match(/IV=0x([0-9a-f]{32})/);
              if (match?.[1]) iv = match[1];
              const uri = line.startsWith("#EXT-X-MAP")
                ? "init.mp4"
                : line.startsWith("seg/")
                  ? line
                  : null;
              if (!uri) continue;
              const body = Buffer.from(await (await get(dir + uri, owner)).arrayBuffer());
              const decipher = createDecipheriv("aes-128-cbc", key, Buffer.from(iv, "hex"));
              parts.push(Buffer.concat([decipher.update(body), decipher.final()]));
            }
            const path = join(storageRoot, name);
            writeFileSync(path, Buffer.concat(parts));
            return probe(path);
          };
          const h264 = await assembled(variantOf("avc1."), "assembled-video.mp4");
          expect(h264.video).toMatchObject({ codec: "h264", width: 1280, height: 720 });
          expect(h264.audio).toMatchObject({ codec: "aac" });
          expect(h264.duration).toBeCloseTo(5, 0);
          const av1 = await assembled(variantOf("av01."), "assembled-av1.mp4");
          expect(av1.video).toMatchObject({ codec: "av1", width: 1280, height: 720 });
          expect(av1.audio).toMatchObject({ codec: "opus" });
          expect(av1.duration).toBeCloseTo(5, 0);
        }, 240_000);

        it("refuses copied, forged, expired and stale links", async () => {
          const owner = cookieOf(await setup());
          const { organisationId, fileId } = await playableFile(owner);
          const { url } = await start(owner, fileId);
          expect((await get(url)).status).toBe(401);

          // Another member of the same organisation cannot use the owner's link.
          const colleague = await joinAs(owner, "engineer@example.test", "member");
          expect((await get(url, colleague)).status).toBe(403);
          // Nor start their own without a role in the project; with one, they can.
          expect((await start(colleague, fileId)).res.status).toBe(404);
          await grantRole(owner, await projectOfFile(fileId), colleague, "Viewer");
          expect((await start(colleague, fileId)).res.status).toBe(201);

          const token = url.split("/")[3] ?? "";
          const [payload, signature] = token.split(".");
          const forged = `${payload}.${(signature ?? "").replace(/^./, (c) => (c === "A" ? "B" : "A"))}`;
          expect((await get(`/api/play/${forged}/master.m3u8`, owner)).status).toBe(403);
          const sessionId = (await db.select().from(schema.authSessions))[0]?.id ?? "";
          const expired = signPlayback(secret, {
            sessionId,
            organisationId,
            fileId,
            expiresAt: Math.floor(Date.now() / 1000) - 1,
          });
          expect((await get(`/api/play/${expired}/master.m3u8`, owner)).status).toBe(403);

          // A workspace that comes to ask for a second factor ends playback without one at once.
          const { url: ownUrl } = await start(owner, fileId);
          expect((await get(ownUrl, owner)).status).toBe(200);
          await db
            .update(schema.organisations)
            .set({ settings: { secondFactor: "everyone" } })
            .where(eq(schema.organisations.id, organisationId));
          const held = await get(ownUrl, owner);
          expect(held.status).toBe(403);
          expect(((await held.json()) as { error: { code: string } }).error.code).toBe(
            "second_factor_required",
          );
          await db
            .update(schema.organisations)
            .set({ settings: {} })
            .where(eq(schema.organisations.id, organisationId));

          // Removing someone from the organisation ends their playback at once.
          const { url: colleagueUrl } = await start(colleague, fileId);
          await db.execute(sql`delete from ${schema.members} where role = 'member'`);
          expect((await get(colleagueUrl, colleague)).status).toBe(403);
        }, 120_000);

        it("will not play what is not ready, nor hand out keys in bulk", async () => {
          const owner = cookieOf(await setup());
          const { fileId, organisationId } = await playableFile(owner);
          await db.update(schema.files).set({ streamStatus: "pending" }).where(sql`id = ${fileId}`);
          expect((await start(owner, fileId)).res.status).toBe(409);
          await db.update(schema.files).set({ streamStatus: "ready" }).where(sql`id = ${fileId}`);

          const { url } = await start(owner, fileId);
          const master = await (await get(url, owner)).text();
          const variant = master.split("\n").find((l) => l.startsWith("r/")) ?? "";
          const keyUrl = url.replace(/master\.m3u8$/, "") + variant.replace(/index\.m3u8$/, "key");
          const statuses: number[] = [];
          let refused: Response | undefined;
          for (let i = 0; i < 32; i++) {
            const res = await get(keyUrl, owner);
            statuses.push(res.status);
            if (res.status === 429) refused = res;
          }
          expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
          expect(statuses.slice(30)).toEqual([429, 429]);
          // A refusal says when to try again, as every rate limit's does.
          expect(Number(refused?.headers.get("retry-after"))).toBeGreaterThan(0);
          const keys = await audit.query(organisationId, { action: "stream.key", limit: 200 });
          expect(keys.events).toHaveLength(30);
        }, 120_000);

        it("serves a file's waveform peaks per channel to its organisation", async () => {
          const owner = cookieOf(await setup());
          const { organisationId, fileId } = await playableFile(owner);
          await analysisHandler({ db, storage, keyring, jobs, workDir: join(storageRoot, "work") })(
            { organisationId, fileId },
            { id: "job", signal: new AbortController().signal, retryCount: 0 },
          );
          const listed = await get(`/api/files/${fileId}/peaks`, owner);
          expect(listed.status).toBe(200);
          const { status, levels } = (await listed.json()) as {
            status: string;
            levels: { id: string; channels: number; samplesPerPeak: number; count: number }[];
          };
          expect(status).toBe("ready");
          expect(levels.map((l) => [l.samplesPerPeak, l.channels])).toEqual([[256, 2]]);

          const level = await get(`/api/files/${fileId}/peaks/${levels[0]?.id}`, owner);
          expect(level.status).toBe(200);
          expect(level.headers.get("cache-control")).toContain("no-store");
          const decoded = decodePeaks(new Uint8Array(await level.arrayBuffer()));
          expect(decoded.count).toBe(levels[0]?.count);

          // Not through another file's path, and not to anyone signed out.
          const other = await playableFile(owner);
          expect(
            (await get(`/api/files/${other.fileId}/peaks/${levels[0]?.id}`, owner)).status,
          ).toBe(404);
          expect((await get(`/api/files/${fileId}/peaks`)).status).toBe(401);

          // The same analysis measured its loudness, per channel.
          const measured = await get(`/api/files/${fileId}/loudness`, owner);
          expect(measured.status).toBe(200);
          const body = (await measured.json()) as {
            status: string;
            summary: LoudnessSummary | null;
            series: { channels: number; count: number } | null;
          };
          expect(body.status).toBe("ready");
          expect(body.summary?.channels).toHaveLength(2);
          expect(body.series?.channels).toBe(2);
          const series = await get(`/api/files/${fileId}/loudness/series`, owner);
          expect(series.status).toBe(200);
          expect(series.headers.get("cache-control")).toContain("no-store");
          expect(decodeLoudness(new Uint8Array(await series.arrayBuffer())).count).toBe(
            body.series?.count,
          );
          // And it checked the recording (#41), against the profile its channels suggest.
          type Report = {
            profile: { id: string; chosen: boolean };
            findings: { check: string; severity: string }[];
          };
          const qa = await get(`/api/files/${fileId}/qa`, owner);
          expect(qa.status).toBe(200);
          const report = (await qa.json()) as Report;
          expect(report.profile).toMatchObject({ id: "streaming", chosen: false });
          expect(report.findings.map((f) => f.check)).toEqual(
            expect.arrayContaining([
              "format",
              "true-peak",
              "clipping",
              "dropouts",
              "clicks",
              "phase",
            ]),
          );
          // The project's choice applies at once, with no new analysis.
          const patched = await app.request(`/api/projects/${await projectOfFile(fileId)}`, {
            ...json({ deliveryProfile: "broadcast" }, owner),
            method: "PATCH",
          });
          expect(patched.status).toBe(200);
          const again = (await (await get(`/api/files/${fileId}/qa`, owner)).json()) as Report;
          expect(again.profile).toMatchObject({ id: "broadcast", chosen: true });
          expect((await get(`/api/files/${other.fileId}/qa`)).status).toBe(401);

          // A file analysed before the checks existed is queued again, and gains them alone.
          const findingsOf = () =>
            db
              .select({ id: schema.qaFindings.id })
              .from(schema.qaFindings)
              .where(eq(schema.qaFindings.fileId, fileId));
          const before = (await findingsOf()).length;
          await db.delete(schema.qaFindings).where(eq(schema.qaFindings.fileId, fileId));
          const queued: string[] = [];
          expect(
            await requeueMissingFindings(db, {
              send: async (_name, data) => {
                queued.push((data as { fileId: string }).fileId);
                return null;
              },
            }),
          ).toBe(1);
          expect(queued).toEqual([fileId]);
          const peakRows = await db
            .select({ id: schema.peakLevels.id })
            .from(schema.peakLevels)
            .where(eq(schema.peakLevels.fileId, fileId));
          await analysisHandler({ db, storage, keyring, jobs, workDir: join(storageRoot, "work") })(
            { organisationId, fileId },
            { id: "job", signal: new AbortController().signal, retryCount: 0 },
          );
          expect((await findingsOf()).length).toBe(before);
          expect(
            await db
              .select({ id: schema.peakLevels.id })
              .from(schema.peakLevels)
              .where(eq(schema.peakLevels.fileId, fileId)),
          ).toEqual(peakRows);

          // One analysed before integrity and bandwidth (#41) gains those alone: integrity
          // decoded again, how high it reaches read from its stored spectrograms.
          const checks = async () =>
            (
              await db
                .select({ check: schema.qaFindings.check })
                .from(schema.qaFindings)
                .where(eq(schema.qaFindings.fileId, fileId))
            )
              .map((f) => f.check)
              .sort();
          const whole = await checks();
          expect(whole).toContain("integrity");
          await db
            .delete(schema.qaFindings)
            .where(
              and(
                eq(schema.qaFindings.fileId, fileId),
                inArray(schema.qaFindings.check, ["integrity", "bandwidth"]),
              ),
            );
          queued.length = 0;
          expect(
            await requeueMissingFindings(db, {
              send: async (_name, data) => {
                queued.push((data as { fileId: string }).fileId);
                return null;
              },
            }),
          ).toBe(1);
          await analysisHandler({ db, storage, keyring, jobs, workDir: join(storageRoot, "work") })(
            { organisationId, fileId },
            { id: "job", signal: new AbortController().signal, retryCount: 0 },
          );
          expect(await checks()).toEqual(whole);

          // One whose second channel is its LFE (#74) is queued for the LFE check alone, read
          // from the stored spectrograms; once it has it, nothing is queued again.
          const [stereo] = await db
            .select({ mediaInfo: schema.files.mediaInfo })
            .from(schema.files)
            .where(eq(schema.files.id, fileId));
          const original = stereo?.mediaInfo ?? null;
          const audioInfo = original?.audio;
          if (!original || !audioInfo) throw new Error("The file has no audio");
          await db
            .update(schema.files)
            .set({ mediaInfo: { ...original, audio: { ...audioInfo, channelLayout: "FL+LFE" } } })
            .where(eq(schema.files.id, fileId));
          const requeue = () =>
            requeueMissingFindings(db, {
              send: async (_name, data) => {
                queued.push((data as { fileId: string }).fileId);
                return null;
              },
            });
          queued.length = 0;
          expect(await requeue()).toBe(1);
          expect(queued).toEqual([fileId]);
          await analysisHandler({ db, storage, keyring, jobs, workDir: join(storageRoot, "work") })(
            { organisationId, fileId },
            { id: "job", signal: new AbortController().signal, retryCount: 0 },
          );
          const lfe = await db
            .select({ channel: schema.qaFindings.channel, severity: schema.qaFindings.severity })
            .from(schema.qaFindings)
            .where(and(eq(schema.qaFindings.fileId, fileId), eq(schema.qaFindings.check, "lfe")));
          // The test tone is full range: no LFE carries that.
          expect(lfe).toEqual([{ channel: 1, severity: "fail" }]);
          expect(await checks()).toEqual([...whole, "lfe"].sort());
          expect(await requeue()).toBe(0);
          await db
            .update(schema.files)
            .set({ mediaInfo: original })
            .where(eq(schema.files.id, fileId));

          // A file not yet analysed has no series, and another organisation's is not there.
          expect((await get(`/api/files/${other.fileId}/loudness/series`, owner)).status).toBe(404);
          const [elsewhere] = await db
            .insert(schema.organisations)
            .values({ name: "Elsewhere", slug: "elsewhere-loudness" })
            .returning();
          const foreignOrg = elsewhere?.id ?? "";
          const [project] = await db
            .insert(schema.projects)
            .values({ organisationId: foreignOrg, name: "Theirs", profile: "music" })
            .returning();
          const bytes = await storage.put(foreignOrg, Buffer.from("theirs"));
          const [foreign] = await db
            .insert(schema.files)
            .values({
              organisationId: foreignOrg,
              projectId: project?.id ?? "",
              name: "Theirs.wav",
              kind: "audio",
              blobId: bytes.id,
              contentType: "audio/wav",
              byteSize: bytes.byteSize,
            })
            .returning();
          await db.insert(schema.loudness).values({
            organisationId: foreignOrg,
            fileId: foreign?.id ?? "",
            summary: body.summary as LoudnessSummary,
            channels: 2,
            sampleRate: 48000,
            samplesPerFrame: 4800,
            frameCount: 0,
            blobId: bytes.id,
          });
          expect((await get(`/api/files/${foreign?.id}/loudness`, owner)).status).toBe(404);
          expect((await get(`/api/files/${foreign?.id}/loudness/series`, owner)).status).toBe(404);

          // And a spectrogram per channel, plus the mid and side of the pair.
          const listedSpectra = await get(`/api/files/${fileId}/spectrograms`, owner);
          expect(listedSpectra.status).toBe(200);
          const { spectrograms } = (await listedSpectra.json()) as {
            spectrograms: { id: string; channel: string; columns: number; bands: number }[];
          };
          expect(spectrograms.map((s) => s.channel).sort()).toEqual(["0", "1", "mid", "side"]);
          const first = spectrograms[0];
          const spectrum = await get(`/api/files/${fileId}/spectrograms/${first?.id}`, owner);
          expect(spectrum.status).toBe(200);
          expect(spectrum.headers.get("cache-control")).toContain("no-store");
          const decodedSpectrum = decodeSpectrogram(new Uint8Array(await spectrum.arrayBuffer()));
          expect([decodedSpectrum.columns, decodedSpectrum.bands]).toEqual([
            first?.columns,
            first?.bands,
          ]);
          // Not through another file's path, nor from another organisation's file.
          expect(
            (await get(`/api/files/${other.fileId}/spectrograms/${first?.id}`, owner)).status,
          ).toBe(404);
          const [foreignSpectrum] = await db
            .insert(schema.spectrograms)
            .values({
              organisationId: foreignOrg,
              fileId: foreign?.id ?? "",
              channel: "0",
              fftSize: 2048,
              sampleRate: 48000,
              samplesPerColumn: 512,
              columnCount: 0,
              bandCount: 1024,
              blobId: bytes.id,
            })
            .returning();
          expect((await get(`/api/files/${foreign?.id}/spectrograms`, owner)).status).toBe(404);
          expect(
            (await get(`/api/files/${foreign?.id}/spectrograms/${foreignSpectrum?.id}`, owner))
              .status,
          ).toBe(404);
        }, 120_000);

        it("describes a file and what it can play, to its own organisation only", async () => {
          const owner = cookieOf(await setup());
          const { fileId, projectId } = await playableFile(owner);
          const res = await get(`/api/files/${fileId}`, owner);
          expect(res.status).toBe(200);
          expect(((await res.json()) as { file: unknown }).file).toMatchObject({
            id: fileId,
            projectId,
            kind: "audio",
            streamStatus: "ready",
            mediaInfo: { audio: { channels: 2 } },
          });
          const started = await app.request(`/api/files/${fileId}/playback`, json({}, owner));
          const body = (await started.json()) as { renditions: { name: string; codecs: string }[] };
          expect(body.renditions.map((r) => [r.name, r.codecs])).toEqual([
            ["aac-256", "mp4a.40.2"],
            ["flac", "fLaC"],
          ]);

          const [other] = await db
            .insert(schema.organisations)
            .values({ name: "Elsewhere", slug: "elsewhere-playback" })
            .returning();
          const [foreignProject] = await db
            .insert(schema.projects)
            .values({ organisationId: other?.id ?? "", name: "Theirs", profile: "music" })
            .returning();
          const foreignBlob = await storage.put(other?.id ?? "", Buffer.from("theirs"));
          const [foreign] = await db
            .insert(schema.files)
            .values({
              organisationId: other?.id ?? "",
              projectId: foreignProject?.id ?? "",
              name: "Theirs.wav",
              kind: "audio",
              blobId: foreignBlob.id,
              contentType: "audio/wav",
              byteSize: 1,
              streamStatus: "ready",
            })
            .returning();
          expect((await get(`/api/files/${foreign?.id}`, owner)).status).toBe(404);
          expect((await start(owner, foreign?.id ?? "")).res.status).toBe(404);
        }, 120_000);
      },
    );
  });
});
