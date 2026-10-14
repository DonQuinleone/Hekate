import { isIP } from "node:net";
import { type Database, inOrg, schema } from "@hekate/db";
import type { AuditAction, AuditActorType, AuditQuery } from "@hekate/shared";
import { getConnInfo } from "@hono/node-server/conninfo";
import { and, desc, eq, gte, lt, lte, type SQL } from "drizzle-orm";
import type { Context } from "hono";

const { accessEvents, users } = schema;

export type AccessEvent = typeof accessEvents.$inferSelect;

export interface Actor {
  type: AuditActorType;
  userId?: string;
  guestId?: string;
  /** Who it was, as shown at the time, for example "Producer <producer@example.test>". */
  label: string;
}

export interface AuditEvent {
  action: AuditAction;
  projectId?: string;
  fileId?: string;
  reviewId?: string;
  /** Action-specific facts. Never secrets, keys or tokens. */
  details?: Record<string, unknown>;
}

export interface RequestInfo {
  ipAddress?: string;
  userAgent?: string;
}

export const systemActor: Actor = { type: "system", label: "Hekate" };

/**
 * The client's address and user agent. Behind Caddy (TRUST_PROXY=true) the address
 * comes from X-Forwarded-For, which Caddy replaces with the real client address;
 * otherwise from the socket, so a client cannot claim another address.
 */
export function requestInfo(c: Context, trustProxy: boolean): RequestInfo {
  let address: string | undefined;
  if (trustProxy) {
    address = c.req.header("x-forwarded-for")?.split(",").pop()?.trim();
  } else {
    try {
      address = getConnInfo(c).remote.address;
    } catch {
      address = undefined;
    }
  }
  const info: RequestInfo = {};
  if (address && isIP(address)) info.ipAddress = address;
  const agent = c.req.header("user-agent");
  if (agent) info.userAgent = agent.slice(0, 512);
  return info;
}

export interface Audit {
  /**
   * Append an event. Awaited, never fire-and-forget: if the log cannot be written,
   * the access it describes must not happen either. Pass the transaction that makes a
   * change to commit the change and its event together.
   */
  record(
    organisationId: string,
    actor: Actor,
    event: AuditEvent,
    request?: RequestInfo,
    into?: Pick<Database, "insert">,
  ): Promise<AccessEvent>;
  /** The actor for a signed-in member, labelled with their current name and email. */
  member(userId: string): Promise<Actor>;
  /** Events newest first, with the cursor for the next page. */
  query(
    organisationId: string,
    filters: AuditQuery,
  ): Promise<{ events: AccessEvent[]; nextBefore: string | null }>;
}

export function createAudit(db: Database): Audit {
  return {
    async record(organisationId, actor, event, request, into = db) {
      const [row] = await into
        .insert(accessEvents)
        .values({
          organisationId,
          action: event.action,
          actorType: actor.type,
          userId: actor.userId ?? null,
          guestId: actor.guestId ?? null,
          actorLabel: actor.label,
          projectId: event.projectId ?? null,
          fileId: event.fileId ?? null,
          reviewId: event.reviewId ?? null,
          ipAddress: request?.ipAddress ?? null,
          userAgent: request?.userAgent ?? null,
          details: event.details ?? null,
        })
        .returning();
      if (!row) throw new Error("The access log did not accept the event");
      return row;
    },

    async member(userId) {
      const [user] = await db
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, userId));
      return { type: "member", userId, label: user ? `${user.name} <${user.email}>` : userId };
    },

    async query(organisationId, f) {
      const conditions: (SQL | undefined)[] = [
        f.projectId ? eq(accessEvents.projectId, f.projectId) : undefined,
        f.fileId ? eq(accessEvents.fileId, f.fileId) : undefined,
        f.reviewId ? eq(accessEvents.reviewId, f.reviewId) : undefined,
        f.userId ? eq(accessEvents.userId, f.userId) : undefined,
        f.action ? eq(accessEvents.action, f.action) : undefined,
        f.from ? gte(accessEvents.occurredAt, new Date(f.from)) : undefined,
        f.to ? lte(accessEvents.occurredAt, new Date(f.to)) : undefined,
        // Ids are UUIDv7, so they sort by time: a cursor needs only the last id.
        f.before ? lt(accessEvents.id, f.before) : undefined,
      ];
      const rows = await db
        .select()
        .from(accessEvents)
        .where(and(inOrg(accessEvents, organisationId, ...conditions)))
        .orderBy(desc(accessEvents.id))
        .limit(f.limit + 1);
      const more = rows.length > f.limit;
      const events = more ? rows.slice(0, f.limit) : rows;
      return { events, nextBefore: more ? (events.at(-1)?.id ?? null) : null };
    },
  };
}

const CSV_COLUMNS = [
  "occurred_at",
  "action",
  "actor_type",
  "actor",
  "user_id",
  "guest_id",
  "project_id",
  "file_id",
  "review_id",
  "ip_address",
  "user_agent",
  "details",
] as const;

/**
 * One CSV cell. Quoted always; and a value a spreadsheet would run as a formula
 * (starting with =, +, -, @, tab or carriage return) is prefixed with an apostrophe.
 */
export function csvCell(value: unknown): string {
  let text =
    value === null || value === undefined
      ? ""
      : value instanceof Date
        ? value.toISOString()
        : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function csvHeader(): string {
  return `${CSV_COLUMNS.join(",")}\r\n`;
}

export function csvRow(event: AccessEvent): string {
  return `${[
    event.occurredAt,
    event.action,
    event.actorType,
    event.actorLabel,
    event.userId,
    event.guestId,
    event.projectId,
    event.fileId,
    event.reviewId,
    event.ipAddress,
    event.userAgent,
    event.details ? JSON.stringify(event.details) : null,
  ]
    .map(csvCell)
    .join(",")}\r\n`;
}
