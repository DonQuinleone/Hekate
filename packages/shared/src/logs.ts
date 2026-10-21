import { z } from "zod";

/**
 * The instance's logs as tables (#157): what operators look up in the app, beside the JSON lines
 * on stdout that log shippers read. Each kind arrives with what writes it: authentication next,
 * then API, webhooks and the billing gateway with their features.
 */
export const logKinds = ["audit", "auth", "mail"] as const;
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

/** A sign-in, a refusal or a lockout, by how it was tried. */
export interface AuthLogRow {
  id: string;
  at: string;
  method: AuthMethod;
  result: "signed_in" | "refused" | "locked";
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
  result: "sent" | "failed" | "logged";
  error: string | null;
}

export interface LogRows {
  audit: AuditLogRow;
  auth: AuthLogRow;
  mail: MailLogRow;
}

export type LogPage<K extends LogKind> = { rows: LogRows[K][]; next: string | null };
