import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, runMigrations, schema, withAuditPurge } from "@hekate/db";
import { createBackends, storageConfigFromEnv } from "@hekate/storage";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { createAudit } from "./audit.ts";
import { createAuth } from "./auth.ts";
import { createKeyring } from "./keyring.ts";
import { memoryMailer } from "./mail.ts";
import { playbackSecret } from "./playback.ts";
import { createStorage } from "./storage.ts";

const url = process.env.DATABASE_URL;

// The breach-check plugin on, as an installed instance has it: the routes that make an account
// themselves (setup, an invitation accepted) must not call the hasher it wraps, which can only
// run inside Better Auth's own endpoints. The routes' own check of the password is left off
// (passwordLeakCheck), so the test asks no outside service.
describe.runIf(url)("a new account's password, with the breach check on", () => {
  const { db, close } = createDb(url ?? "", { max: 3 });
  const mailer = memoryMailer();
  const audit = createAudit(db);
  const keyring = createKeyring(db, { current: Buffer.alloc(32, 7), previous: [] });
  const auth = createAuth({
    db,
    secret: "test-secret-test-secret-test-secret-0",
    baseURL: "http://localhost:3000",
    testing: true,
    leakCheck: true,
    mailer,
    audit,
    keyring,
  });
  const storageRoot = mkdtempSync(join(tmpdir(), "hekate-passwords-storage-"));
  const app = createApp({
    db,
    auth,
    mailer,
    storage: createStorage(
      db,
      createBackends(storageConfigFromEnv({ STORAGE_LOCAL_PATH: storageRoot })),
      keyring,
    ),
    audit,
    jobs: { send: async () => "job" },
    keyring,
    playbackSecret: playbackSecret("test-secret-test-secret-test-secret-0"),
    publicUrl: "http://localhost:3000",
    log: false,
  });
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
  const signIn = (email: string, password: string) =>
    app.request("/api/auth/sign-in/email", json({ email, password }));

  // Setup refuses once anyone has an account, so the suite starts and ends with none.
  const empty = async () => {
    await withAuditPurge(db, (tx) =>
      tx.execute(sql`truncate ${schema.organisations}, ${schema.users} cascade`),
    );
    await db.execute(sql`truncate ${schema.requestLimits}`);
  };
  beforeAll(async () => {
    await runMigrations(url ?? "");
    await empty();
  });
  afterAll(async () => {
    await empty();
    await close();
    rmSync(storageRoot, { recursive: true, force: true });
  });

  it("sets up the instance, and an invitation makes an account, both signing in after", async () => {
    const owner = {
      name: "Alex Rivera",
      email: "alex@example.test",
      password: "correct horse battery",
    };
    const setup = await app.request("/api/setup", json({ ...owner, organisation: "Studio" }));
    expect(setup.status).toBe(201);
    expect((await signIn(owner.email, owner.password)).status).toBe(200);

    const invited = await app.request(
      "/api/organisation/invitations",
      json({ email: "ines@example.test", role: "member" }, cookieOf(setup)),
    );
    const { link } = (await invited.json()) as { link: string };
    const accepted = await app.request(
      `/api/invitations/${link.split("/invite/")[1] ?? ""}/accept`,
      json({ name: "Ines Arlow", password: "a long enough password" }),
    );
    expect(accepted.status).toBe(201);
    expect((await signIn("ines@example.test", "a long enough password")).status).toBe(200);
  });
});
