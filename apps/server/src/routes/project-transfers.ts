import { type Database, inOrg, schema } from "@hekate/db";
import {
  acceptanceProblem,
  approvalProblem,
  lapsed,
  mayTakeProjects,
  nameMatches,
  type OrganisationRole,
  type ProjectTransfer,
  readyToMove,
  TRANSFER_TTL_MS,
  type TransferConfirmation,
  type TransferDestination,
  transferConfirmation,
  transferRequestInput,
} from "@hekate/shared";
import type { Backends } from "@hekate/storage";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, inArray, isNull, lte, ne, or, type SQL } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { actorOf, projectAccess } from "../access.ts";
import { confirmIdentity } from "../account-deletion.ts";
import { type Audit, type RequestInfo, requestInfo } from "../audit.ts";
import type { Auth } from "../auth.ts";
import { CodedException, NotFound } from "../errors.ts";
import type { Subdomains } from "../hosts.ts";
import type { Jobs } from "../jobs.ts";
import type { Keyring } from "../keyring.ts";
import type { Mailer } from "../mail.ts";
import { notifyNow } from "../notifications.ts";
import { moveProject } from "../project-transfer.ts";
import type { TenantVariables } from "../tenancy.ts";

const { members, organisations, projectMembers, projectRoles, projects, projectTransfers, users } =
  schema;

const idParam = zValidator("param", z.object({ id: z.uuid() }));

type Transfer = typeof projectTransfers.$inferSelect;

/** A transfer's two workspaces, named in every change to its row, as tenancy asks. */
const sidesOf = (t: Pick<Transfer, "fromOrganisationId" | "toOrganisationId">) =>
  and(
    eq(projectTransfers.fromOrganisationId, t.fromOrganisationId),
    eq(projectTransfers.toOrganisationId, t.toOrganisationId),
  );

export interface TransferDeps {
  db: Database;
  auth: Auth;
  keyring: Keyring;
  backends: Backends;
  jobs: Pick<Jobs, "send">;
  audit: Audit;
  mailer: Mailer;
  publicUrl: string;
  /** Each workspace's own address for the links it sends, with subdomains on (#437). */
  subdomains?: Subdomains | null;
  trustProxy: boolean;
}

/** A workspace's owners and admins: those who may accept a project into it. */
async function takers(db: Database, organisationId: string) {
  const rows = await db
    .select({ userId: members.userId })
    .from(members)
    .where(inOrg(members, organisationId, inArray(members.role, ["owner", "admin"])));
  return rows.map((r) => r.userId);
}

/**
 * Who may approve moving a project out, or withdraw it: the losing workspace's owners and
 * admins, and members whose role in the project may delete it.
 */
async function approvers(db: Database, organisationId: string, projectId: string) {
  const roles = await db
    .select({ userId: projectMembers.userId, permissions: projectRoles.permissions })
    .from(projectMembers)
    .innerJoin(
      projectRoles,
      and(
        eq(projectRoles.id, projectMembers.roleId),
        eq(projectRoles.organisationId, organisationId),
      ),
    )
    .where(inOrg(projectMembers, organisationId, eq(projectMembers.projectId, projectId)));
  const deleting = roles
    .filter((r) => r.permissions.includes("delete_project"))
    .map((r) => r.userId);
  return [...new Set([...(await takers(db, organisationId)), ...deleting])];
}

/** The workspace role someone holds in a workspace, or null when they are not a member. */
async function roleIn(db: Database, organisationId: string, userId: string) {
  const [row] = await db
    .select({ role: members.role })
    .from(members)
    .where(inOrg(members, organisationId, eq(members.userId, userId)));
  return (row?.role ?? null) as OrganisationRole | null;
}

const nameOf = async (db: Database, userId: string | null) => {
  if (!userId) return null;
  const [user] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId));
  return user?.name ?? null;
};

/**
 * Confirm a step: the project's name typed, and the person themself at the keyboard (their
 * password, or a sign-in in the last ten minutes for an account without one).
 */
async function confirmStep(
  deps: TransferDeps,
  vars: TenantVariables,
  input: TransferConfirmation,
  projectName: string,
) {
  if (!nameMatches(input.name, projectName))
    throw new CodedException(422, "name_mismatch", "Type the project's name to confirm");
  const confirmed = await confirmIdentity(
    deps.db,
    deps.auth,
    deps.keyring,
    { userId: vars.userId, sessionId: vars.sessionId },
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
}

/**
 * Projects moving between workspaces (#240, decision 136): asked for from the project, approved
 * by a second member of the losing workspace, accepted by an owner or admin of the gaining one,
 * and moved once both have. Someone who is an owner or admin of both moves it at once.
 */
export const projectTransferRoutes = (deps: TransferDeps) => {
  const { db, audit } = deps;

  /** Write a step to both workspaces' logs; the gaining one names the project only by name. */
  const logBoth = async (
    t: Pick<Transfer, "fromOrganisationId" | "toOrganisationId" | "projectId" | "projectName">,
    userId: string,
    action:
      | "project.transfer_request"
      | "project.transfer_approve"
      | "project.transfer_accept"
      | "project.transfer_refuse"
      | "project.transfer_cancel"
      | "project.transfer",
    request: RequestInfo,
    moved = false,
  ) => {
    const who = await audit.member(userId);
    const [from, to] = await Promise.all([
      orgName(t.fromOrganisationId),
      orgName(t.toOrganisationId),
    ]);
    const details = { name: t.projectName, from, to };
    await audit.record(
      t.fromOrganisationId,
      who,
      { action, ...(moved ? {} : { projectId: t.projectId }), details },
      request,
    );
    await audit.record(
      t.toOrganisationId,
      who,
      { action, ...(moved ? { projectId: t.projectId } : {}), details },
      request,
    );
  };

  const orgName = async (id: string) => {
    const [row] = await db
      .select({ name: organisations.name })
      .from(organisations)
      .where(eq(organisations.id, id));
    return row?.name ?? "";
  };

  /** Tell people of a step in their own workspace; a failure to tell never undoes the step. */
  const tell = async (
    organisationId: string,
    recipients: string[],
    actorId: string,
    text: string,
    link: string,
  ) =>
    notifyNow(deps, {
      organisationId,
      kind: "transfer",
      recipients: [...new Set(recipients)].filter((id) => id !== actorId),
      actor: { userId: actorId },
      text,
      link,
    }).catch((error: unknown) =>
      console.warn(`Could not tell of a project transfer: ${String(error)}`),
    );

  /** A transfer that names this workspace on either side, lapsed ones marked as such. */
  const reach = async (organisationId: string, id: string) => {
    const [row] = await db
      .select()
      .from(projectTransfers)
      .where(
        and(
          eq(projectTransfers.id, id),
          or(
            eq(projectTransfers.fromOrganisationId, organisationId),
            eq(projectTransfers.toOrganisationId, organisationId),
          ),
        ),
      );
    if (!row) throw new NotFound("Transfer");
    return expire(row);
  };

  const expire = async (row: Transfer): Promise<Transfer> => {
    const now = new Date();
    if (!lapsed(row, now)) return row;
    await db
      .update(projectTransfers)
      .set({ status: "expired", resolvedAt: now })
      .where(
        and(eq(projectTransfers.id, row.id), sidesOf(row), eq(projectTransfers.status, "pending")),
      );
    return { ...row, status: "expired", resolvedAt: now };
  };

  /** A transfer as the person looking sees it, with what they may do about it now. */
  const view = async (row: Transfer, vars: TenantVariables): Promise<ProjectTransfer> => {
    const losing = vars.organisationId === row.fromOrganisationId;
    const pending = row.status === "pending";
    const access = losing
      ? await projectAccess(db, actorOf(vars), row.projectId).catch(() => null)
      : null;
    const mayDelete = access?.granted.has("delete_project") ?? false;
    const [from, to, requestedBy, approvedBy, acceptedBy] = await Promise.all([
      orgName(row.fromOrganisationId),
      orgName(row.toOrganisationId),
      nameOf(db, row.requestedBy),
      nameOf(db, row.approvedBy),
      nameOf(db, row.acceptedBy),
    ]);
    return {
      id: row.id,
      project: { id: row.projectId, name: row.projectName },
      from: { id: row.fromOrganisationId, name: from },
      to: { id: row.toOrganisationId, name: to },
      status: row.status,
      requestedBy,
      requestedAt: row.requestedAt.toISOString(),
      approvedBy,
      approvedAt: row.approvedAt?.toISOString() ?? null,
      acceptedBy,
      acceptedAt: row.acceptedAt?.toISOString() ?? null,
      expiresAt: row.expiresAt.toISOString(),
      you: {
        mayApprove: losing && approvalProblem(row, { userId: vars.userId, mayDelete }) === null,
        mayAccept: !losing && acceptanceProblem(row, { role: vars.organisationRole }) === null,
        mayRefuse:
          pending &&
          (losing
            ? mayDelete && row.requestedBy !== vars.userId
            : mayTakeProjects(vars.organisationRole)),
        mayCancel: pending && losing && row.requestedBy === vars.userId,
      },
    };
  };

  /**
   * Move it, once approved and accepted. Claimed first (pending to moving), so two people
   * finishing it at once move it once; a move that fails puts it back to wait.
   */
  const execute = async (
    row: Transfer,
    userId: string,
    request: RequestInfo,
    /** The step that made it ready, undone should the move fail, so it can be taken again. */
    undo: "ask" | "approve" | "accept",
    /** Written once the move has happened, before the move itself: the step that made it ready. */
    first?: () => Promise<void>,
  ) => {
    const id = row.id;
    const scoped = (...conditions: SQL[]) =>
      and(eq(projectTransfers.id, id), sidesOf(row), ...conditions);
    const [claimed] = await db
      .update(projectTransfers)
      .set({ status: "moving" })
      .where(scoped(eq(projectTransfers.status, "pending")))
      .returning();
    if (!claimed || !readyToMove(claimed)) {
      if (claimed)
        await db
          .update(projectTransfers)
          .set({ status: "pending" })
          .where(scoped(eq(projectTransfers.status, "moving")));
      return claimed ?? null;
    }
    try {
      await moveProject(deps, {
        projectId: claimed.projectId,
        from: claimed.fromOrganisationId,
        to: claimed.toOrganisationId,
      });
    } catch (failure) {
      // Nothing moved. A request moved at once ends; a sign-off is taken back, to be given
      // again once whatever stopped it is put right.
      await db
        .update(projectTransfers)
        .set(
          undo === "ask"
            ? { status: "cancelled", resolvedBy: userId, resolvedAt: new Date() }
            : undo === "approve"
              ? { status: "pending", approvedBy: null, approvedAt: null }
              : { status: "pending", acceptedBy: null, acceptedAt: null },
        )
        .where(scoped(eq(projectTransfers.status, "moving")));
      throw failure;
    }
    const [moved] = await db
      .update(projectTransfers)
      .set({ status: "moved", resolvedAt: new Date() })
      .where(scoped())
      .returning();
    await first?.();
    await logBoth(claimed, userId, "project.transfer", request, true);
    const [from, to] = await Promise.all([
      orgName(claimed.fromOrganisationId),
      orgName(claimed.toOrganisationId),
    ]);
    const everyone = [claimed.requestedBy, claimed.approvedBy, claimed.acceptedBy].filter(
      (u): u is string => u !== null,
    );
    await tell(
      claimed.fromOrganisationId,
      [...(await takers(db, claimed.fromOrganisationId)), ...everyone],
      userId,
      `moved ${claimed.projectName} to ${to}`,
      "/settings/transfers",
    );
    await tell(
      claimed.toOrganisationId,
      [...(await takers(db, claimed.toOrganisationId)), ...everyone],
      userId,
      `moved ${claimed.projectName} here from ${from}`,
      `/projects/${claimed.projectId}`,
    );
    return moved ?? null;
  };

  return (
    new Hono<{ Variables: TenantVariables }>()
      // The transfer waiting on a project, for its danger zone.
      .get("/projects/:id/transfer", idParam, async (c) => {
        const access = await projectAccess(db, actorOf(c.var), c.req.valid("param").id);
        if (!access) throw new NotFound("Project");
        const [row] = await db
          .select()
          .from(projectTransfers)
          .where(
            and(
              eq(projectTransfers.fromOrganisationId, c.var.organisationId),
              eq(projectTransfers.projectId, access.projectId),
              inArray(projectTransfers.status, ["pending", "moving"]),
            ),
          );
        const live = row ? await expire(row) : null;
        return c.json({
          transfer: live && live.status !== "expired" ? await view(live, c.var) : null,
        });
      })
      // Where this person may ask to move it: their other workspaces, open to projects.
      .get("/projects/:id/transfer/destinations", idParam, async (c) => {
        const access = await projectAccess(db, actorOf(c.var), c.req.valid("param").id);
        if (!access) throw new NotFound("Project");
        if (!access.granted.has("delete_project"))
          throw new HTTPException(403, {
            message: "Your role in this project does not allow that",
          });
        // The person's own memberships: theirs to list, whichever workspace they are in.
        const rows = await db
          .select({
            id: organisations.id,
            name: organisations.name,
            role: members.role,
            suspendedAt: organisations.suspendedAt,
            deleteAfter: organisations.deleteAfter,
          })
          .from(members)
          .innerJoin(organisations, eq(organisations.id, members.organisationId))
          .where(
            and(eq(members.userId, c.var.userId), ne(members.organisationId, c.var.organisationId)),
          )
          .orderBy(organisations.name);
        const destinations: TransferDestination[] = rows
          .filter((r) => !r.suspendedAt && !r.deleteAfter)
          .map((r) => ({ id: r.id, name: r.name, atOnce: mayTakeProjects(r.role) }));
        return c.json({ destinations });
      })
      // Asked for: moved at once by someone who may take projects there, else left to wait.
      .post(
        "/projects/:id/transfer",
        idParam,
        zValidator("json", transferRequestInput),
        async (c) => {
          const { organisationId, userId } = c.var;
          const input = c.req.valid("json");
          const access = await projectAccess(db, actorOf(c.var), c.req.valid("param").id);
          if (!access) throw new NotFound("Project");
          if (!access.granted.has("delete_project"))
            throw new HTTPException(403, {
              message: "Your role in this project does not allow that",
            });
          const [project] = await db
            .select({ name: projects.name, deletionRequestedAt: projects.deletionRequestedAt })
            .from(projects)
            .where(inOrg(projects, organisationId, eq(projects.id, access.projectId)));
          if (!project) throw new NotFound("Project");
          if (project.deletionRequestedAt)
            throw new HTTPException(409, {
              message: "This project's deletion is asked for; withdraw it first",
            });
          // The gaining workspace: one of the person's own, or another by its address.
          const [gaining] = await db
            .select({
              id: organisations.id,
              suspendedAt: organisations.suspendedAt,
              deleteAfter: organisations.deleteAfter,
            })
            .from(organisations)
            .where(
              "id" in input.to
                ? eq(organisations.id, input.to.id)
                : eq(organisations.slug, input.to.address),
            );
          const role = gaining ? await roleIn(db, gaining.id, userId) : null;
          if (!gaining || ("id" in input.to && role === null)) throw new NotFound("Workspace");
          if (gaining.id === organisationId)
            throw new HTTPException(422, { message: "The project is already in that workspace" });
          if (gaining.suspendedAt || gaining.deleteAfter)
            throw new HTTPException(409, { message: "That workspace cannot take projects now" });
          await confirmStep(deps, c.var, input, project.name);
          const atOnce = mayTakeProjects(role);
          const now = new Date();
          // One that lapsed unread no longer stands in the way.
          await db
            .update(projectTransfers)
            .set({ status: "expired", resolvedAt: now })
            .where(
              and(
                eq(projectTransfers.fromOrganisationId, organisationId),
                eq(projectTransfers.projectId, access.projectId),
                eq(projectTransfers.status, "pending"),
                lte(projectTransfers.expiresAt, now),
              ),
            );
          const [row] = await db
            .insert(projectTransfers)
            .values({
              fromOrganisationId: organisationId,
              toOrganisationId: gaining.id,
              projectId: access.projectId,
              projectName: project.name,
              requestedBy: userId,
              requestedAt: now,
              // Someone who may do both does both, as they confirm.
              ...(atOnce
                ? { approvedBy: userId, approvedAt: now, acceptedBy: userId, acceptedAt: now }
                : {}),
              expiresAt: new Date(now.getTime() + TRANSFER_TTL_MS),
            })
            .onConflictDoNothing()
            .returning();
          if (!row)
            throw new HTTPException(409, {
              message: "A transfer of this project is already waiting",
            });
          const request = requestInfo(c, deps.trustProxy);
          await logBoth(row, userId, "project.transfer_request", request);
          if (atOnce) {
            const moved = await execute(row, userId, request, "ask");
            return c.json({ transfer: moved ? await view(moved, c.var) : null }, 201);
          }
          const to = await orgName(gaining.id);
          await tell(
            organisationId,
            await approvers(db, organisationId, access.projectId),
            userId,
            `asked to move ${project.name} to ${to}`,
            "/settings/transfers",
          );
          await tell(
            gaining.id,
            await takers(db, gaining.id),
            userId,
            `asked to move ${project.name} here from ${await orgName(organisationId)}`,
            "/settings/transfers",
          );
          return c.json({ transfer: await view(row, c.var) }, 201);
        },
      )
      // The transfers naming this workspace: waiting first, then the latest.
      .get("/transfers", async (c) => {
        const { organisationId } = c.var;
        const rows = await db
          .select()
          .from(projectTransfers)
          .where(
            or(
              eq(projectTransfers.fromOrganisationId, organisationId),
              eq(projectTransfers.toOrganisationId, organisationId),
            ),
          )
          .orderBy(desc(projectTransfers.requestedAt))
          .limit(50);
        // Owners and admins see every transfer naming the workspace; anyone else, only those
        // moving out a project they can see, so no project's name reaches someone who cannot.
        const shown = mayTakeProjects(c.var.organisationRole)
          ? rows
          : (
              await Promise.all(
                rows.map(async (r) =>
                  r.fromOrganisationId === organisationId &&
                  (await projectAccess(db, actorOf(c.var), r.projectId))
                    ? r
                    : null,
                ),
              )
            ).filter((r): r is Transfer => r !== null);
        const live = await Promise.all(shown.map(expire));
        const views = await Promise.all(live.map((r) => view(r, c.var)));
        return c.json({
          transfers: [
            ...views.filter((v) => v.status === "pending"),
            ...views.filter((v) => v.status !== "pending"),
          ],
        });
      })
      // Approved by a second member of the losing workspace.
      .post(
        "/transfers/:id/approve",
        idParam,
        zValidator("json", transferConfirmation),
        async (c) => {
          const { organisationId, userId } = c.var;
          const row = await reach(organisationId, c.req.valid("param").id);
          if (row.fromOrganisationId !== organisationId) throw new NotFound("Transfer");
          const access = await projectAccess(db, actorOf(c.var), row.projectId);
          const problem = approvalProblem(row, {
            userId,
            mayDelete: access?.granted.has("delete_project") ?? false,
          });
          if (problem)
            throw new HTTPException(row.status === "pending" ? 403 : 409, { message: problem });
          await confirmStep(deps, c.var, c.req.valid("json"), row.projectName);
          return c.json({ transfer: await step(c, row, "approve") });
        },
      )
      // Accepted by an owner or admin of the gaining workspace.
      .post(
        "/transfers/:id/accept",
        idParam,
        zValidator("json", transferConfirmation),
        async (c) => {
          const { organisationId } = c.var;
          const row = await reach(organisationId, c.req.valid("param").id);
          if (row.toOrganisationId !== organisationId) throw new NotFound("Transfer");
          const problem = acceptanceProblem(row, { role: c.var.organisationRole });
          if (problem)
            throw new HTTPException(row.status === "pending" ? 403 : 409, { message: problem });
          const [gaining] = await db
            .select({
              suspendedAt: organisations.suspendedAt,
              deleteAfter: organisations.deleteAfter,
            })
            .from(organisations)
            .where(eq(organisations.id, organisationId));
          if (gaining?.suspendedAt || gaining?.deleteAfter)
            throw new HTTPException(409, { message: "This workspace cannot take projects now" });
          await confirmStep(deps, c.var, c.req.valid("json"), row.projectName);
          return c.json({ transfer: await step(c, row, "accept") });
        },
      )
      // Refused by either side, or withdrawn by whoever asked.
      .post("/transfers/:id/refuse", idParam, async (c) => {
        const row = await reach(c.var.organisationId, c.req.valid("param").id);
        const seen = await view(row, c.var);
        if (!seen.you.mayRefuse)
          throw new HTTPException(row.status === "pending" ? 403 : 409, {
            message:
              row.status === "pending"
                ? "Your role does not allow refusing this transfer"
                : "This transfer is no longer waiting",
          });
        return c.json({ transfer: await end(c, row, "refused") });
      })
      .delete("/transfers/:id", idParam, async (c) => {
        const row = await reach(c.var.organisationId, c.req.valid("param").id);
        const seen = await view(row, c.var);
        if (!seen.you.mayCancel)
          throw new HTTPException(row.status === "pending" ? 403 : 409, {
            message:
              row.status === "pending"
                ? "Only whoever asked may withdraw it"
                : "This transfer is no longer waiting",
          });
        await end(c, row, "cancelled");
        return c.body(null, 204);
      })
  );

  /** Record an approval or acceptance; the move follows once both are in. */
  async function step(
    c: Context<{ Variables: TenantVariables }>,
    row: Transfer,
    kind: "approve" | "accept",
  ) {
    const { userId } = c.var;
    const now = new Date();
    const [updated] = await db
      .update(projectTransfers)
      .set(
        kind === "approve"
          ? { approvedBy: userId, approvedAt: now }
          : { acceptedBy: userId, acceptedAt: now },
      )
      .where(
        and(
          eq(projectTransfers.id, row.id),
          sidesOf(row),
          eq(projectTransfers.status, "pending"),
          // Claimed once: of two people signing at the same moment, one does.
          kind === "approve"
            ? and(
                eq(projectTransfers.fromOrganisationId, c.var.organisationId),
                isNull(projectTransfers.approvedAt),
              )
            : and(
                eq(projectTransfers.toOrganisationId, c.var.organisationId),
                isNull(projectTransfers.acceptedAt),
              ),
        ),
      )
      .returning();
    if (!updated) throw new HTTPException(409, { message: "This transfer is no longer waiting" });
    const request = requestInfo(c, deps.trustProxy);
    const logStep = () =>
      logBoth(
        updated,
        userId,
        kind === "approve" ? "project.transfer_approve" : "project.transfer_accept",
        request,
      );
    // The last sign-off is written only once the move it starts has happened; one taken back
    // because the move could not happen yet leaves no trace but the refusal.
    if (readyToMove(updated)) {
      const moved = await execute(updated, userId, request, kind, logStep);
      return moved ? view(moved, c.var) : null;
    }
    await logStep();
    const verb = kind === "approve" ? "approved" : "accepted";
    if (updated.requestedBy)
      await tell(
        updated.fromOrganisationId,
        [updated.requestedBy],
        userId,
        `${verb} moving ${updated.projectName}`,
        "/settings/transfers",
      );
    return view(updated, c.var);
  }

  /** Stop it waiting, refused or withdrawn; whoever asked hears, unless it was them. */
  async function end(
    c: Context<{ Variables: TenantVariables }>,
    row: Transfer,
    status: "refused" | "cancelled",
  ) {
    const { userId } = c.var;
    const [ended] = await db
      .update(projectTransfers)
      .set({ status, resolvedBy: userId, resolvedAt: new Date() })
      .where(
        and(eq(projectTransfers.id, row.id), sidesOf(row), eq(projectTransfers.status, "pending")),
      )
      .returning();
    if (!ended) throw new HTTPException(409, { message: "This transfer is no longer waiting" });
    await logBoth(
      ended,
      userId,
      status === "refused" ? "project.transfer_refuse" : "project.transfer_cancel",
      requestInfo(c, deps.trustProxy),
    );
    if (status === "refused" && ended.requestedBy)
      await tell(
        ended.fromOrganisationId,
        [ended.requestedBy],
        userId,
        `refused moving ${ended.projectName}`,
        "/settings/transfers",
      );
    return view(ended, c.var);
  }
};

/**
 * An operator's move (#240): straight from one workspace to another, without approval or
 * acceptance, for when an instance must. A transfer waiting on the project is withdrawn, the
 * move is kept as a transfer already done, and both workspaces' logs and owners hear of it.
 * The caller confirms the operator and the project's name first.
 */
export async function operatorMove(
  deps: Omit<TransferDeps, "auth" | "trustProxy">,
  input: { operatorId: string; projectId: string; from: string; to: string },
  request: RequestInfo,
) {
  const { db, audit } = deps;
  const [project] = await db
    .select({ name: projects.name })
    .from(projects)
    .where(inOrg(projects, input.from, eq(projects.id, input.projectId)));
  if (!project) throw new NotFound("Project");
  const now = new Date();
  await moveProject(deps, { projectId: input.projectId, from: input.from, to: input.to });
  // Only once it has moved: a move refused leaves a transfer waiting on it as it was.
  await db
    .update(projectTransfers)
    .set({ status: "cancelled", resolvedBy: input.operatorId, resolvedAt: new Date() })
    .where(
      and(
        eq(projectTransfers.fromOrganisationId, input.from),
        eq(projectTransfers.projectId, input.projectId),
        inArray(projectTransfers.status, ["pending", "moving"]),
      ),
    );
  await db.insert(projectTransfers).values({
    fromOrganisationId: input.from,
    toOrganisationId: input.to,
    projectId: input.projectId,
    projectName: project.name,
    status: "moved",
    requestedBy: input.operatorId,
    requestedAt: now,
    approvedBy: input.operatorId,
    approvedAt: now,
    acceptedBy: input.operatorId,
    acceptedAt: now,
    resolvedBy: input.operatorId,
    resolvedAt: new Date(),
    expiresAt: now,
  });
  const names = await db
    .select({ id: organisations.id, name: organisations.name })
    .from(organisations)
    .where(inArray(organisations.id, [input.from, input.to]));
  const nameIn = (id: string) => names.find((n) => n.id === id)?.name ?? "";
  const details = {
    name: project.name,
    from: nameIn(input.from),
    to: nameIn(input.to),
    byOperator: true,
  };
  const who = await audit.member(input.operatorId);
  await audit.record(input.from, who, { action: "project.transfer", details }, request);
  await audit.record(
    input.to,
    who,
    { action: "project.transfer", projectId: input.projectId, details },
    request,
  );
  for (const [organisationId, text, link] of [
    [input.from, `moved ${project.name} to ${details.to}`, "/settings/transfers"],
    [input.to, `moved ${project.name} here from ${details.from}`, `/projects/${input.projectId}`],
  ] as const)
    await notifyNow(deps, {
      organisationId,
      kind: "transfer",
      recipients: await takers(db, organisationId),
      actor: { userId: input.operatorId },
      text,
      link,
    }).catch((error: unknown) =>
      console.warn(`Could not tell of an operator's move: ${String(error)}`),
    );
  return details;
}
