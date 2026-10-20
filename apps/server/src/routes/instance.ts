import { type Database, inOrg, schema } from "@hekate/db";
import {
  type ErrorReport,
  type ErrorReportRow,
  type ErrorSource,
  errorReferenceParam,
  errorReportsQuery,
  flagInput,
  flagParam,
  healthQuery,
  type InspectKind,
  type InstanceAccess,
  type InstanceEnvironment,
  type InstanceMemberRow,
  type InstanceOverview,
  type InstanceProjectRow,
  type InstanceWorkspace,
  type InstanceWorkspaceDetail,
  type InstanceWorkspaceKeys,
  type InstanceWorkspacePage,
  type InstanceWorkspaceSettings,
  type InstanceWorkspaceStorage,
  inspectFileParam,
  inspectReviewParam,
  inspectSessionParam,
  instanceFlags,
  instanceSettingsInput,
  instanceWorkspacesQuery,
  nameMatches,
  newerReleases,
  newWorkspaceInput,
  type OperatorRow,
  operatorInput,
  operatorMoveInput,
  operatorParam as operatorParamSchema,
  settingsChanges,
  suspendWorkspaceInput,
  WORKSPACE_DELETE_GRACE_DAYS,
  workspaceSettingsOf,
  workspaceStateOf,
} from "@hekate/shared";
import type { Backends } from "@hekate/storage";
import { zValidator } from "@hono/zod-validator";
import {
  and,
  count,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNotNull,
  isNull,
  max,
  notInArray,
  or,
  type SQL,
  sql,
  sum,
} from "drizzle-orm";
import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { confirmIdentity } from "../account-deletion.ts";
import { type Audit, requestInfo } from "../audit.ts";
import type { Auth } from "../auth.ts";
import { workspaceEmail } from "../email/templates.ts";
import { CodedException, NotFound } from "../errors.ts";
import { createFlags } from "../flags.ts";
import { inspectFile, inspectReview, inspectSession } from "../inspect.ts";
import type { InstanceSettingsStore } from "../instance-settings.ts";
import { INVITATION_LIFETIME_MS, newInvitationToken } from "../invitation-token.ts";
import { type JobName, type Jobs, jobDefinitions } from "../jobs.ts";
import type { Keyring } from "../keyring.ts";
import { type Mailer, sendEmail } from "../mail.ts";
import { type SystemHealthDeps, systemHealth } from "../system-health.ts";
import { HEKATE_VERSION, systemInformation } from "../system-info.ts";
import { factorStanding, type SecondFactorRule } from "../tenancy.ts";
import { pendingRewrap } from "../workspace-keys.ts";
import { operatorMove } from "./project-transfers.ts";
import { retryFile } from "./retry.ts";

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
  mailer: Mailer;
  publicUrl: string;
  keyring: Keyring;
  jobs: Pick<Jobs, "send">;
  backends: Backends;
  audit: Audit;
  /** The instance's settings (#160), shared with the rest of the server. */
  settings: InstanceSettingsStore;
  /** The build running and whether releases are checked (#158). */
  system: { build: string; checkOn: boolean };
  /** What System health reads (#156). */
  health: SystemHealthDeps;
  /** What the environment sets, shown beside the settings. */
  environment: InstanceEnvironment;
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

/** The columns every error report shows. */
const reportRow = {
  reference: schema.errorReports.reference,
  occurredAt: schema.errorReports.occurredAt,
  source: schema.errorReports.source,
  location: schema.errorReports.location,
  message: schema.errorReports.message,
};
const DAY_MS = 24 * 60 * 60 * 1000;
/** Enough for a bad day; the lookup reaches any reference still kept. */
const ERRORS_LISTED = 200;

/** An operator, by their account's id. */
const operatorParam = zValidator("param", operatorParamSchema);
const idParam = zValidator("param", z.object({ id: z.uuid() }));
const memberAction = zValidator(
  "param",
  z.object({
    id: z.uuid(),
    userId: z.string().min(1).max(64),
    action: z.enum(["sessions", "password-reset", "second-factor"]),
  }),
);

/** The workspaces a viewer may see: undefined for every one (an operator who may act). */
const visibleTo = (access: InstanceAccess) =>
  access.operator && !access.keyNeeded ? undefined : access.owned.map((o) => o.id);

/** The workspace, if this viewer may see it; the same 404 for one that does not exist. */
async function reachable(access: InstanceAccess, id: string) {
  const visible = visibleTo(access);
  if (visible && !visible.includes(id)) throw new NotFound("Workspace");
  return id;
}

/** Throws a 404 for a workspace that does not exist. */
async function workspaceName(db: Pick<Database, "select">, id: string) {
  const [row] = await db
    .select({ name: schema.organisations.name })
    .from(schema.organisations)
    .where(eq(schema.organisations.id, id));
  if (!row) throw new NotFound("Workspace");
  return row.name;
}

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (m) => `\\${m}`);

/** Members, projects and stored bytes of some workspaces, counted at once. */
async function figuresOf(db: Database, ids: string[]) {
  if (ids.length === 0)
    return {
      members: new Map<string, number>(),
      projects: new Map<string, number>(),
      bytes: new Map<string, number>(),
    };
  const tally = async (table: typeof schema.members | typeof schema.projects) =>
    new Map(
      (
        await db
          .select({ id: table.organisationId, n: count() })
          .from(table)
          .where(inArray(table.organisationId, ids))
          .groupBy(table.organisationId)
      ).map((r) => [r.id, r.n]),
    );
  const bytes = new Map(
    (
      await db
        .select({ id: schema.blobs.organisationId, n: sum(schema.blobs.byteSize) })
        .from(schema.blobs)
        .where(inArray(schema.blobs.organisationId, ids))
        .groupBy(schema.blobs.organisationId)
    ).map((r) => [r.id, Number(r.n ?? 0)]),
  );
  return { members: await tally(schema.members), projects: await tally(schema.projects), bytes };
}

function workspaceOf(
  r: {
    id: string;
    name: string;
    slug: string;
    createdAt: Date;
    suspendedAt: Date | null;
    suspendedReason: string | null;
    deleteAfter: Date | null;
  },
  figures: Awaited<ReturnType<typeof figuresOf>>,
): InstanceWorkspace {
  return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    createdAt: r.createdAt.toISOString(),
    state: workspaceStateOf(r),
    suspendedAt: r.suspendedAt?.toISOString() ?? null,
    suspendedReason: r.suspendedReason,
    deleteAfter: r.deleteAfter?.toISOString() ?? null,
    members: figures.members.get(r.id) ?? 0,
    projects: figures.projects.get(r.id) ?? 0,
    storageBytes: figures.bytes.get(r.id) ?? 0,
  };
}

export function instanceRoutes(options: InstanceOptions) {
  const flags = createFlags(options.db);
  /**
   * An operator looked into a workspace: what, and where. The workspace's id is kept beside
   * its name, which can change or be shared by another.
   */
  const inspected = (
    c: Context<{ Variables: InstanceVariables }>,
    kind: InspectKind,
    id: string,
    workspace: { id: string; name: string } | null,
    fallback: string,
  ) =>
    recordInstanceEvent(options.db, {
      actorId: c.var.userId,
      action: "debug.inspected",
      target: workspace?.name ?? fallback,
      details: { kind, id, organisationId: workspace?.id ?? null },
      ipAddress: requestInfo(c, options.trustProxy).ipAddress ?? null,
    });
  const { db } = options;
  return (
    new Hono<{ Variables: InstanceVariables }>()
      .use("*", requireInstance(options))
      .get("/me", (c) => c.json(c.var.access))
      // The workspaces this viewer may see, a page at a time: every one for an operator, their
      // own for an owner. Searched by name or subdomain, filtered by where they stand.
      .get("/workspaces", zValidator("query", instanceWorkspacesQuery), async (c) => {
        const { q, state, after, limit } = c.req.valid("query");
        const visible = visibleTo(c.var.access);
        if (visible && visible.length === 0)
          return c.json({ workspaces: [], total: 0, next: null } satisfies InstanceWorkspacePage);
        const o = schema.organisations;
        const conditions: (SQL | undefined)[] = [
          visible ? inArray(o.id, visible) : undefined,
          q
            ? or(ilike(o.name, `%${escapeLike(q)}%`), ilike(o.slug, `%${escapeLike(q)}%`))
            : undefined,
          state === "suspended" ? isNotNull(o.suspendedAt) : undefined,
          state === "active" ? isNull(o.suspendedAt) : undefined,
        ];
        const [{ total } = { total: 0 }] = await db
          .select({ total: count() })
          .from(o)
          .where(and(...conditions));
        // By name, then id: the page after `after` starts past its name and id.
        const cursor = after
          ? (await db.select({ name: o.name }).from(o).where(eq(o.id, after)))[0]
          : undefined;
        const rows = await db
          .select({
            id: o.id,
            name: o.name,
            slug: o.slug,
            createdAt: o.createdAt,
            suspendedAt: o.suspendedAt,
            suspendedReason: o.suspendedReason,
            deleteAfter: o.deleteAfter,
          })
          .from(o)
          .where(
            and(
              ...conditions,
              cursor && after
                ? or(gt(o.name, cursor.name), and(eq(o.name, cursor.name), gt(o.id, after)))
                : undefined,
            ),
          )
          .orderBy(o.name, o.id)
          .limit(limit + 1);
        const page = rows.slice(0, limit);
        const figures = await figuresOf(
          db,
          page.map((r) => r.id),
        );
        return c.json({
          workspaces: page.map((r) => workspaceOf(r, figures)),
          total,
          next: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
        } satisfies InstanceWorkspacePage);
      })
      // A new workspace: its first owner is invited by address, as any member would be.
      .post("/workspaces", operatorsOnly, zValidator("json", newWorkspaceInput), async (c) => {
        const { name, slug, ownerEmail } = c.req.valid("json");
        const email = ownerEmail.toLowerCase();
        const { token, hash } = newInvitationToken();
        const made = await db.transaction(async (tx) => {
          const [organisation] = await tx
            .insert(schema.organisations)
            .values({ name, slug })
            .onConflictDoNothing({ target: schema.organisations.slug })
            .returning({ id: schema.organisations.id });
          if (!organisation)
            throw new CodedException(409, "slug_taken", "Another workspace has that subdomain");
          await tx.insert(schema.invitations).values({
            organisationId: organisation.id,
            email,
            role: "owner",
            tokenHash: hash,
            invitedBy: c.var.userId,
            expiresAt: new Date(Date.now() + INVITATION_LIFETIME_MS),
          });
          await recordInstanceEvent(tx, {
            actorId: c.var.userId,
            action: "workspace.created",
            target: name,
            details: { organisationId: organisation.id, slug, owner: email },
            ipAddress: requestInfo(c, options.trustProxy).ipAddress ?? null,
          });
          return organisation;
        });
        const [inviter] = await db
          .select({ name: schema.users.name })
          .from(schema.users)
          .where(eq(schema.users.id, c.var.userId));
        const link = `${options.publicUrl.replace(/\/$/, "")}/invite/${token}`;
        // The workspace stands whether or not the mail goes: when it does not, the operator is
        // told, and passes on the link by hand.
        let mailed = true;
        try {
          await sendEmail(
            options.mailer,
            email,
            workspaceEmail(
              "invitation",
              {
                workspace: name,
                inviter: inviter?.name ?? "The instance's operators",
                url: link,
                days: Math.round(INVITATION_LIFETIME_MS / (24 * 60 * 60 * 1000)),
              },
              {},
            ),
          );
        } catch (error) {
          console.error("The invitation to a new workspace's owner was not sent:", error);
          mailed = false;
        }
        return c.json({ id: made.id, link, mailed }, 201);
      })
      // One workspace in figures, for an operator or its own owner.
      .get("/workspaces/:id", idParam, async (c) => {
        const id = await reachable(c.var.access, c.req.valid("param").id);
        const o = schema.organisations;
        const [row] = await db
          .select({
            id: o.id,
            name: o.name,
            slug: o.slug,
            createdAt: o.createdAt,
            suspendedAt: o.suspendedAt,
            suspendedReason: o.suspendedReason,
            deleteAfter: o.deleteAfter,
            settings: o.settings,
          })
          .from(o)
          .where(eq(o.id, id));
        if (!row) throw new NotFound("Workspace");
        const [[guests], [reviews], [sso], invited, recent] = await Promise.all([
          db.select({ n: count() }).from(schema.guests).where(inOrg(schema.guests, id)),
          db
            .select({ n: count() })
            .from(schema.reviews)
            .where(inOrg(schema.reviews, id, eq(schema.reviews.status, "open"))),
          db
            .select({ protocol: schema.ssoProviders.protocol })
            .from(schema.ssoProviders)
            .where(inOrg(schema.ssoProviders, id, eq(schema.ssoProviders.enabled, true))),
          db
            .select({
              email: schema.invitations.email,
              role: schema.invitations.role,
              expiresAt: schema.invitations.expiresAt,
            })
            .from(schema.invitations)
            .where(
              inOrg(
                schema.invitations,
                id,
                isNull(schema.invitations.acceptedAt),
                isNull(schema.invitations.revokedAt),
                gt(schema.invitations.expiresAt, new Date()),
              ),
            )
            .orderBy(desc(schema.invitations.createdAt)),
          // What people did there, without the stream of keys, segments and pages behind playback.
          db
            .select({
              at: schema.accessEvents.occurredAt,
              actor: schema.accessEvents.actorLabel,
              action: schema.accessEvents.action,
            })
            .from(schema.accessEvents)
            .where(
              inOrg(
                schema.accessEvents,
                id,
                notInArray(schema.accessEvents.action, [
                  "stream.key",
                  "stream.session",
                  "stream.segment",
                  "page.render",
                ]),
              ),
            )
            .orderBy(desc(schema.accessEvents.occurredAt))
            .limit(6),
        ]);
        const figures = await figuresOf(db, [id]);
        const detail: InstanceWorkspaceDetail = {
          ...workspaceOf(row, figures),
          guests: guests?.n ?? 0,
          activeReviews: reviews?.n ?? 0,
          signIn: {
            method: sso ? "sso" : "password",
            provider: sso ? sso.protocol.toUpperCase() : null,
            secondFactor: workspaceSettingsOf(row.settings).secondFactor !== "off",
          },
          invited: invited.map((i) => ({ ...i, expiresAt: i.expiresAt.toISOString() })),
          recent: recent.map((r) => ({ at: r.at.toISOString(), actor: r.actor, action: r.action })),
        };
        return c.json(detail);
      })
      // Its members: who they are, their role, when last seen and how they sign in.
      .get("/workspaces/:id/members", idParam, async (c) => {
        const id = await reachable(c.var.access, c.req.valid("param").id);
        const rows = await db
          .select({
            userId: schema.users.id,
            name: schema.users.name,
            email: schema.users.email,
            role: schema.members.role,
            codeApp: schema.users.twoFactorEnabled,
          })
          .from(schema.members)
          .innerJoin(schema.users, eq(schema.users.id, schema.members.userId))
          .where(inOrg(schema.members, id))
          .orderBy(schema.users.name)
          .limit(500);
        const ids = rows.map((r) => r.userId);
        const [keys, seen] =
          ids.length === 0
            ? [[], []]
            : await Promise.all([
                db
                  .select({ userId: schema.passkeys.userId, n: count() })
                  .from(schema.passkeys)
                  .where(inArray(schema.passkeys.userId, ids))
                  .groupBy(schema.passkeys.userId),
                db
                  .select({
                    userId: schema.authSessions.userId,
                    at: max(schema.authSessions.updatedAt),
                  })
                  .from(schema.authSessions)
                  .where(inArray(schema.authSessions.userId, ids))
                  .groupBy(schema.authSessions.userId),
              ]);
        return c.json({
          members: rows.map((r): InstanceMemberRow => {
            const at = seen.find((s) => s.userId === r.userId)?.at;
            return {
              userId: r.userId,
              name: r.name,
              email: r.email,
              role: r.role,
              lastSeenAt: at ? new Date(at).toISOString() : null,
              factor: keys.some((k) => k.userId === r.userId) ? "key" : r.codeApp ? "app" : "none",
            };
          }),
        });
      })
      // Its projects, by name and size only: the content stays the workspace's.
      .get("/workspaces/:id/projects", idParam, async (c) => {
        const id = await reachable(c.var.access, c.req.valid("param").id);
        const p = schema.projects;
        const f = schema.files;
        const r = schema.reviews;
        const [rows, stored, open] = await Promise.all([
          db
            .select({ id: p.id, name: p.name, profile: p.profile, archivedAt: p.archivedAt })
            .from(p)
            .where(inOrg(p, id))
            .orderBy(p.name)
            .limit(500),
          db
            .select({ projectId: f.projectId, files: count(), bytes: sum(schema.blobs.byteSize) })
            .from(f)
            .leftJoin(
              schema.blobs,
              and(eq(schema.blobs.id, f.blobId), eq(schema.blobs.organisationId, id)),
            )
            .where(inOrg(f, id))
            .groupBy(f.projectId),
          db
            .select({ projectId: r.projectId, n: count() })
            .from(r)
            .where(inOrg(r, id, eq(r.status, "open")))
            .groupBy(r.projectId),
        ]);
        return c.json({
          projects: rows.map((row): InstanceProjectRow => {
            const s = stored.find((x) => x.projectId === row.id);
            return {
              id: row.id,
              name: row.name,
              profile: row.profile,
              archived: row.archivedAt !== null,
              files: s?.files ?? 0,
              storageBytes: Number(s?.bytes ?? 0),
              openReviews: open.find((x) => x.projectId === row.id)?.n ?? 0,
            };
          }),
        });
      })
      // Where its bytes are: originals and what was made from them, by backend.
      .get("/workspaces/:id/storage", idParam, async (c) => {
        const id = await reachable(c.var.access, c.req.valid("param").id);
        const b = schema.blobs;
        const [[org], byBackend, [originals], findings] = await Promise.all([
          db
            .select({ backend: schema.organisations.storageBackend })
            .from(schema.organisations)
            .where(eq(schema.organisations.id, id)),
          db
            .select({ name: b.backend, objects: count(), bytes: sum(b.byteSize) })
            .from(b)
            .where(inOrg(b, id))
            .groupBy(b.backend)
            .orderBy(b.backend),
          db
            .select({ bytes: sum(b.byteSize) })
            .from(b)
            .where(
              inOrg(
                b,
                id,
                sql`exists (select 1 from ${schema.files} where ${schema.files.organisationId} = ${id} and ${schema.files.blobId} = ${b.id})`,
              ),
            ),
          db
            .select({ kind: schema.storageFindings.kind, n: count() })
            .from(schema.storageFindings)
            .where(
              and(
                eq(schema.storageFindings.ownerOrganisationId, id),
                isNull(schema.storageFindings.resolvedAt),
              ),
            )
            .groupBy(schema.storageFindings.kind),
        ]);
        if (!org) throw new NotFound("Workspace");
        const total = byBackend.reduce((t, r) => t + Number(r.bytes ?? 0), 0);
        const original = Number(originals?.bytes ?? 0);
        const of = (kind: string) => findings.find((f) => f.kind === kind)?.n ?? 0;
        const storage: InstanceWorkspaceStorage = {
          originalBytes: original,
          derivedBytes: Math.max(0, total - original),
          backend: org.backend ?? options.backends.defaultBackend,
          backendIsDefault: org.backend === null,
          backends: byBackend.map((r) => ({
            name: r.name,
            objects: r.objects,
            bytes: Number(r.bytes ?? 0),
          })),
          findings: { missing: of("missing_object"), orphans: of("orphan_object") },
        };
        return c.json(storage);
      })
      // What its owner sees in its settings, read-only: operators change none of it.
      .get("/workspaces/:id/settings", idParam, async (c) => {
        const id = await reachable(c.var.access, c.req.valid("param").id);
        const [[org], [sso], [directory]] = await Promise.all([
          db
            .select({ settings: schema.organisations.settings })
            .from(schema.organisations)
            .where(eq(schema.organisations.id, id)),
          db
            .select({
              protocol: schema.ssoProviders.protocol,
              enforce: schema.ssoProviders.enforce,
            })
            .from(schema.ssoProviders)
            .where(inOrg(schema.ssoProviders, id, eq(schema.ssoProviders.enabled, true))),
          db
            .select({ enabled: schema.directories.enabled })
            .from(schema.directories)
            .where(inOrg(schema.directories, id)),
        ]);
        if (!org) throw new NotFound("Workspace");
        const w = workspaceSettingsOf(org.settings);
        const settings: InstanceWorkspaceSettings = {
          guestLinkDays: w.guestLinkDays,
          guestVerification: w.guestVerification,
          secondFactor: w.secondFactor,
          securityKeyForAdmins: w.securityKeyForAdmins,
          locale: w.locale,
          defaultProfile: w.defaultProfile,
          sso: sso ? { protocol: sso.protocol.toUpperCase(), enforced: sso.enforce } : null,
          directory: directory?.enabled ?? false,
        };
        return c.json(settings);
      })
      // Its key's versions, and how much an earlier version still wraps.
      .get("/workspaces/:id/keys", idParam, async (c) => {
        const id = await reachable(c.var.access, c.req.valid("param").id);
        await workspaceName(db, id);
        const versions = await db
          .select({
            version: schema.organisationKeys.version,
            createdAt: schema.organisationKeys.createdAt,
          })
          .from(schema.organisationKeys)
          .where(inOrg(schema.organisationKeys, id))
          .orderBy(desc(schema.organisationKeys.version));
        const current = versions[0]?.version ?? null;
        const keys: InstanceWorkspaceKeys = {
          versions: versions.map((v) => ({
            version: v.version,
            createdAt: v.createdAt.toISOString(),
          })),
          current,
          pending: current === null ? 0 : await pendingRewrap(db, id, current),
        };
        return c.json(keys);
      })
      .use("/workspaces/:id/*", operatorsOnly)
      // An operator moves a project to another workspace (#240), without approval or acceptance,
      // confirming it with the project's name and their own password.
      .post(
        "/workspaces/:id/projects/:projectId/move",
        zValidator("param", z.object({ id: z.uuid(), projectId: z.uuid() })),
        zValidator("json", operatorMoveInput),
        async (c) => {
          const { id, projectId } = c.req.valid("param");
          const input = c.req.valid("json");
          const [project] = await db
            .select({ name: schema.projects.name })
            .from(schema.projects)
            .where(inOrg(schema.projects, id, eq(schema.projects.id, projectId)));
          if (!project) throw new NotFound("Project");
          if (!nameMatches(input.name, project.name))
            throw new CodedException(422, "name_mismatch", "Type the project's name to confirm");
          const confirmed = await confirmIdentity(
            db,
            options.auth,
            options.keyring,
            { userId: c.var.userId, sessionId: c.var.sessionId },
            input.password,
          );
          if (confirmed === "sign_in_again")
            throw new CodedException(
              403,
              "sign_in_again",
              "Sign in again, then confirm within ten minutes",
            );
          if (confirmed === "refused")
            throw new CodedException(403, "password_refused", "That password is not right");
          await workspaceName(db, input.to);
          const request = requestInfo(c, options.trustProxy);
          const moved = await operatorMove(
            options,
            { operatorId: c.var.userId, projectId, from: id, to: input.to },
            request,
          );
          await recordInstanceEvent(db, {
            actorId: c.var.userId,
            action: "workspace.project_moved",
            target: moved.name,
            details: { from: id, to: input.to, projectId },
            ipAddress: request.ipAddress ?? null,
          });
          return c.json({ moved: { projectId, to: input.to } });
        },
      )
      // A new version of its key; everything it holds is rewrapped in the background.
      .post("/workspaces/:id/keys/rotate", idParam, async (c) => {
        const { id } = c.req.valid("param");
        const name = await workspaceName(db, id);
        // The new version and its record together.
        const version = await db.transaction(async (tx) => {
          const made = await options.keyring.rotate(id, tx);
          await recordInstanceEvent(tx, {
            actorId: c.var.userId,
            action: "workspace.key_rotated",
            target: name,
            details: { organisationId: id, version: made },
            ipAddress: requestInfo(c, options.trustProxy).ipAddress ?? null,
          });
          return made;
        });
        // Queued once it is committed; should the queue be down, the hourly sweep rewraps it.
        await options.jobs
          .send("organisation-rewrap", { organisationId: id }, { singletonKey: `rewrap:${id}` })
          .catch((error) => console.error("The rewrap could not be queued:", error));
        return c.json({ version });
      })
      // Deleting is for a suspended workspace, and waits out a grace period: until then,
      // reinstating it, or cancelling, keeps everything.
      .post("/workspaces/:id/delete", idParam, async (c) => {
        const { id } = c.req.valid("param");
        const after = new Date(Date.now() + WORKSPACE_DELETE_GRACE_DAYS * 24 * 60 * 60 * 1000);
        await db.transaction(async (tx) => {
          const [row] = await tx
            .update(schema.organisations)
            .set({ deleteAfter: after, updatedAt: new Date() })
            .where(
              and(
                eq(schema.organisations.id, id),
                isNotNull(schema.organisations.suspendedAt),
                isNull(schema.organisations.deleteAfter),
              ),
            )
            .returning({ name: schema.organisations.name });
          if (!row) {
            await workspaceName(tx, id);
            throw new CodedException(
              409,
              "not_deletable",
              "Only a suspended workspace can be deleted, and only once",
            );
          }
          await recordInstanceEvent(tx, {
            actorId: c.var.userId,
            action: "workspace.deletion_scheduled",
            target: row.name,
            details: { organisationId: id, deleteAfter: after.toISOString() },
            ipAddress: requestInfo(c, options.trustProxy).ipAddress ?? null,
          });
        });
        return c.json({ deleteAfter: after.toISOString() });
      })
      .post("/workspaces/:id/delete/cancel", idParam, async (c) => {
        const { id } = c.req.valid("param");
        await db.transaction(async (tx) => {
          const [row] = await tx
            .update(schema.organisations)
            .set({ deleteAfter: null, updatedAt: new Date() })
            .where(
              and(eq(schema.organisations.id, id), isNotNull(schema.organisations.deleteAfter)),
            )
            .returning({ name: schema.organisations.name });
          if (!row) {
            await workspaceName(tx, id);
            throw new CodedException(409, "not_deleting", "It is not set to be deleted");
          }
          await recordInstanceEvent(tx, {
            actorId: c.var.userId,
            action: "workspace.deletion_cancelled",
            target: row.name,
            details: { organisationId: id },
            ipAddress: requestInfo(c, options.trustProxy).ipAddress ?? null,
          });
        });
        return c.body(null, 204);
      })
      // Suspending keeps everything and lets nobody in: members are told why, guests' links stop.
      .post(
        "/workspaces/:id/suspend",
        idParam,
        zValidator("json", suspendWorkspaceInput),
        async (c) => {
          const { id } = c.req.valid("param");
          const { reason } = c.req.valid("json");
          // The change and its record together: nothing an operator does escapes the events.
          await db.transaction(async (tx) => {
            const [row] = await tx
              .update(schema.organisations)
              .set({ suspendedAt: new Date(), suspendedReason: reason, updatedAt: new Date() })
              .where(and(eq(schema.organisations.id, id), isNull(schema.organisations.suspendedAt)))
              .returning({ name: schema.organisations.name });
            if (!row) {
              await workspaceName(tx, id);
              throw new CodedException(409, "already_suspended", "It is already suspended");
            }
            await recordInstanceEvent(tx, {
              actorId: c.var.userId,
              action: "workspace.suspended",
              target: row.name,
              details: { organisationId: id, reason },
              ipAddress: requestInfo(c, options.trustProxy).ipAddress ?? null,
            });
          });
          return c.body(null, 204);
        },
      )
      .post("/workspaces/:id/reinstate", idParam, async (c) => {
        const { id } = c.req.valid("param");
        await db.transaction(async (tx) => {
          const [row] = await tx
            .update(schema.organisations)
            .set({
              suspendedAt: null,
              suspendedReason: null,
              deleteAfter: null,
              updatedAt: new Date(),
            })
            .where(
              and(eq(schema.organisations.id, id), isNotNull(schema.organisations.suspendedAt)),
            )
            .returning({ name: schema.organisations.name });
          if (!row) {
            await workspaceName(tx, id);
            throw new CodedException(409, "not_suspended", "It is not suspended");
          }
          await recordInstanceEvent(tx, {
            actorId: c.var.userId,
            action: "workspace.reinstated",
            target: row.name,
            details: { organisationId: id },
            ipAddress: requestInfo(c, options.trustProxy).ipAddress ?? null,
          });
        });
        return c.body(null, 204);
      })
      // Help for one member: never signing in as them (operators never impersonate), only
      // what they could ask for themselves.
      .post("/workspaces/:id/members/:userId/:action", memberAction, async (c) => {
        const { id, userId, action } = c.req.valid("param");
        const [member] = await db
          .select({ email: schema.users.email })
          .from(schema.members)
          .innerJoin(schema.users, eq(schema.users.id, schema.members.userId))
          .where(inOrg(schema.members, id, eq(schema.members.userId, userId)));
        if (!member) throw new NotFound("Member");
        const event = (details: Record<string, unknown>) => ({
          actorId: c.var.userId,
          action:
            action === "sessions"
              ? "member.sessions_revoked"
              : action === "password-reset"
                ? "member.password_reset"
                : "member.second_factor_reset",
          target: member.email,
          details: { organisationId: id, ...details },
          ipAddress: requestInfo(c, options.trustProxy).ipAddress ?? null,
        });
        if (action === "password-reset") {
          // Mail cannot be undone: it goes first, and is recorded once it has.
          await options.auth.api.requestPasswordResetEmailOTP({ body: { email: member.email } });
          await recordInstanceEvent(db, event({}));
        } else {
          // Each change and its record together.
          await db.transaction(async (tx) => {
            if (action === "sessions") {
              const ended = await tx
                .delete(schema.authSessions)
                .where(eq(schema.authSessions.userId, userId))
                .returning({ id: schema.authSessions.id });
              await recordInstanceEvent(tx, event({ sessions: ended.length }));
              return;
            }
            // Their code app and every passkey go, so they sign in with their password and add
            // one again.
            await tx.delete(schema.twoFactors).where(eq(schema.twoFactors.userId, userId));
            await tx.delete(schema.passkeys).where(eq(schema.passkeys.userId, userId));
            await tx
              .update(schema.users)
              .set({ twoFactorEnabled: false })
              .where(eq(schema.users.id, userId));
            await recordInstanceEvent(tx, event({}));
          });
        }
        return c.body(null, 204);
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
        // A newer release on the operator's channel (#158), when the check is on.
        if (options.system.checkOn) {
          const { channel } = (await options.settings.get()).updates;
          const [checked] = await db.select().from(schema.releaseChecks);
          const [newest] = newerReleases(HEKATE_VERSION, checked?.releases ?? [], channel);
          if (newest)
            needs.push({
              kind: "release_available",
              title: `Release ${newest.version} is out`,
              detail: `This instance runs ${HEKATE_VERSION}. System information has its notes and how to upgrade.`,
            });
        }
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
      .use("/errors", operatorsOnly)
      .use("/errors/*", operatorsOnly)
      // What failed in the last day, by the viewer's clock, newest first (#159).
      .get("/errors", zValidator("query", errorReportsQuery), async (c) => {
        const { since } = c.req.valid("query");
        const rows = await db
          .select({ ...reportRow, workspace: schema.organisations.name })
          .from(schema.errorReports)
          .leftJoin(
            schema.organisations,
            eq(schema.organisations.id, schema.errorReports.organisationId),
          )
          .where(
            gt(
              schema.errorReports.occurredAt,
              since ? new Date(since) : new Date(Date.now() - DAY_MS),
            ),
          )
          .orderBy(desc(schema.errorReports.occurredAt))
          .limit(ERRORS_LISTED);
        const errors: ErrorReportRow[] = rows.map((r) => ({
          ...r,
          source: r.source as ErrorSource,
          occurredAt: r.occurredAt.toISOString(),
        }));
        return c.json({ errors });
      })
      // The whole story behind a reference someone quoted.
      .get("/errors/:reference", zValidator("param", errorReferenceParam), async (c) => {
        const { reference } = c.req.valid("param");
        const [r] = await db
          .select({
            ...reportRow,
            status: schema.errorReports.status,
            stack: schema.errorReports.stack,
            requestId: schema.errorReports.requestId,
            jobId: schema.errorReports.jobId,
            context: schema.errorReports.context,
            workspaceId: schema.errorReports.organisationId,
            workspace: schema.organisations.name,
            whoName: schema.users.name,
            whoEmail: schema.users.email,
          })
          .from(schema.errorReports)
          .leftJoin(
            schema.organisations,
            eq(schema.organisations.id, schema.errorReports.organisationId),
          )
          .leftJoin(schema.users, eq(schema.users.id, schema.errorReports.userId))
          .where(eq(schema.errorReports.reference, reference));
        if (!r) throw new NotFound("Error report");
        const { whoName, whoEmail, ...rest } = r;
        const report: ErrorReport = {
          ...rest,
          source: r.source as ErrorSource,
          occurredAt: r.occurredAt.toISOString(),
          context: (r.context as Record<string, unknown> | null) ?? null,
          who: whoName !== null && whoEmail !== null ? { name: whoName, email: whoEmail } : null,
        };
        return c.json(report);
      })
      // Read-only inspectors (#159). Each look into a workspace is an instance event.
      .use("/inspect/*", operatorsOnly)
      .get("/inspect/file/:id", zValidator("param", inspectFileParam), async (c) => {
        const { id } = c.req.valid("param");
        const found = await inspectFile(db, id);
        if (!found) throw new NotFound("File");
        await inspected(c, "file", id, found.workspace, found.name);
        return c.json(found);
      })
      .get("/inspect/review/:id", zValidator("param", inspectReviewParam), async (c) => {
        const { id } = c.req.valid("param");
        const found = await inspectReview(db, id);
        if (!found) throw new NotFound("Review");
        await inspected(c, "review", id, found.workspace, found.title);
        return c.json(found);
      })
      .get("/inspect/session/:id", zValidator("param", inspectSessionParam), async (c) => {
        const { id } = c.req.valid("param");
        const found = await inspectSession(db, id);
        if (!found) throw new NotFound("Session");
        await inspected(c, "session", id, found.workspace, found.who.email);
        return c.json(found);
      })
      // A job's failure, run again (#159): a file's preparation by its retry plan, any other job
      // with the data it had. Written to the instance's events.
      .post("/errors/:reference/retry", zValidator("param", errorReferenceParam), async (c) => {
        const { reference } = c.req.valid("param");
        const [report] = await db
          .select({
            source: schema.errorReports.source,
            location: schema.errorReports.location,
            context: schema.errorReports.context,
            organisationId: schema.errorReports.organisationId,
          })
          .from(schema.errorReports)
          .where(eq(schema.errorReports.reference, reference));
        if (!report) throw new NotFound("Error report");
        if (report.source !== "worker")
          throw new CodedException(409, "not_a_job", "Only a job's failure can be run again");
        const context = (report.context ?? {}) as Record<string, unknown>;
        let queued: string[];
        if (typeof context.fileId === "string" && report.organisationId) {
          queued = await retryFile(db, options.jobs, report.organisationId, context.fileId);
        } else {
          const name = report.location as JobName;
          const parsed = jobDefinitions[name]?.data.safeParse(context);
          if (!parsed?.success)
            throw new CodedException(409, "not_retryable", "This job cannot be run again");
          // The data is the job's own, checked against its schema; the queue checks it again.
          const id = await options.jobs.send(name, parsed.data as never).catch(() => null);
          if (!id)
            throw new HTTPException(503, { message: "The queue would not take it; try again" });
          queued = [name];
        }
        await recordInstanceEvent(db, {
          actorId: c.var.userId,
          action: "debug.job_retried",
          target: reference,
          details: { jobs: queued, organisationId: report.organisationId },
          ipAddress: requestInfo(c, options.trustProxy).ipAddress ?? null,
        });
        return c.json({ jobs: queued }, 202);
      })
      // System information (#158): what runs, what is newer, and what it runs on.
      .use("/system", operatorsOnly)
      .use("/system/*", operatorsOnly)
      .get("/system", async (c) =>
        c.json(
          await systemInformation(db, {
            backends: options.backends,
            build: options.system.build,
            checkOn: options.system.checkOn,
            channel: (await options.settings.get()).updates.channel,
          }),
        ),
      )
      .post("/system/check", async (c) => {
        if (!options.system.checkOn)
          throw new HTTPException(409, {
            message: "Release checks are off: set HEKATE_UPDATE_CHECK=true to turn them on.",
          });
        await options.jobs.send("release-check", {}, { singletonKey: "release-check" });
        return c.body(null, 202);
      })
      // System health (#156): the machine now, its last hour or day, services and metrics.
      .use("/health", operatorsOnly)
      .get("/health", zValidator("query", healthQuery), async (c) =>
        c.json(await systemHealth(db, c.req.valid("query").range, options.health)),
      )
      // The instance's settings (#160), and what the environment sets beside them.
      .use("/settings", operatorsOnly)
      .get("/settings", async (c) => {
        options.settings.forget();
        return c.json({
          settings: await options.settings.get(),
          environment: options.environment,
        });
      })
      .put("/settings", zValidator("json", instanceSettingsInput), async (c) => {
        const next = c.req.valid("json");
        await db.transaction(async (tx) => {
          const before = await options.settings.write(tx, next, c.var.userId);
          // Every change an instance event, each thing that changed its own.
          for (const change of settingsChanges(before, next))
            await recordInstanceEvent(tx, {
              actorId: c.var.userId,
              action: change.action,
              target: change.action.startsWith("maintenance.")
                ? "Maintenance mode"
                : change.action.startsWith("updates.")
                  ? "The update channel"
                  : "A second factor",
              details: change.details,
              ipAddress: requestInfo(c, options.trustProxy).ipAddress ?? null,
            });
        });
        // Committed: every read from now on is the new settings.
        options.settings.forget();
        return c.json({ settings: await options.settings.get(), environment: options.environment });
      })
      // The instance's flags (#159): read as the server runs, so turning one needs no restart.
      .use("/flags", operatorsOnly)
      .use("/flags/*", operatorsOnly)
      .get("/flags", async (c) => c.json({ flags: await flags.list() }))
      .put(
        "/flags/:key",
        zValidator("param", flagParam),
        zValidator("json", flagInput),
        async (c) => {
          const { key } = c.req.valid("param");
          const { on } = c.req.valid("json");
          await db.transaction(async (tx) => {
            await flags.set(key, on, c.var.userId, tx);
            await recordInstanceEvent(tx, {
              actorId: c.var.userId,
              action: on ? "flag.on" : "flag.off",
              target: instanceFlags[key].label,
              details: { key },
              ipAddress: requestInfo(c, options.trustProxy).ipAddress ?? null,
            });
          });
          return c.json({ flags: await flags.list() });
        },
      )
  );
}
