import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buffer } from "node:stream/consumers";
import { createDb, runMigrations, schema } from "@hekate/db";
import { createBackends, encryptedSize, storageConfigFromEnv } from "@hekate/storage";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { createAuth } from "./auth.ts";
import { createClient } from "./client.ts";
import { loadConfig } from "./config.ts";
import { createKeyring } from "./keyring.ts";
import { memoryMailer } from "./mail.ts";
import { createStorage } from "./storage.ts";

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
  const app = createApp({
    db,
    auth,
    mailer,
    storage,
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
    await db.execute(sql`truncate ${schema.organisations}, ${schema.users} cascade`);
  });
  afterAll(async () => {
    await db.execute(sql`truncate ${schema.organisations}, ${schema.users} cascade`);
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
  });
});
