import { type Database, schema } from "@hekate/db";
import { lt, sql } from "drizzle-orm";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { requestInfo } from "./audit.ts";

const { requestLimits } = schema;

export interface LimitRule {
  /** Requests allowed in one window. */
  max: number;
  windowMs: number;
}

/**
 * Counts one request against `key` and says whether it is allowed (#172). The count lives in
 * PostgreSQL and is taken in one statement, so replicas share it and a burst cannot slip
 * through between a read and a write. A window that has passed starts again at one.
 */
export async function admit(db: Database, key: string, rule: LimitRule, now = new Date()) {
  // Raw SQL parameters go as ISO strings, cast; only typed columns take Date objects.
  const expired = sql`${new Date(now.getTime() - rule.windowMs).toISOString()}::timestamptz`;
  const start = sql`${now.toISOString()}::timestamptz`;
  const [row] = await db
    .insert(requestLimits)
    .values({ key, count: 1, windowStartedAt: now })
    .onConflictDoUpdate({
      target: requestLimits.key,
      set: {
        count: sql`case when ${requestLimits.windowStartedAt} <= ${expired} then 1 else ${requestLimits.count} + 1 end`,
        windowStartedAt: sql`case when ${requestLimits.windowStartedAt} <= ${expired} then ${start} else ${requestLimits.windowStartedAt} end`,
      },
    })
    .returning({ count: requestLimits.count, windowStartedAt: requestLimits.windowStartedAt });
  const count = row?.count ?? 1;
  const started = row?.windowStartedAt ?? now;
  const retryAfter = Math.max(
    1,
    Math.ceil((started.getTime() + rule.windowMs - now.getTime()) / 1000),
  );
  return { allowed: count <= rule.max, retryAfter };
}

/** Counts older than a day are of no use to any limit; the hourly purge removes them. */
export async function purgeRequestLimits(db: Database, now = new Date()) {
  await db
    .delete(requestLimits)
    .where(lt(requestLimits.windowStartedAt, new Date(now.getTime() - 24 * 60 * 60 * 1000)));
}

/**
 * Refuses a client past `rule` with 429 and a Retry-After. `by` names who is counted: by
 * default the client's address, which is all there is before anyone signs in.
 */
/** A refusal for going past a limit: 429, with when to try again (docs/security.md). */
export function tooMany(c: Context, retryAfter: number, message?: string) {
  c.header("Retry-After", String(retryAfter));
  return c.json(
    {
      error: {
        code: "rate_limited",
        message: message ?? "Too many requests. Wait a moment and try again.",
      },
    },
    429,
  );
}

export const rateLimit = (
  db: Database,
  name: string,
  rule: LimitRule,
  options: { trustProxy: boolean; by?: (c: Context) => string | undefined },
) =>
  createMiddleware(async (c, next) => {
    const who = options.by?.(c) ?? requestInfo(c, options.trustProxy).ipAddress ?? "unknown";
    const { allowed, retryAfter } = await admit(db, `${name}:${who}`, rule);
    if (!allowed) return tooMany(c, retryAfter);
    await next();
  });
