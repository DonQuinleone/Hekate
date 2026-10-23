import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, runMigrations, schema, withAuditPurge } from "@hekate/db";
import type {
  OperatorTicketDetail,
  SupportDesk,
  SupportModule,
  TicketDetail,
  TicketRow,
  WorkspaceSupport,
} from "@hekate/shared";
import { createBackends, storageConfigFromEnv } from "@hekate/storage";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import { createAudit } from "./audit.ts";
import { createAuth } from "./auth.ts";
import { createInstanceSettings } from "./instance-settings.ts";
import { createKeyring } from "./keyring.ts";
import { memoryMailer } from "./mail.ts";
import { playbackSecret } from "./playback.ts";
import { createStorage } from "./storage.ts";

const url = process.env.DATABASE_URL;

describe.runIf(url)("support (#181, #182)", () => {
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
  const storageRoot = mkdtempSync(join(tmpdir(), "hekate-support-storage-"));
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
  const jobs = { send: async () => "job" };
  // One store for every app here, forgotten between tests, so none reads another's desk.
  const settings = createInstanceSettings(db);
  const build = (support: "off" | "app", billing: "off" | "manual" = "manual") =>
    createApp({
      settings,
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
      modules: {
        billing,
        support,
        supportAddress: null,
        docsUrl: "https://docs.hekate.studio",
        statusUrl: "https://status.example",
      },
    });
  const app = build("app");
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
  const get = (path: string, cookie: string, via = app) =>
    via.request(path, { headers: { cookie } });
  const send = (path: string, body: unknown, cookie: string, method = "POST", via = app) =>
    via.request(path, json(body, cookie, method));
  /** The installer's owner: of the workspace Endless Hall Records, and the first operator. */
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
  const accept = async (link: string, name: string) => {
    const res = await app.request(
      `/api/invitations/${link.split("/invite/")[1]}/accept`,
      json({ name, password: "correct horse battery" }),
    );
    expect(res.status).toBe(201);
    return cookieOf(res);
  };
  const joinAs = async (owner: string, email: string, name: string, role = "member") => {
    const res = await send("/api/organisation/invitations", { email, role }, owner);
    return accept(((await res.json()) as { link: string }).link, name);
  };
  /** Another workspace, made by the operator, with its owner signed in. */
  const elsewhere = async (operator: string) => {
    const res = await send(
      "/api/instance/workspaces",
      { name: "Saltmarsh Films", slug: "saltmarsh", ownerEmail: "ines@saltmarsh.example" },
      operator,
    );
    expect(res.status).toBe(201);
    return accept(((await res.json()) as { link: string }).link, "Ines Arlow");
  };
  const ticket = {
    subject: "Score page 7 will not render",
    kind: "problem",
    severity: "normal",
    message: "Pages 1 to 6 show, then a blank. The PDF opens fine elsewhere.",
  };
  const ask = async (cookie: string, body: object = ticket, via = app) => {
    const res = await send("/api/organisation/support/tickets", body, cookie, "POST", via);
    return { res, body: (await res.json()) as { ticket: TicketDetail; messageId: string } };
  };
  const workspaceId = async (name: string) =>
    (
      await db
        .select({ id: schema.organisations.id })
        .from(schema.organisations)
        .where(eq(schema.organisations.name, name))
    )[0]?.id ?? "";

  beforeAll(async () => {
    await runMigrations(url ?? "");
  });
  beforeEach(async () => {
    await withAuditPurge(db, (tx) =>
      tx.execute(sql`truncate ${schema.organisations}, ${schema.users} cascade`),
    );
    await db.execute(sql`truncate ${schema.requestLimits}`);
    // The desk's own, the instance's: each test starts with none.
    await db.delete(schema.cannedReplies);
    await db.delete(schema.plans);
    await db.delete(schema.instanceSettings);
    settings.forget();
    mailer.sent.length = 0;
  });
  afterAll(async () => {
    await withAuditPurge(db, (tx) =>
      tx.execute(sql`truncate ${schema.organisations}, ${schema.users} cascade`),
    );
    await db.delete(schema.instanceSettings);
    await close();
    rmSync(storageRoot, { recursive: true, force: true });
  });

  it("is refused on both sides unless tickets are answered in the app", async () => {
    const off = build("off");
    const owner = await setup();
    const asked = await ask(owner, ticket, off);
    expect(asked.res.status).toBe(409);
    expect(asked.body).toMatchObject({ error: { code: "support_off" } });
    expect((await get("/api/instance/support", owner, off)).status).toBe(409);
    // The help menu learns how the instance answers from who the person is.
    const me = (await (await get("/api/me", owner, off)).json()) as { support: SupportModule };
    expect(me.support).toMatchObject({ mode: "off", statusUrl: "https://status.example" });
    const on = (await (await get("/api/me", owner)).json()) as { support: SupportModule };
    expect(on.support.mode).toBe("app");
    // The instance side shows Support only with it on.
    expect(await (await get("/api/instance/me", owner)).json()).toMatchObject({ support: true });
    expect(await (await get("/api/instance/me", owner, off)).json()).toMatchObject({
      support: false,
    });
  });

  it("sends a ticket with a reference, and tells the desk", async () => {
    const owner = await setup();
    const { res, body } = await ask(owner);
    expect(res.status).toBe(201);
    expect(body.ticket).toMatchObject({
      subject: "Score page 7 will not render",
      kind: "problem",
      severity: "normal",
      state: "waiting",
      requester: { name: "Alex Rivera" },
      messages: 1,
    });
    expect(body.ticket.reference).toMatch(/^T-[0-9A-F]{4}-[0-9A-F]{2}$/);
    expect(body.ticket.thread).toEqual([
      expect.objectContaining({ author: "member", name: "Alex Rivera", body: ticket.message }),
    ]);
    // Every operator hears of it, with no one on call.
    const mail = mailer.sent.find((m) => m.to === "alex@endlesshall.example");
    expect(mail?.subject).toBe(`[${body.ticket.reference}] Score page 7 will not render`);
    expect(mail?.text).toContain(`/instance/support?ticket=${body.ticket.id}`);
    // Refused without a subject, or with a type that is not one.
    expect((await ask(owner, { ...ticket, subject: " " })).res.status).toBe(400);
    expect((await ask(owner, { ...ticket, kind: "rant" })).res.status).toBe(400);
  });

  it("keeps another workspace's tickets invisible, and a member's to themselves", async () => {
    const owner = await setup();
    const member = await joinAs(owner, "tomas@endlesshall.example", "Tomas Varga");
    const admin = await joinAs(owner, "mira@endlesshall.example", "Mira Solberg", "admin");
    const theirs = (await ask(member, { ...ticket, subject: "Can guests see takes?" })).body.ticket;
    const mine = (await ask(owner)).body.ticket;
    const other = await elsewhere(owner);
    const outside = (await ask(other, { ...ticket, subject: "Raise our quota" })).body.ticket;

    const list = async (cookie: string) =>
      ((await (await get("/api/organisation/support", cookie)).json()) as WorkspaceSupport).tickets
        .map((t: TicketRow) => t.subject)
        .sort();
    // Owners and admins read every ticket the workspace sent; a member reads their own.
    expect(await list(owner)).toEqual(["Can guests see takes?", "Score page 7 will not render"]);
    expect(await list(admin)).toEqual(["Can guests see takes?", "Score page 7 will not render"]);
    expect(await list(member)).toEqual(["Can guests see takes?"]);
    expect(await list(other)).toEqual(["Raise our quota"]);

    // Another's, here or elsewhere, is not found: never confirmed, never answered.
    expect((await get(`/api/organisation/support/tickets/${mine.id}`, member)).status).toBe(404);
    expect((await get(`/api/organisation/support/tickets/${outside.id}`, owner)).status).toBe(404);
    expect((await get(`/api/organisation/support/tickets/${theirs.id}`, other)).status).toBe(404);
    const reply = (cookie: string, id: string) =>
      send(`/api/organisation/support/tickets/${id}/messages`, { body: "Any news?" }, cookie);
    expect((await reply(other, theirs.id)).status).toBe(404);
    expect((await reply(member, mine.id)).status).toBe(404);
    expect(
      (await send(`/api/organisation/support/tickets/${outside.id}/resolve`, {}, owner)).status,
    ).toBe(404);
    // The workspace's admin answers its member's ticket.
    expect((await reply(admin, theirs.id)).status).toBe(201);
  });

  it("holds the severity to the workspace's plan", async () => {
    const owner = await setup();
    const id = await workspaceId("Endless Hall Records");
    const plan = (key: string, name: string, amount: number, severities: string[]) =>
      send(
        "/api/instance/plans",
        {
          key,
          name,
          price: { amount, currency: "GBP", interval: "month" },
          storageQuota: null,
          memberLimit: null,
          projectLimit: null,
          features: [],
          severities,
        },
        owner,
      );
    await plan("solo", "Solo", 900, ["low", "normal"]);
    const made = (await (
      await plan("label", "Label", 19_000, ["low", "normal", "high", "urgent", "emergency"])
    ).json()) as { plans: { id: string; key: string }[] };
    const solo = made.plans.find((p) => p.key === "solo");
    expect(
      (await send(`/api/instance/workspaces/${id}/plan`, { planId: solo?.id }, owner, "PUT"))
        .status,
    ).toBe(200);

    // A workspace on a plan allowing Low and Normal cannot send Urgent.
    const urgent = await ask(owner, { ...ticket, severity: "urgent" });
    expect(urgent.res.status).toBe(403);
    expect(urgent.body).toMatchObject({ error: { code: "severity_not_entitled" } });
    expect((await ask(owner, { ...ticket, severity: "normal" })).res.status).toBe(201);
    // The page says which plan unlocks what this one does not.
    const page = (await (await get("/api/organisation/support", owner)).json()) as WorkspaceSupport;
    expect(page.severities).toEqual([
      { severity: "low", allowed: true, plan: null },
      { severity: "normal", allowed: true, plan: null },
      { severity: "high", allowed: false, plan: "Label" },
      { severity: "urgent", allowed: false, plan: "Label" },
      { severity: "emergency", allowed: false, plan: "Label" },
    ]);
    // Without billing, every workspace is on the internal plan, which allows them all.
    expect(
      (await ask(owner, { ...ticket, severity: "urgent" }, build("app", "off"))).res.status,
    ).toBe(201);
  });

  it("notifies both sides as the thread goes back and forth", async () => {
    const owner = await setup();
    const member = await joinAs(owner, "tomas@endlesshall.example", "Tomas Varga");
    const other = await joinAs(owner, "mira@endlesshall.example", "Mira Solberg");
    const asked = (await ask(member)).body.ticket;
    mailer.sent.length = 0;

    // The operator answers: the ticket waits on the workspace, and the requester hears.
    const answered = await send(
      `/api/instance/support/tickets/${asked.id}/messages`,
      { body: "The PDF has a damaged cross-reference table at page 7." },
      owner,
    );
    expect(answered.status).toBe(201);
    const detail = ((await answered.json()) as { ticket: OperatorTicketDetail }).ticket;
    expect(detail.state).toBe("answered");
    expect(detail.who).toMatchObject({
      name: "Tomas Varga",
      email: "tomas@endlesshall.example",
      role: "member",
    });
    expect(detail.who.lastSeenAt).not.toBeNull();
    expect(detail.place).toMatchObject({ name: "Endless Hall Records", openReviews: 0 });
    const told = mailer.sent.find((m) => m.to === "tomas@endlesshall.example");
    expect(told?.subject).toBe(`[${asked.reference}] ${asked.subject}`);
    expect(told?.text).toContain(`/settings/support?ticket=${asked.id}`);
    expect(mailer.sent.some((m) => m.to === "mira@endlesshall.example")).toBe(false);

    // The requester replies: back with support, and the operator who answered hears.
    mailer.sent.length = 0;
    const replied = await send(
      `/api/organisation/support/tickets/${asked.id}/messages`,
      { body: "Re-exported; it renders now." },
      member,
    );
    expect(replied.status).toBe(201);
    expect(((await replied.json()) as { ticket: TicketDetail }).ticket.state).toBe("waiting");
    expect(mailer.sent.map((m) => m.to)).toEqual(["alex@endlesshall.example"]);

    // Resolved by the workspace; an operator may set any state, and the desk records it.
    const resolved = await send(
      `/api/organisation/support/tickets/${asked.id}/resolve`,
      {},
      member,
    );
    expect(((await resolved.json()) as { ticket: TicketDetail }).ticket.state).toBe("resolved");
    const reopened = await send(
      `/api/instance/support/tickets/${asked.id}/state`,
      { state: "open" },
      owner,
      "PUT",
    );
    expect(((await reopened.json()) as { ticket: TicketDetail }).ticket.state).toBe("open");
    const events = await db
      .select({ action: schema.instanceEvents.action })
      .from(schema.instanceEvents)
      .where(eq(schema.instanceEvents.target, asked.reference));
    expect(events.map((e) => e.action).sort()).toEqual(["support.replied", "support.state"]);

    // Someone else in the workspace, not an admin, cannot reply to it.
    expect(
      (
        await send(
          `/api/organisation/support/tickets/${asked.id}/messages`,
          { body: "Me too" },
          other,
        )
      ).status,
    ).toBe(404);
  });

  it("is the operators' alone on the instance side, filtered as asked", async () => {
    const operator = await setup();
    const member = await joinAs(operator, "tomas@endlesshall.example", "Tomas Varga");
    const owner = await elsewhere(operator);
    await ask(member);
    await ask(owner, { ...ticket, subject: "Raise our quota", kind: "billing", severity: "low" });

    // A workspace's owner who does not operate the instance is refused, as is a member.
    expect((await get("/api/instance/support", owner)).status).toBe(403);
    expect((await get("/api/instance/support", member)).status).toBe(403);

    type Desk = { tickets: TicketRow[]; figures: { open: number }; workspaces: { name: string }[] };
    const desk = async (query = "") =>
      (await (await get(`/api/instance/support${query}`, operator)).json()) as Desk;
    const all = await desk();
    expect(all.tickets).toHaveLength(2);
    expect(all.figures).toMatchObject({ open: 2, waiting: 2, resolved: 0 });
    expect(all.workspaces.map((w) => w.name)).toEqual(["Endless Hall Records", "Saltmarsh Films"]);
    expect(all.tickets.find((t) => t.subject === "Raise our quota")?.workspace?.name).toBe(
      "Saltmarsh Films",
    );
    const subjects = (d: Desk) => d.tickets.map((t) => t.subject);
    expect(subjects(await desk("?severity=low"))).toEqual(["Raise our quota"]);
    expect(subjects(await desk("?q=saltmarsh"))).toEqual(["Raise our quota"]);
    expect(subjects(await desk("?q=tomas"))).toEqual(["Score page 7 will not render"]);
    const id = await workspaceId("Endless Hall Records");
    expect(subjects(await desk(`?workspace=${id}`))).toEqual(["Score page 7 will not render"]);
    expect((await get("/api/instance/support?state=closed", operator)).status).toBe(400);
  });

  it("keeps attachments encrypted, for those who may read the ticket, each download logged", async () => {
    const owner = await setup();
    const member = await joinAs(owner, "tomas@endlesshall.example", "Tomas Varga");
    const other = await joinAs(owner, "mira@endlesshall.example", "Mira Solberg");
    const { body } = await ask(member);
    const attach = (cookie: string, name = "webhooks.png") =>
      app.request(
        `/api/organisation/support/tickets/${body.ticket.id}/messages/${body.messageId}/attachments`,
        {
          method: "POST",
          headers: {
            cookie,
            origin: "http://localhost:3000",
            "content-type": "image/png",
            "x-file-name": encodeURIComponent(name),
          },
          body: new Uint8Array([137, 80, 78, 71, 1, 2, 3]),
        },
      );
    // Only the message's sender attaches to it.
    expect((await attach(owner)).status).toBe(403);
    const added = await attach(member);
    expect(added.status).toBe(201);
    const { attachment } = (await added.json()) as { attachment: { id: string } };
    const download = (cookie: string, via = `/api/organisation/support/tickets`) =>
      app.request(`${via}/${body.ticket.id}/attachments/${attachment.id}/download`, {
        method: "POST",
        headers: { cookie, origin: "http://localhost:3000" },
      });
    const got = await download(member);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-disposition")).toContain("webhooks.png");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(
      new Uint8Array([137, 80, 78, 71, 1, 2, 3]),
    );
    // Storage holds ciphertext only.
    const [blob] = await db.select().from(schema.blobs);
    expect(blob?.byteSize).toBe(7);
    // A member who may not read the ticket gets nothing; the desk does, under the operator's name.
    expect((await download(other)).status).toBe(404);
    expect((await download(owner, "/api/instance/support/tickets")).status).toBe(200);
    const logged = await db
      .select({ label: schema.accessEvents.actorLabel })
      .from(schema.accessEvents)
      .where(eq(schema.accessEvents.action, "support.attachment_download"));
    expect(logged.map((l) => l.label).sort()).toEqual([
      "Alex Rivera <alex@endlesshall.example> (operator)",
      "Tomas Varga <tomas@endlesshall.example>",
    ]);
  });

  it("attaches the person's own error reference, never another workspace's", async () => {
    const owner = await setup();
    const id = await workspaceId("Endless Hall Records");
    const other = await elsewhere(owner);
    const otherId = await workspaceId("Saltmarsh Films");
    const [me] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, "alex@endlesshall.example"));
    for (const [reference, organisationId] of [
      ["HK-7F3A-2C", id],
      ["HK-2B91-E0", otherId],
    ] as const)
      await db.insert(schema.errorReports).values({
        reference,
        source: "api",
        location: "GET /api/files/:id",
        message: "boom",
        organisationId,
        userId: me?.id ?? null,
      });
    // Offered on the Support page, as the last failure this person saw here.
    const page = (await (await get("/api/organisation/support", owner)).json()) as WorkspaceSupport;
    expect(page.recentError?.reference).toBe("HK-7F3A-2C");

    const sent = await ask(owner, {
      ...ticket,
      errorReference: "hk7f3a2c",
      message: "It said HK-2B91-E0 as well.",
    });
    expect(sent.res.status).toBe(201);
    expect(sent.body.ticket.errorReference).toBe("HK-7F3A-2C");
    // Hekate's own note in the thread names the one that is theirs, and only that one.
    const notes = sent.body.ticket.thread.filter((m) => m.author === "system");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.body).toContain("HK-7F3A-2C");
    expect(JSON.stringify(sent.body.ticket)).not.toContain("boom");
    // Another workspace's, chosen outright, is refused without saying whose it is.
    const refused = await ask(other, { ...ticket, errorReference: "HK-7F3A-2C" });
    expect(refused.res.status).toBe(422);
  });

  it("keeps the desk's canned replies and settings", async () => {
    const operator = await setup();
    const member = await joinAs(operator, "tomas@endlesshall.example", "Tomas Varga");
    const [tomas] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, "tomas@endlesshall.example"));
    const [alex] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, "alex@endlesshall.example"));
    const reply = { title: "Fixed in the next patch", body: "This is fixed in the next patch." };
    expect((await send("/api/instance/support/replies", reply, member)).status).toBe(403);
    const made = await send("/api/instance/support/replies", reply, operator);
    expect(made.status).toBe(201);
    const { replies } = (await made.json()) as { replies: { id: string; title: string }[] };
    expect(replies.map((r) => r.title)).toEqual(["Fixed in the next patch"]);
    const changed = await send(
      `/api/instance/support/replies/${replies[0]?.id}`,
      { ...reply, title: "Patched tonight" },
      operator,
      "PUT",
    );
    expect(((await changed.json()) as { replies: { title: string }[] }).replies[0]?.title).toBe(
      "Patched tonight",
    );
    expect(
      (await send(`/api/instance/support/replies/${replies[0]?.id}`, {}, operator, "DELETE"))
        .status,
    ).toBe(200);

    // Only an operator can be on call; the status page is a web address.
    const desk = (body: unknown) => send("/api/instance/support/desk", body, operator, "PUT");
    expect((await desk({ statusUrl: null, onCall: tomas?.id })).status).toBe(422);
    expect((await desk({ statusUrl: "not an address", onCall: null })).status).toBe(400);
    const saved = await desk({ statusUrl: "https://status.endlesshall.example", onCall: alex?.id });
    expect(saved.status).toBe(200);
    expect((await saved.json()) as SupportDesk).toMatchObject({
      statusUrl: "https://status.endlesshall.example",
      environmentStatusUrl: "https://status.example",
      onCall: alex?.id,
      operators: [{ name: "Alex Rivera" }],
    });
    // The desk's status page is the one the workspace's help menu links to.
    const me = (await (await get("/api/me", member)).json()) as { support: SupportModule };
    expect(me.support.statusUrl).toBe("https://status.endlesshall.example");
    // A Settings page loaded before the desk changed never undoes it.
    const { settings: stale } = (await (await get("/api/instance/settings", operator)).json()) as {
      settings: Record<string, unknown>;
    };
    expect(
      (
        await send(
          "/api/instance/settings",
          { ...stale, support: { statusUrl: null, onCall: null } },
          operator,
          "PUT",
        )
      ).status,
    ).toBe(200);
    expect(
      ((await (await get("/api/instance/support/desk", operator)).json()) as SupportDesk).onCall,
    ).toBe(alex?.id);

    // With someone on call, an Emergency goes to them and is marked as one.
    mailer.sent.length = 0;
    await ask(member, { ...ticket, severity: "emergency" }, build("app", "off"));
    expect(mailer.sent.map((m) => m.to)).toEqual(["alex@endlesshall.example"]);
    expect(mailer.sent[0]?.subject).toMatch(/^Emergency: \[T-/);
  });
});
