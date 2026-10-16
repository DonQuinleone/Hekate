import { type Database, inOrg, schema } from "@hekate/db";
import { type Mark, type MarkKind, markInput } from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { eq, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { actorOf, can } from "../access.ts";
import type { TenantVariables } from "../tenancy.ts";

const { marks, folders, tracks, files } = schema;

const idParam = zValidator("param", z.object({ id: z.uuid() }));

const tables = { folder: folders, track: tracks, file: files } as const;
const columns = { folder: marks.folderId, track: marks.trackId, file: marks.fileId } as const;

/**
 * `/api/projects/:id/marks`: the viewer's own pins, favourites and seen files in a project.
 * Anyone who can see the project marks what is in it for themselves; nobody else sees them.
 */
export const projectMarkRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
    .get("/:id/marks", idParam, async (c) => {
      const { organisationId, userId } = c.var;
      const { projectId } = await can(db, actorOf(c.var), "view", c.req.valid("param").id);
      const rows = await db
        .select()
        .from(marks)
        .where(
          inOrg(marks, organisationId, eq(marks.userId, userId), eq(marks.projectId, projectId)),
        );
      const list: Mark[] = rows.map((m) => ({
        kind: m.fileId ? "file" : m.trackId ? "track" : "folder",
        id: (m.fileId ?? m.trackId ?? m.folderId) as string,
        pinned: m.pinnedAt !== null,
        favourite: m.favouriteAt !== null,
        viewed: m.viewedAt !== null,
      }));
      return c.json({ marks: list });
    })
    .post("/:id/marks", idParam, zValidator("json", markInput), async (c) => {
      const { organisationId, userId } = c.var;
      const { projectId } = await can(db, actorOf(c.var), "view", c.req.valid("param").id);
      const { items, pinned, favourite, viewed } = c.req.valid("json");
      const now = new Date();
      const change = {
        ...(pinned !== undefined ? { pinnedAt: pinned ? now : null } : {}),
        ...(favourite !== undefined ? { favouriteAt: favourite ? now : null } : {}),
        ...(viewed !== undefined ? { viewedAt: viewed ? now : null } : {}),
      };
      const byKind = new Map<MarkKind, string[]>();
      for (const item of items) {
        const ids = byKind.get(item.kind) ?? [];
        if (!ids.includes(item.id)) ids.push(item.id);
        byKind.set(item.kind, ids);
      }
      await db.transaction(async (tx) => {
        for (const [kind, ids] of byKind) {
          const table = tables[kind];
          // Only what is in this project: ids from elsewhere are refused, not ignored.
          const found = await tx
            .select({ id: table.id })
            .from(table)
            .where(
              inOrg(table, organisationId, eq(table.projectId, projectId), inArray(table.id, ids)),
            );
          if (found.length !== ids.length) {
            throw new HTTPException(422, { message: `That ${kind} is not in this project` });
          }
          const column = columns[kind];
          await tx
            .insert(marks)
            .values(
              ids.map((id) => ({
                organisationId,
                userId,
                projectId,
                [`${kind}Id`]: id,
                ...change,
              })),
            )
            .onConflictDoUpdate({
              target: [marks.organisationId, marks.userId, column],
              set: { ...change, updatedAt: now },
            });
        }
        // A mark with nothing left on it is no mark.
        await tx
          .delete(marks)
          .where(
            inOrg(
              marks,
              organisationId,
              eq(marks.userId, userId),
              eq(marks.projectId, projectId),
              isNull(marks.pinnedAt),
              isNull(marks.favouriteAt),
              isNull(marks.viewedAt),
            ),
          );
      });
      return c.body(null, 204);
    });
