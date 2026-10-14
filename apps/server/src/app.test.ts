import { spawnSync } from "node:child_process";
import { createDecipheriv } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { createDb, runMigrations, schema, withAuditPurge } from "@hekate/db";
import { CHUNK_SIZE, createBackends, encryptedSize, storageConfigFromEnv } from "@hekate/storage";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { createAudit, csvCell } from "./audit.ts";
import { createAuth } from "./auth.ts";
import { createClient } from "./client.ts";
import { loadConfig } from "./config.ts";
import { createKeyring } from "./keyring.ts";
import { memoryMailer } from "./mail.ts";
import { probe, run } from "./media/ffmpeg.ts";
import { checksumHandler, proxyHandler } from "./media/workers.ts";
import { playbackSecret, signPlayback } from "./playback.ts";
import { createStorage } from "./storage.ts";
import { expireUploads } from "./uploads.ts";

const url = process.env.DATABASE_URL;

describe("config", () => {
  it("reports every invalid setting", () => {
    expect(() => loadConfig({ PORT: "nope" })).toThrow(/PORT[\s\S]*DATABASE_URL[\s\S]*AUTH_SECRET/);
  });
});

describe.runIf(url)("api", () => {
  const { db, close } = createDb(url ?? "", { max: 3 });
  const auth = createAuth({
    db,
    secret: "test-secret-test-secret-test-secret-0",
    baseURL: "http://localhost:3000",
    testing: true,
  });
  const mailer = memoryMailer();
  const storageRoot = mkdtempSync(join(tmpdir(), "hekate-api-storage-"));
  const backends = createBackends(
    storageConfigFromEnv({
      STORAGE_BACKENDS: "local,spare",
      STORAGE_LOCAL_PATH: join(storageRoot, "local"),
      STORAGE_SPARE_DRIVER: "local",
      STORAGE_SPARE_PATH: join(storageRoot, "spare"),
    }),
  );
  const masterKey = Buffer.alloc(32, 7);
  const keyring = createKeyring(db, { current: masterKey, previous: [] });
  const storage = createStorage(db, backends, keyring);
  const audit = createAudit(db);
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

  beforeAll(async () => {
    await runMigrations(url ?? "");
  });
  beforeEach(async () => {
    await withAuditPurge(db, (tx) =>
      tx.execute(sql`truncate ${schema.organisations}, ${schema.users} cascade`),
    );
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
    const res = await client.projects.$get();
    const body = await res.json();
    expect(body.projects[0]?.name).toBe("Crossing");
  });

  describe("members and invitations", () => {
    const tokenFrom = (link: string) => link.split("/invite/")[1] ?? "";
    const invite = async (cookie: string, email: string, role = "member") => {
      const res = await app.request("/api/organisation/invitations", json({ email, role }, cookie));
      return { res, body: (await res.json()) as { link: string; invitation: { id: string } } };
    };

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
          body: bytes,
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
          return {
            res,
            url: res.status === 201 ? ((await res.json()) as { url: string }).url : "",
          };
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

          const logged = await audit.query(organisationId, { fileId, limit: 10 });
          expect(logged.events.map((e) => e.action).sort()).toEqual([
            "stream.key",
            "stream.session",
          ]);
        }, 120_000);

        it("plays video as an encrypted ladder that decrypts to H.264 and AAC", async () => {
          const owner = cookieOf(await setup());
          const { fileId } = await playableFile(owner, "video");
          const { url } = await start(owner, fileId);
          const master = await (await get(url, owner)).text();
          expect(master).toContain("RESOLUTION=1920x1080");
          expect(master).toContain("RESOLUTION=1280x720");
          const lines = master.split("\n");
          const variant =
            lines[lines.findIndex((l) => l.includes("RESOLUTION=1280x720")) + 1] ?? "";
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
          const assembled = join(storageRoot, "assembled-video.mp4");
          writeFileSync(assembled, Buffer.concat(parts));
          const info = await probe(assembled);
          expect(info.video).toMatchObject({ codec: "h264", width: 1280, height: 720 });
          expect(info.audio).toMatchObject({ codec: "aac" });
          expect(info.duration).toBeCloseTo(5, 0);
        }, 180_000);

        it("refuses copied, forged, expired and stale links", async () => {
          const owner = cookieOf(await setup());
          const { organisationId, fileId } = await playableFile(owner);
          const { url } = await start(owner, fileId);
          expect((await get(url)).status).toBe(401);

          // Another member of the same organisation cannot use the owner's link.
          const colleague = await joinAs(owner, "engineer@example.test", "member");
          expect((await get(url, colleague)).status).toBe(403);
          // But can start their own.
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
          for (let i = 0; i < 32; i++) statuses.push((await get(keyUrl, owner)).status);
          expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
          expect(statuses.slice(30)).toEqual([429, 429]);
          const keys = await audit.query(organisationId, { action: "stream.key", limit: 200 });
          expect(keys.events).toHaveLength(30);
        }, 120_000);
      },
    );
  });
});
