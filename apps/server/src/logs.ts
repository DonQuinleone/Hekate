import type { Database } from "@hekate/db";
import {
  type AuditLogRow,
  type LogKind,
  type LogQuery,
  logRangeHours,
  type MailLogRow,
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

/** A log's page of either kind. */
export const readLog = (db: Database, kind: LogKind, filters: Filters, now?: Date) =>
  kind === "audit" ? auditLog(db, filters, now) : mailLog(db, filters, now);

const csvColumns: Record<LogKind, string[]> = {
  audit: ["occurred_at", "source", "who", "workspace", "action", "target", "ip_address"],
  mail: ["occurred_at", "to", "subject", "result", "error"],
};

const csvLine = (cells: unknown[]) => `${cells.map(csvCell).join(",")}\r\n`;

/** A row as the export writes it, each cell neutralised as the access log's are. */
function csvOf(kind: LogKind, row: AuditLogRow | MailLogRow): string {
  if (kind === "audit") {
    const r = row as AuditLogRow;
    return csvLine([r.at, r.source, r.who, r.workspace?.name, r.action, r.target, r.ipAddress]);
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
