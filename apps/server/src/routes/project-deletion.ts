import { type Database, inOrg, schema } from "@hekate/db";
import {
  confirmableAt,
  DELETION_GRACE_MS,
  deletionProblem,
  type ProjectDeletion,
} from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { actorOf, projectAccess } from "../access.ts";
import { type Audit, requestInfo } from "../audit.ts";
import { NotFound } from "../errors.ts";
import type { Mailer } from "../mail.ts";
import { notifyNow } from "../notifications.ts";
import type { TenantVariables } from "../tenancy.ts";

const { members, projects, reviews, users } = schema;

const idParam = zValidator("param", z.object({ id: z.uuid() }));

/** The workspace's owners, who may confirm a deletion. */
async function ownersOf(db: Pick<Database, "select">, organisationId: string) {
  const rows = await db
    .select({ userId: members.userId })
    .from(members)
    .where(inOrg(members, organisationId, eq(members.role, "owner")));
  return rows.map((r) => r.userId);
}

/**
 * The deletion waiting on a project, as the person looking sees it (#240), or null when none
 * is: who asked and when, whether they may confirm or withdraw it, and, once confirmed, when
 * it goes for good.
 */
export async function deletionView(
  db: Database,
  vars: TenantVariables,
  project: {
    deletionRequestedBy: string | null;
    deletionRequestedAt: Date | null;
    deleteAfter: Date | null;
  },
  mayDelete: boolean,
): Promise<ProjectDeletion | null> {
  if (!project.deletionRequestedAt) return null;
  const request = {
    requestedBy: project.deletionRequestedBy,
    requestedAt: project.deletionRequestedAt,
  };
  const [owners, [asker]] = await Promise.all([
    ownersOf(db, vars.organisationId),
    request.requestedBy
      ? db.select({ name: users.name }).from(users).where(eq(users.id, request.requestedBy))
      : Promise.resolve([]),
  ]);
  const confirmer = { userId: vars.userId, role: vars.organisationRole };
  const confirmed = project.deleteAfter !== null;
  return {
    requestedBy: asker?.name ?? null,
    requestedAt: request.requestedAt.toISOString(),
    mayConfirm:
      !confirmed && deletionProblem(request, confirmer, owners.length, new Date()) === null,
    mayCancel: mayDelete || vars.userId === request.requestedBy,
    confirmableAt: confirmed
      ? null
      : (confirmableAt(request, confirmer, owners.length)?.toISOString() ?? null),
    deleteAfter: project.deleteAfter?.toISOString() ?? null,
  };
}

/**
 * `/api/projects/:id/deletion`: deleting a project, which takes two people (#240). Someone
 * whose role may delete it asks; a workspace owner other than them confirms. It is then
 * archived, read-only, and goes for good seven days later (see `purgeDueProjects`), unless
 * someone keeps it meanwhile.
 */
export const projectDeletionRoutes = (deps: {
  db: Database;
  audit: Audit;
  trustProxy: boolean;
  mailer: Mailer;
  publicUrl: string;
}) => {
  const { db, audit } = deps;
  /** The project, as this member reaches it; 404 for one they cannot see. */
  const reach = async (vars: TenantVariables, id: string) => {
    const access = await projectAccess(db, actorOf(vars), id);
    if (!access) throw new NotFound("Project");
    return access;
  };
  return (
    new Hono<{ Variables: TenantVariables }>()
      .post("/:id/deletion", idParam, async (c) => {
        const { organisationId, userId } = c.var;
        const access = await reach(c.var, c.req.valid("param").id);
        if (!access.granted.has("delete_project")) {
          throw new HTTPException(403, {
            message: "Your role in this project does not allow that",
          });
        }
        const who = await audit.member(userId);
        const name = await db.transaction(async (tx) => {
          const [project] = await tx
            .select({ name: projects.name, requestedAt: projects.deletionRequestedAt })
            .from(projects)
            .where(inOrg(projects, organisationId, eq(projects.id, access.projectId)))
            .for("update");
          if (!project) throw new NotFound("Project");
          if (project.requestedAt) {
            throw new HTTPException(409, {
              message: "This project's deletion is already asked for",
            });
          }
          await tx
            .update(projects)
            .set({ deletionRequestedBy: userId, deletionRequestedAt: new Date() })
            .where(inOrg(projects, organisationId, eq(projects.id, access.projectId)));
          await audit.record(
            organisationId,
            who,
            { action: "project.deletion_request", projectId: access.projectId },
            requestInfo(c, deps.trustProxy),
            tx,
          );
          return project.name;
        });
        // The owners who could confirm hear of it; the one who asked needs no telling.
        const owners = (await ownersOf(db, organisationId)).filter((id) => id !== userId);
        await notifyNow(deps, {
          organisationId,
          kind: "deletion_requested",
          recipients: owners,
          actor: { userId },
          projectId: access.projectId,
          text: `asked to delete ${name}`,
          link: `/projects/${access.projectId}/settings`,
        }).catch((error: unknown) =>
          console.warn(`Could not tell the owners of a deletion request: ${String(error)}`),
        );
        const [project] = await db
          .select()
          .from(projects)
          .where(inOrg(projects, organisationId, eq(projects.id, access.projectId)));
        return c.json({
          deletion: project ? await deletionView(db, c.var, project, true) : null,
        });
      })
      // Withdrawn, or the project kept during its seven days, by whoever asked or by anyone
      // whose role may delete it. A project kept stays archived until someone unarchives it.
      .delete("/:id/deletion", idParam, async (c) => {
        const { organisationId, userId } = c.var;
        const access = await reach(c.var, c.req.valid("param").id);
        const who = await audit.member(userId);
        await db.transaction(async (tx) => {
          const [project] = await tx
            .select({
              requestedBy: projects.deletionRequestedBy,
              requestedAt: projects.deletionRequestedAt,
            })
            .from(projects)
            .where(inOrg(projects, organisationId, eq(projects.id, access.projectId)))
            .for("update");
          if (!project?.requestedAt) return;
          if (!access.granted.has("delete_project") && project.requestedBy !== userId) {
            throw new HTTPException(403, {
              message: "Your role in this project does not allow that",
            });
          }
          await tx
            .update(projects)
            .set({ deletionRequestedBy: null, deletionRequestedAt: null, deleteAfter: null })
            .where(inOrg(projects, organisationId, eq(projects.id, access.projectId)));
          await audit.record(
            organisationId,
            who,
            { action: "project.deletion_cancel", projectId: access.projectId },
            requestInfo(c, deps.trustProxy),
            tx,
          );
        });
        return c.body(null, 204);
      })
      // A workspace owner other than the one who asked confirms: the project is archived at
      // once, its open reviews closing, and goes for good seven days later.
      .post("/:id/deletion/confirm", idParam, async (c) => {
        const { organisationId, userId, organisationRole } = c.var;
        const access = await reach(c.var, c.req.valid("param").id);
        const owners = await ownersOf(db, organisationId);
        const who = await audit.member(userId);
        const deleteAfter = await db.transaction(async (tx) => {
          // Taken for update, as archiving does, so a review requested meanwhile is closed too.
          const [project] = await tx
            .select({
              requestedBy: projects.deletionRequestedBy,
              requestedAt: projects.deletionRequestedAt,
              deleteAfter: projects.deleteAfter,
              archivedAt: projects.archivedAt,
            })
            .from(projects)
            .where(inOrg(projects, organisationId, eq(projects.id, access.projectId)))
            .for("update");
          if (!project) throw new NotFound("Project");
          if (!project.requestedAt) {
            throw new HTTPException(409, { message: "No one has asked to delete this project" });
          }
          if (project.deleteAfter) {
            throw new HTTPException(409, {
              message: "This project's deletion is already confirmed",
            });
          }
          const problem = deletionProblem(
            project,
            { userId, role: organisationRole },
            owners.length,
            new Date(),
          );
          if (problem) throw new HTTPException(403, { message: problem });
          const now = new Date();
          const after = new Date(now.getTime() + DELETION_GRACE_MS);
          await tx
            .update(projects)
            .set({ deleteAfter: after, archivedAt: project.archivedAt ?? now, updatedAt: now })
            .where(inOrg(projects, organisationId, eq(projects.id, access.projectId)));
          await tx
            .update(reviews)
            .set({ status: "cancelled", completedAt: now, updatedAt: now })
            .where(
              inOrg(
                reviews,
                organisationId,
                eq(reviews.projectId, access.projectId),
                eq(reviews.status, "open"),
              ),
            );
          await audit.record(
            organisationId,
            who,
            {
              action: "project.deletion_confirm",
              projectId: access.projectId,
              details: { deleteAfter: after.toISOString() },
            },
            requestInfo(c, deps.trustProxy),
            tx,
          );
          return after;
        });
        return c.json({ deleteAfter: deleteAfter.toISOString() });
      })
  );
};
