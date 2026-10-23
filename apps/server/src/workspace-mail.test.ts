import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createDb, runMigrations, schema, uuidv7 } from "@hekate/db";
import type { MailStepInput } from "@hekate/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKeyring } from "./keyring.ts";
import { createMailer, loggedMailer, type Mailer, type Message, memoryMailer } from "./mail.ts";
import {
  MailRefused,
  mergedMail,
  pinnedFetch,
  routedMailer,
  saveWorkspaceMail,
  workspaceMailer,
  workspaceMailOf,
} from "./workspace-mail.ts";

const message = (organisationId?: string): Message => ({
  to: "ines@example.test",
  subject: "Booklet sign-off is waiting on you",
  text: "Open it in Hekate.",
  ...(organisationId ? { organisationId } : {}),
});

describe("a workspace's own mail (#161), without a database", () => {
  it("refuses an SMTP server on a private network unless the operator trusts it", async () => {
    const mail: MailStepInput = {
      provider: "smtp",
      host: "127.0.0.1",
      port: 2525,
      username: "hekate",
      password: "secret",
      from: "Endless Hall Records <mail@endlesshall.example>",
    };
    await expect(workspaceMailer(mail, []).send(message())).rejects.toThrow(/private network/);
    // Trusted, it is tried: nothing listens there, so the connection itself fails.
    await expect(
      workspaceMailer(mail, ["smtp://127.0.0.1:2525"]).send(message()),
    ).rejects.not.toThrow(/private network/);
  });
});

describe("reaching a workspace's Mailcoach (#161)", () => {
  it("refuses private addresses, and follows no redirect even where trusted", async () => {
    await expect(pinnedFetch([])("https://127.0.0.1/api/user")).rejects.toThrow(/private network/);
    await expect(pinnedFetch([])("https://localhost:9/api/user")).rejects.toThrow(
      /private network/,
    );
    await expect(pinnedFetch([])("http://mail.example/api/user")).rejects.toThrow(/https/);
    // A server that sends every request somewhere else.
    let asked = 0;
    const redirecting = createServer((_req, res) => {
      asked += 1;
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
    });
    await new Promise<void>((resolve) => redirecting.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(redirecting.address() as AddressInfo).port}`;
    try {
      const res = await pinnedFetch([origin])(`${origin}/api/user`, {
        headers: { authorization: "Bearer mc" },
      });
      expect(res.status).toBe(302);
      expect(asked).toBe(1);
    } finally {
      redirecting.close();
    }
  });
});

const url = process.env.DATABASE_URL;

describe.runIf(url)("a workspace's own mail (#161)", () => {
  const { db, close } = createDb(url ?? "", { max: 3 });
  const keyring = createKeyring(db, { current: Buffer.alloc(32, 5), previous: [] });

  beforeAll(async () => {
    await runMigrations(url ?? "");
  });
  afterAll(async () => {
    await close();
  });

  const workspace = async () => {
    const [org] = await db
      .insert(schema.organisations)
      .values({ name: "Endless Hall Records", slug: `mail-${uuidv7()}` })
      .returning();
    return org?.id ?? "";
  };
  const resend: MailStepInput = {
    provider: "resend",
    password: "re_secret",
    from: "Endless Hall Records <mail@endlesshall.example>",
  };

  it("sends a workspace's mail through its own, and everything else through the instance's", async () => {
    const organisationId = await workspace();
    const other = await workspace();
    await saveWorkspaceMail(db, keyring, organisationId, resend);
    const instance = memoryMailer();
    const own = memoryMailer();
    const built: MailStepInput[] = [];
    const mailer = routedMailer({
      db,
      keyring,
      instance,
      trusted: [],
      build: (mail) => {
        built.push(mail);
        return own;
      },
    });
    await mailer.send(message(organisationId));
    await mailer.send(message(organisationId));
    await mailer.send(message(other));
    await mailer.send(message());
    expect(own.sent).toHaveLength(2);
    expect(instance.sent).toHaveLength(2);
    // Opened from its seal, once for the saved details.
    expect(built).toEqual([resend]);
    const [row] = await db
      .select()
      .from(schema.workspaceMail)
      .where(eq(schema.workspaceMail.organisationId, organisationId));
    expect(row?.configSealed).not.toContain("re_secret");
    expect(row?.lastSentAt).not.toBeNull();
    // Settings see everything but the secret.
    const view = await workspaceMailOf(
      db,
      keyring,
      organisationId,
      "https://review.endlesshall.example",
    );
    expect(view).toMatchObject({
      provider: "resend",
      target: "smtp.resend.com:465",
      hasSecret: true,
    });
    expect(JSON.stringify(view)).not.toContain("re_secret");
  });

  it("lets the instance's mail stand in when the workspace's refuses, and pauses it after five", async () => {
    const organisationId = await workspace();
    await saveWorkspaceMail(db, keyring, organisationId, resend);
    const instance = memoryMailer();
    let tries = 0;
    const refusing: Mailer = {
      async send() {
        tries += 1;
        throw new Error("535 Authentication failed");
      },
    };
    const at = new Date("2026-10-23T10:00:00Z");
    const mailer = routedMailer({
      db,
      keyring,
      instance,
      trusted: [],
      build: () => refusing,
      now: () => at,
    });
    for (let i = 0; i < 5; i++) await mailer.send(message(organisationId));
    // Nothing lost: every message went, through the instance.
    expect(instance.sent).toHaveLength(5);
    expect(tries).toBe(5);
    const view = await workspaceMailOf(
      db,
      keyring,
      organisationId,
      "https://review.endlesshall.example",
    );
    expect(view).toMatchObject({ failures: 5, lastError: "535 Authentication failed" });
    const [row] = await db
      .select()
      .from(schema.workspaceMail)
      .where(eq(schema.workspaceMail.organisationId, organisationId));
    expect(row?.pausedUntil?.getTime()).toBe(at.getTime() + 15 * 60_000);
    // Paused, the workspace's mail is not tried at all.
    await mailer.send(message(organisationId));
    expect(tries).toBe(5);
    expect(instance.sent).toHaveLength(6);
    // Saved again, it starts afresh.
    await saveWorkspaceMail(db, keyring, organisationId, resend);
    expect(
      await workspaceMailOf(db, keyring, organisationId, "https://review.endlesshall.example"),
    ).toMatchObject({
      failures: 0,
      pausedUntil: null,
      lastError: null,
    });
  });

  it("logs a message the workspace's mail sent as sent, where the instance's only logs", async () => {
    const organisationId = await workspace();
    await saveWorkspaceMail(db, keyring, organisationId, resend);
    const mailer = loggedMailer(
      db,
      routedMailer({
        db,
        keyring,
        instance: createMailer({ transport: { kind: "log" }, from: "hekate@localhost" }),
        trusted: [],
        build: () => memoryMailer(),
      }),
      false,
    );
    const subject = `Logged ${uuidv7()}`;
    await mailer.send({ ...message(organisationId), subject: `${subject} own` });
    await mailer.send({ ...message(), subject: `${subject} instance` });
    // The log is written beside the message, not awaited.
    await new Promise((r) => setTimeout(r, 100));
    const logged = await db
      .select({ subject: schema.mailEvents.subject, result: schema.mailEvents.result })
      .from(schema.mailEvents);
    expect(
      logged
        .filter((l) => l.subject.startsWith(subject))
        .sort((a, b) => a.subject.localeCompare(b.subject)),
    ).toEqual([
      { subject: `${subject} instance`, result: "logged" },
      { subject: `${subject} own`, result: "sent" },
    ]);
  });

  it("keeps the stored secret on a save that leaves it out, only for the same provider", async () => {
    const organisationId = await workspace();
    await saveWorkspaceMail(db, keyring, organisationId, resend);
    const kept = await mergedMail(db, keyring, organisationId, {
      provider: "resend",
      from: "Mira Solberg <mira@endlesshall.example>",
    });
    expect(kept.password).toBe("re_secret");
    // Another provider's secret is not this one's: Microsoft 365 asks for its own.
    await expect(
      mergedMail(db, keyring, organisationId, {
        provider: "microsoft",
        tenant: "endlesshall.onmicrosoft.com",
        clientId: "app",
        from: "mail@endlesshall.example",
      }),
    ).rejects.toBeInstanceOf(MailRefused);
  });
});
