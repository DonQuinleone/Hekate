import { createHmac, createPublicKey, timingSafeEqual, verify } from "node:crypto";
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
 * Bounce reports (#161). A provider tells Hekate, by a webhook it signs, that an address bounced
 * for good or that someone complained; Hekate checks the signature with the secret the operator
 * or the workspace gave, and stops sending to the address. Transient bounces are not reports:
 * the provider retries those itself.
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

type Headers = (name: string) => string | undefined;

const same = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);
const fresh = (seconds: number, now: Date) =>
  Number.isFinite(seconds) && Math.abs(now.getTime() / 1000 - seconds) <= TOLERANCE_SECONDS;
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
function resend(secret: string, body: string, header: Headers, now: Date): BounceReport[] {
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
  if (event.type === "email.bounced" && event.data?.bounce?.type !== "Transient")
    return to.flatMap((a) => report(a, "bounce", event.data?.bounce?.message));
  if (event.type === "email.complained") return to.flatMap((a) => report(a, "complaint", null));
  return [];
}

/** Mailgun signs the time and a token with HMAC-SHA256, inside the report itself. */
function mailgun(secret: string, body: string, _header: Headers, now: Date): BounceReport[] {
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
function sendgrid(secret: string, body: string, header: Headers, now: Date): BounceReport[] {
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

const readers: Record<
  BounceProvider,
  (secret: string, body: string, header: Headers, now: Date) => BounceReport[]
> = { resend, mailgun, sendgrid, sparkpost };

/** The reports in a webhook's body, once its signature holds; Unverified where it does not. */
export function readBounces(
  provider: BounceProvider,
  secret: string,
  body: string,
  header: Headers,
  now = new Date(),
): BounceReport[] {
  if (!secret) throw new Unverified("No secret is set to check reports with");
  return readers[provider](secret, body, header, now);
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

/**
 * The instance's bounce reports: its SMTP host says which provider it is, and the operator gives
 * the secret. None where the provider sends no reports Hekate reads, or no secret is set.
 */
export function instanceBouncesOf(settings: {
  SMTP_URL?: string | undefined;
  MAIL_WEBHOOK_SECRET?: string | undefined;
}): { provider: BounceProvider; secret: string } | null {
  const provider = bounceProviderOf(settings.SMTP_URL);
  if (!provider || !settings.MAIL_WEBHOOK_SECRET) return null;
  return { provider, secret: settings.MAIL_WEBHOOK_SECRET };
}

/** The provider an SMTP host is, where it is one whose bounce reports Hekate reads. */
export function bounceProviderOf(smtpUrl: string | undefined): BounceProvider | null {
  const provider = smtpUrl ? describeSmtp(smtpUrl)?.provider : undefined;
  return isBounceProvider(provider) ? provider : null;
}
