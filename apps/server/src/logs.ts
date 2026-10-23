import type { Database } from "@hekate/db";
import {
  type ApiLogRow,
  type AuditLogRow,
  type AuthLogRow,
  type GatewayLogRow,
  type LogKind,
  type LogQuery,
  logRangeHours,
  type MailLogRow,
  type WebhookLogRow,
} from "@hekate/shared";
import { type SQL, sql } from "drizzle-orm";
import { csvCell } from "./audit.ts";

/**
 * The instance's logs as tables (#157), read by operators. Ids are UUIDv7, so they sort by time
 * and a range is a scan of the primary key: newest first, a page at a time by the last id.
 */

/** Text searched for as itself, its wildcards made plain. */
export const escapeLike = (text: string) => text.replace(/[\\%_]/g, (m) => `\\${m}`);

/** The smallest UUIDv7 made at a moment: every id made since sorts after it. */
export function idAt(date: Date): string {
  const hex = Math.max(0, date.getTime()).toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-0000-0000-000000000000`;
}

/** The access log's own records, too many and too alike for the audit table. */
const ACCESS_ONLY = ["stream.key", "stream.session", "stream.segment", "page.render"];

type Filters = Omit<LogQuery, "before" | "limit"> & { before?: string | undefined; limit: number };

const sinceOf = (filters: Filters, now: Date) =>
  idAt(new Date(now.getTime() - logRangeHours[filters.range] * 60 * 60_000));

/** The conditions joined with `and`; none is true. */
const all = (conditions: SQL[]) =>
  conditions.length === 0 ? sql`true` : sql.join(conditions, sql` and `);

/**
 * Operators' actions on the instance and everyone's in a workspace, together: one workspace's
 * when filtered, the operators' about it among them.
 */
export async function auditLog(
  db: Database,
  filters: Filters,
  now = new Date(),
): Promise<{ rows: AuditLogRow[]; next: string | null }> {
  const since = sinceOf(filters, now);
  const conditions: SQL[] = [];
  if (filters.before) conditions.push(sql`l.id < ${filters.before}::uuid`);
  if (filters.workspace) conditions.push(sql`l.workspace_id = ${filters.workspace}::uuid`);
  if (filters.q) {
    const like = `%${escapeLike(filters.q)}%`;
    conditions.push(
      sql`(l.who ilike ${like} or l.action ilike ${like} or l.target ilike ${like}
           or l.workspace_name ilike ${like} or l.ip ilike ${like})`,
    );
  }
  const rows = await db.execute<{
    id: string;
    at: Date | string;
    source: "instance" | "workspace";
    who: string;
    workspace_id: string | null;
    workspace_name: string | null;
    action: string;
    target: string | null;
    ip: string | null;
  }>(sql`
    select * from (
      select e.id, e.created_at as at, 'instance' as source,
             coalesce('Operator: ' || u.name, 'Hekate') as who,
             o.id as workspace_id, o.name as workspace_name,
             e.action, e.target, e.ip_address as ip
      from instance_events e
      left join users u on u.id = e.actor_id
      left join organisations o on o.id::text = e.details->>'organisationId'
      where e.id >= ${since}::uuid
      union all
      select a.id, a.occurred_at, 'workspace', a.actor_label,
             o.id, o.name, a.action::text,
             -- What it was done to; a deleted file's or project's name lives on in the details.
             coalesce(f.name, r.title, a.details->>'name', p.name), host(a.ip_address)
      from access_events a
      join organisations o on o.id = a.organisation_id
      left join files f on f.id = a.file_id and f.organisation_id = a.organisation_id
      left join reviews r on r.id = a.review_id and r.organisation_id = a.organisation_id
      left join projects p on p.id = a.project_id and p.organisation_id = a.organisation_id
      where a.id >= ${since}::uuid
        and a.action::text not in (${sql.join(
          ACCESS_ONLY.map((a) => sql`${a}`),
          sql`, `,
        )})
    ) l
    where ${all(conditions)}
    order by l.id desc
    limit ${filters.limit + 1}`);
  const page = rows.slice(0, filters.limit);
  return {
    rows: page.map((r) => ({
      id: r.id,
      at: new Date(r.at).toISOString(),
      source: r.source,
      who: r.who,
      workspace: r.workspace_id ? { id: r.workspace_id, name: r.workspace_name ?? "" } : null,
      action: r.action,
      target: r.target,
      ipAddress: r.ip,
    })),
    next: rows.length > filters.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

/** Every message handed to instance mail, and what came of it. */
export async function mailLog(
  db: Database,
  filters: Filters,
  now = new Date(),
): Promise<{ rows: MailLogRow[]; next: string | null }> {
  const conditions: SQL[] = [sql`m.id >= ${sinceOf(filters, now)}::uuid`];
  if (filters.before) conditions.push(sql`m.id < ${filters.before}::uuid`);
  if (filters.q) {
    const like = `%${escapeLike(filters.q)}%`;
    conditions.push(
      sql`(m.recipient ilike ${like} or m.subject ilike ${like} or m.error ilike ${like})`,
    );
  }
  const rows = await db.execute<{
    id: string;
    at: Date | string;
    recipient: string;
    subject: string;
    result: MailLogRow["result"];
    error: string | null;
  }>(sql`
    select m.id, m.occurred_at as at, m.recipient, m.subject, m.result, m.error
    from mail_events m
    where ${all(conditions)}
    order by m.id desc
    limit ${filters.limit + 1}`);
  const page = rows.slice(0, filters.limit);
  return {
    rows: page.map((r) => ({
      id: r.id,
      at: new Date(r.at).toISOString(),
      to: r.recipient,
      subject: r.subject,
      result: r.result,
      error: r.error,
    })),
    next: rows.length > filters.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

/** Every sign-in, refusal and lockout; one workspace's where filtered. */
export async function authLog(
  db: Database,
  filters: Filters,
  now = new Date(),
): Promise<{ rows: AuthLogRow[]; next: string | null }> {
  const conditions: SQL[] = [sql`e.id >= ${sinceOf(filters, now)}::uuid`];
  if (filters.before) conditions.push(sql`e.id < ${filters.before}::uuid`);
  if (filters.workspace) conditions.push(sql`e.organisation_id = ${filters.workspace}::uuid`);
  if (filters.q) {
    const like = `%${escapeLike(filters.q)}%`;
    conditions.push(
      sql`((case when u.deleted_at is not null then 'A former member' else e.account end) ilike ${like}
           or e.method::text ilike ${like} or e.reason ilike ${like}
           or e.ip_address ilike ${like} or o.name ilike ${like})`,
    );
  }
  const rows = await db.execute<{
    id: string;
    at: Date | string;
    method: AuthLogRow["method"];
    result: AuthLogRow["result"];
    reason: string | null;
    account: string;
    workspace_id: string | null;
    workspace_name: string | null;
    ip_address: string | null;
    user_agent: string | null;
  }>(sql`
    select e.id, e.occurred_at as at, e.method, e.result, e.reason,
           -- An account deleted since is named by no one, whatever its row kept.
           case when u.deleted_at is not null then 'A former member' else e.account end as account,
           o.id as workspace_id, o.name as workspace_name, e.ip_address, e.user_agent
    from auth_events e
    left join users u on u.id = e.user_id
    left join organisations o on o.id = e.organisation_id
    where ${all(conditions)}
    order by e.id desc
    limit ${filters.limit + 1}`);
  const page = rows.slice(0, filters.limit);
  return {
    rows: page.map((r) => ({
      id: r.id,
      at: new Date(r.at).toISOString(),
      method: r.method,
      result: r.result,
      reason: r.reason,
      account: r.account,
      workspace: r.workspace_id ? { id: r.workspace_id, name: r.workspace_name ?? "" } : null,
      ipAddress: r.ip_address,
      userAgent: r.user_agent,
    })),
    next: rows.length > filters.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

/** Every delivery to a workspace's channel (#161), and its attempts; one workspace's where filtered. */
export async function webhookLog(
  db: Database,
  filters: Filters,
  now = new Date(),
): Promise<{ rows: WebhookLogRow[]; next: string | null }> {
  const conditions: SQL[] = [sql`d.id >= ${sinceOf(filters, now)}::uuid`];
  if (filters.before) conditions.push(sql`d.id < ${filters.before}::uuid`);
  if (filters.workspace) conditions.push(sql`d.organisation_id = ${filters.workspace}::uuid`);
  if (filters.q) {
    const like = `%${escapeLike(filters.q)}%`;
    conditions.push(
      sql`(c.name ilike ${like} or c.kind ilike ${like} or e.kind ilike ${like}
           or d.last_result ilike ${like} or d.status ilike ${like} or o.name ilike ${like})`,
    );
  }
  const rows = await db.execute<{
    id: string;
    at: Date | string;
    workspace_id: string;
    workspace_name: string;
    channel_id: string;
    channel_kind: WebhookLogRow["channel"]["kind"];
    channel_name: string;
    event: WebhookLogRow["event"];
    status: WebhookLogRow["status"];
    result: string | null;
    attempts: number;
    replay: boolean;
  }>(sql`
    select d.id, d.created_at as at, o.id as workspace_id, o.name as workspace_name,
           c.id as channel_id, c.kind as channel_kind, c.name as channel_name, e.kind as event,
           d.status, d.last_result as result, d.attempts, d.replay_of is not null as replay
    from event_deliveries d
    join channels c on c.id = d.channel_id and c.organisation_id = d.organisation_id
    join events e on e.id = d.event_id and e.organisation_id = d.organisation_id
    join organisations o on o.id = d.organisation_id
    where ${all(conditions)}
    order by d.id desc
    limit ${filters.limit + 1}`);
  const page = rows.slice(0, filters.limit);
  return {
    rows: page.map((r) => ({
      id: r.id,
      at: new Date(r.at).toISOString(),
      workspace: { id: r.workspace_id, name: r.workspace_name },
      channel: { id: r.channel_id, kind: r.channel_kind, name: r.channel_name },
      event: r.event,
      status: r.status,
      result: r.result,
      attempts: r.attempts,
      replay: r.replay,
    })),
    next: rows.length > filters.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

/** Every call made with an API token (#198); one workspace's where filtered. */
export async function apiLog(
  db: Database,
  filters: Filters,
  now = new Date(),
): Promise<{ rows: ApiLogRow[]; next: string | null }> {
  const conditions: SQL[] = [sql`r.id >= ${sinceOf(filters, now)}::uuid`];
  if (filters.before) conditions.push(sql`r.id < ${filters.before}::uuid`);
  if (filters.workspace) conditions.push(sql`r.organisation_id = ${filters.workspace}::uuid`);
  if (filters.q) {
    const like = `%${escapeLike(filters.q)}%`;
    conditions.push(
      sql`(r.token_name ilike ${like} or r.path ilike ${like} or r.method ilike ${like}
           or r.status::text = ${filters.q} or r.ip_address ilike ${like} or o.name ilike ${like})`,
    );
  }
  const rows = await db.execute<{
    id: string;
    at: Date | string;
    workspace_id: string;
    workspace_name: string;
    token_id: string | null;
    token_name: string;
    token_kind: ApiLogRow["token"]["kind"];
    method: string;
    path: string;
    status: number;
    duration_ms: number;
    ip_address: string | null;
  }>(sql`
    select r.id, r.created_at as at, o.id as workspace_id, o.name as workspace_name,
           r.token_id, r.token_name, r.token_kind, r.method, r.path, r.status, r.duration_ms,
           r.ip_address
    from api_requests r
    join organisations o on o.id = r.organisation_id
    where ${all(conditions)}
    order by r.id desc
    limit ${filters.limit + 1}`);
  const page = rows.slice(0, filters.limit);
  return {
    rows: page.map((r) => ({
      id: r.id,
      at: new Date(r.at).toISOString(),
      workspace: { id: r.workspace_id, name: r.workspace_name },
      token: { id: r.token_id, name: r.token_name, kind: r.token_kind },
      method: r.method,
      path: r.path,
      status: r.status,
      durationMs: r.duration_ms,
      ipAddress: r.ip_address,
    })),
    next: rows.length > filters.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

/** Every event the billing gateway sent (#178); one workspace's where filtered. */
export async function gatewayLog(
  db: Database,
  filters: Filters,
  now = new Date(),
): Promise<{ rows: GatewayLogRow[]; next: string | null }> {
  const conditions: SQL[] = [sql`g.id >= ${sinceOf(filters, now)}::uuid`];
  if (filters.before) conditions.push(sql`g.id < ${filters.before}::uuid`);
  if (filters.workspace) conditions.push(sql`g.organisation_id = ${filters.workspace}::uuid`);
  if (filters.q) {
    const like = `%${escapeLike(filters.q)}%`;
    conditions.push(
      sql`(g.type ilike ${like} or g.summary ilike ${like} or g.result ilike ${like}
           or g.event_id ilike ${like} or o.name ilike ${like})`,
    );
  }
  const rows = await db.execute<{
    id: string;
    at: Date | string;
    gateway: string;
    event: string;
    workspace_id: string | null;
    workspace_name: string | null;
    summary: string | null;
    amount: number | null;
    currency: string | null;
    result: string | null;
  }>(sql`
    select g.id, g.received_at as at, g.gateway, g.type as event, o.id as workspace_id,
           o.name as workspace_name, g.summary, g.amount, g.currency, g.result
    from gateway_events g
    left join organisations o on o.id = g.organisation_id
    where ${all(conditions)}
    order by g.id desc
    limit ${filters.limit + 1}`);
  const page = rows.slice(0, filters.limit);
  return {
    rows: page.map((r) => ({
      id: r.id,
      at: new Date(r.at).toISOString(),
      gateway: r.gateway,
      event: r.event,
      workspace: r.workspace_id ? { id: r.workspace_id, name: r.workspace_name ?? "" } : null,
      summary: r.summary,
      amount: r.amount,
      currency: r.currency,
      result: r.result,
    })),
    next: rows.length > filters.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

type AnyLogRow = AuditLogRow | AuthLogRow | ApiLogRow | MailLogRow | WebhookLogRow | GatewayLogRow;

/** A log's page, of whichever kind. */
export function readLog(
  db: Database,
  kind: LogKind,
  filters: Filters,
  now?: Date,
): Promise<{
  rows: AnyLogRow[];
  next: string | null;
}> {
  if (kind === "audit") return auditLog(db, filters, now);
  if (kind === "auth") return authLog(db, filters, now);
  if (kind === "api") return apiLog(db, filters, now);
  if (kind === "webhooks") return webhookLog(db, filters, now);
  if (kind === "gateway") return gatewayLog(db, filters, now);
  return mailLog(db, filters, now);
}

const csvColumns: Record<LogKind, string[]> = {
  audit: ["occurred_at", "source", "who", "workspace", "action", "target", "ip_address"],
  auth: [
    "occurred_at",
    "account",
    "method",
    "result",
    "reason",
    "workspace",
    "ip_address",
    "user_agent",
  ],
  api: [
    "created_at",
    "workspace",
    "token",
    "kind",
    "method",
    "path",
    "status",
    "duration_ms",
    "ip_address",
  ],
  mail: ["occurred_at", "to", "subject", "result", "error"],
  webhooks: [
    "created_at",
    "workspace",
    "channel",
    "kind",
    "event",
    "status",
    "result",
    "attempts",
    "replay",
  ],
  gateway: [
    "received_at",
    "gateway",
    "event",
    "workspace",
    "summary",
    "amount",
    "currency",
    "result",
  ],
};

export const csvLine = (cells: unknown[]) => `${cells.map(csvCell).join(",")}\r\n`;

/** A row as the export writes it, each cell neutralised as the access log's are. */
function csvOf(kind: LogKind, row: AnyLogRow): string {
  if (kind === "audit") {
    const r = row as AuditLogRow;
    return csvLine([r.at, r.source, r.who, r.workspace?.name, r.action, r.target, r.ipAddress]);
  }
  if (kind === "auth") {
    const r = row as AuthLogRow;
    return csvLine([
      r.at,
      r.account,
      r.method,
      r.result,
      r.reason,
      r.workspace?.name,
      r.ipAddress,
      r.userAgent,
    ]);
  }
  if (kind === "api") {
    const r = row as ApiLogRow;
    return csvLine([
      r.at,
      r.workspace.name,
      r.token.name,
      r.token.kind,
      r.method,
      r.path,
      r.status,
      r.durationMs,
      r.ipAddress,
    ]);
  }
  if (kind === "webhooks") {
    const r = row as WebhookLogRow;
    return csvLine([
      r.at,
      r.workspace.name,
      r.channel.name,
      r.channel.kind,
      r.event,
      r.status,
      r.result,
      r.attempts,
      r.replay ? "yes" : "no",
    ]);
  }
  if (kind === "gateway") {
    const r = row as GatewayLogRow;
    return csvLine([
      r.at,
      r.gateway,
      r.event,
      r.workspace?.name,
      r.summary,
      r.amount,
      r.currency,
      r.result,
    ]);
  }
  const r = row as MailLogRow;
  return csvLine([r.at, r.to, r.subject, r.result, r.error]);
}

/** A whole log as CSV, a page at a time, for a stream to send as it is read. */
export async function* logCsv(
  db: Database,
  kind: LogKind,
  filters: Omit<Filters, "before" | "limit">,
  now = new Date(),
): AsyncGenerator<string> {
  yield csvLine(csvColumns[kind]);
  let before: string | undefined;
  for (;;) {
    const page = await readLog(db, kind, { ...filters, before, limit: 500 }, now);
    for (const row of page.rows) yield csvOf(kind, row);
    if (!page.next) return;
    before = page.next;
  }
}
