import {
  createHmac,
  createPublicKey,
  type KeyObject,
  timingSafeEqual,
  verify,
  X509Certificate,
} from "node:crypto";
import { type Database, inOrg, schema } from "@hekate/db";
import {
  type BounceProvider,
  describeSmtp,
  isBounceProvider,
  type SuppressionKind,
} from "@hekate/shared";
import { eq, sql } from "drizzle-orm";

const { mailSuppressions, workspaceMailSuppressions, mailEvents } = schema;

/**
 * Bounce reports (#161, #432). A provider tells Hekate, by a webhook it signs, that an address
 * bounced for good or that someone complained; Hekate checks the signature with the secret the
 * operator or the workspace gave, and stops sending to the address. Transient bounces are not
 * reports: the provider retries those itself.
 */

export interface BounceReport {
  /** Lower-cased. */
  address: string;
  kind: SuppressionKind;
  /** What the provider said, cut short. */
  detail: string | null;
}

/** The report did not come from the provider: wrong, stale or missing signature. */
export class Unverified extends Error {}

/** A signature older than this, or this far ahead, is refused. */
const TOLERANCE_SECONDS = 5 * 60;
/**
 * Where the time signed is the report's own, kept on every retry (Amazon SNS, Postal), it may be
 * this old: SNS retries an endpoint for an hour at most, Postal for under forty minutes.
 */
const RETRIED_TOLERANCE_SECONDS = 60 * 60;

type Headers = (name: string) => string | undefined;
/** How Amazon SNS's certificates and subscription addresses are reached; a test gives its own. */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
interface Context {
  now: Date;
  fetch: Fetcher;
}

const same = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);
const fresh = (seconds: number, now: Date, tolerance = TOLERANCE_SECONDS) =>
  Number.isFinite(seconds) && Math.abs(now.getTime() / 1000 - seconds) <= tolerance;
const report = (address: unknown, kind: SuppressionKind, detail: unknown): BounceReport[] =>
  typeof address === "string" && address.includes("@")
    ? [
        {
          address: address.trim().toLowerCase(),
          kind,
          detail: typeof detail === "string" && detail ? detail.slice(0, 300) : null,
        },
      ]
    : [];
const parsed = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    throw new Unverified("The report is not JSON");
  }
};

/** Resend signs with Svix: HMAC-SHA256 of the message id, its time and the body. */
function resend(secret: string, body: string, header: Headers, { now }: Context): BounceReport[] {
  const id = header("svix-id") ?? "";
  const at = header("svix-timestamp") ?? "";
  if (!id || !fresh(Number(at), now)) throw new Unverified("No fresh Svix signature");
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${at}.${body}`).digest();
  const given = (header("svix-signature") ?? "")
    .split(" ")
    .map((part) => part.split(","))
    .filter(([version]) => version === "v1")
    .map(([, signature]) => Buffer.from(signature ?? "", "base64"));
  if (!given.some((signature) => same(signature, expected)))
    throw new Unverified("The Svix signature does not hold");
  const event = parsed(body) as {
    type?: string;
    data?: { to?: string[]; bounce?: { type?: string; message?: string } };
  };
  const to = event.data?.to ?? [];
  // Only a permanent bounce: a transient one is retried, and an undetermined one may be either.
  if (event.type === "email.bounced" && event.data?.bounce?.type === "Permanent")
    return to.flatMap((a) => report(a, "bounce", event.data?.bounce?.message));
  if (event.type === "email.complained") return to.flatMap((a) => report(a, "complaint", null));
  return [];
}

/** Mailgun signs the time and a token with HMAC-SHA256, inside the report itself. */
function mailgun(secret: string, body: string, _header: Headers, { now }: Context): BounceReport[] {
  const event = parsed(body) as {
    signature?: { timestamp?: string; token?: string; signature?: string };
    "event-data"?: {
      event?: string;
      severity?: string;
      recipient?: string;
      reason?: string;
      "delivery-status"?: { description?: string; message?: string };
    };
  };
  const { timestamp = "", token = "", signature = "" } = event.signature ?? {};
  if (!fresh(Number(timestamp), now)) throw new Unverified("No fresh Mailgun signature");
  const expected = createHmac("sha256", secret).update(`${timestamp}${token}`).digest();
  if (!same(Buffer.from(signature, "hex"), expected))
    throw new Unverified("The Mailgun signature does not hold");
  const data = event["event-data"] ?? {};
  const said = data["delivery-status"]?.description || data["delivery-status"]?.message;
  if (data.event === "failed" && data.severity === "permanent")
    return report(data.recipient, "bounce", said || data.reason);
  if (data.event === "complained") return report(data.recipient, "complaint", null);
  return [];
}

/** SendGrid signs the time and the body with ECDSA, checked with its public verification key. */
function sendgrid(secret: string, body: string, header: Headers, { now }: Context): BounceReport[] {
  const at = header("x-twilio-email-event-webhook-timestamp") ?? "";
  const signature = header("x-twilio-email-event-webhook-signature") ?? "";
  if (!signature || !fresh(Number(at), now)) throw new Unverified("No fresh SendGrid signature");
  let holds = false;
  try {
    const key = createPublicKey({
      key: Buffer.from(secret, "base64"),
      format: "der",
      type: "spki",
    });
    holds = verify("sha256", Buffer.from(`${at}${body}`), key, Buffer.from(signature, "base64"));
  } catch {
    holds = false;
  }
  if (!holds) throw new Unverified("The SendGrid signature does not hold");
  const events = parsed(body);
  if (!Array.isArray(events)) return [];
  return (events as { event?: string; type?: string; email?: string; reason?: string }[]).flatMap(
    (e) =>
      e.event === "bounce" && e.type !== "blocked"
        ? report(e.email, "bounce", e.reason)
        : e.event === "spamreport"
          ? report(e.email, "complaint", null)
          : [],
  );
}

/** SparkPost's bounce classes that mean the address will never take mail. */
const HARD_BOUNCES = new Set(["10", "30", "90"]);

/** SparkPost authenticates its webhook with basic authentication, set when it was made. */
function sparkpost(secret: string, body: string, header: Headers): BounceReport[] {
  const given = (header("authorization") ?? "").replace(/^Basic\s+/i, "");
  if (!same(Buffer.from(given, "base64"), Buffer.from(secret)))
    throw new Unverified("The SparkPost credentials do not match");
  const batch = parsed(body);
  if (!Array.isArray(batch)) return [];
  return (
    batch as {
      msys?: {
        message_event?: {
          type?: string;
          bounce_class?: string;
          rcpt_to?: string;
          raw_reason?: string;
        };
      };
    }[]
  ).flatMap(({ msys }) => {
    const e = msys?.message_event;
    if (e?.type === "bounce" && HARD_BOUNCES.has(String(e.bounce_class)))
      return report(e.rcpt_to, "bounce", e.raw_reason);
    if (e?.type === "spam_complaint") return report(e.rcpt_to, "complaint", null);
    return [];
  });
}

/**
 * Amazon SNS's own hosts, the only ones its signing certificate is fetched from and its
 * subscription confirmed at: `sns.<region>.amazonaws.com`, and `.com.cn` in China.
 */
const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

/** An address on one of SNS's hosts, over HTTPS; null where it is anything else. */
export function snsUrl(value: unknown): URL | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && SNS_HOST.test(url.hostname) && !url.port && !url.username
      ? url
      : null;
  } catch {
    return null;
  }
}

/** The fields SNS signs, in the order it signs them, for each kind of message. */
const SNS_SIGNED: Record<string, string[]> = {
  Notification: ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"],
  SubscriptionConfirmation: [
    "Message",
    "MessageId",
    "SubscribeURL",
    "Timestamp",
    "Token",
    "TopicArn",
    "Type",
  ],
  UnsubscribeConfirmation: [
    "Message",
    "MessageId",
    "SubscribeURL",
    "Timestamp",
    "Token",
    "TopicArn",
    "Type",
  ],
};

/** What SNS signs: each field present, by name then value, a line each. */
export function snsStringToSign(message: Record<string, unknown>): string | null {
  const fields = SNS_SIGNED[String(message.Type)];
  if (!fields) return null;
  let text = "";
  for (const name of fields) {
    const value = message[name];
    // Only the subject may be left out; it is then not signed.
    if (value === undefined && name === "Subject") continue;
    if (typeof value !== "string") return null;
    text += `${name}\n${value}\n`;
  }
  return text;
}

/** SNS's signing certificates, kept once fetched: each address holds one certificate. */
const snsCertificates = new Map<string, KeyObject>();

async function snsKey(url: URL, { now, fetch }: Context): Promise<KeyObject> {
  const known = snsCertificates.get(url.href);
  if (known) return known;
  const res = await fetch(url.href, { redirect: "error", signal: AbortSignal.timeout(10_000) });
  const pem = res.ok ? await res.text() : "";
  let certificate: X509Certificate;
  try {
    if (pem.length > 65_536) throw new Error("too large");
    certificate = new X509Certificate(pem);
  } catch {
    throw new Unverified("The SNS signing certificate could not be read");
  }
  if (now < new Date(certificate.validFrom) || now > new Date(certificate.validTo))
    throw new Unverified("The SNS signing certificate is not valid now");
  // A handful of regions sign at most; a full map is a sign of something else, and starts again.
  if (snsCertificates.size >= 32) snsCertificates.clear();
  snsCertificates.set(url.href, certificate.publicKey);
  return certificate.publicKey;
}

/**
 * Amazon SES through Amazon SNS. Each message is signed with RSA (SHA-1 for signature version 1,
 * SHA-256 for 2) by a certificate fetched only from SNS's own hosts over HTTPS, and must name the
 * topic the operator or workspace gave, so a topic of anyone else's is refused however genuine.
 * A subscription is confirmed by visiting its address, again only on SNS's hosts. Only then are
 * SES's notifications read: permanent bounces and complaints.
 */
async function ses(
  topicArn: string,
  body: string,
  _header: Headers,
  context: Context,
): Promise<BounceReport[]> {
  const message = parsed(body);
  if (!message || typeof message !== "object") throw new Unverified("Not an SNS message");
  const m = message as Record<string, unknown>;
  const text = snsStringToSign(m);
  const algorithm =
    m.SignatureVersion === "1" ? "sha1" : m.SignatureVersion === "2" ? "sha256" : null;
  const certificate = snsUrl(m.SigningCertURL);
  if (!text || !algorithm || !certificate || typeof m.Signature !== "string")
    throw new Unverified("Not a signed SNS message");
  if (!certificate.pathname.endsWith(".pem"))
    throw new Unverified("The SNS signing certificate is not SNS's");
  // The topic is checked first: a message for another topic costs no certificate fetch.
  if (m.TopicArn !== topicArn.trim()) throw new Unverified("The SNS topic is not the one given");
  if (!fresh(Date.parse(String(m.Timestamp)) / 1000, context.now, RETRIED_TOLERANCE_SECONDS))
    throw new Unverified("The SNS message is not fresh");
  const key = await snsKey(certificate, context);
  let holds = false;
  try {
    holds = verify(algorithm, Buffer.from(text), key, Buffer.from(m.Signature, "base64"));
  } catch {
    holds = false;
  }
  if (!holds) throw new Unverified("The SNS signature does not hold");

  if (m.Type === "SubscriptionConfirmation") {
    const subscribe = snsUrl(m.SubscribeURL);
    if (subscribe?.searchParams.get("Action") !== "ConfirmSubscription")
      throw new Unverified("The subscription address is not SNS's");
    const res = await context.fetch(subscribe.href, {
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    // Not confirmed, SNS asks again; an error here says so to it.
    if (!res.ok) throw new Error(`SNS refused the subscription: ${res.status}`);
    return [];
  }
  if (m.Type !== "Notification") return [];
  const notification = (() => {
    try {
      return JSON.parse(String(m.Message)) as unknown;
    } catch {
      return null;
    }
  })() as {
    notificationType?: string;
    eventType?: string;
    bounce?: {
      bounceType?: string;
      bounceSubType?: string;
      bouncedRecipients?: { emailAddress?: string; diagnosticCode?: string }[];
    };
    complaint?: {
      complaintFeedbackType?: string;
      complainedRecipients?: { emailAddress?: string }[];
    };
  } | null;
  // Notifications name their kind `notificationType`; a configuration set's events, `eventType`.
  const kind = notification?.notificationType ?? notification?.eventType;
  if (kind === "Bounce" && notification?.bounce?.bounceType === "Permanent")
    return (notification.bounce.bouncedRecipients ?? []).flatMap((r) =>
      report(r.emailAddress, "bounce", r.diagnosticCode || notification.bounce?.bounceSubType),
    );
  // A recipient's provider saying a message was not spam after all is no complaint.
  if (kind === "Complaint" && notification?.complaint?.complaintFeedbackType !== "not-spam")
    return (notification?.complaint?.complainedRecipients ?? []).flatMap((r) =>
      report(r.emailAddress, "complaint", null),
    );
  return [];
}

/**
 * Postal's public key, given as its DKIM record's `p=` value (the whole record will do) or as
 * PEM, its line breaks lost or not.
 */
function postalKey(secret: string): KeyObject | null {
  const p = /(?:^|;)\s*p=([^;]+)/.exec(secret)?.[1] ?? secret;
  const der = Buffer.from(
    p.replace(/-----(BEGIN|END)[A-Z ]+-----/g, "").replace(/\s+/g, ""),
    "base64",
  );
  for (const type of ["spki", "pkcs1"] as const) {
    try {
      return createPublicKey({ key: der, format: "der", type });
    } catch {
      // Try the next form.
    }
  }
  return null;
}

/**
 * Postal signs each webhook's body with its RSA key: SHA-256 in `X-Postal-Signature-256` from
 * Postal 3.2, and SHA-1 in `X-Postal-Signature`, all that Postal 2 sends. The body names its
 * own time, kept on retries. A permanent failure reaches Postal's suppression list after
 * repeated hard fails, and the next message to the address is held: that hold, and a bounce
 * message Postal links to what was sent, are the reports.
 */
function postal(secret: string, body: string, header: Headers, { now }: Context): BounceReport[] {
  const sha256 = header("x-postal-signature-256");
  const [algorithm, signature] = sha256
    ? ["sha256", sha256]
    : ["sha1", header("x-postal-signature") ?? ""];
  const key = postalKey(secret);
  let holds = false;
  try {
    holds =
      Boolean(key && signature) &&
      verify(algorithm, Buffer.from(body), key as KeyObject, Buffer.from(signature, "base64"));
  } catch {
    holds = false;
  }
  if (!holds) throw new Unverified("The Postal signature does not hold");
  const event = parsed(body) as {
    event?: string;
    timestamp?: number;
    payload?: {
      original_message?: { to?: string };
      bounce?: { subject?: string };
      message?: { to?: string };
      details?: string;
    };
  };
  if (!fresh(Number(event.timestamp), now, RETRIED_TOLERANCE_SECONDS))
    throw new Unverified("The Postal report is not fresh");
  const payload = event.payload ?? {};
  if (event.event === "MessageBounced")
    return report(payload.original_message?.to, "bounce", payload.bounce?.subject);
  // Held for other reasons (a send limit, a credential set to hold), it says nothing of the address.
  if (event.event === "MessageHeld" && /suppression list/i.test(payload.details ?? ""))
    return report(payload.message?.to, "bounce", payload.details);
  return [];
}

/**
 * Plunk signs nothing: a workflow's Webhook step sends the headers it is given, so the step on
 * `email.bounce` and on `email.complaint` sends `Authorization: Bearer <secret>`. Its default
 * body names the contact, and the event: a bounce's type, or when a complaint came.
 */
function plunk(secret: string, body: string, header: Headers): BounceReport[] {
  if (!same(Buffer.from(header("authorization") ?? ""), Buffer.from(`Bearer ${secret}`)))
    throw new Unverified("The Plunk token does not match");
  const call = parsed(body) as {
    contact?: { email?: string };
    event?: { bounceType?: string; complainedAt?: string };
  };
  const event = call.event ?? {};
  if (event.bounceType === "Permanent")
    return report(call.contact?.email, "bounce", "Permanent bounce");
  if (!event.bounceType && event.complainedAt)
    return report(call.contact?.email, "complaint", null);
  return [];
}

/**
 * Mailcoach signs each webhook's body with HMAC-SHA256 of the webhook's secret, in hex in the
 * `Signature` header. `BounceRegisteredEvent` is a hard bounce; a soft bounce is retried, and
 * Mailcoach sends no complaints by webhook.
 */
function mailcoach(secret: string, body: string, header: Headers): BounceReport[] {
  const given = Buffer.from(header("signature") ?? "", "hex");
  if (!same(given, createHmac("sha256", secret).update(body).digest()))
    throw new Unverified("The Mailcoach signature does not hold");
  const event = parsed(body) as { event?: string; subscriber_email?: string };
  if (event.event === "BounceRegisteredEvent")
    return report(event.subscriber_email, "bounce", null);
  return [];
}

const readers: Record<
  BounceProvider,
  (
    secret: string,
    body: string,
    header: Headers,
    context: Context,
  ) => BounceReport[] | Promise<BounceReport[]>
> = { resend, mailgun, sendgrid, sparkpost, ses, postal, plunk, mailcoach };

/** The reports in a webhook's body, once its signature holds; Unverified where it does not. */
export async function readBounces(
  provider: BounceProvider,
  secret: string,
  body: string,
  header: Headers,
  context: Partial<Context> = {},
): Promise<BounceReport[]> {
  if (!secret) throw new Unverified("No secret is set to check reports with");
  return readers[provider](secret, body, header, {
    now: context.now ?? new Date(),
    fetch: context.fetch ?? fetch,
  });
}

/** The mail log's subject for a report, which has no message of its own. */
const subjectOf = (kind: SuppressionKind) =>
  kind === "bounce" ? "Bounce report" : "Complaint report";

/**
 * Stop sending to what was reported: the instance's reports for everyone, a workspace's own
 * provider's for that workspace. Each report is also in the mail log.
 */
export async function recordBounces(
  db: Database,
  scope: { organisationId: string } | "instance",
  provider: BounceProvider,
  reports: BounceReport[],
) {
  for (const r of reports) {
    const values = { address: r.address, kind: r.kind, provider, detail: r.detail };
    if (scope === "instance")
      await db
        .insert(mailSuppressions)
        .values(values)
        .onConflictDoUpdate({
          target: mailSuppressions.address,
          set: { ...values, updatedAt: new Date() },
        });
    else
      await db
        .insert(workspaceMailSuppressions)
        .values({ organisationId: scope.organisationId, ...values })
        .onConflictDoUpdate({
          target: [workspaceMailSuppressions.organisationId, workspaceMailSuppressions.address],
          set: { ...values, updatedAt: new Date() },
        });
    await db.insert(mailEvents).values({
      recipient: r.address,
      subject: subjectOf(r.kind),
      result: "bounced",
      error: r.detail,
    });
  }
}

/**
 * Whether mail to an address is held back: the instance's provider reported it, or, for mail
 * sent for a workspace, that workspace's own provider did.
 */
export async function suppressed(
  db: Pick<Database, "select">,
  address: string,
  organisationId?: string,
): Promise<boolean> {
  const to = address.trim().toLowerCase();
  const [everyone] = await db
    .select({ id: mailSuppressions.id })
    .from(mailSuppressions)
    .where(eq(mailSuppressions.address, to))
    .limit(1);
  if (everyone) return true;
  if (!organisationId) return false;
  const [theirs] = await db
    .select({ id: workspaceMailSuppressions.id })
    .from(workspaceMailSuppressions)
    .where(
      inOrg(workspaceMailSuppressions, organisationId, eq(workspaceMailSuppressions.address, to)),
    )
    .limit(1);
  return Boolean(theirs);
}

/** How many addresses a workspace's own provider reported. */
export async function suppressedCount(db: Database, organisationId: string) {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(workspaceMailSuppressions)
    .where(inOrg(workspaceMailSuppressions, organisationId));
  return row?.n ?? 0;
}

/** What says which provider the instance's mail is. */
export interface InstanceMailSettings {
  SMTP_URL?: string | undefined;
  MAIL_MAILCOACH_URL?: string | undefined;
  MAIL_BOUNCE_PROVIDER?: BounceProvider | undefined;
}

/**
 * The instance's bounce reports: its mail settings say which provider it is, and the operator
 * gives the secret. None where the provider sends no reports Hekate reads, or no secret is set.
 */
export function instanceBouncesOf(
  settings: InstanceMailSettings & { MAIL_WEBHOOK_SECRET?: string | undefined },
): { provider: BounceProvider; secret: string } | null {
  const provider = bounceProviderOf(settings);
  if (!provider || !settings.MAIL_WEBHOOK_SECRET) return null;
  return { provider, secret: settings.MAIL_WEBHOOK_SECRET };
}

/**
 * Amazon SES's SMTP endpoints, which differ by region: `email-smtp.<region>.amazonaws.com`, its
 * FIPS twin, and a VPC endpoint's name for either.
 */
const SES_SMTP_HOST = /(^|\.)email-smtp(-fips)?\.[a-z0-9-]+\.(vpce\.)?amazonaws\.com(\.cn)?$/i;

/**
 * The provider the instance's mail is, where it is one whose bounce reports Hekate reads:
 * named by `MAIL_BOUNCE_PROVIDER` where its host cannot say (Postal, which runs on the
 * operator's own host), Mailcoach where its API sends, and otherwise the SMTP host's.
 */
export function bounceProviderOf(settings: InstanceMailSettings): BounceProvider | null {
  if (settings.MAIL_BOUNCE_PROVIDER) return settings.MAIL_BOUNCE_PROVIDER;
  if (settings.MAIL_MAILCOACH_URL) return "mailcoach";
  const smtp = settings.SMTP_URL ? describeSmtp(settings.SMTP_URL) : null;
  if (!smtp) return null;
  if (SES_SMTP_HOST.test(smtp.host)) return "ses";
  return isBounceProvider(smtp.provider) ? smtp.provider : null;
}
