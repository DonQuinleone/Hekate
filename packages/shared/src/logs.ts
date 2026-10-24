import { z } from "zod";
import type { ApiTokenKind } from "./api-tokens.ts";
import type { ChannelKind, DeliveryStatus, EventKind } from "./events.ts";

/**
 * The instance's logs as tables (#157): what operators look up in the app, beside the JSON lines
 * on stdout that log shippers read. Each kind arrives with what writes it: the API's with API
 * tokens (#198). The billing gateway's (#178) is shown only with billing on.
 */
export const logKinds = ["audit", "auth", "api", "mail", "webhooks", "gateway"] as const;
export type LogKind = (typeof logKinds)[number];
export const logKindParam = z.object({ kind: z.enum(logKinds) });

export const logRanges = ["1h", "24h", "7d", "30d"] as const;
export type LogRange = (typeof logRanges)[number];
export const logRangeHours: Record<LogRange, number> = {
  "1h": 1,
  "24h": 24,
  "7d": 168,
  "30d": 720,
};

/** Filters for reading a log, newest first; `before` is the last id of the previous page. */
export const logQuery = z.object({
  q: z.string().trim().max(200).optional(),
  range: z.enum(logRanges).default("24h"),
  /** Audit and authentication: one workspace's events, and the operators' events about it. */
  workspace: z.uuid().optional(),
  before: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type LogQuery = z.infer<typeof logQuery>;

/** Filters for an export: the same, without paging. */
export const logExportQuery = logQuery.omit({ before: true, limit: true });

/**
 * An action a person or an operator took: an operator's on the instance, or anyone's in a
 * workspace's access log (streams and page renders left out: they are the access log's alone).
 */
export interface AuditLogRow {
  id: string;
  at: string;
  source: "instance" | "workspace";
  who: string;
  workspace: { id: string; name: string } | null;
  action: string;
  /** What it was done to, in words: a workspace, an address, a file, a review. */
  target: string | null;
  ipAddress: string | null;
}

export const authMethods = [
  "password",
  "passkey",
  "second_factor",
  "directory",
  "sso",
  "guest_link",
  "guest_code",
] as const;
export type AuthMethod = (typeof authMethods)[number];
export const authResults = ["signed_in", "refused", "locked"] as const;
export type AuthResult = (typeof authResults)[number];
/**
 * What came of a message: sent, refused, written to the server's log, reported back by the
 * provider as bounced or complained of (#161), or not sent to an address that had.
 */
export const mailResults = ["sent", "failed", "logged", "bounced", "suppressed"] as const;
export type MailResult = (typeof mailResults)[number];

/** A sign-in, a refusal or a lockout, by how it was tried. */
export interface AuthLogRow {
  id: string;
  at: string;
  method: AuthMethod;
  result: AuthResult;
  reason: string | null;
  /** The address tried, or the guest's label; "Not known" where nothing named one. */
  account: string;
  workspace: { id: string; name: string } | null;
  ipAddress: string | null;
  userAgent: string | null;
}

/** A message handed to instance mail, and what came of it. */
export interface MailLogRow {
  id: string;
  at: string;
  to: string;
  subject: string;
  result: MailResult;
  error: string | null;
}

/** One event sent to one of a workspace's channels (#161), and what came of it so far. */
export interface WebhookLogRow {
  id: string;
  at: string;
  workspace: { id: string; name: string };
  channel: { id: string; kind: ChannelKind; name: string };
  event: EventKind;
  status: DeliveryStatus;
  /** The receiver's last answer, or what went wrong before one. */
  result: string | null;
  attempts: number;
  /** A replay, sent again from the debug tools. */
  replay: boolean;
}

/** One call made with an API token (#198), and how it was answered. */
export interface ApiLogRow {
  id: string;
  at: string;
  workspace: { id: string; name: string };
  /**
   * The token's name as it was then, and whose: a member's own, the workspace's, or an
   * application's acting for a member (#447).
   */
  token: { id: string | null; name: string; kind: ApiTokenKind };
  method: string;
  /** The path, without its query. */
  path: string;
  status: number;
  /** How long it took to answer, in milliseconds. */
  durationMs: number;
  ipAddress: string | null;
}

/** One event from the billing gateway (#178), and what it meant here. */
export interface GatewayLogRow {
  id: string;
  /** When it arrived. */
  at: string;
  gateway: string;
  /** The gateway's own name for it: `invoice.paid`. */
  event: string;
  /** Its workspace; none for a payout, or once the workspace is gone. */
  workspace: { id: string; name: string } | null;
  /** What it was about: an invoice's number, a plan's name. */
  summary: string | null;
  amount: number | null;
  currency: string | null;
  /** `taken`, `ignored…`, `failed: …`, or null while it is being taken. */
  result: string | null;
}

export interface LogRows {
  audit: AuditLogRow;
  auth: AuthLogRow;
  api: ApiLogRow;
  mail: MailLogRow;
  webhooks: WebhookLogRow;
  gateway: GatewayLogRow;
}

export type LogPage<K extends LogKind> = { rows: LogRows[K][]; next: string | null };
