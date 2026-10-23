import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import { createDb, runMigrations, schema, uuidv7 } from "@hekate/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKeyring } from "./keyring.ts";
import { memoryMailer } from "./mail.ts";
import {
  instanceBouncesOf,
  readBounces,
  recordBounces,
  suppressed,
  Unverified,
} from "./mail-bounces.ts";
import { routedMailer } from "./workspace-mail.ts";

const now = new Date("2026-10-23T10:00:00Z");
const seconds = String(Math.floor(now.getTime() / 1000));
const headers = (h: Record<string, string>) => (name: string) => h[name.toLowerCase()];

describe("bounce reports (#161)", () => {
  it("reads Resend's reports once their Svix signature holds", () => {
    const key = Buffer.from("endless-hall-signing-key");
    const secret = `whsec_${key.toString("base64")}`;
    const signed = (body: string, at = seconds, id = "msg_1") =>
      headers({
        "svix-id": id,
        "svix-timestamp": at,
        "svix-signature": `v1,${createHmac("sha256", key).update(`${id}.${at}.${body}`).digest("base64")}`,
      });
    const bounced = JSON.stringify({
      type: "email.bounced",
      data: { to: ["Ines@Example.test"], bounce: { type: "Permanent", message: "No such user" } },
    });
    expect(readBounces("resend", secret, bounced, signed(bounced), now)).toEqual([
      { address: "ines@example.test", kind: "bounce", detail: "No such user" },
    ]);
    // Altered, old, or signed with another secret: refused.
    expect(() => readBounces("resend", secret, `${bounced} `, signed(bounced), now)).toThrow(
      Unverified,
    );
    expect(() =>
      readBounces("resend", secret, bounced, signed(bounced, String(Number(seconds) - 600)), now),
    ).toThrow(Unverified);
    expect(() => readBounces("resend", "whsec_b3RoZXI=", bounced, signed(bounced), now)).toThrow(
      Unverified,
    );
    // A transient bounce is the provider's to retry, not a report.
    const transient = JSON.stringify({
      type: "email.bounced",
      data: { to: ["ines@example.test"], bounce: { type: "Transient" } },
    });
    expect(readBounces("resend", secret, transient, signed(transient), now)).toEqual([]);
    // Nor is one Resend could not class: it may have been either.
    const undetermined = JSON.stringify({
      type: "email.bounced",
      data: { to: ["ines@example.test"], bounce: { type: "Undetermined" } },
    });
    expect(readBounces("resend", secret, undetermined, signed(undetermined), now)).toEqual([]);
    const complained = JSON.stringify({ type: "email.complained", data: { to: ["a@b.test"] } });
    expect(readBounces("resend", secret, complained, signed(complained), now)).toEqual([
      { address: "a@b.test", kind: "complaint", detail: null },
    ]);
  });

  it("reads Mailgun's reports once their signature holds", () => {
    const key = "mailgun-signing-key";
    const report = (event: Record<string, unknown>, by = key) =>
      JSON.stringify({
        signature: {
          timestamp: seconds,
          token: "t0k3n",
          signature: createHmac("sha256", by).update(`${seconds}t0k3n`).digest("hex"),
        },
        "event-data": event,
      });
    const failed = report({
      event: "failed",
      severity: "permanent",
      recipient: "tomas@example.test",
      "delivery-status": { description: "Mailbox does not exist" },
    });
    expect(readBounces("mailgun", key, failed, headers({}), now)).toEqual([
      { address: "tomas@example.test", kind: "bounce", detail: "Mailbox does not exist" },
    ]);
    expect(() =>
      readBounces("mailgun", key, report({ event: "failed" }, "another"), headers({}), now),
    ).toThrow(Unverified);
    const temporary = report({ event: "failed", severity: "temporary", recipient: "a@b.test" });
    expect(readBounces("mailgun", key, temporary, headers({}), now)).toEqual([]);
  });

  it("reads SendGrid's reports once their ECDSA signature holds", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const secret = publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const body = JSON.stringify([
      { event: "bounce", type: "bounce", email: "mira@example.test", reason: "550 5.1.1" },
      { event: "bounce", type: "blocked", email: "alex@example.test" },
      { event: "spamreport", email: "ines@example.test" },
      { event: "delivered", email: "tomas@example.test" },
    ]);
    const signed = (text: string) =>
      headers({
        "x-twilio-email-event-webhook-timestamp": seconds,
        "x-twilio-email-event-webhook-signature": sign(
          "sha256",
          Buffer.from(`${seconds}${text}`),
          privateKey,
        ).toString("base64"),
      });
    expect(readBounces("sendgrid", secret, body, signed(body), now)).toEqual([
      { address: "mira@example.test", kind: "bounce", detail: "550 5.1.1" },
      { address: "ines@example.test", kind: "complaint", detail: null },
    ]);
    expect(() => readBounces("sendgrid", secret, `${body} `, signed(body), now)).toThrow(
      Unverified,
    );
    expect(() => readBounces("sendgrid", "not a key", body, signed(body), now)).toThrow(Unverified);
  });

  it("reads SparkPost's reports with its basic authentication, hard bounces only", () => {
    const secret = "hekate:sparkpost-pass";
    const body = JSON.stringify([
      { msys: { message_event: { type: "bounce", bounce_class: "10", rcpt_to: "a@b.test" } } },
      { msys: { message_event: { type: "bounce", bounce_class: "21", rcpt_to: "c@d.test" } } },
      { msys: { message_event: { type: "spam_complaint", rcpt_to: "e@f.test" } } },
      { msys: {} },
    ]);
    const auth = (pair: string) =>
      headers({ authorization: `Basic ${Buffer.from(pair).toString("base64")}` });
    expect(readBounces("sparkpost", secret, body, auth(secret), now).map((r) => r.address)).toEqual(
      ["a@b.test", "e@f.test"],
    );
    expect(() => readBounces("sparkpost", secret, body, auth("hekate:wrong"), now)).toThrow(
      Unverified,
    );
    expect(() => readBounces("sparkpost", secret, body, headers({}), now)).toThrow(Unverified);
  });

  it("refuses every report while no secret is set", () => {
    expect(() => readBounces("resend", "", "{}", headers({}), now)).toThrow(Unverified);
  });

  it("knows the instance's provider from its SMTP host, and needs its secret", () => {
    expect(
      instanceBouncesOf({
        SMTP_URL: "smtps://resend:re@smtp.resend.com:465",
        MAIL_WEBHOOK_SECRET: "whsec_x",
      }),
    ).toEqual({ provider: "resend", secret: "whsec_x" });
    expect(instanceBouncesOf({ SMTP_URL: "smtps://resend:re@smtp.resend.com:465" })).toBeNull();
    expect(
      instanceBouncesOf({ SMTP_URL: "smtp://mail.example.test:587", MAIL_WEBHOOK_SECRET: "x" }),
    ).toBeNull();
  });
});

const url = process.env.DATABASE_URL;

describe.runIf(url)("what bounce reports stop (#161)", () => {
  const { db, close } = createDb(url ?? "", { max: 3 });
  const keyring = createKeyring(db, { current: Buffer.alloc(32, 6), previous: [] });

  beforeAll(async () => {
    await runMigrations(url ?? "");
  });
  afterAll(async () => {
    await close();
  });

  const workspace = async () => {
    const [org] = await db
      .insert(schema.organisations)
      .values({ name: "Endless Hall Records", slug: `bounces-${uuidv7()}` })
      .returning();
    return org?.id ?? "";
  };

  it("stops mail to a reported address: the instance's for everyone, a workspace's for itself", async () => {
    const a = await workspace();
    const b = await workspace();
    const everyone = `gone-${uuidv7()}@example.test`;
    const theirs = `complained-${uuidv7()}@example.test`;
    await recordBounces(db, "instance", "resend", [
      { address: everyone, kind: "bounce", detail: "No such user" },
    ]);
    await recordBounces(db, { organisationId: a }, "mailgun", [
      { address: theirs, kind: "complaint", detail: null },
    ]);
    // Reported twice, kept once.
    await recordBounces(db, { organisationId: a }, "mailgun", [
      { address: theirs, kind: "complaint", detail: null },
    ]);
    expect(await suppressed(db, everyone)).toBe(true);
    expect(await suppressed(db, everyone.toUpperCase(), b)).toBe(true);
    expect(await suppressed(db, theirs, a)).toBe(true);
    expect(await suppressed(db, theirs, b)).toBe(false);
    expect(await suppressed(db, theirs)).toBe(false);
    const kept = await db
      .select()
      .from(schema.workspaceMailSuppressions)
      .where(eq(schema.workspaceMailSuppressions.address, theirs));
    expect(kept).toHaveLength(1);
    // The mail log has each report.
    const logged = await db
      .select({ result: schema.mailEvents.result })
      .from(schema.mailEvents)
      .where(eq(schema.mailEvents.recipient, everyone));
    expect(logged).toEqual([{ result: "bounced" }]);

    // The mailer holds back what was reported, and sends the rest.
    const instance = memoryMailer();
    const mailer = routedMailer({ db, keyring, instance, trusted: [] });
    const message = { subject: "A review is waiting", text: "Open it." };
    expect(await mailer.send({ ...message, to: everyone })).toBe("suppressed");
    expect(await mailer.send({ ...message, to: theirs, organisationId: a })).toBe("suppressed");
    await mailer.send({ ...message, to: theirs, organisationId: b });
    expect(instance.sent.map((m) => m.to)).toEqual([theirs]);
  });
});
