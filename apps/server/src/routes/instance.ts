import { type Database, schema } from "@hekate/db";
import {
  type InstanceAccess,
  type InstanceOverview,
  type InstanceWorkspace,
  type OperatorRow,
  operatorInput,
  operatorParam as operatorParamSchema,
} from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq, inArray, isNull, max, sql, sum } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { requestInfo } from "../audit.ts";
import type { Auth } from "../auth.ts";
import { CodedException } from "../errors.ts";
import { factorStanding, type SecondFactorRule } from "../tenancy.ts";

/**
 * The instance side (#155, decision 062). Operators manage every workspace; a workspace's
 * owner sees their own workspaces here and nothing else. Whether someone is an operator, and
 * whether their session may act as one, is decided here, never in the browser.
 */
export interface InstanceOptions {
  db: Database;
  auth: Auth;
  rule: SecondFactorRule;
  /** Operators act only from a session signed in with a passkey or security key. */
  operatorSecurityKey: boolean;
  trustProxy: boolean;
}

interface InstanceVariables {
  userId: string;
  sessionId: string;
  access: InstanceAccess;
}

/** Who someone is on the instance side, read fresh on every request. */
export async function instanceAccess(
  db: Database,
  userId: string,
  sessionId: string,
  options: Pick<InstanceOptions, "rule" | "operatorSecurityKey">,
): Promise<InstanceAccess> {
  const [operator] = await db
    .select({ userId: schema.instanceOperators.userId })
    .from(schema.instanceOperators)
    .where(eq(schema.instanceOperators.userId, userId));
  const [session] = await db
    .select({ factor: schema.authSessions.factor })
    .from(schema.authSessions)
    .where(eq(schema.authSessions.id, sessionId));
  const ownedRows = await db
    .select({ id: schema.organisations.id, name: schema.organisations.name })
    .from(schema.members)
    .innerJoin(schema.organisations, eq(schema.organisations.id, schema.members.organisationId))
    .where(and(eq(schema.members.userId, userId), eq(schema.members.role, "owner")))
    .orderBy(schema.organisations.name);
  // A workspace's owner reaches it here only as their workspace would let them in.
  const owned = [];
  for (const o of ownedRows) {
    const standing = await factorStanding(
      db,
      sessionId,
      { organisationId: o.id, role: "owner" },
      options.rule,
    );
    if (standing.met) owned.push(o);
  }
  return {
    operator: !!operator,
    keyNeeded: !!operator && options.operatorSecurityKey && session?.factor !== "passkey",
    owned,
  };
}

/** Refuses whoever is neither an operator nor a workspace owner. */
const requireInstance = (options: InstanceOptions) =>
  createMiddleware<{ Variables: InstanceVariables }>(async (c, next) => {
    const session = await options.auth.api.getSession({ headers: c.req.raw.headers });
    if (!session) throw new HTTPException(401, { message: "Sign in to continue" });
    const access = await instanceAccess(options.db, session.user.id, session.session.id, options);
    if (!access.operator && access.owned.length === 0)
      throw new CodedException(
        403,
        "not_instance",
        "Only operators and workspace owners open this",
      );
    c.set("userId", session.user.id);
    c.set("sessionId", session.session.id);
    c.set("access", access);
    await next();
  });

/** Refuses all but operators, and operators whose session was not signed in with a key. */
const operatorsOnly = createMiddleware<{ Variables: InstanceVariables }>(async (c, next) => {
  const { access } = c.var;
  if (!access.operator)
    throw new CodedException(403, "not_operator", "Only the instance's operators may do this");
  if (access.keyNeeded)
    throw new CodedException(
      403,
      "security_key_required",
      "Operators sign in with a passkey or hardware security key. Sign in again with yours.",
    );
  await next();
});

/** Writes what an operator did, for the Overview and the audit (#157). */
export async function recordInstanceEvent(
  db: Pick<Database, "insert">,
  event: {
    actorId: string | null;
    action: string;
    target?: string | null;
    details?: Record<string, unknown>;
    ipAddress?: string | null;
  },
) {
  await db.insert(schema.instanceEvents).values({
    actorId: event.actorId,
    action: event.action,
    target: event.target ?? null,
    details: event.details ?? null,
    ipAddress: event.ipAddress ?? null,
  });
}

const startOfToday = () => {
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  return day;
};

/** The queue's tables not made yet (a fresh database, before the worker first starts). */
const notYetMade = (error: unknown) => {
  const code = (error as { cause?: { code?: string }; code?: string }).cause?.code;
  return code === "42P01" || code === "3F000";
};

/**
 * Jobs by state, from the queue's own table; a queue not yet created counts as empty, and one
 * that cannot be read is null, so the overview says so rather than showing it idle.
 */
async function queueCounts(db: Database): Promise<InstanceOverview["queue"]> {
  try {
    const rows = await db.execute<{ state: string; n: number; today: number }>(
      sql`select state, count(*)::int as n,
            count(*) filter (where completed_on >= ${startOfToday().toISOString()})::int as today
          from pgboss.job group by state`,
    );
    const of = (state: string) => rows.find((r) => r.state === state);
    return {
      waiting: (of("created")?.n ?? 0) + (of("retry")?.n ?? 0),
      active: of("active")?.n ?? 0,
      failedToday: of("failed")?.today ?? 0,
    };
  } catch (error) {
    if (notYetMade(error)) return { waiting: 0, active: 0, failedToday: 0 };
    console.error("The job queue could not be read:", error);
    return null;
  }
}

/** Which failed today, by kind of job, for "Needs an operator". */
async function failedToday(db: Database) {
  try {
    return await db.execute<{ name: string; n: number }>(
      sql`select name, count(*)::int as n from pgboss.job
          where state = 'failed' and completed_on >= ${startOfToday().toISOString()}
          group by name order by n desc`,
    );
  } catch (error) {
    if (!notYetMade(error)) console.error("The job queue could not be read:", error);
    return [];
  }
}

/** An operator, by their account's id. */
const operatorParam = zValidator("param", operatorParamSchema);

export function instanceRoutes(options: InstanceOptions) {
  const { db } = options;
  return (
    new Hono<{ Variables: InstanceVariables }>()
      .use("*", requireInstance(options))
      .get("/me", (c) => c.json(c.var.access))
      // The workspaces this viewer may see: every one for an operator, their own for an owner.
      .get("/workspaces", async (c) => {
        const { access } = c.var;
        const visible =
          access.operator && !access.keyNeeded ? undefined : access.owned.map((o) => o.id);
        if (visible && visible.length === 0) return c.json({ workspaces: [] });
        const where = visible ? inArray(schema.organisations.id, visible) : undefined;
        const rows = await db
          .select({
            id: schema.organisations.id,
            name: schema.organisations.name,
            slug: schema.organisations.slug,
            createdAt: schema.organisations.createdAt,
          })
          .from(schema.organisations)
          .where(where)
          .orderBy(schema.organisations.name)
          .limit(500);
        const ids = rows.map((r) => r.id);
        const tally = async (
          table: typeof schema.members | typeof schema.projects,
        ): Promise<Map<string, number>> =>
          ids.length === 0
            ? new Map()
            : new Map(
                (
                  await db
                    .select({ id: table.organisationId, n: count() })
                    .from(table)
                    .where(inArray(table.organisationId, ids))
                    .groupBy(table.organisationId)
                ).map((r) => [r.id, r.n]),
              );
        const members = await tally(schema.members);
        const projects = await tally(schema.projects);
        const bytes =
          ids.length === 0
            ? new Map<string, number>()
            : new Map(
                (
                  await db
                    .select({ id: schema.blobs.organisationId, n: sum(schema.blobs.byteSize) })
                    .from(schema.blobs)
                    .where(inArray(schema.blobs.organisationId, ids))
                    .groupBy(schema.blobs.organisationId)
                ).map((r) => [r.id, Number(r.n ?? 0)]),
              );
        return c.json({
          workspaces: rows.map(
            (r): InstanceWorkspace => ({
              id: r.id,
              name: r.name,
              slug: r.slug,
              createdAt: r.createdAt.toISOString(),
              members: members.get(r.id) ?? 0,
              projects: projects.get(r.id) ?? 0,
              storageBytes: bytes.get(r.id) ?? 0,
            }),
          ),
        });
      })
      .use("/overview", operatorsOnly)
      .use("/operators", operatorsOnly)
      .use("/operators/*", operatorsOnly)
      .get("/overview", async (c) => {
        const [[workspaces], [people], [storage], [missing], queue, failed, recent, unkeyed] =
          await Promise.all([
            db.select({ n: count() }).from(schema.organisations),
            db.select({ n: count() }).from(schema.users).where(isNull(schema.users.deletedAt)),
            db.select({ n: sum(schema.blobs.byteSize) }).from(schema.blobs),
            db
              .select({ n: count() })
              .from(schema.storageFindings)
              .where(
                and(
                  eq(schema.storageFindings.kind, "missing_object"),
                  isNull(schema.storageFindings.resolvedAt),
                ),
              ),
            queueCounts(db),
            failedToday(db),
            db
              .select({
                at: schema.instanceEvents.createdAt,
                actor: schema.users.name,
                action: schema.instanceEvents.action,
                target: schema.instanceEvents.target,
              })
              .from(schema.instanceEvents)
              .leftJoin(schema.users, eq(schema.users.id, schema.instanceEvents.actorId))
              .orderBy(desc(schema.instanceEvents.createdAt))
              .limit(8),
            // Operators without a single hardware key: one lost phone from being locked out.
            db
              .select({ name: schema.users.name })
              .from(schema.instanceOperators)
              .innerJoin(schema.users, eq(schema.users.id, schema.instanceOperators.userId))
              .where(
                sql`not exists (select 1 from ${schema.passkeys} where ${schema.passkeys.userId} = ${schema.instanceOperators.userId})`,
              ),
          ]);
        const needs: InstanceOverview["needs"] = [];
        if (!queue)
          needs.push({
            kind: "queue_unreadable",
            title: "The job queue could not be read",
            detail: "Uploads, playback and mail wait on it. The server's log says why.",
          });
        for (const f of failed)
          needs.push({
            kind: "failed_jobs",
            title: `${f.n} ${f.name} job${f.n === 1 ? "" : "s"} failed today`,
            detail: "Retries are spent; the files they were for show as failed.",
          });
        if ((missing?.n ?? 0) > 0)
          needs.push({
            kind: "missing_objects",
            title: `${missing?.n} stored file${missing?.n === 1 ? " is" : "s are"} missing from storage`,
            detail:
              "The reconciliation found records whose bytes are gone. Restore them from a backup.",
          });
        for (const o of unkeyed)
          needs.push({
            kind: "key_missing",
            title: `${o.name} has no passkey or security key`,
            detail: "Operators sign in with one; until they add one they cannot act here.",
          });
        const overview: InstanceOverview = {
          workspaces: workspaces?.n ?? 0,
          people: people?.n ?? 0,
          storageBytes: Number(storage?.n ?? 0),
          queue,
          needs,
          recent: recent.map((r) => ({
            at: r.at.toISOString(),
            actor: r.actor,
            action: r.action,
            target: r.target,
          })),
        };
        return c.json(overview);
      })
      .get("/operators", async (c) => {
        const adder = sql<
          string | null
        >`(select ${schema.users.name} from ${schema.users} where ${schema.users.id} = ${schema.instanceOperators.addedBy})`;
        const rows = await db
          .select({
            userId: schema.instanceOperators.userId,
            name: schema.users.name,
            email: schema.users.email,
            codeApp: schema.users.twoFactorEnabled,
            since: schema.instanceOperators.createdAt,
            addedBy: adder,
          })
          .from(schema.instanceOperators)
          .innerJoin(schema.users, eq(schema.users.id, schema.instanceOperators.userId))
          .orderBy(schema.instanceOperators.createdAt);
        const ids = rows.map((r) => r.userId);
        const keys =
          ids.length === 0
            ? []
            : await db
                .select({
                  userId: schema.passkeys.userId,
                  n: count(),
                  hardware: sql<number>`count(*) filter (where ${schema.passkeys.deviceType} = 'singleDevice')::int`,
                })
                .from(schema.passkeys)
                .where(inArray(schema.passkeys.userId, ids))
                .groupBy(schema.passkeys.userId);
        const seen =
          ids.length === 0
            ? []
            : await db
                .select({
                  userId: schema.authSessions.userId,
                  at: max(schema.authSessions.createdAt),
                })
                .from(schema.authSessions)
                .where(inArray(schema.authSessions.userId, ids))
                .groupBy(schema.authSessions.userId);
        return c.json({
          operators: rows.map((r): OperatorRow => {
            const k = keys.find((x) => x.userId === r.userId);
            const s = seen.find((x) => x.userId === r.userId);
            return {
              userId: r.userId,
              name: r.name,
              email: r.email,
              keys: k?.n ?? 0,
              hardwareKeys: k?.hardware ?? 0,
              codeApp: r.codeApp,
              lastSignInAt: s?.at ? new Date(s.at).toISOString() : null,
              since: r.since.toISOString(),
              addedBy: r.addedBy,
            };
          }),
        });
      })
      // Operators are accounts: an existing one is made an operator by its address.
      .post("/operators", zValidator("json", operatorInput), async (c) => {
        const email = c.req.valid("json").email.toLowerCase();
        const [user] = await db
          .select({ id: schema.users.id, email: schema.users.email })
          .from(schema.users)
          .where(and(eq(schema.users.email, email), isNull(schema.users.deletedAt)));
        if (!user)
          throw new CodedException(
            422,
            "no_account",
            "No account has that address. They need one first: an invitation to a workspace makes it.",
          );
        // The change and its record together: nothing an operator does escapes the events.
        await db.transaction(async (tx) => {
          const added = await tx
            .insert(schema.instanceOperators)
            .values({ userId: user.id, addedBy: c.var.userId })
            .onConflictDoNothing()
            .returning();
          if (added.length === 0)
            throw new CodedException(409, "already_operator", "They are already an operator");
          await recordInstanceEvent(tx, {
            actorId: c.var.userId,
            action: "operator.added",
            target: user.email,
            ipAddress: requestInfo(c, options.trustProxy).ipAddress ?? null,
          });
        });
        return c.json({ added: user.id }, 201);
      })
      // The last operator stays: removing them would leave nobody able to manage the instance.
      .delete("/operators/:userId", operatorParam, async (c) => {
        const { userId } = c.req.valid("param");
        await db.transaction(async (tx) => {
          const all = await tx
            .select({ userId: schema.instanceOperators.userId })
            .from(schema.instanceOperators)
            .for("update");
          if (!all.some((o) => o.userId === userId))
            throw new HTTPException(404, { message: "Operator not found" });
          if (all.length === 1)
            throw new CodedException(
              409,
              "last_operator",
              "The instance needs an operator. Make someone else one first.",
            );
          const [user] = await tx
            .select({ email: schema.users.email })
            .from(schema.users)
            .where(eq(schema.users.id, userId));
          await tx
            .delete(schema.instanceOperators)
            .where(eq(schema.instanceOperators.userId, userId));
          await recordInstanceEvent(tx, {
            actorId: c.var.userId,
            action: "operator.removed",
            target: user?.email ?? null,
            ipAddress: requestInfo(c, options.trustProxy).ipAddress ?? null,
          });
        });
        return c.body(null, 204);
      })
      // Every session the operator has ends: for a lost laptop or a key that has gone astray.
      .post("/operators/:userId/sessions/revoke", operatorParam, async (c) => {
        const { userId } = c.req.valid("param");
        const ended = await db.transaction(async (tx) => {
          const [operator] = await tx
            .select({ email: schema.users.email })
            .from(schema.instanceOperators)
            .innerJoin(schema.users, eq(schema.users.id, schema.instanceOperators.userId))
            .where(eq(schema.instanceOperators.userId, userId));
          if (!operator) throw new HTTPException(404, { message: "Operator not found" });
          const gone = await tx
            .delete(schema.authSessions)
            .where(eq(schema.authSessions.userId, userId))
            .returning({ id: schema.authSessions.id });
          await recordInstanceEvent(tx, {
            actorId: c.var.userId,
            action: "operator.sessions_revoked",
            target: operator.email,
            details: { sessions: gone.length },
            ipAddress: requestInfo(c, options.trustProxy).ipAddress ?? null,
          });
          return gone.length;
        });
        return c.json({ ended });
      })
  );
}
