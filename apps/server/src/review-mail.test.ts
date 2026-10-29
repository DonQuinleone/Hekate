import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, runMigrations, schema, withAuditPurge } from "@hekate/db";
import { defaultProjectRoles } from "@hekate/shared";
import { createBackends, storageConfigFromEnv } from "@hekate/storage";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { createAudit } from "./audit.ts";
import { createAuth } from "./auth.ts";
import { createKeyring } from "./keyring.ts";
import { memoryMailer } from "./mail.ts";
import { playbackSecret } from "./playback.ts";
import { createStorage } from "./storage.ts";

const url = process.env.DATABASE_URL;

/**
 * The two review emails (#503): asking someone for a review mails them, and their decision
 * mails whoever asked, each once, through their notification preferences rather than a send
 * of its own. And where the instance's mail goes to its log, the account says so.
 */
describe.runIf(url)("review mail through notification preferences", () => {
  const { db, close } = createDb(url ?? "", { max: 4 });
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
  const storageRoot = mkdtempSync(join(tmpdir(), "hekate-review-mail-"));
  const storage = createStorage(
    db,
    createBackends(storageConfigFromEnv({ STORAGE_LOCAL_PATH: storageRoot })),
    keyring,
  );
  const deps = {
    db,
    auth,
    mailer,
    storage,
    audit,
    jobs: { send: async () => "job" },
    keyring,
    playbackSecret: playbackSecret("test-secret-test-secret-test-secret-0"),
    trustProxy: true,
    publicUrl: "http://localhost:3000",
    log: false,
  };
  // As a development install runs: nothing set, so mail goes to the log.
  const app = createApp(deps);
  // And as a production one: an SMTP server set.
  const sending = createApp({ ...deps, mail: "smtp" });

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
  const get = (path: string, cookie: string) => app.request(path, { headers: { cookie } });
  const post = (path: string, body: unknown, cookie: string) =>
    app.request(path, json(body, cookie));
  const put = (path: string, body: unknown, cookie: string) =>
    app.request(path, json(body, cookie, "PUT"));
  const idOf = async (cookie: string) =>
    ((await (await get("/api/me", cookie)).json()) as { user: { id: string } }).user.id;

  const mira = { name: "Mira Solberg", email: "mira@endlesshall.example" };
  const tomas = { name: "Tomas Varga", email: "tomas@endlesshall.example" };

  const setup = async () =>
    cookieOf(
      await app.request(
        "/api/setup",
        json({
          ...mira,
          password: "correct horse battery",
          organisation: "Endless Hall Records",
        }),
      ),
    );
  const joinAs = async (owner: string, email: string, name: string) => {
    const invited = await post("/api/organisation/invitations", { email, role: "member" }, owner);
    const { link } = (await invited.json()) as { link: string };
    const res = await app.request(
      `/api/invitations/${link.split("/invite/")[1]}/accept`,
      json({ name, password: "correct horse battery" }),
    );
    expect(res.status).toBe(201);
    return cookieOf(res);
  };
  const grantRole = async (owner: string, projectId: string, holder: string, name: string) => {
    const { roles } = (await (await get(`/api/projects/${projectId}/roles`, owner)).json()) as {
      roles: { id: string; name: string }[];
    };
    let role = roles.find((r) => r.name === name);
    if (!role) {
      const permissions = defaultProjectRoles.find((r) => r.name === name)?.permissions ?? [];
      const made = await post(`/api/projects/${projectId}/roles`, { name, permissions }, owner);
      role = ((await made.json()) as { role: { id: string; name: string } }).role;
    }
    const res = await app.request(
      `/api/projects/${projectId}/members/${await idOf(holder)}`,
      json({ roleId: role.id }, owner, "PUT"),
    );
    expect(res.status).toBe(204);
  };

  /** Mira's label, with a project whose track has one version, and Tomas reviewing on it. */
  const studio = async () => {
    const owner = await setup();
    const organisationId = (
      (await (await get("/api/me", owner)).json()) as { activeOrganisationId: string }
    ).activeOrganisationId;
    const made = await post("/api/projects", { name: "Joplin Rags", profile: "music" }, owner);
    const projectId = ((await made.json()) as { project: { id: string } }).project.id;
    const reviewer = await joinAs(owner, tomas.email, tomas.name);
    await grantRole(owner, projectId, reviewer, "Reviewer");
    const blob = await storage.put(organisationId, Buffer.from("Maple Leaf Rag - V1.wav"));
    const [file] = await db
      .insert(schema.files)
      .values({
        organisationId,
        projectId,
        name: "Maple Leaf Rag - V1.wav",
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
    const [track] = await db
      .insert(schema.tracks)
      .values({ organisationId, projectId, name: "Maple Leaf Rag" })
      .returning();
    const [version] = await db
      .insert(schema.versions)
      .values({ organisationId, trackId: track?.id ?? "", number: 1 })
      .returning();
    await db.insert(schema.variants).values({
      organisationId,
      versionId: version?.id ?? "",
      fileId: file?.id ?? "",
      name: "Mix",
      isPrimary: true,
    });
    mailer.sent.length = 0;
    return {
      owner,
      reviewer,
      projectId,
      trackId: track?.id ?? "",
      reviewerId: await idOf(reviewer),
    };
  };
  type Studio = Awaited<ReturnType<typeof studio>>;

  const ask = async (s: Studio, title: string) => {
    const res = await post(
      `/api/projects/${s.projectId}/reviews`,
      { kind: "approval", title, items: [{ trackId: s.trackId }], reviewers: [s.reviewerId] },
      s.owner,
    );
    expect(res.status).toBe(201);
    return ((await res.json()) as { review: { id: string } }).review.id;
  };
  const decide = async (s: Studio, reviewId: string) => {
    const res = await post(
      `/api/reviews/${reviewId}/decisions`,
      { decision: "approved" },
      s.reviewer,
    );
    expect(res.status).toBe(200);
  };
  const preferences = (cookie: string, body: Record<string, unknown>) =>
    put(
      "/api/notifications/preferences",
      { mailMode: "instant", digest: "daily", kinds: {}, ...body },
      cookie,
    );
  const inApp = async (cookie: string) =>
    (
      (await (await get("/api/notifications", cookie)).json()) as {
        notifications: { kind: string; text: string }[];
      }
    ).notifications;

  beforeAll(async () => {
    await runMigrations(url ?? "");
  });
  beforeEach(async () => {
    await withAuditPurge(db, (tx) =>
      tx.execute(sql`truncate ${schema.organisations}, ${schema.users} cascade`),
    );
    await db.execute(sql`truncate ${schema.requestLimits}`);
    mailer.sent.length = 0;
  });
  afterAll(async () => {
    await close();
    rmSync(storageRoot, { recursive: true, force: true });
  });

  it("mails the reviewer once when asked, and the requester once when they decide", async () => {
    const s = await studio();
    const reviewId = await ask(s, "Master sign-off");
    expect(mailer.sent.map((m) => [m.to, m.subject])).toEqual([
      [tomas.email, "Master sign-off: your approval is asked"],
    ]);
    expect(mailer.sent[0]?.text).toContain(`/reviews/${reviewId}`);

    mailer.sent.length = 0;
    await decide(s, reviewId);
    expect(mailer.sent.map((m) => [m.to, m.subject])).toEqual([
      [mira.email, "Master sign-off: approved"],
    ]);
    expect(mailer.sent[0]?.text).toContain("Tomas Varga");
  });

  it("consults each person's preferences: mail off keeps it to the app, a digest holds it", async () => {
    const s = await studio();
    // Tomas keeps review requests to the app; Mira gathers her mail into a digest.
    expect(
      (await preferences(s.reviewer, { kinds: { review_requested: { app: true, mail: false } } }))
        .status,
    ).toBe(200);
    expect((await preferences(s.owner, { mailMode: "digest", digest: "hourly" })).status).toBe(200);
    const reviewId = await ask(s, "Second pass");
    expect(mailer.sent).toEqual([]);
    expect((await inApp(s.reviewer)).map((n) => n.kind)).toEqual(["review_requested"]);

    await decide(s, reviewId);
    expect(mailer.sent).toEqual([]);
    const [queued] = await db
      .select({
        mailMode: schema.notifications.mailMode,
        emailedAt: schema.notifications.emailedAt,
      })
      .from(schema.notifications)
      .where(sql`${schema.notifications.kind} = 'decision'`);
    expect(queued).toEqual({ mailMode: "digest", emailedAt: null });
  });

  it("tells the account when the instance's mail only reaches its log", async () => {
    const s = await studio();
    const flag = async (which: typeof app) =>
      (
        (await (await which.request("/api/me", { headers: { cookie: s.owner } })).json()) as {
          mail: { logOnly: boolean };
        }
      ).mail;
    expect(await flag(app)).toEqual({ logOnly: true });
    expect(await flag(sending)).toEqual({ logOnly: false });
  });
});
