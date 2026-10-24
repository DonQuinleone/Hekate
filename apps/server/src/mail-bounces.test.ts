import { createHmac, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { createDb, runMigrations, schema, uuidv7 } from "@hekate/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKeyring } from "./keyring.ts";
import { memoryMailer } from "./mail.ts";
import {
  bounceProviderOf,
  instanceBouncesOf,
  readBounces,
  recordBounces,
  suppressed,
  Unverified,
} from "./mail-bounces.ts";
import { mailHookRoutes } from "./routes/mail-hooks.ts";
import { routedMailer, saveWorkspaceMail } from "./workspace-mail.ts";

const now = new Date("2026-10-23T10:00:00Z");
const seconds = String(Math.floor(now.getTime() / 1000));
const headers = (h: Record<string, string>) => (name: string) => h[name.toLowerCase()];

/** DER, as much of it as a certificate takes. */
const der = (tag: number, ...parts: Buffer[]) => {
  const body = Buffer.concat(parts);
  const n = body.length;
  const length =
    n < 0x80
      ? Buffer.from([n])
      : n < 0x100
        ? Buffer.from([0x81, n])
        : Buffer.from([0x82, n >> 8, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
};
const oid = (dotted: string) => {
  const [a = 0, b = 0, ...rest] = dotted.split(".").map(Number);
  const bytes = [a * 40 + b];
  for (const part of rest) {
    const groups = [part & 0x7f];
    for (let v = part >> 7; v > 0; v >>= 7) groups.unshift((v & 0x7f) | 0x80);
    bytes.push(...groups);
  }
  return der(0x06, Buffer.from(bytes));
};

/**
 * A self-signed certificate for a key, as SNS serves its signing certificate: made here, so the
 * suite signs as SNS would without a key of AWS's.
 */
function certificateFor(keys: { publicKey: KeyObject; privateKey: KeyObject }) {
  const algorithm = der(0x30, oid("1.2.840.113549.1.1.11"), Buffer.from([0x05, 0x00]));
  const name = der(
    0x30,
    der(0x31, der(0x30, oid("2.5.4.3"), der(0x0c, Buffer.from("sns.amazonaws.com")))),
  );
  const tbs = der(
    0x30,
    der(0x02, Buffer.from([0x01])),
    algorithm,
    name,
    der(0x30, der(0x17, Buffer.from("000101000000Z")), der(0x17, Buffer.from("491231235959Z"))),
    name,
    keys.publicKey.export({ format: "der", type: "spki" }),
  );
  const signature = sign("sha256", tbs, keys.privateKey);
  const cert = der(0x30, tbs, algorithm, der(0x03, Buffer.from([0x00]), signature));
  const lines = cert.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join("\n")}\n-----END CERTIFICATE-----\n`;
}

describe("bounce reports (#161)", () => {
  it("reads Resend's reports once their Svix signature holds", async () => {
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
    expect(await readBounces("resend", secret, bounced, signed(bounced), { now })).toEqual([
      { address: "ines@example.test", kind: "bounce", detail: "No such user" },
    ]);
    // Altered, old, or signed with another secret: refused.
    await expect(
      readBounces("resend", secret, `${bounced} `, signed(bounced), { now }),
    ).rejects.toThrow(Unverified);
    await expect(
      readBounces("resend", secret, bounced, signed(bounced, String(Number(seconds) - 600)), {
        now,
      }),
    ).rejects.toThrow(Unverified);
    await expect(
      readBounces("resend", "whsec_b3RoZXI=", bounced, signed(bounced), { now }),
    ).rejects.toThrow(Unverified);
    // A transient bounce is the provider's to retry, not a report.
    const transient = JSON.stringify({
      type: "email.bounced",
      data: { to: ["ines@example.test"], bounce: { type: "Transient" } },
    });
    expect(await readBounces("resend", secret, transient, signed(transient), { now })).toEqual([]);
    // Nor is one Resend could not class: it may have been either.
    const undetermined = JSON.stringify({
      type: "email.bounced",
      data: { to: ["ines@example.test"], bounce: { type: "Undetermined" } },
    });
    expect(
      await readBounces("resend", secret, undetermined, signed(undetermined), { now }),
    ).toEqual([]);
    const complained = JSON.stringify({ type: "email.complained", data: { to: ["a@b.test"] } });
    expect(await readBounces("resend", secret, complained, signed(complained), { now })).toEqual([
      { address: "a@b.test", kind: "complaint", detail: null },
    ]);
  });

  it("reads Mailgun's reports once their signature holds", async () => {
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
    expect(await readBounces("mailgun", key, failed, headers({}), { now })).toEqual([
      { address: "tomas@example.test", kind: "bounce", detail: "Mailbox does not exist" },
    ]);
    await expect(
      readBounces("mailgun", key, report({ event: "failed" }, "another"), headers({}), { now }),
    ).rejects.toThrow(Unverified);
    const temporary = report({ event: "failed", severity: "temporary", recipient: "a@b.test" });
    expect(await readBounces("mailgun", key, temporary, headers({}), { now })).toEqual([]);
  });

  it("reads SendGrid's reports once their ECDSA signature holds", async () => {
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
    expect(await readBounces("sendgrid", secret, body, signed(body), { now })).toEqual([
      { address: "mira@example.test", kind: "bounce", detail: "550 5.1.1" },
      { address: "ines@example.test", kind: "complaint", detail: null },
    ]);
    await expect(
      readBounces("sendgrid", secret, `${body} `, signed(body), { now }),
    ).rejects.toThrow(Unverified);
    await expect(readBounces("sendgrid", "not a key", body, signed(body), { now })).rejects.toThrow(
      Unverified,
    );
  });

  it("reads SparkPost's reports with its basic authentication, hard bounces only", async () => {
    const secret = "hekate:sparkpost-pass";
    const body = JSON.stringify([
      { msys: { message_event: { type: "bounce", bounce_class: "10", rcpt_to: "a@b.test" } } },
      { msys: { message_event: { type: "bounce", bounce_class: "21", rcpt_to: "c@d.test" } } },
      { msys: { message_event: { type: "spam_complaint", rcpt_to: "e@f.test" } } },
      { msys: {} },
    ]);
    const auth = (pair: string) =>
      headers({ authorization: `Basic ${Buffer.from(pair).toString("base64")}` });
    expect(
      (await readBounces("sparkpost", secret, body, auth(secret), { now })).map((r) => r.address),
    ).toEqual(["a@b.test", "e@f.test"]);
    await expect(
      readBounces("sparkpost", secret, body, auth("hekate:wrong"), { now }),
    ).rejects.toThrow(Unverified);
    await expect(readBounces("sparkpost", secret, body, headers({}), { now })).rejects.toThrow(
      Unverified,
    );
  });

  it("refuses every report while no secret is set", async () => {
    await expect(readBounces("resend", "", "{}", headers({}), { now })).rejects.toThrow(Unverified);
  });

  it("knows the instance's provider from its SMTP host, and needs its secret", async () => {
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

  it("knows Amazon SES by its regional endpoints, Plunk by its host and Mailcoach by its API", () => {
    const secret = { MAIL_WEBHOOK_SECRET: "x" };
    const providerOf = bounceProviderOf;
    expect(providerOf({ SMTP_URL: "smtp://AKIA:pw@email-smtp.eu-west-1.amazonaws.com:587" })).toBe(
      "ses",
    );
    expect(providerOf({ SMTP_URL: "smtp://u:p@email-smtp-fips.us-east-1.amazonaws.com:587" })).toBe(
      "ses",
    );
    expect(
      providerOf({ SMTP_URL: "smtp://u:p@email-smtp.eu-west-1.amazonaws.com.example:587" }),
    ).toBe(null);
    expect(providerOf({ SMTP_URL: "smtp://plunk:sk@smtp.useplunk.com:587" })).toBe("plunk");
    expect(providerOf({ MAIL_MAILCOACH_URL: "https://endlesshall.mailcoach.app" })).toBe(
      "mailcoach",
    );
    // Postal runs on the operator's own host, which says nothing: the setting names it.
    expect(providerOf({ SMTP_URL: "smtp://hekate:pw@postal.example.test:25" })).toBeNull();
    expect(
      instanceBouncesOf({
        SMTP_URL: "smtp://hekate:pw@postal.example.test:25",
        MAIL_BOUNCE_PROVIDER: "postal",
        ...secret,
      }),
    ).toEqual({ provider: "postal", secret: "x" });
  });

  describe("Amazon SES, through Amazon SNS", () => {
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = certificateFor(keys);
    const topic = "arn:aws:sns:eu-west-1:123456789012:hekate-bounces";
    const certUrl =
      "https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-0000000000000000000000.pem";
    /** What SNS was asked for, and its answers: the certificate, and a confirmation. */
    const fetched: string[] = [];
    const fetcher = async (url: string) => {
      fetched.push(url);
      if (url === certUrl) return new Response(pem);
      if (url.includes("Action=ConfirmSubscription")) return new Response("<ok/>");
      return new Response("Not found", { status: 404 });
    };
    /** A message as SNS sends it, signed as SNS signs it. */
    const signed = (
      fields: Record<string, string>,
      { version = "2", by = keys.privateKey }: { version?: string; by?: KeyObject } = {},
    ) => {
      const message: Record<string, string> = {
        MessageId: "22b80b92-fdea-4c2c-8f9d-bdfb0c7bf324",
        TopicArn: topic,
        Timestamp: "2026-10-23T09:59:30.000Z",
        SignatureVersion: version,
        SigningCertURL: certUrl,
        ...fields,
      };
      const order =
        message.Type === "Notification"
          ? ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"]
          : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
      const text = order
        .filter((name) => message[name] !== undefined)
        .map((name) => `${name}\n${message[name]}\n`)
        .join("");
      message.Signature = sign(version === "1" ? "sha1" : "sha256", Buffer.from(text), by).toString(
        "base64",
      );
      return JSON.stringify(message);
    };
    const notification = (ses: unknown, extra: Record<string, string> = {}) =>
      signed({ Type: "Notification", Message: JSON.stringify(ses), ...extra });
    const read = (body: string, secret = topic) =>
      readBounces("ses", secret, body, headers({}), { now, fetch: fetcher });
    const bounce = {
      notificationType: "Bounce",
      bounce: {
        bounceType: "Permanent",
        bounceSubType: "General",
        bouncedRecipients: [
          {
            emailAddress: "Mira.Solberg@example.test",
            action: "failed",
            status: "5.1.1",
            diagnosticCode: "smtp; 550 5.1.1 user unknown",
          },
        ],
        timestamp: "2026-10-23T09:59:28.000Z",
        feedbackId: "0102019a1-bounce",
      },
      mail: {
        timestamp: "2026-10-23T09:59:20.000Z",
        source: "hekate@example.test",
        messageId: "0102019a1-mail",
        destination: ["mira.solberg@example.test"],
      },
    };

    it("reads permanent bounces and complaints once SNS's signature holds", async () => {
      expect(await read(notification(bounce))).toEqual([
        {
          address: "mira.solberg@example.test",
          kind: "bounce",
          detail: "smtp; 550 5.1.1 user unknown",
        },
      ]);
      // Signature version 1 signs with SHA-1, as a topic does unless told otherwise.
      expect(
        await read(
          signed({ Type: "Notification", Message: JSON.stringify(bounce) }, { version: "1" }),
        ),
      ).toHaveLength(1);
      // With a subject, which is then signed too.
      expect(await read(notification(bounce, { Subject: "Amazon SES Email Event" }))).toHaveLength(
        1,
      );
      const transient = { ...bounce, bounce: { ...bounce.bounce, bounceType: "Transient" } };
      expect(await read(notification(transient))).toEqual([]);
      const complaint = {
        notificationType: "Complaint",
        complaint: {
          complainedRecipients: [{ emailAddress: "tomas.varga@example.test" }],
          complaintFeedbackType: "abuse",
          timestamp: "2026-10-23T09:59:28.000Z",
        },
      };
      expect(await read(notification(complaint))).toEqual([
        { address: "tomas.varga@example.test", kind: "complaint", detail: null },
      ]);
      // A recipient's provider saying it was not spam after all is no complaint.
      const notSpam = {
        ...complaint,
        complaint: { ...complaint.complaint, complaintFeedbackType: "not-spam" },
      };
      expect(await read(notification(notSpam))).toEqual([]);
      // A configuration set's events name their kind eventType.
      expect(
        await read(notification({ ...bounce, notificationType: undefined, eventType: "Bounce" })),
      ).toHaveLength(1);
      // The certificate was fetched once, and kept.
      expect(fetched.filter((u) => u === certUrl)).toHaveLength(1);
    });

    it("refuses what SNS did not sign, for a topic not given, or stale", async () => {
      const good = JSON.parse(notification(bounce)) as Record<string, string>;
      // Altered after signing.
      const altered = JSON.stringify({
        ...good,
        Message: JSON.stringify({
          ...bounce,
          bounce: {
            ...bounce.bounce,
            bouncedRecipients: [{ emailAddress: "ines.arlow@example.test" }],
          },
        }),
      });
      await expect(read(altered)).rejects.toThrow(Unverified);
      // Signed by a key that is not the certificate's.
      const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
      await expect(
        read(
          signed(
            { Type: "Notification", Message: JSON.stringify(bounce) },
            { by: other.privateKey },
          ),
        ),
      ).rejects.toThrow(Unverified);
      // Unsigned, as raw message delivery would send it.
      await expect(read(JSON.stringify(bounce))).rejects.toThrow(Unverified);
      const before = fetched.length;
      // Genuinely SNS's, but another topic: nothing is fetched for it.
      await expect(
        read(notification(bounce), "arn:aws:sns:eu-west-1:123456789012:another"),
      ).rejects.toThrow(Unverified);
      // A certificate anywhere but SNS's own hosts over HTTPS is never fetched.
      for (const where of [
        "http://sns.eu-west-1.amazonaws.com/SimpleNotificationService-0.pem",
        "https://sns.eu-west-1.amazonaws.com.example.test/SimpleNotificationService-0.pem",
        "https://sns-eu-west-1.example.test/SimpleNotificationService-0.pem",
        "https://sns.eu-west-1.amazonaws.com:8443/SimpleNotificationService-0.pem",
      ])
        await expect(
          read(
            signed({
              Type: "Notification",
              Message: JSON.stringify(bounce),
              SigningCertURL: where,
            }),
          ),
        ).rejects.toThrow(Unverified);
      // More than an hour old: SNS has stopped retrying by then.
      await expect(
        read(notification(bounce, { Timestamp: "2026-10-23T08:30:00.000Z" })),
      ).rejects.toThrow(Unverified);
      expect(fetched.length).toBe(before);
    });

    it("confirms its subscription at SNS, and only there", async () => {
      const subscribe = `https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${topic}&Token=2336412f37fb687f5d51e6e2425c464de`;
      const confirmation = (to: string) =>
        signed({
          Type: "SubscriptionConfirmation",
          Token: "2336412f37fb687f5d51e6e2425c464de",
          Message: `You have chosen to subscribe to the topic ${topic}. To confirm the subscription, visit the SubscribeURL included in this message.`,
          SubscribeURL: to,
        });
      expect(await read(confirmation(subscribe))).toEqual([]);
      expect(fetched).toContain(subscribe);
      const before = fetched.length;
      await expect(
        read(confirmation("https://hooks.example.test/?Action=ConfirmSubscription")),
      ).rejects.toThrow(Unverified);
      // Unsigned, nothing is visited.
      const unsigned = JSON.parse(confirmation(subscribe)) as Record<string, string>;
      await expect(read(JSON.stringify({ ...unsigned, Signature: "AAAA" }))).rejects.toThrow(
        Unverified,
      );
      expect(fetched.length).toBe(before);
    });
  });

  describe("Postal", () => {
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    // As its DKIM record gives it: the key's base64, after p=.
    const p = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const at = now.getTime() / 1000 - 30;
    const call = (event: string, payload: unknown, timestamp = at) =>
      JSON.stringify({
        event,
        timestamp,
        payload,
        uuid: "6f8b7b5a-3bb6-4d2c-9a26-2b1f4b0b8f61",
      });
    const signed = (body: string, legacy = false) =>
      headers(
        legacy
          ? {
              "x-postal-signature": sign("sha1", Buffer.from(body), keys.privateKey).toString(
                "base64",
              ),
            }
          : {
              "x-postal-signature-kid": "postal",
              "x-postal-signature": sign("sha1", Buffer.from(body), keys.privateKey).toString(
                "base64",
              ),
              "x-postal-signature-256": sign("sha256", Buffer.from(body), keys.privateKey).toString(
                "base64",
              ),
            },
      );
    const message = {
      id: 12345,
      token: "abcdef123",
      direction: "outgoing",
      message_id: "5817a64332f44_4ec93ff59e79d154565eb@hekate.example.test",
      to: "Ines.Arlow@example.test",
      from: "hekate@example.test",
      subject: "A review is waiting",
      timestamp: at,
      spam_status: "NotSpam",
      tag: null,
    };
    const bounced = call("MessageBounced", {
      original_message: message,
      bounce: { ...message, id: 12347, direction: "incoming", subject: "Delivery Error" },
    });

    it("reads bounces and holds for the suppression list once Postal's signature holds", async () => {
      expect(await readBounces("postal", p, bounced, signed(bounced), { now })).toEqual([
        { address: "ines.arlow@example.test", kind: "bounce", detail: "Delivery Error" },
      ]);
      // Postal 2 signs with SHA-1 alone.
      expect(await readBounces("postal", p, bounced, signed(bounced, true), { now })).toHaveLength(
        1,
      );
      // The key as PEM, its line breaks lost in pasting, or the whole DKIM record.
      const pem = keys.publicKey.export({ format: "pem", type: "spki" }).toString();
      for (const given of [pem, pem.replace(/\n/g, ""), `v=DKIM1; t=s; h=sha256; p=${p};`])
        expect(await readBounces("postal", given, bounced, signed(bounced), { now })).toHaveLength(
          1,
        );
      const held = call("MessageHeld", {
        message,
        status: "Held",
        details:
          "Recipient (ines.arlow@example.test) is on the suppression list (reason: too many hard fails)",
        output: "",
        sent_with_ssl: false,
        timestamp: at,
        time: null,
      });
      expect(await readBounces("postal", p, held, signed(held), { now })).toEqual([
        {
          address: "ines.arlow@example.test",
          kind: "bounce",
          detail:
            "Recipient (ines.arlow@example.test) is on the suppression list (reason: too many hard fails)",
        },
      ]);
      // Held for a send limit, or failed once: nothing said of the address for good.
      const limit = call("MessageHeld", {
        message,
        status: "Held",
        details: "Message held because send limit (100) has been reached.",
      });
      expect(await readBounces("postal", p, limit, signed(limit), { now })).toEqual([]);
      const failed = call("MessageDeliveryFailed", { message, status: "HardFail" });
      expect(await readBounces("postal", p, failed, signed(failed), { now })).toEqual([]);
    });

    it("refuses what Postal did not sign, or stale", async () => {
      await expect(
        readBounces("postal", p, `${bounced} `, signed(bounced), { now }),
      ).rejects.toThrow(Unverified);
      await expect(readBounces("postal", p, bounced, headers({}), { now })).rejects.toThrow(
        Unverified,
      );
      const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const otherKey = other.publicKey.export({ format: "der", type: "spki" }).toString("base64");
      await expect(
        readBounces("postal", otherKey, bounced, signed(bounced), { now }),
      ).rejects.toThrow(Unverified);
      await expect(
        readBounces("postal", "not a key", bounced, signed(bounced), { now }),
      ).rejects.toThrow(Unverified);
      const stale = call("MessageBounced", { original_message: message }, at - 2 * 60 * 60);
      await expect(readBounces("postal", p, stale, signed(stale), { now })).rejects.toThrow(
        Unverified,
      );
    });
  });

  it("reads Plunk's workflow webhooks with the bearer token it is given", async () => {
    const token = "plunk-bounces-token";
    const bearer = (t: string) => headers({ authorization: `Bearer ${t}` });
    const call = (event: Record<string, unknown>) =>
      JSON.stringify({
        contact: { email: "Alex.Rivera@example.test", subscribed: false, data: {} },
        workflow: { id: "wf_bounces", name: "Bounces to Hekate" },
        execution: { id: "exec_1", startedAt: "2026-10-23T09:59:50.000Z" },
        event: {
          subject: "A review is waiting",
          from: "hekate@example.test",
          fromName: "Hekate",
          messageId: "ses-message-id",
          emailId: "ac32f08e-c6b9-45d3-9824-a73dff1e3bbf",
          templateId: null,
          campaignId: null,
          sourceType: "TRANSACTIONAL",
          ...event,
        },
      });
    const permanent = call({ bounceType: "Permanent", bouncedAt: "2026-10-23T09:59:40.000Z" });
    expect(await readBounces("plunk", token, permanent, bearer(token), { now })).toEqual([
      { address: "alex.rivera@example.test", kind: "bounce", detail: "Permanent bounce" },
    ]);
    const transient = call({ bounceType: "Transient", transientBounce: true });
    expect(await readBounces("plunk", token, transient, bearer(token), { now })).toEqual([]);
    const complaint = call({ complainedAt: "2026-10-23T09:59:40.000Z" });
    expect(await readBounces("plunk", token, complaint, bearer(token), { now })).toEqual([
      { address: "alex.rivera@example.test", kind: "complaint", detail: null },
    ]);
    await expect(
      readBounces("plunk", token, permanent, bearer("another-token"), { now }),
    ).rejects.toThrow(Unverified);
    await expect(readBounces("plunk", token, permanent, headers({}), { now })).rejects.toThrow(
      Unverified,
    );
  });

  it("reads Mailcoach's webhooks once their signature holds, hard bounces only", async () => {
    const secret = "mailcoach-webhook-secret";
    const signed = (body: string, by = secret) =>
      headers({ signature: createHmac("sha256", by).update(body).digest("hex") });
    const call = (event: string) =>
      JSON.stringify({
        send_uuid: "2c8f8b8e-4f0b-4d55-9d0e-8b6f4c3a1e21",
        subscriber_uuid: "8a4c6e2d-1b3f-4e5a-9c7d-0f1e2d3c4b5a",
        subscriber_email: "Tomas.Varga@example.test",
        email_list_uuid: "5d6e7f80-9a0b-4c1d-8e2f-3a4b5c6d7e8f",
        event,
      });
    const hard = call("BounceRegisteredEvent");
    expect(await readBounces("mailcoach", secret, hard, signed(hard), { now })).toEqual([
      { address: "tomas.varga@example.test", kind: "bounce", detail: null },
    ]);
    const soft = call("SoftBounceRegisteredEvent");
    expect(await readBounces("mailcoach", secret, soft, signed(soft), { now })).toEqual([]);
    await expect(
      readBounces("mailcoach", secret, hard, signed(hard, "another"), { now }),
    ).rejects.toThrow(Unverified);
    await expect(readBounces("mailcoach", secret, hard, headers({}), { now })).rejects.toThrow(
      Unverified,
    );
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

  it("takes Amazon SES's reports at the instance's address, and Mailcoach's at a workspace's", async () => {
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const certUrl = "https://sns.eu-north-1.amazonaws.com/SimpleNotificationService-routes.pem";
    const topic = "arn:aws:sns:eu-north-1:123456789012:hekate-bounces";
    const hooks = mailHookRoutes({
      db,
      keyring,
      instance: { provider: "ses", secret: topic },
      fetch: async (u) =>
        u === certUrl ? new Response(certificateFor(keys)) : new Response("", { status: 404 }),
    });
    const gone = `gone-${uuidv7()}@example.test`;
    const message: Record<string, string> = {
      Type: "Notification",
      MessageId: uuidv7(),
      TopicArn: topic,
      Message: JSON.stringify({
        notificationType: "Complaint",
        complaint: {
          complainedRecipients: [{ emailAddress: gone }],
          complaintFeedbackType: "abuse",
        },
      }),
      Timestamp: new Date().toISOString(),
      SignatureVersion: "2",
      SigningCertURL: certUrl,
    };
    const text = ["Message", "MessageId", "Timestamp", "TopicArn", "Type"]
      .map((name) => `${name}\n${message[name]}\n`)
      .join("");
    const body = JSON.stringify({
      ...message,
      Signature: sign("sha256", Buffer.from(text), keys.privateKey).toString("base64"),
    });
    const post = (path: string, text: string, headers: Record<string, string> = {}) =>
      hooks.request(path, { method: "POST", headers, body: text });
    // Altered, it changes nothing.
    expect((await post("/instance", body.replace(gone, `x${gone}`))).status).toBe(401);
    expect(await suppressed(db, gone)).toBe(false);
    expect((await post("/instance", body)).status).toBe(204);
    expect(await suppressed(db, gone)).toBe(true);

    const org = await workspace();
    await saveWorkspaceMail(db, keyring, org, {
      provider: "mailcoach",
      url: "https://endlesshall.mailcoach.app",
      password: "mailcoach-token",
      from: "Endless Hall Records <mail@endlesshall.example>",
      webhookSecret: "mailcoach-webhook-secret",
    });
    const theirs = `bounced-${uuidv7()}@example.test`;
    const hard = JSON.stringify({
      send_uuid: uuidv7(),
      subscriber_uuid: uuidv7(),
      subscriber_email: theirs,
      email_list_uuid: uuidv7(),
      event: "BounceRegisteredEvent",
    });
    const mac = (by: string) => createHmac("sha256", by).update(hard).digest("hex");
    expect((await post(`/workspaces/${org}`, hard, { signature: mac("another") })).status).toBe(
      401,
    );
    expect(await suppressed(db, theirs, org)).toBe(false);
    expect(
      (await post(`/workspaces/${org}`, hard, { signature: mac("mailcoach-webhook-secret") }))
        .status,
    ).toBe(204);
    expect(await suppressed(db, theirs, org)).toBe(true);
    expect(await suppressed(db, theirs)).toBe(false);
  });
});
