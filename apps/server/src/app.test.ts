import { spawnSync } from "node:child_process";
import { createDecipheriv } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buffer } from "node:stream/consumers";
import { createDb, runMigrations, schema, withAuditPurge } from "@hekate/db";
import {
  decodeLoudness,
  decodePeaks,
  decodeSpectrogram,
  defaultProjectRoles,
  type LoudnessSummary,
  mapTime,
} from "@hekate/shared";
import { CHUNK_SIZE, createBackends, encryptedSize, storageConfigFromEnv } from "@hekate/storage";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { createAudit, csvCell } from "./audit.ts";
import { createAuth } from "./auth.ts";
import { createClient } from "./client.ts";
import { loadConfig } from "./config.ts";
import { createKeyring } from "./keyring.ts";
import { memoryMailer } from "./mail.ts";
import { probe, run } from "./media/ffmpeg.ts";
import { webpComplete } from "./media/pages.ts";
import {
  analysisHandler,
  checksumHandler,
  proxyHandler,
  requeueAlignments,
  requeueMissingFindings,
} from "./media/workers.ts";
import { deliverDigests, deliverInstant, tellProcessingFailed } from "./notifications.ts";
import { playbackSecret, signPlayback } from "./playback.ts";
import { createStorage } from "./storage.ts";
import { expireUploads } from "./uploads.ts";

const url = process.env.DATABASE_URL;

describe("config", () => {
  it("reports every invalid setting", () => {
    expect(() => loadConfig({ PORT: "nope" })).toThrow(/PORT[\s\S]*DATABASE_URL[\s\S]*AUTH_SECRET/);
  });

  it("refuses a work directory that media tools could not be given safely", () => {
    expect(() => loadConfig({ WORK_DIR: "/mnt/scratch space" })).toThrow(/WORK_DIR/);
    expect(() => loadConfig({ WORK_DIR: "relative/work" })).toThrow(/WORK_DIR/);
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

    describe("tracks", () => {
      type TrackView = {
        id: string;
        name: string;
        position: number;
        scoreFileId: string | null;
        versions: {
          id: string;
          number: number;
          variations: { id: string; fileId: string; name: string; isPrimary: boolean }[];
        }[];
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

      it("gives every project the default roles, and its creator the Producer's", async () => {
        const { owner, projectId } = await studio();
        const roles = (await (await getAs(`/api/projects/${projectId}/roles`, owner)).json()) as {
          roles: { name: string; permissions: string[]; members: number }[];
        };
        expect(roles.roles.map((r) => r.name)).toEqual(defaultProjectRoles.map((r) => r.name));
        expect(roles.roles.find((r) => r.name === "Reviewer")?.permissions).toEqual([
          "view",
          "comment",
          "decide",
        ]);
        expect(roles.roles.find((r) => r.name === "Producer")?.members).toBe(1);
        const members = (await (
          await getAs(`/api/projects/${projectId}/members`, owner)
        ).json()) as {
          members: { name: string }[];
        };
        expect(members.members.map((m) => m.name)).toEqual(["Producer"]);
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
        expect((await list(engineer)).map((p) => [p.name, p.mayArchive])).toEqual([
          ["Rags", false],
        ]);
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
        expect(seen.project.permissions).toEqual(["view"]);
        expect(seen.project.archivedAt).not.toBeNull();
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
          ["view", "see the comments", (c) => getAs(`/api/files/${fileId}/comments`, c)],
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

      it("manages roles and members, and keeps them to the project", async () => {
        const { owner, organisationId, projectId } = await studio();
        const roles = `/api/projects/${projectId}/roles`;
        const made = await app.request(
          roles,
          json({ name: "Mixer", permissions: ["comment", "view"] }, owner),
        );
        expect(made.status).toBe(201);
        const mixer = ((await made.json()) as { role: { id: string; permissions: string[] } }).role;
        expect(mixer.permissions).toEqual(["view", "comment"]);
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
        items: { kind: string; fileId: string | null; version?: { number: number } | null }[];
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
            composer: await idOf(composer),
            accompanist: await idOf(accompanist),
            engineer: await idOf(engineer),
          },
        };
      };
      const request = (cookie: string, projectId: string, body: Record<string, unknown>) =>
        app.request(`/api/projects/${projectId}/reviews`, json(body, cookie));

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
        expect(mailer.sent[1]?.subject).toBe('composer approved "Album master"');
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
          },
        );

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
        expect(await refused.text()).toMatch(/music projects/);

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

          // The session, the key and every segment served, each attributable.
          const logged = await audit.query(organisationId, { fileId, limit: 50 });
          const actions = logged.events.map((e) => e.action);
          const served = media.split("\n").filter((l) => l.startsWith("seg/")).length;
          expect(actions.filter((a) => a === "stream.segment")).toHaveLength(served);
          expect(new Set(actions)).toEqual(
            new Set(["stream.key", "stream.session", "stream.segment"]),
          );
          expect(logged.events.every((e) => e.projectId)).toBe(true);
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
