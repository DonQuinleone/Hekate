import { type Database, inOrg, schema } from "@hekate/db";
import {
  defaultNotificationPreferences,
  followInput,
  notificationPreferencesInput,
} from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq, isNull, lt, type SQL, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { actorOf, can, visibleProjects } from "../access.ts";
import { NotFound } from "../errors.ts";
import { follow } from "../notifications.ts";
import type { TenantVariables } from "../tenancy.ts";

const { notifications, notificationPreferences, follows, tracks, reviews, projects } = schema;

const idParam = zValidator("param", z.object({ id: z.uuid() }));
const listQuery = zValidator(
  "query",
  z.object({
    before: z.uuid().optional(),
    unread: z.enum(["1"]).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
  }),
);

/**
 * `/api/notifications`: what has happened that concerns you, in this workspace; how it
 * reaches you; and the tracks and reviews you follow. Everyone sees only their own.
 */
export const notificationRoutes = (db: Database) =>
  new Hono<{ Variables: TenantVariables }>()
    .get("/", listQuery, async (c) => {
      const { organisationId, userId } = c.var;
      const { before, unread, limit } = c.req.valid("query");
      const mine = (...more: (SQL | undefined)[]) =>
        inOrg(
          notifications,
          organisationId,
          eq(notifications.userId, userId),
          eq(notifications.inApp, true),
          ...more,
        );
      const [rows, [waiting]] = await Promise.all([
        db
          .select({
            id: notifications.id,
            kind: notifications.kind,
            actorName: notifications.actorName,
            actorUserId: notifications.actorUserId,
            actorGuestId: notifications.actorGuestId,
            text: notifications.text,
            link: notifications.link,
            readAt: notifications.readAt,
            createdAt: notifications.createdAt,
          })
          .from(notifications)
          .where(
            mine(
              before ? lt(notifications.id, before) : undefined,
              unread ? isNull(notifications.readAt) : undefined,
            ),
          )
          // Ids are UUIDv7, so they sort by time.
          .orderBy(desc(notifications.id))
          .limit(limit + 1),
        db
          .select({ n: count() })
          .from(notifications)
          .where(mine(isNull(notifications.readAt))),
      ]);
      const more = rows.length > limit;
      const page = more ? rows.slice(0, limit) : rows;
      return c.json({
        notifications: page,
        unread: waiting?.n ?? 0,
        nextBefore: more ? (page.at(-1)?.id ?? null) : null,
      });
    })
    .post("/read-all", async (c) => {
      const now = new Date();
      await db
        .update(notifications)
        .set({ readAt: now, updatedAt: now })
        .where(
          inOrg(
            notifications,
            c.var.organisationId,
            eq(notifications.userId, c.var.userId),
            isNull(notifications.readAt),
          ),
        );
      return c.body(null, 204);
    })
    .post("/:id/read", idParam, async (c) => {
      const now = new Date();
      const [row] = await db
        .update(notifications)
        .set({ readAt: now, updatedAt: now })
        .where(
          inOrg(
            notifications,
            c.var.organisationId,
            eq(notifications.id, c.req.valid("param").id),
            eq(notifications.userId, c.var.userId),
          ),
        )
        .returning({ id: notifications.id });
      if (!row) throw new NotFound("Notification");
      return c.body(null, 204);
    })
    .get("/preferences", async (c) => {
      const [row] = await db
        .select({
          mailMode: notificationPreferences.mailMode,
          digest: notificationPreferences.digest,
          kinds: notificationPreferences.kinds,
        })
        .from(notificationPreferences)
        .where(
          inOrg(
            notificationPreferences,
            c.var.organisationId,
            eq(notificationPreferences.userId, c.var.userId),
          ),
        );
      return c.json({ preferences: row ?? defaultNotificationPreferences });
    })
    .put("/preferences", zValidator("json", notificationPreferencesInput), async (c) => {
      const input = c.req.valid("json");
      const now = new Date();
      await db
        .insert(notificationPreferences)
        .values({ organisationId: c.var.organisationId, userId: c.var.userId, ...input })
        .onConflictDoUpdate({
          target: [notificationPreferences.organisationId, notificationPreferences.userId],
          set: { ...input, updatedAt: now },
        });
      return c.json({ preferences: input });
    })
    .get("/follows", async (c) => {
      const { organisationId, userId } = c.var;
      const rows = await db
        .select({
          id: follows.id,
          trackId: follows.trackId,
          reviewId: follows.reviewId,
          name: sql<string>`coalesce(${tracks.name}, ${reviews.title})`,
          projectId: projects.id,
          projectName: projects.name,
        })
        .from(follows)
        .leftJoin(
          tracks,
          and(eq(tracks.id, follows.trackId), eq(tracks.organisationId, organisationId)),
        )
        .leftJoin(
          reviews,
          and(eq(reviews.id, follows.reviewId), eq(reviews.organisationId, organisationId)),
        )
        // A follow is of a track or of a review; either way it sits in one project.
        .innerJoin(
          projects,
          and(
            eq(projects.organisationId, organisationId),
            eq(projects.id, sql`coalesce(${tracks.projectId}, ${reviews.projectId})`),
          ),
        )
        // Only what you can still see: a follow outlives your access, but tells you nothing.
        .where(
          inOrg(
            follows,
            organisationId,
            eq(follows.userId, userId),
            visibleProjects(actorOf(c.var)),
          ),
        )
        .orderBy(desc(follows.createdAt));
      return c.json({ follows: rows });
    })
    .post("/follows", zValidator("json", followInput), async (c) => {
      const { organisationId, userId } = c.var;
      const input = c.req.valid("json");
      // Only what you can see can be followed; anything else does not exist for you.
      const [found] =
        "trackId" in input
          ? await db
              .select({ projectId: tracks.projectId })
              .from(tracks)
              .where(inOrg(tracks, organisationId, eq(tracks.id, input.trackId)))
          : await db
              .select({ projectId: reviews.projectId })
              .from(reviews)
              .where(inOrg(reviews, organisationId, eq(reviews.id, input.reviewId)));
      if (!found) throw new NotFound("trackId" in input ? "Track" : "Review");
      await can(db, actorOf(c.var), "view", found.projectId);
      await follow(db, organisationId, userId, input);
      return c.body(null, 204);
    })
    .delete("/follows/:id", idParam, async (c) => {
      const [row] = await db
        .delete(follows)
        .where(
          inOrg(
            follows,
            c.var.organisationId,
            eq(follows.id, c.req.valid("param").id),
            eq(follows.userId, c.var.userId),
          ),
        )
        .returning({ id: follows.id });
      if (!row) throw new NotFound("Follow");
      return c.body(null, 204);
    });
