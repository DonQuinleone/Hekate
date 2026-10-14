import { type Database, inOrg, schema } from "@hekate/db";
import {
  canMoveFolder,
  createFolderInput,
  descendantsOf,
  updateFileInput,
  updateFolderInput,
} from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { and, asc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { type Actor, actorOf, can, canOnFile, type MemberActor } from "../access.ts";
import { type Audit, requestInfo } from "../audit.ts";
import { NotFound } from "../errors.ts";
import type { ViewerVariables } from "../guests.ts";
import type { TenantVariables } from "../tenancy.ts";

const { folders, files, projects, variations, versions, tracks, reviewItems, reviews } = schema;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const idParam = zValidator("param", z.object({ id: z.uuid() }));

/** True when a statement failed on the named unique constraint. */
function violates(error: unknown, constraint: string): boolean {
  const cause = (error as { cause?: { code?: string; constraint_name?: string } }).cause;
  return cause?.code === "23505" && cause.constraint_name === constraint;
}
const nameTaken = () =>
  new HTTPException(409, { message: "There is already a folder with that name here" });

/** Guests reach files through reviews; organising them is for members. */
function memberOnly(actor: Actor): MemberActor {
  if (actor.kind === "guest") {
    throw new HTTPException(403, { message: "Guests cannot organise files" });
  }
  return actor;
}

/** A project's folders, every level, in name order. */
function foldersOf(db: Database | Tx, organisationId: string, projectId: string) {
  return db
    .select({ id: folders.id, parentId: folders.parentId, name: folders.name })
    .from(folders)
    .where(inOrg(folders, organisationId, eq(folders.projectId, projectId)))
    .orderBy(asc(folders.name));
}

/**
 * Serialise changes to one project's folders: two moves at once could otherwise each pass
 * the cycle check and together make a loop.
 */
async function lockProject(tx: Tx, organisationId: string, projectId: string) {
  await tx
    .select({ id: projects.id })
    .from(projects)
    .where(inOrg(projects, organisationId, eq(projects.id, projectId)))
    .for("update");
}

/** A folder of this project, or 422: ids from elsewhere are not places to put things. */
async function folderIn(db: Database | Tx, organisationId: string, projectId: string, id: string) {
  const [folder] = await db
    .select({ id: folders.id })
    .from(folders)
    .where(inOrg(folders, organisationId, eq(folders.id, id), eq(folders.projectId, projectId)));
  if (!folder) throw new HTTPException(422, { message: "That folder is not in this project" });
  return folder;
}

/** `/api/projects/:id/folders`: a project's folders, and making one. */
export const projectFolderRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
    .get("/:id/folders", idParam, async (c) => {
      const { projectId } = await can(db, actorOf(c.var), "view", c.req.valid("param").id);
      return c.json({ folders: await foldersOf(db, c.var.organisationId, projectId) });
    })
    .post("/:id/folders", idParam, zValidator("json", createFolderInput), async (c) => {
      const actor = actorOf(c.var);
      const { projectId } = await can(db, actor, "organise", c.req.valid("param").id);
      const input = c.req.valid("json");
      const folder = await db
        .transaction(async (tx) => {
          await lockProject(tx, actor.organisationId, projectId);
          if (input.parentId) await folderIn(tx, actor.organisationId, projectId, input.parentId);
          const [row] = await tx
            .insert(folders)
            .values({
              organisationId: actor.organisationId,
              projectId,
              parentId: input.parentId ?? null,
              name: input.name,
            })
            .returning({ id: folders.id, parentId: folders.parentId, name: folders.name });
          return row;
        })
        .catch((error: unknown) => {
          throw violates(error, "folders_sibling_name") ? nameTaken() : error;
        });
      return c.json({ folder }, 201);
    });

/** `/api/folders/:id`: renaming, moving and deleting a folder. */
export const folderRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
    .patch("/:id", idParam, zValidator("json", updateFolderInput), async (c) => {
      const actor = actorOf(c.var);
      const input = c.req.valid("json");
      const [found] = await db
        .select({ projectId: folders.projectId })
        .from(folders)
        .where(inOrg(folders, actor.organisationId, eq(folders.id, c.req.valid("param").id)));
      if (!found) throw new NotFound("Folder");
      const { projectId } = await can(db, actor, "organise", found.projectId);
      const folder = await db
        .transaction(async (tx) => {
          await lockProject(tx, actor.organisationId, projectId);
          const all = await foldersOf(tx, actor.organisationId, projectId);
          const id = c.req.valid("param").id;
          if (!all.some((f) => f.id === id)) throw new NotFound("Folder");
          if (input.parentId !== undefined) {
            if (input.parentId) await folderIn(tx, actor.organisationId, projectId, input.parentId);
            if (!canMoveFolder(all, id, input.parentId)) {
              throw new HTTPException(422, {
                message: "A folder cannot go inside itself or one of its own folders",
              });
            }
          }
          const [row] = await tx
            .update(folders)
            .set({
              ...(input.name !== undefined ? { name: input.name } : {}),
              ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
              updatedAt: new Date(),
            })
            .where(inOrg(folders, actor.organisationId, eq(folders.id, id)))
            .returning({ id: folders.id, parentId: folders.parentId, name: folders.name });
          return row;
        })
        .catch((error: unknown) => {
          throw violates(error, "folders_sibling_name") ? nameTaken() : error;
        });
      return c.json({ folder });
    })
    // Deleting a folder keeps what was in it: its files, and its folders' files, move up to
    // where the folder was. Only the folders go.
    .delete("/:id", idParam, async (c) => {
      const actor = actorOf(c.var);
      const id = c.req.valid("param").id;
      const [found] = await db
        .select({ projectId: folders.projectId, parentId: folders.parentId })
        .from(folders)
        .where(inOrg(folders, actor.organisationId, eq(folders.id, id)));
      if (!found) throw new NotFound("Folder");
      const { projectId } = await can(db, actor, "organise", found.projectId);
      const moved = await db.transaction(async (tx) => {
        await lockProject(tx, actor.organisationId, projectId);
        const all = await foldersOf(tx, actor.organisationId, projectId);
        const gone = [...descendantsOf(all, id)];
        const [current] = await tx
          .select({ parentId: folders.parentId })
          .from(folders)
          .where(inOrg(folders, actor.organisationId, eq(folders.id, id)));
        if (!current) throw new NotFound("Folder");
        const out = await tx
          .update(files)
          .set({ folderId: current.parentId, updatedAt: new Date() })
          .where(inOrg(files, actor.organisationId, inArray(files.folderId, gone)))
          .returning({ id: files.id });
        await tx
          .update(tracks)
          .set({ folderId: current.parentId, updatedAt: new Date() })
          .where(inOrg(tracks, actor.organisationId, inArray(tracks.folderId, gone)));
        await tx.delete(folders).where(inOrg(folders, actor.organisationId, eq(folders.id, id)));
        return out.length;
      });
      return c.json({ moved });
    });

/**
 * `/api/files/:id`: renaming, moving and deleting a file. Members only, with the project's
 * "organise" permission.
 */
export const fileManageRoutes = (db: Database, audit: Audit, trustProxy: boolean) =>
  new Hono<{ Variables: ViewerVariables }>()
    .patch("/:id", idParam, zValidator("json", updateFileInput), async (c) => {
      const actor = memberOnly(c.var.actor);
      const id = c.req.valid("param").id;
      const { projectId } = await canOnFile(db, actor, "organise", id);
      const input = c.req.valid("json");
      // Under the project lock, so the destination cannot be deleted between check and move.
      const file = await db.transaction(async (tx) => {
        await lockProject(tx, actor.organisationId, projectId);
        if (input.folderId) await folderIn(tx, actor.organisationId, projectId, input.folderId);
        const [row] = await tx
          .update(files)
          .set({
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.folderId !== undefined ? { folderId: input.folderId } : {}),
            updatedAt: new Date(),
          })
          .where(inOrg(files, actor.organisationId, eq(files.id, id)))
          .returning({ id: files.id, name: files.name, folderId: files.folderId });
        return row;
      });
      if (!file) throw new NotFound("File");
      return c.json({ file });
    })
    // A file that is part of a track's version, or under review, stays: removing it would
    // change what reviewers were asked about. Its stored bytes go at the next reconciliation.
    .delete("/:id", idParam, async (c) => {
      const actor = memberOnly(c.var.actor);
      const id = c.req.valid("param").id;
      const { projectId } = await canOnFile(db, actor, "organise", id);
      const who = await audit.member(actor.userId);
      await db.transaction(async (tx) => {
        const [file] = await tx
          .select({ id: files.id, name: files.name })
          .from(files)
          .where(inOrg(files, actor.organisationId, eq(files.id, id)))
          .for("update");
        if (!file) throw new NotFound("File");
        const [variation] = await tx
          .select({ track: tracks.name, version: versions.number })
          .from(variations)
          .innerJoin(
            versions,
            and(
              eq(versions.id, variations.versionId),
              eq(versions.organisationId, actor.organisationId),
            ),
          )
          .innerJoin(
            tracks,
            and(eq(tracks.id, versions.trackId), eq(tracks.organisationId, actor.organisationId)),
          )
          .where(inOrg(variations, actor.organisationId, eq(variations.fileId, id)));
        if (variation) {
          throw new HTTPException(409, {
            message: `This file is in version ${variation.version} of ${variation.track}`,
          });
        }
        const [reviewed] = await tx
          .select({ title: reviews.title })
          .from(reviewItems)
          .innerJoin(reviews, eq(reviews.id, reviewItems.reviewId))
          .where(
            and(
              inOrg(reviewItems, actor.organisationId, eq(reviewItems.fileId, id)),
              eq(reviews.organisationId, actor.organisationId),
            ),
          );
        if (reviewed) {
          throw new HTTPException(409, {
            message: `This file is part of the review "${reviewed.title}"`,
          });
        }
        await tx.delete(files).where(inOrg(files, actor.organisationId, eq(files.id, id)));
        await audit.record(
          actor.organisationId,
          who,
          { action: "file.delete", projectId, details: { fileId: id, name: file.name } },
          requestInfo(c, trustProxy),
          tx,
        );
      });
      return c.body(null, 204);
    });
