import { createHash, randomBytes } from "node:crypto";
import { type Database, inOrg, schema } from "@hekate/db";
import {
  type CalendarEvent,
  dayIn,
  icsCalendar,
  monthGrid,
  type ProjectPermission,
} from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { type AnyColumn, and, asc, eq, isNotNull, ne, type SQL, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { actorOf, can, projectAccess } from "../access.ts";
import { NotFound } from "../errors.ts";
import type { TenantVariables } from "../tenancy.ts";

const { calendarFeeds, members, organisations, projects, reviews, sessions, tasks, users } = schema;

const idParam = zValidator("param", z.object({ id: z.uuid() }));
const monthQuery = zValidator(
  "query",
  z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }),
);

/** A feed's token as stored: its SHA-256, so the database alone opens no feed. */
const hashOf = (token: string) => createHash("sha256").update(token).digest("hex");

/** Someone's time zone, as their account keeps it; null where they chose none. */
async function zoneOf(db: Database, userId: string) {
  const [user] = await db
    .select({ timeZone: users.timeZone })
    .from(users)
    .where(eq(users.id, userId));
  return user?.timeZone ?? null;
}

const DAY = 86_400_000;

/**
 * What is on a project's calendar, between two days (both included) or all of it: reviews and
 * tasks due, and, for those who may see takes, the days sessions were recorded. A review is due
 * at a moment, so it goes on the day that moment is where the reader is (`timeZone`).
 */
export async function calendarEvents(
  db: Database,
  organisationId: string,
  projectId: string,
  permissions: ReadonlySet<ProjectPermission>,
  range: { from: string; to: string } | null,
  timeZone: string | null,
  now = new Date(),
): Promise<CalendarEvent[]> {
  const today = dayIn(now, timeZone);
  // Both days included; none for the whole calendar.
  const within = (column: AnyColumn, from: unknown, to: unknown): SQL | undefined =>
    range ? sql`${column} between ${from} and ${to}` : undefined;
  const [due, todo, booked] = await Promise.all([
    db
      .select({
        id: reviews.id,
        title: reviews.title,
        dueAt: reviews.dueAt,
        status: reviews.status,
      })
      .from(reviews)
      .where(
        inOrg(
          reviews,
          organisationId,
          eq(reviews.projectId, projectId),
          isNotNull(reviews.dueAt),
          ne(reviews.status, "cancelled"),
          within(
            reviews.dueAt,
            // A day either side covers every time zone; each is placed below. As text: the
            // driver passes a raw condition's values as they are.
            range && new Date(Date.parse(range.from) - DAY).toISOString(),
            range && new Date(Date.parse(range.to) + 2 * DAY).toISOString(),
          ),
        ),
      )
      .orderBy(asc(reviews.dueAt)),
    db
      .select({ id: tasks.id, title: tasks.title, dueOn: tasks.dueOn, status: tasks.status })
      .from(tasks)
      .where(
        inOrg(
          tasks,
          organisationId,
          eq(tasks.projectId, projectId),
          isNotNull(tasks.dueOn),
          within(tasks.dueOn, range?.from, range?.to),
        ),
      )
      .orderBy(asc(tasks.dueOn), asc(tasks.number)),
    permissions.has("view_takes")
      ? db
          .select({
            id: sessions.id,
            name: sessions.name,
            venue: sessions.venue,
            recordedOn: sessions.recordedOn,
          })
          .from(sessions)
          .where(
            inOrg(
              sessions,
              organisationId,
              eq(sessions.projectId, projectId),
              isNotNull(sessions.recordedOn),
              within(sessions.recordedOn, range?.from, range?.to),
            ),
          )
          .orderBy(asc(sessions.recordedOn))
      : [],
  ]);
  return [
    ...due.flatMap((r): CalendarEvent[] => {
      const date = r.dueAt ? dayIn(r.dueAt, timeZone) : null;
      return r.dueAt && date && (!range || (date >= range.from && date <= range.to))
        ? [
            {
              id: `review-${r.id}`,
              kind: "review",
              date,
              title: r.title,
              link: `/reviews/${r.id}`,
              overdue: r.status === "open" && r.dueAt < now,
            },
          ]
        : [];
    }),
    ...todo.flatMap((t): CalendarEvent[] =>
      t.dueOn
        ? [
            {
              id: `task-${t.id}`,
              kind: "task",
              date: t.dueOn,
              title: t.title,
              link: `/projects/${projectId}/tasks?task=${t.id}`,
              overdue: t.status !== "done" && t.dueOn < today,
            },
          ]
        : [],
    ),
    ...booked.flatMap((s): CalendarEvent[] =>
      s.recordedOn
        ? [
            {
              id: `session-${s.id}`,
              kind: "session",
              date: s.recordedOn,
              title: s.venue ? `${s.name} at ${s.venue}` : s.name,
              link: `/sessions/${s.id}`,
              overdue: false,
            },
          ]
        : [],
    ),
  ].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * `/api/projects/:id/calendar` (#141): a month of the project's calendar, and the viewer's own
 * feed of it, which they get (a new link replacing any before) or stop.
 */
export const projectCalendarRoutes = (db: Database, publicUrl: string) => {
  const feedUrl = (token: string) => `${publicUrl.replace(/\/$/, "")}/api/calendar/${token}.ics`;
  return new Hono<{ Variables: TenantVariables }>()
    .get("/:id/calendar", idParam, monthQuery, async (c) => {
      const organisationId = c.var.organisationId;
      const access = await can(db, actorOf(c.var), "view", c.req.valid("param").id);
      const { days } = monthGrid(c.req.valid("query").month);
      const events = await calendarEvents(
        db,
        organisationId,
        access.projectId,
        access.permissions,
        {
          from: days[0] ?? "",
          to: days[days.length - 1] ?? "",
        },
        await zoneOf(db, c.var.userId),
      );
      const [feed] = await db
        .select({ createdAt: calendarFeeds.createdAt, readAt: calendarFeeds.readAt })
        .from(calendarFeeds)
        .where(
          inOrg(
            calendarFeeds,
            organisationId,
            eq(calendarFeeds.userId, c.var.userId),
            eq(calendarFeeds.projectId, access.projectId),
          ),
        );
      return c.json({
        events,
        feed: feed
          ? { createdAt: feed.createdAt.toISOString(), readAt: feed.readAt?.toISOString() ?? null }
          : null,
      });
    })
    .post("/:id/calendar/feed", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const access = await can(db, actorOf(c.var), "view", c.req.valid("param").id);
      // The link is shown once, here; only its hash is kept.
      const token = randomBytes(32).toString("base64url");
      // One statement, so two made at once both land, the later replacing the earlier.
      await db
        .insert(calendarFeeds)
        .values({
          organisationId,
          userId: c.var.userId,
          projectId: access.projectId,
          tokenHash: hashOf(token),
        })
        .onConflictDoUpdate({
          target: [calendarFeeds.organisationId, calendarFeeds.userId, calendarFeeds.projectId],
          set: { tokenHash: hashOf(token), createdAt: new Date(), readAt: null },
        });
      return c.json({ url: feedUrl(token) }, 201);
    })
    .delete("/:id/calendar/feed", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const access = await can(db, actorOf(c.var), "view", c.req.valid("param").id);
      await db
        .delete(calendarFeeds)
        .where(
          inOrg(
            calendarFeeds,
            organisationId,
            eq(calendarFeeds.userId, c.var.userId),
            eq(calendarFeeds.projectId, access.projectId),
          ),
        );
      return c.body(null, 204);
    });
};

/**
 * `/api/calendar/:token.ics` (#141): someone's feed of a project, for their calendar to read,
 * with no session. The link is the credential, so it shows only what its owner may see now:
 * a member no longer, a project they lost, or a workspace suspended reads as not found.
 */
export const calendarFeedRoutes = (db: Database, publicUrl: string) =>
  new Hono().get("/:file", async (c) => {
    const file = c.req.param("file");
    const token = file.endsWith(".ics") ? file.slice(0, -4) : "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new NotFound("Calendar");
    const [feed] = await db
      .select({
        id: calendarFeeds.id,
        organisationId: calendarFeeds.organisationId,
        userId: calendarFeeds.userId,
        projectId: calendarFeeds.projectId,
        projectName: projects.name,
        role: members.role,
        timeZone: users.timeZone,
        suspendedAt: organisations.suspendedAt,
        deleteAfter: organisations.deleteAfter,
      })
      .from(calendarFeeds)
      .innerJoin(
        projects,
        and(
          eq(projects.id, calendarFeeds.projectId),
          eq(projects.organisationId, calendarFeeds.organisationId),
        ),
      )
      .innerJoin(organisations, eq(organisations.id, calendarFeeds.organisationId))
      .innerJoin(users, eq(users.id, calendarFeeds.userId))
      .leftJoin(
        members,
        and(
          eq(members.organisationId, calendarFeeds.organisationId),
          eq(members.userId, calendarFeeds.userId),
        ),
      )
      // Looked up by the token's hash alone: the one place a feed is found without a workspace.
      .where(eq(calendarFeeds.tokenHash, hashOf(token)));
    if (!feed?.role || feed.suspendedAt || feed.deleteAfter) throw new NotFound("Calendar");
    const access = await projectAccess(
      db,
      {
        kind: "member",
        userId: feed.userId,
        organisationId: feed.organisationId,
        organisationRole: feed.role,
      },
      feed.projectId,
    );
    if (!access) throw new NotFound("Calendar");
    const now = new Date();
    const events = await calendarEvents(
      db,
      feed.organisationId,
      feed.projectId,
      access.permissions,
      null,
      feed.timeZone,
      now,
    );
    await db
      .update(calendarFeeds)
      .set({ readAt: now })
      .where(inOrg(calendarFeeds, feed.organisationId, eq(calendarFeeds.id, feed.id)));
    const host = new URL(publicUrl).host;
    return c.body(icsCalendar(feed.projectName, events, { base: publicUrl, host, now }), 200, {
      "Content-Type": "text/calendar; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
    });
  });
