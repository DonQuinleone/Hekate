import { type Database, inOrg, schema } from "@hekate/db";
import {
  createProjectInput,
  creatorRole,
  defaultProjectRoles,
  type ProjectProfile,
  permissionsFor,
  playerTools,
  projectListQuery,
  projectPermissions,
  referencesOf,
  updateProjectInput,
  workspaceSettingsOf,
} from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { actorOf, can, projectAccess, visibleProjects } from "../access.ts";
import { type Audit, requestInfo } from "../audit.ts";
import { assertProfileRef } from "../delivery-profiles.ts";
import { NotFound } from "../errors.ts";
import { projectFigures } from "../project-figures.ts";
import type { TenantVariables } from "../tenancy.ts";
import { categoriesOf, seedCategories } from "./categories.ts";
import { copyCategories, templateFor } from "./templates.ts";

const { projects, files, users, projectRoles, projectMembers, reviews } = schema;

/** A project as it leaves the server: its comment references read, its profile's if unset. */
function shown<P extends { commentReferences: unknown; profile: ProjectProfile }>(project: P) {
  const { commentReferences, ...rest } = project;
  return { ...rest, references: referencesOf(commentReferences, project.profile) };
}

const idParam = zValidator("param", z.object({ id: z.uuid() }));

export const projectRoutes = (db: Database, audit: Audit, trustProxy: boolean) =>
  new Hono<{ Variables: TenantVariables }>()
    // The projects this member may see: those in use, or (`archived=1`) those archived. With
    // `figures=1`, each carries what its card shows. Each says whether it is one of yours and
    // whether you may archive or unarchive it.
    .get("/", zValidator("query", projectListQuery), async (c) => {
      const { archived, figures } = c.req.valid("query");
      const { organisationId, userId, organisationRole } = c.var;
      const rows = await db
        .select({
          project: projects,
          memberId: projectMembers.id,
          rolePermissions: projectRoles.permissions,
        })
        .from(projects)
        .leftJoin(
          projectMembers,
          and(
            eq(projectMembers.projectId, projects.id),
            eq(projectMembers.organisationId, organisationId),
            eq(projectMembers.userId, userId),
          ),
        )
        .leftJoin(
          projectRoles,
          and(
            eq(projectRoles.id, projectMembers.roleId),
            eq(projectRoles.organisationId, organisationId),
          ),
        )
        .where(
          inOrg(
            projects,
            organisationId,
            archived ? isNotNull(projects.archivedAt) : isNull(projects.archivedAt),
            visibleProjects(actorOf(c.var)),
          ),
        )
        .orderBy(desc(projects.createdAt));
      const list = rows.map((r) => ({
        ...shown(r.project),
        mine: r.memberId !== null,
        // Archiving is part of running the project: whoever manages its roles and members.
        mayArchive: permissionsFor(organisationRole, r.rolePermissions).has("delete_project"),
      }));
      if (!figures || list.length === 0) return c.json({ projects: list });
      const counted = await projectFigures(
        db,
        organisationId,
        list.map((p) => p.id),
      );
      return c.json({
        projects: list.map((p) => {
          const { lastFileAt, ...rest } = counted.of(p.id);
          return { ...p, figures: { ...rest, lastActiveAt: lastFileAt ?? p.createdAt } };
        }),
      });
    })
    // Any member may start a project. It comes with the default roles, or a template's, and its
    // creator is its first Producer.
    .post("/", zValidator("json", createProjectInput), async (c) => {
      const { templateId, savedTemplateId, ...input } = c.req.valid("json");
      const organisationId = c.var.organisationId;
      // A template must be a project the creator can see; its settings and roles are copied,
      // never its content.
      const template = templateId
        ? await (async () => {
            const access = await can(db, actorOf(c.var), "view", templateId);
            const [settings] = await db
              .select({
                carriedCommentsShown: projects.carriedCommentsShown,
                deliveryProfile: projects.deliveryProfile,
                checkTruePeak: projects.checkTruePeak,
                requireEdl: projects.requireEdl,
                qaSettings: projects.qaSettings,
                commentReferences: projects.commentReferences,
                normalisation: projects.normalisation,
              })
              .from(projects)
              .where(inOrg(projects, organisationId, eq(projects.id, access.projectId)));
            const roles = await db
              .select({
                name: projectRoles.name,
                permissions: projectRoles.permissions,
                tools: projectRoles.tools,
              })
              .from(projectRoles)
              .where(
                inOrg(projectRoles, organisationId, eq(projectRoles.projectId, access.projectId)),
              )
              .orderBy(asc(projectRoles.position));
            const categories = (await categoriesOf(db, organisationId, access.projectId)).map(
              (k) => ({ name: k.name, handling: k.handling, stage: k.stage }),
            );
            return { settings, roles, categories };
          })()
        : savedTemplateId
          ? // A saved template (#240): its copy of a project's set-up.
            await db.transaction((tx) => templateFor(tx, organisationId, savedTemplateId))
          : null;
      const roles = template?.roles.length ? template.roles : defaultProjectRoles;
      // Without a template, the workspace's defaults.
      const [workspace] = template
        ? []
        : await db
            .select({ settings: schema.organisations.settings })
            .from(schema.organisations)
            .where(eq(schema.organisations.id, organisationId));
      const defaults = workspace && {
        carriedCommentsShown: workspaceSettingsOf(workspace.settings).carriedCommentsShown,
      };
      const project = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(projects)
          .values({
            ...input,
            description: input.description || null,
            ...defaults,
            ...template?.settings,
            organisationId,
          })
          .returning();
        if (!created) throw new Error("Project insert returned no row");
        // Its comment categories: the template's, else the defaults (#36).
        if (template) await copyCategories(tx, organisationId, created.id, template.categories);
        else await seedCategories(tx, organisationId, created.id);
        const made = await tx
          .insert(projectRoles)
          .values(
            roles.map((role, position) => ({
              organisationId,
              projectId: created.id,
              name: role.name,
              permissions: role.permissions,
              // Roles from before tools per role keep every one (#240).
              tools: role.tools ?? [...playerTools],
              position,
            })),
          )
          .returning({
            id: projectRoles.id,
            name: projectRoles.name,
            permissions: projectRoles.permissions,
          });
        // The creator takes the Producer role, or failing that the first that may run the
        // project; a template without one (a renamed or reduced Producer, say) gains a
        // Producer, so no project is left without someone who can see and run it.
        const runs = (r: { permissions: string[] }) =>
          r.permissions.includes("view") && r.permissions.includes("manage_roles");
        let producer = made.find((r) => r.name === creatorRole && runs(r)) ?? made.find(runs);
        if (!producer) {
          [producer] = await tx
            .insert(projectRoles)
            .values({
              organisationId,
              projectId: created.id,
              // A template may already hold a role by that name that cannot run the project.
              name: made.some((r) => r.name === creatorRole)
                ? `${creatorRole} (creator)`
                : creatorRole,
              permissions: [...projectPermissions],
              position: made.length,
            })
            .returning({
              id: projectRoles.id,
              name: projectRoles.name,
              permissions: projectRoles.permissions,
            });
        }
        if (!producer) throw new Error("No role for the project's creator");
        await tx.insert(projectMembers).values({
          organisationId,
          projectId: created.id,
          userId: c.var.userId,
          roleId: producer.id,
        });
        return created;
      });
      // The creator may do whatever their role allows; a Producer, everything.
      const access = await can(db, actorOf(c.var), "view", project.id);
      return c.json({ project: { ...shown(project), permissions: [...access.permissions] } }, 201);
    })
    // Archiving closes the project's open reviews and makes it read-only; it leaves everyone's
    // lists but keeps everything. Unarchiving makes it whole again (closed reviews stay closed).
    .post("/:id/archive", idParam, async (c) => {
      const project = await mayArchive(db, c.var, c.req.valid("param").id);
      if (project.archived) return c.body(null, 204);
      const who = await audit.member(c.var.userId);
      const now = new Date();
      await db.transaction(async (tx) => {
        // Taken for update, so a review being requested meanwhile (which holds the row for
        // share) either lands first and is closed here, or waits and is refused.
        await tx
          .select({ id: projects.id })
          .from(projects)
          .where(inOrg(projects, c.var.organisationId, eq(projects.id, project.projectId)))
          .for("update");
        await tx
          .update(projects)
          .set({ archivedAt: now, updatedAt: now })
          .where(inOrg(projects, c.var.organisationId, eq(projects.id, project.projectId)));
        await tx
          .update(reviews)
          .set({ status: "cancelled", completedAt: now, updatedAt: now })
          .where(
            inOrg(
              reviews,
              c.var.organisationId,
              eq(reviews.projectId, project.projectId),
              eq(reviews.status, "open"),
            ),
          );
        await audit.record(
          c.var.organisationId,
          who,
          { action: "project.archive", projectId: project.projectId },
          requestInfo(c, trustProxy),
          tx,
        );
      });
      return c.body(null, 204);
    })
    .post("/:id/unarchive", idParam, async (c) => {
      const project = await mayArchive(db, c.var, c.req.valid("param").id);
      if (!project.archived) return c.body(null, 204);
      const who = await audit.member(c.var.userId);
      await db.transaction(async (tx) => {
        await tx
          .update(projects)
          .set({ archivedAt: null, updatedAt: new Date() })
          .where(inOrg(projects, c.var.organisationId, eq(projects.id, project.projectId)));
        await audit.record(
          c.var.organisationId,
          who,
          { action: "project.unarchive", projectId: project.projectId },
          requestInfo(c, trustProxy),
          tx,
        );
      });
      return c.body(null, 204);
    })
    .get("/:id", idParam, async (c) => {
      const access = await can(db, actorOf(c.var), "view", c.req.valid("param").id);
      const [project] = await db
        .select()
        .from(projects)
        .where(inOrg(projects, c.var.organisationId, eq(projects.id, access.projectId)));
      // What the caller may do here, so the interface offers only that (the server still checks),
      // and whether they may archive or unarchive it.
      return c.json({
        project: {
          ...(project && shown(project)),
          permissions: [...access.permissions],
          mayArchive: access.granted.has("delete_project"),
        },
      });
    })
    // The project's settings: its own (name, description, profile, comments) for those who may edit
    // the project; how versions are checked, for those who may edit its workflow.
    .patch("/:id", idParam, zValidator("json", updateProjectInput), async (c) => {
      const input = c.req.valid("json");
      const general =
        input.name !== undefined ||
        input.description !== undefined ||
        input.profile !== undefined ||
        input.carriedCommentsShown !== undefined ||
        input.references !== undefined ||
        input.normalisation !== undefined;
      const workflow =
        input.deliveryProfile !== undefined ||
        input.checkTruePeak !== undefined ||
        input.requireEdl !== undefined ||
        input.qaSettings !== undefined;
      const id = c.req.valid("param").id;
      if (workflow) await can(db, actorOf(c.var), "edit_workflows", id);
      const access = await can(db, actorOf(c.var), general ? "edit_project" : "edit_workflows", id);
      const project = await db.transaction(async (tx) => {
        await assertProfileRef(tx, c.var.organisationId, input.deliveryProfile);
        const { references, ...rest } = input;
        const [row] = await tx
          .update(projects)
          .set({
            ...rest,
            ...(references ? { commentReferences: references } : {}),
            updatedAt: new Date(),
          })
          .where(inOrg(projects, c.var.organisationId, eq(projects.id, access.projectId)))
          .returning();
        return row;
      });
      return c.json({
        project: { ...(project && shown(project)), permissions: [...access.permissions] },
      });
    })
    .get("/:id/files", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const access = await can(db, actorOf(c.var), "view", c.req.valid("param").id);
      const project = { id: access.projectId };
      // Metadata only: file contents leave Hekate solely through protected delivery.
      const rows = await db
        .select({
          id: files.id,
          folderId: files.folderId,
          name: files.name,
          kind: files.kind,
          contentType: files.contentType,
          byteSize: files.byteSize,
          mediaInfo: files.mediaInfo,
          streamStatus: files.streamStatus,
          analysisStatus: files.analysisStatus,
          uploadedBy: users.name,
          uploadedById: users.id,
          createdAt: files.createdAt,
          // Threads on it not yet resolved.
          openComments: sql<number>`(select count(*)::int from comments c
            where c.file_id = ${files.id} and c.organisation_id = ${organisationId}
            and c.parent_id is null and c.resolved_at is null)`,
          tagIds: sql<string[]>`coalesce((select array_agg(ft.tag_id::text order by ft.tag_id)
            from file_tags ft where ft.file_id = ${files.id}
            and ft.organisation_id = ${organisationId}), '{}')`,
        })
        .from(files)
        .leftJoin(users, eq(files.uploadedBy, users.id))
        .where(inOrg(files, organisationId, eq(files.projectId, project.id)))
        .orderBy(asc(files.name), desc(files.createdAt));
      return c.json({ files: rows });
    });

/** The project, if this member may archive or unarchive it: whoever may run it, archived or not. */
async function mayArchive(db: Database, vars: TenantVariables, projectId: string) {
  const access = await projectAccess(db, actorOf(vars), projectId);
  if (!access) throw new NotFound("Project");
  if (!access.granted.has("delete_project")) {
    throw new HTTPException(403, { message: "Your role in this project does not allow that" });
  }
  return access;
}
