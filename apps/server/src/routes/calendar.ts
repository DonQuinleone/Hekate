import { createHash, randomBytes } from "node:crypto";
import { type Database, inOrg, schema } from "@hekate/db";
import {
  type CalendarEntry,
  type CalendarEntryChange,
  type CalendarEntryInput,
  type CalendarEvent,
  calendarEntryChange,
  calendarEntryInput,
  dayIn,
  deadlinePassed,
  icsCalendar,
  monthGrid,
  type ProjectPermission,
  sameStatus,
} from "@hekate/shared";
import {
  type AnyColumn,
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  ne,
  notExists,
  type SQL,
  sql,
} from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { actorOf, can, lockLiveProject, projectAccess } from "../access.ts";
import { NotFound } from "../errors.ts";
import { zValidator } from "../openapi/validator.ts";
import type { TenantVariables } from "../tenancy.ts";

const {
  calendarAttendees,
  calendarEntries,
  calendarFeeds,
  members,
  organisations,
  projects,
  reviews,
  scheduleDays,
  sessions,
  sessionTracks,
  takes,
  tasks,
  tracks,
  users,
} = schema;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const idParam = zValidator("param", z.object({ id: z.uuid() }));
const isoDay = /^\d{4}-\d{2}-\d{2}$/;
/** A month (the grid's six weeks), or a range of days, both included, up to a year. */
const rangeQuery = zValidator(
  "query",
  z
    .object({
      month: z
        .string()
        .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
        .optional(),
      from: z.string().regex(isoDay).optional(),
      to: z.string().regex(isoDay).optional(),
    })
    .refine((q) => q.month || (q.from && q.to), { message: "A month, or from and to" })
    .refine(
      (q) =>
        !q.from ||
        !q.to ||
        (q.to >= q.from && Date.parse(q.to) - Date.parse(q.from) <= 366 * 86_400_000),
      { message: "A range runs forwards, for a year at most" },
    ),
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

/** The day an instant kept as midnight UTC stands for: 2026-10-21. */
const dayOf = (at: Date) => at.toISOString().slice(0, 10);
/** A day as the instant it is kept as: midnight UTC. */
const atMidnight = (day: string) => new Date(`${day}T00:00:00Z`);

/**
 * A project's entries (#505), between two days or all of them, each with its attendees; a
 * range is wanted where any of its days falls within the range.
 */
async function entriesOf(
  db: Database,
  organisationId: string,
  projectId: string,
  range: { from: string; to: string } | null,
  ids?: string[],
): Promise<CalendarEntry[]> {
  const rows = await db
    .select()
    .from(calendarEntries)
    .where(
      inOrg(
        calendarEntries,
        organisationId,
        eq(calendarEntries.projectId, projectId),
        ids ? inArray(calendarEntries.id, ids) : undefined,
        range
          ? sql`${calendarEntries.startsAt} <= ${atMidnight(range.to).toISOString()} and coalesce(${calendarEntries.endsAt}, ${calendarEntries.startsAt}) >= ${atMidnight(range.from).toISOString()}`
          : undefined,
      ),
    )
    .orderBy(asc(calendarEntries.startsAt), asc(calendarEntries.createdAt));
  if (rows.length === 0) return [];
  const people = await db
    .select({ entryId: calendarAttendees.entryId, id: users.id, name: users.name })
    .from(calendarAttendees)
    .innerJoin(users, eq(users.id, calendarAttendees.userId))
    .where(
      inOrg(
        calendarAttendees,
        organisationId,
        inArray(
          calendarAttendees.entryId,
          rows.map((r) => r.id),
        ),
      ),
    )
    .orderBy(asc(users.name));
  return rows.map((r) => ({
    id: r.id,
    projectId: r.projectId,
    kind: r.kind,
    title: r.title,
    startsOn: dayOf(r.startsAt),
    endsOn: r.endsAt ? dayOf(r.endsAt) : null,
    trackId: r.trackId,
    reviewId: r.reviewId,
    sessionId: r.sessionId,
    attendees: people.filter((p) => p.entryId === r.id).map((p) => ({ id: p.id, name: p.name })),
  }));
}

/**
 * What is on a project's calendar, between two days (both included) or all of it: reviews,
 * tracks and tasks due, its entries (#505), for those who may see takes, the days sessions
 * were recorded (those an entry booked are the entry's), and, for those who see the production
 * tools, the schedule's days (#50). A review or a track is due at a moment, so it goes on the
 * day that moment is where the reader is (`timeZone`).
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
  // A day either side covers every time zone; each instant is placed below. As text: the
  // driver passes a raw condition's values as they are.
  const instantFrom = range && new Date(Date.parse(range.from) - DAY).toISOString();
  const instantTo = range && new Date(Date.parse(range.to) + 2 * DAY).toISOString();
  const [due, deadlines, [project], todo, booked, planned, entries] = await Promise.all([
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
          within(reviews.dueAt, instantFrom, instantTo),
        ),
      )
      .orderBy(asc(reviews.dueAt)),
    db
      .select({
        id: tracks.id,
        name: tracks.name,
        dueAt: tracks.dueAt,
        status: tracks.workflowStatus,
      })
      .from(tracks)
      .where(
        inOrg(
          tracks,
          organisationId,
          eq(tracks.projectId, projectId),
          isNotNull(tracks.dueAt),
          within(tracks.dueAt, instantFrom, instantTo),
        ),
      )
      .orderBy(asc(tracks.dueAt)),
    // Its status set: a track whose status reads as done is finished, whatever its deadline.
    db
      .select({ statuses: projects.workflowStatuses })
      .from(projects)
      .where(inOrg(projects, organisationId, eq(projects.id, projectId))),
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
              // A session an entry booked is listed as the entry, once.
              notExists(
                db
                  .select({ id: calendarEntries.id })
                  .from(calendarEntries)
                  .where(
                    inOrg(
                      calendarEntries,
                      organisationId,
                      eq(calendarEntries.sessionId, sessions.id),
                    ),
                  ),
              ),
            ),
          )
          .orderBy(asc(sessions.recordedOn))
      : [],
    permissions.has("view_production")
      ? db
          .select({ id: scheduleDays.id, label: scheduleDays.label, date: scheduleDays.date })
          .from(scheduleDays)
          .where(
            inOrg(
              scheduleDays,
              organisationId,
              eq(scheduleDays.projectId, projectId),
              isNotNull(scheduleDays.date),
              within(scheduleDays.date, range?.from, range?.to),
            ),
          )
          .orderBy(asc(scheduleDays.date), asc(scheduleDays.position))
      : [],
    entriesOf(db, organisationId, projectId, range),
  ]);
  const finished = (status: string | null) =>
    status !== null &&
    (project?.statuses ?? []).some((s) => sameStatus(s.name, status) && s.category === "done");
  const inRange = (date: string) => !range || (date >= range.from && date <= range.to);
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
    ...deadlines.flatMap((t): CalendarEvent[] => {
      const date = t.dueAt ? dayIn(t.dueAt, timeZone) : null;
      return t.dueAt && date && inRange(date)
        ? [
            {
              id: `track-${t.id}`,
              kind: "track",
              date,
              title: `${t.name} due`,
              link: `/tracks/${t.id}?view=versions`,
              overdue: !finished(t.status) && deadlinePassed(t.dueAt, now),
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
    ...planned.flatMap((d): CalendarEvent[] =>
      d.date
        ? [
            {
              id: `schedule-${d.id}`,
              kind: "schedule",
              date: d.date,
              title: `${d.label} schedule`,
              link: `/projects/${projectId}/schedule`,
              overdue: false,
            },
          ]
        : [],
    ),
    ...entries.map(
      (e): CalendarEvent => ({
        id: `entry-${e.id}`,
        kind: "entry",
        date: e.startsOn,
        ...(e.endsOn ? { end: e.endsOn } : {}),
        title: e.title,
        // A session entry opens its session; any other, the calendar it is on.
        link:
          e.sessionId && permissions.has("view_takes")
            ? `/sessions/${e.sessionId}`
            : `/projects/${projectId}/board?view=calendar&month=${e.startsOn.slice(0, 7)}`,
        overdue: false,
        entry: e,
      }),
    ),
  ].sort((a, b) => a.date.localeCompare(b.date));
}

/** The range a request asks for: a month's six weeks, or the days given. */
function rangeOf(query: { month?: string; from?: string; to?: string }) {
  if (query.month) {
    const { days } = monthGrid(query.month);
    return { from: days[0] ?? "", to: days[days.length - 1] ?? "" };
  }
  return { from: query.from ?? "", to: query.to ?? "" };
}

/**
 * An entry's track and review are the project's own, or it is refused (422); its attendees
 * are members of the workspace (anyone else is left out, as a member who left would be).
 */
async function checkLinks(
  db: Pick<Database, "select">,
  organisationId: string,
  projectId: string,
  input: { trackId?: string | null; reviewId?: string | null; attendees?: string[] },
) {
  if (input.trackId) {
    const [track] = await db
      .select({ id: tracks.id })
      .from(tracks)
      .where(
        inOrg(
          tracks,
          organisationId,
          eq(tracks.id, input.trackId),
          eq(tracks.projectId, projectId),
        ),
      );
    if (!track) throw new HTTPException(422, { message: "That track is not in this project" });
  }
  if (input.reviewId) {
    const [review] = await db
      .select({ id: reviews.id })
      .from(reviews)
      .where(
        inOrg(
          reviews,
          organisationId,
          eq(reviews.id, input.reviewId),
          eq(reviews.projectId, projectId),
        ),
      );
    if (!review) throw new HTTPException(422, { message: "That review is not in this project" });
  }
  const wanted = [...new Set(input.attendees ?? [])];
  if (wanted.length === 0) return [];
  const known = await db
    .select({ userId: members.userId })
    .from(members)
    .where(inOrg(members, organisationId, inArray(members.userId, wanted)));
  return known.map((m) => m.userId);
}

/** The attendees of an entry, replaced whole. */
async function setAttendees(tx: Tx, organisationId: string, entryId: string, userIds: string[]) {
  await tx
    .delete(calendarAttendees)
    .where(inOrg(calendarAttendees, organisationId, eq(calendarAttendees.entryId, entryId)));
  if (userIds.length > 0)
    await tx
      .insert(calendarAttendees)
      .values(userIds.map((userId) => ({ organisationId, entryId, userId })));
}

/**
 * The session a session entry booked follows the entry's title, day and track. Only the link
 * the entry made is moved: tracks the session took up since, by recording takes of them, stay.
 * `previousTrackId` is the track the entry linked before, null for a session just booked.
 */
async function followEntry(
  tx: Tx,
  organisationId: string,
  entry: {
    projectId: string;
    sessionId: string | null;
    title: string;
    startsAt: Date;
    trackId: string | null;
  },
  previousTrackId: string | null,
) {
  const sessionId = entry.sessionId;
  if (!sessionId) return;
  await tx
    .update(sessions)
    .set({ name: entry.title, recordedOn: dayOf(entry.startsAt), updatedAt: new Date() })
    .where(inOrg(sessions, organisationId, eq(sessions.id, sessionId)));
  if (previousTrackId === entry.trackId) return;
  if (previousTrackId)
    // The old track leaves the session only if nothing was recorded of it there.
    await tx.delete(sessionTracks).where(
      inOrg(
        sessionTracks,
        organisationId,
        and(
          eq(sessionTracks.sessionId, sessionId),
          eq(sessionTracks.trackId, previousTrackId),
          notExists(
            tx
              .select({ id: takes.id })
              .from(takes)
              .where(
                inOrg(
                  takes,
                  organisationId,
                  and(eq(takes.sessionId, sessionId), eq(takes.trackId, previousTrackId)),
                ),
              ),
          ),
        ),
      ),
    );
  if (entry.trackId)
    await tx
      .insert(sessionTracks)
      .values({ organisationId, sessionId, trackId: entry.trackId })
      .onConflictDoNothing();
}

/**
 * Who may add and change entries: whoever edits the schedule (`edit_production`, as the
 * production tools' timetable). A session entry books a recording session as well, which
 * takes the sessions' own permission too.
 */
async function canEnter(
  db: Database,
  vars: TenantVariables,
  projectId: string,
  kind: CalendarEntryInput["kind"] | undefined,
) {
  const access = await can(db, actorOf(vars), "edit_production", projectId);
  if (kind === "session" && !access.permissions.has("edit_takes"))
    throw new HTTPException(403, {
      message: "Booking a session needs the permission to edit sessions and takes",
    });
  return access;
}

/**
 * `/api/projects/:id/calendar` (#141): a month of the project's calendar, and the viewer's own
 * feed of it, which they get (a new link replacing any before) or stop.
 */
export const projectCalendarRoutes = (db: Database, publicUrl: string) => {
  const feedUrl = (token: string) => `${publicUrl.replace(/\/$/, "")}/api/calendar/${token}.ics`;
  return (
    new Hono<{ Variables: TenantVariables }>()
      .get("/:id/calendar", idParam, rangeQuery, async (c) => {
        const organisationId = c.var.organisationId;
        const access = await can(db, actorOf(c.var), "view", c.req.valid("param").id);
        const events = await calendarEvents(
          db,
          organisationId,
          access.projectId,
          access.permissions,
          rangeOf(c.req.valid("query")),
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
            ? {
                createdAt: feed.createdAt.toISOString(),
                readAt: feed.readAt?.toISOString() ?? null,
              }
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
      })
      // A new entry (#505): a session entry books a recording session under Production as well,
      // named and dated as the entry is and linked to its track.
      .post("/:id/calendar/entries", idParam, zValidator("json", calendarEntryInput), async (c) => {
        const organisationId = c.var.organisationId;
        const input = c.req.valid("json");
        const { projectId } = await canEnter(db, c.var, c.req.valid("param").id, input.kind);
        const attendees = await checkLinks(db, organisationId, projectId, input);
        const id = await db.transaction(async (tx) => {
          await lockLiveProject(tx, organisationId, projectId);
          let sessionId: string | null = null;
          if (input.kind === "session") {
            const [made] = await tx
              .insert(sessions)
              .values({
                organisationId,
                projectId,
                name: input.title,
                recordedOn: input.startsOn,
              })
              .returning({ id: sessions.id });
            sessionId = made?.id ?? null;
            if (sessionId && input.trackId)
              await tx
                .insert(sessionTracks)
                .values({ organisationId, sessionId, trackId: input.trackId });
          }
          const [row] = await tx
            .insert(calendarEntries)
            .values({
              organisationId,
              projectId,
              kind: input.kind,
              title: input.title,
              startsAt: atMidnight(input.startsOn),
              endsAt:
                input.endsOn && input.endsOn > input.startsOn ? atMidnight(input.endsOn) : null,
              trackId: input.trackId ?? null,
              reviewId: input.reviewId ?? null,
              sessionId,
              createdBy: c.var.userId,
            })
            .returning({ id: calendarEntries.id });
          if (!row) throw new NotFound("Entry");
          await setAttendees(tx, organisationId, row.id, attendees);
          return row.id;
        });
        const [entry] = await entriesOf(db, organisationId, projectId, null, [id]);
        return c.json({ entry }, 201);
      })
  );
};

/**
 * `/api/calendar-entries/:id` (#505): changing an entry (its title, days, kind, links and
 * attendees; the session it booked follows) and removing one (the session stays, with what
 * was recorded in it). For whoever edits the schedule.
 */
export const calendarEntryRoutes = (db: Database) => {
  const entryOf = async (organisationId: string, id: string) => {
    const [row] = await db
      .select()
      .from(calendarEntries)
      .where(inOrg(calendarEntries, organisationId, eq(calendarEntries.id, id)));
    if (!row) throw new NotFound("Entry");
    return row;
  };
  const seen = async (
    vars: TenantVariables,
    projectId: string,
    kind?: CalendarEntryChange["kind"],
  ) => {
    try {
      return await canEnter(db, vars, projectId, kind);
    } catch (error) {
      if (error instanceof NotFound) throw new NotFound("Entry");
      throw error;
    }
  };
  return new Hono<{ Variables: TenantVariables }>()
    .patch("/:id", idParam, zValidator("json", calendarEntryChange), async (c) => {
      const organisationId = c.var.organisationId;
      const { id } = c.req.valid("param");
      const input = c.req.valid("json");
      const entry = await entryOf(organisationId, id);
      // A session entry's changes reach the session it booked, and making an entry a session
      // books one, so either takes the sessions' permission too.
      await seen(
        c.var,
        entry.projectId,
        entry.sessionId || input.kind === "session" ? "session" : undefined,
      );
      const known = await checkLinks(db, organisationId, entry.projectId, input);
      const attendees = input.attendees !== undefined ? known : null;
      const startsOn = input.startsOn ?? dayOf(entry.startsAt);
      const endsGiven =
        input.endsOn !== undefined ? input.endsOn : entry.endsAt && dayOf(entry.endsAt);
      // A range moved by its start keeps its end unless the end is given too; never backwards.
      const endsOn = endsGiven && endsGiven > startsOn ? endsGiven : null;
      await db.transaction(async (tx) => {
        await lockLiveProject(tx, organisationId, entry.projectId);
        let sessionId = entry.sessionId;
        if (input.kind === "session" && !sessionId) {
          const [made] = await tx
            .insert(sessions)
            .values({
              organisationId,
              projectId: entry.projectId,
              name: input.title ?? entry.title,
              recordedOn: startsOn,
            })
            .returning({ id: sessions.id });
          sessionId = made?.id ?? null;
        }
        const next = {
          kind: input.kind ?? entry.kind,
          title: input.title ?? entry.title,
          startsAt: atMidnight(startsOn),
          endsAt: endsOn ? atMidnight(endsOn) : null,
          trackId: input.trackId !== undefined ? input.trackId : entry.trackId,
          reviewId: input.reviewId !== undefined ? input.reviewId : entry.reviewId,
          sessionId,
        };
        await tx
          .update(calendarEntries)
          .set({ ...next, updatedAt: new Date() })
          .where(inOrg(calendarEntries, organisationId, eq(calendarEntries.id, id)));
        if (attendees) await setAttendees(tx, organisationId, id, attendees);
        await followEntry(
          tx,
          organisationId,
          { projectId: entry.projectId, ...next },
          // A session booked by this change has no track yet; one booked before had the entry's.
          entry.sessionId ? entry.trackId : null,
        );
      });
      const [changed] = await entriesOf(db, organisationId, entry.projectId, null, [id]);
      return c.json({ entry: changed });
    })
    .delete("/:id", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const { id } = c.req.valid("param");
      const entry = await entryOf(organisationId, id);
      await seen(c.var, entry.projectId);
      await db
        .delete(calendarEntries)
        .where(inOrg(calendarEntries, organisationId, eq(calendarEntries.id, id)));
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
