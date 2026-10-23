import { type Database, inOrg, schema } from "@hekate/db";
import { fileTagsInput, tagInput } from "@hekate/shared";
import { and, asc, count, eq, inArray, notInArray } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { canOnFile, lockLiveProject } from "../access.ts";
import { NotFound } from "../errors.ts";
import type { ViewerVariables } from "../guests.ts";
import { zValidator } from "../openapi/validator.ts";
import { requireRole, type TenantVariables } from "../tenancy.ts";

const { tags, fileTags, files } = schema;

const idParam = zValidator("param", z.object({ id: z.uuid() }));

/** True when a statement failed on the named unique index. */
function violates(error: unknown, constraint: string): boolean {
  const cause = (error as { cause?: { code?: string; constraint_name?: string } }).cause;
  return cause?.code === "23505" && cause.constraint_name === constraint;
}
const nameTaken = () =>
  new HTTPException(409, { message: "There is already a tag with that name" });

/**
 * `/api/tags`: the workspace's tags. Every member sees them and may make one while tagging;
 * renaming and deleting change every project's files, so they are for owners and admins.
 */
export const tagRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
    .get("/", async (c) => {
      const organisationId = c.var.organisationId;
      const rows = await db
        .select({ id: tags.id, name: tags.name, files: count(fileTags.id) })
        .from(tags)
        .leftJoin(
          fileTags,
          and(eq(fileTags.tagId, tags.id), eq(fileTags.organisationId, organisationId)),
        )
        .where(inOrg(tags, organisationId))
        .groupBy(tags.id)
        .orderBy(asc(tags.name));
      return c.json({ tags: rows });
    })
    .post("/", zValidator("json", tagInput), async (c) => {
      const { name } = c.req.valid("json");
      try {
        const [tag] = await db
          .insert(tags)
          .values({ organisationId: c.var.organisationId, name })
          .returning({ id: tags.id, name: tags.name });
        return c.json({ tag: { ...tag, files: 0 } }, 201);
      } catch (error) {
        if (violates(error, "tags_name_idx")) throw nameTaken();
        throw error;
      }
    })
    .patch("/:id", requireRole("admin"), idParam, zValidator("json", tagInput), async (c) => {
      const { name } = c.req.valid("json");
      try {
        const [tag] = await db
          .update(tags)
          .set({ name, updatedAt: new Date() })
          .where(inOrg(tags, c.var.organisationId, eq(tags.id, c.req.valid("param").id)))
          .returning({ id: tags.id, name: tags.name });
        if (!tag) throw new NotFound("Tag");
        return c.json({ tag });
      } catch (error) {
        if (violates(error, "tags_name_idx")) throw nameTaken();
        throw error;
      }
    })
    .delete("/:id", requireRole("admin"), idParam, async (c) => {
      const [tag] = await db
        .delete(tags)
        .where(inOrg(tags, c.var.organisationId, eq(tags.id, c.req.valid("param").id)))
        .returning({ id: tags.id });
      if (!tag) throw new NotFound("Tag");
      return c.body(null, 204);
    });

/**
 * `/api/files/:id/tags`: the tags on a file, set all at once. Members with the project's
 * "organise" permission, and only the workspace's own tags.
 */
export const fileTagRoutes = (db: Database) =>
  new Hono<{ Variables: ViewerVariables }>().put(
    "/:id/tags",
    idParam,
    zValidator("json", fileTagsInput),
    async (c) => {
      const actor = c.var.actor;
      if (actor.kind === "guest") {
        throw new HTTPException(403, { message: "Guests cannot tag files" });
      }
      const fileId = c.req.valid("param").id;
      const { projectId } = await canOnFile(db, actor, "organise", fileId);
      const { tagIds } = c.req.valid("json");
      const organisationId = actor.organisationId;
      const ids = await db.transaction(async (tx) => {
        // The project stays live and the file stays put until the tags are in.
        await lockLiveProject(tx, organisationId, projectId);
        const [file] = await tx
          .select({ id: files.id })
          .from(files)
          .where(inOrg(files, organisationId, eq(files.id, fileId)))
          .for("share");
        if (!file) throw new NotFound("File");
        if (tagIds.length) {
          // Taken FOR SHARE, so a tag cannot be deleted between this check and the insert.
          const known = await tx
            .select({ id: tags.id })
            .from(tags)
            .where(inOrg(tags, organisationId, inArray(tags.id, tagIds)))
            .for("share");
          if (known.length !== tagIds.length) {
            throw new HTTPException(422, { message: "That tag is not in this workspace" });
          }
        }
        await tx
          .delete(fileTags)
          .where(
            inOrg(
              fileTags,
              organisationId,
              eq(fileTags.fileId, fileId),
              tagIds.length ? notInArray(fileTags.tagId, tagIds) : undefined,
            ),
          );
        if (tagIds.length) {
          await tx
            .insert(fileTags)
            .values(tagIds.map((tagId) => ({ organisationId, fileId, tagId })))
            .onConflictDoNothing();
        }
        return tagIds;
      });
      return c.json({ tagIds: ids });
    },
  );
