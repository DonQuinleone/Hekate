import { type Database, inOrg, schema } from "@hekate/db";
import {
  confirmableAt,
  deletionProblem,
  nameMatches,
  OWNER_DELETION_REASON,
  WORKSPACE_DELETE_GRACE_DAYS,
  type WorkspaceDeletion,
  type WorkspaceExportStarted,
  workspaceDeletionConfirm,
  workspaceExportInput,
} from "@hekate/shared";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { type Audit, requestInfo } from "../audit.ts";
import { type BillingDeps, cancelAtPeriodEnd } from "../billing/billing.ts";
import { CodedException, NotFound } from "../errors.ts";
import {
  ExportRefused,
  exportResponse,
  exportsOf,
  exportTicket,
  redeemExportTicket,
  startExport,
  viewOf,
} from "../export/workspace-export.ts";
import { recordInstanceEvent } from "../instance-events.ts";
import type { Jobs } from "../jobs.ts";
import type { Mailer } from "../mail.ts";
import { notifyNow } from "../notifications.ts";
import { zValidator } from "../openapi/validator.ts";
import { admit, tooMany } from "../rate-limit.ts";
import type { Storage } from "../storage.ts";
import { requireRole, type TenantVariables } from "../tenancy.ts";

const { members, organisations, users } = schema;

export interface LifecycleDeps {
  db: Database;
  storage: Storage;
  audit: Audit;
  jobs: Pick<Jobs, "send">;
  mailer: Mailer;
  publicUrl: string;
  trustProxy: boolean;
  billing: BillingDeps;
}

const idParam = zValidator("param", z.object({ id: z.uuid() }));
const tokenParam = zValidator("param", z.object({ token: z.string().min(20).max(100) }));

/** Download links for exports one person may ask for in an hour. */
const LINKS_PER_HOUR = 20;

/** An export refused, as the API says it. */
export function refusal(error: unknown): never {
  if (error instanceof ExportRefused) {
    if (error.status === 404) throw new NotFound("Export");
    throw new HTTPException(error.status, { message: error.message });
  }
  throw error;
}

/** The archive, sent once the access log has its download: nothing leaves before the record. */
export async function sendExport(
  deps: Pick<LifecycleDeps, "db" | "storage" | "audit" | "trustProxy">,
  c: Context,
  row: Awaited<ReturnType<typeof redeemExportTicket>>,
  actor: Parameters<Audit["record"]>[1],
) {
  await deps.audit.record(
    row.organisationId,
    actor,
    {
      action: "organisation.export_download",
      details: { exportId: row.id, bytes: row.byteSize, recipient: row.recipient },
    },
    requestInfo(c, deps.trustProxy),
  );
  return exportResponse(deps.db, deps.storage, row);
}

/**
 * `/api/organisation/exports`: an owner's exports of everything the workspace holds (#186). A
 * new one is encrypted to the owner's own age key, or to one made for it and shown once; it is
 * made in the background, and downloads through a one-time link for this session, logged
 * before its first byte. Open to owners while they are deleting the workspace, too.
 */
export const workspaceExportRoutes = (deps: LifecycleDeps) => {
  const { db, audit } = deps;
  return new Hono<{ Variables: TenantVariables }>()
    .use(requireRole("owner"))
    .get("/", async (c) => c.json({ exports: await exportsOf(db, c.var.organisationId) }))
    .post("/", zValidator("json", workspaceExportInput), async (c) => {
      const { organisationId, userId } = c.var;
      const who = await audit.member(userId);
      const { row, key } = await startExport(
        deps,
        {
          organisationId,
          requestedBy: userId,
          byOperator: false,
          recipient: c.req.valid("json").recipient,
        },
        (tx, exportId, ownKey) =>
          audit.record(
            organisationId,
            who,
            { action: "organisation.export_request", details: { exportId, ownKey } },
            requestInfo(c, deps.trustProxy),
            tx,
          ),
      ).catch(refusal);
      const [me] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId));
      return c.json(
        { export: viewOf(row, me?.name ?? null), key } satisfies WorkspaceExportStarted,
        201,
      );
    })
    .post("/:id/download", idParam, async (c) => {
      const { organisationId, userId, sessionId } = c.var;
      const { allowed, retryAfter } = await admit(db, `export:${userId}`, {
        max: LINKS_PER_HOUR,
        windowMs: 60 * 60_000,
      });
      if (!allowed) return tooMany(c, retryAfter, "Too many downloads this hour; try again later");
      const token = await exportTicket(
        db,
        organisationId,
        c.req.valid("param").id,
        sessionId,
      ).catch(refusal);
      return c.json({ url: `/api/organisation/exports/download/${token}` }, 201);
    })
    .get("/download/:token", tokenParam, async (c) => {
      const { organisationId, userId, sessionId } = c.var;
      const row = await redeemExportTicket(
        db,
        organisationId,
        c.req.valid("param").token,
        sessionId,
      ).catch(refusal);
      return sendExport(deps, c, row, await audit.member(userId));
    });
};

/** The workspace's owners. */
async function ownersOf(db: Pick<Database, "select">, organisationId: string) {
  const rows = await db
    .select({ userId: members.userId })
    .from(members)
    .where(inOrg(members, organisationId, eq(members.role, "owner")));
  return rows.map((r) => r.userId);
}

/** The deletion waiting on the workspace, as this owner sees it, or null when none is. */
export async function workspaceDeletionView(
  db: Database,
  vars: Pick<TenantVariables, "organisationId" | "userId" | "organisationRole">,
): Promise<WorkspaceDeletion | null> {
  const [row] = await db
    .select({
      requestedBy: organisations.deletionRequestedBy,
      requestedAt: organisations.deletionRequestedAt,
      deleteAfter: organisations.deleteAfter,
      reason: organisations.suspendedReason,
    })
    .from(organisations)
    .where(eq(organisations.id, vars.organisationId));
  if (!row?.requestedAt) return null;
  const request = { requestedBy: row.requestedBy, requestedAt: row.requestedAt };
  const [owners, [asker]] = await Promise.all([
    ownersOf(db, vars.organisationId),
    row.requestedBy
      ? db.select({ name: users.name }).from(users).where(eq(users.id, row.requestedBy))
      : Promise.resolve([]),
  ]);
  const confirmer = { userId: vars.userId, role: vars.organisationRole };
  // Confirmed by its owners: suspended for it, with a day it goes.
  const confirmed = row.deleteAfter !== null && row.reason === OWNER_DELETION_REASON;
  return {
    requestedBy: asker?.name ?? null,
    requestedAt: row.requestedAt.toISOString(),
    mayConfirm:
      !confirmed &&
      deletionProblem(request, confirmer, owners.length, new Date(), "workspace") === null,
    mayCancel: vars.organisationRole === "owner",
    confirmableAt: confirmed
      ? null
      : (confirmableAt(request, confirmer, owners.length)?.toISOString() ?? null),
    deleteAfter: confirmed ? (row.deleteAfter?.toISOString() ?? null) : null,
  };
}

/**
 * `/api/organisation/deletion`: deleting the workspace, which takes two of its owners (#186), as
 * deleting a project does (#240). One asks; another confirms by typing its name, or, where it
 * has only one owner, they confirm a day after asking. Confirmed, it is suspended at once, as an
 * operator's deletion suspends it, and purged after the same grace period; until then any owner
 * can keep it, which opens it again, and export it.
 */
export const workspaceDeletionRoutes = (deps: LifecycleDeps) => {
  const { db, audit } = deps;
  const request = (c: Context) => requestInfo(c, deps.trustProxy);
  return (
    new Hono<{ Variables: TenantVariables }>()
      .use(requireRole("owner"))
      .get("/", async (c) => c.json({ deletion: await workspaceDeletionView(db, c.var) }))
      .post("/", async (c) => {
        const { organisationId, userId } = c.var;
        const who = await audit.member(userId);
        const name = await db.transaction(async (tx) => {
          const [row] = await tx
            .select({ name: organisations.name, requestedAt: organisations.deletionRequestedAt })
            .from(organisations)
            .where(eq(organisations.id, organisationId))
            .for("update");
          if (!row) throw new NotFound("Workspace");
          if (row.requestedAt)
            throw new HTTPException(409, {
              message: "This workspace's deletion is already asked for",
            });
          await tx
            .update(organisations)
            .set({ deletionRequestedBy: userId, deletionRequestedAt: new Date() })
            .where(eq(organisations.id, organisationId));
          await audit.record(
            organisationId,
            who,
            { action: "organisation.deletion_request" },
            request(c),
            tx,
          );
          return row.name;
        });
        // The other owners, who could confirm, hear of it.
        const others = (await ownersOf(db, organisationId)).filter((id) => id !== userId);
        await notifyNow(deps, {
          organisationId,
          kind: "deletion_requested",
          recipients: others,
          actor: { userId },
          text: `asked to delete the workspace ${name}`,
          link: "/settings/general",
        }).catch((error: unknown) =>
          console.warn(`Could not tell the owners of a deletion request: ${String(error)}`),
        );
        return c.json({ deletion: await workspaceDeletionView(db, c.var) });
      })
      // Withdrawn before it is confirmed, or the workspace kept during its grace period: it opens
      // again at once. Any owner may.
      .delete("/", async (c) => {
        const { organisationId, userId } = c.var;
        const who = await audit.member(userId);
        await db.transaction(async (tx) => {
          const [row] = await tx
            .select({
              name: organisations.name,
              requestedAt: organisations.deletionRequestedAt,
              reason: organisations.suspendedReason,
              deleteAfter: organisations.deleteAfter,
            })
            .from(organisations)
            .where(eq(organisations.id, organisationId))
            .for("update");
          if (!row?.requestedAt) return;
          const confirmed = row.deleteAfter !== null && row.reason === OWNER_DELETION_REASON;
          await tx
            .update(organisations)
            .set({
              deletionRequestedBy: null,
              deletionRequestedAt: null,
              ...(confirmed ? { suspendedAt: null, suspendedReason: null, deleteAfter: null } : {}),
              updatedAt: new Date(),
            })
            .where(eq(organisations.id, organisationId));
          await audit.record(
            organisationId,
            who,
            { action: "organisation.deletion_cancel", details: { kept: confirmed } },
            request(c),
            tx,
          );
          if (confirmed)
            await recordInstanceEvent(tx, {
              actorId: userId,
              action: "workspace.deletion_cancelled",
              target: row.name,
              details: { organisationId, by: "owner" },
              ipAddress: request(c).ipAddress ?? null,
            });
        });
        return c.body(null, 204);
      })
      .post("/confirm", zValidator("json", workspaceDeletionConfirm), async (c) => {
        const { organisationId, userId, organisationRole } = c.var;
        const owners = await ownersOf(db, organisationId);
        const who = await audit.member(userId);
        const after = await db.transaction(async (tx) => {
          const [row] = await tx
            .select({
              name: organisations.name,
              requestedBy: organisations.deletionRequestedBy,
              requestedAt: organisations.deletionRequestedAt,
              suspendedAt: organisations.suspendedAt,
              deleteAfter: organisations.deleteAfter,
            })
            .from(organisations)
            .where(eq(organisations.id, organisationId))
            .for("update");
          if (!row) throw new NotFound("Workspace");
          if (!row.requestedAt)
            throw new HTTPException(409, { message: "No one has asked to delete this workspace" });
          if (row.suspendedAt || row.deleteAfter)
            throw new HTTPException(409, {
              message: "This workspace's deletion is already confirmed",
            });
          if (!nameMatches(c.req.valid("json").name, row.name))
            throw new CodedException(400, "name_mismatch", `Type ${row.name} to confirm`);
          const problem = deletionProblem(
            row,
            { userId, role: organisationRole },
            owners.length,
            new Date(),
            "workspace",
          );
          if (problem) throw new HTTPException(403, { message: problem });
          const now = new Date();
          const deleteAfter = new Date(now.getTime() + WORKSPACE_DELETE_GRACE_DAYS * 86_400_000);
          await tx
            .update(organisations)
            .set({
              suspendedAt: now,
              suspendedReason: OWNER_DELETION_REASON,
              deleteAfter,
              updatedAt: now,
            })
            .where(eq(organisations.id, organisationId));
          await audit.record(
            organisationId,
            who,
            {
              action: "organisation.deletion_confirm",
              details: { deleteAfter: deleteAfter.toISOString() },
            },
            request(c),
            tx,
          );
          // The operators see it among their workspaces' events, as one of their own deletions.
          await recordInstanceEvent(tx, {
            actorId: userId,
            action: "workspace.deletion_scheduled",
            target: row.name,
            details: { organisationId, deleteAfter: deleteAfter.toISOString(), by: "owner" },
            ipAddress: request(c).ipAddress ?? null,
          });
          return deleteAfter;
        });
        // Nothing more is charged for a workspace on its way out: its subscription ends with the
        // period paid for, as cancelling it in Billing would (#179), and can be kept there.
        if (deps.billing.gateway)
          await cancelAtPeriodEnd(deps.billing, organisationId, true).catch((error: unknown) => {
            if (!(error instanceof CodedException && error.code === "not_subscribed"))
              console.warn(`Could not cancel the subscription of a deleted workspace: ${error}`);
          });
        return c.json({ deleteAfter: after.toISOString() });
      })
  );
};
