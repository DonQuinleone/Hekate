import { type Database, inOrg, schema } from "@hekate/db";
import {
  channelsFor,
  DAILY_DIGEST_HOUR_UTC,
  type DigestFrequency,
  defaultNotificationPreferences,
  type EmailSubjects,
  type MailMode,
  type NotificationKind,
  type NotificationMail,
  subjectFor,
  workspaceSettingsOf,
} from "@hekate/shared";
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import { render } from "./email/render.ts";
import type { Mailer } from "./mail.ts";

const {
  notifications,
  notificationPreferences,
  members,
  users,
  guests,
  projectMembers,
  projectRoles,
  organisations,
} = schema;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Db = Database | Tx;

/** Who did what a notification tells of. Null when Hekate itself did, such as a failed job. */
export type NotificationActor = { userId: string } | { guestId: string } | null;

export interface NotificationEvent {
  organisationId: string;
  kind: NotificationKind;
  /** Members to tell. The actor, anyone outside the workspace and anyone who cannot see the project are left out. */
  recipients: string[];
  actor: NotificationActor;
  projectId?: string | null;
  reviewId?: string | null;
  fileId?: string | null;
  trackId?: string | null;
  commentId?: string | null;
  /** What happened, after the actor's name: "approved Album masters". */
  text: string;
  detail?: string | null;
  /** Where it leads in the app, as a path such as `/reviews/…`. */
  link: string;
  /** The workspace template whose subject line its mail takes, and the values for it. */
  mail?: NotificationMail;
}

export type NotificationRow = typeof notifications.$inferSelect;

/**
 * The members among `ids` who belong to the workspace and, for a project's event, may see
 * that project: owners and admins see every project, others through a role with `view`.
 */
async function reachable(db: Db, organisationId: string, ids: string[], projectId?: string | null) {
  if (ids.length === 0) return [];
  const rows = await db
    .select({ userId: members.userId, role: members.role })
    .from(members)
    .where(inOrg(members, organisationId, inArray(members.userId, ids)));
  if (!projectId) return rows.map((r) => r.userId);
  const seeing = new Set(
    (
      await db
        .select({ userId: projectMembers.userId })
        .from(projectMembers)
        .innerJoin(
          projectRoles,
          and(
            eq(projectRoles.id, projectMembers.roleId),
            eq(projectRoles.organisationId, organisationId),
          ),
        )
        .where(
          inOrg(
            projectMembers,
            organisationId,
            eq(projectMembers.projectId, projectId),
            inArray(projectMembers.userId, ids),
            sql`'view' = any(${projectRoles.permissions})`,
          ),
        )
    ).map((r) => r.userId),
  );
  return rows
    .filter((r) => r.role === "owner" || r.role === "admin" || seeing.has(r.userId))
    .map((r) => r.userId);
}

async function actorName(db: Db, organisationId: string, actor: NotificationActor) {
  if (!actor) return null;
  if ("userId" in actor) {
    const [user] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, actor.userId));
    return user?.name ?? null;
  }
  const [guest] = await db
    .select({ name: guests.name })
    .from(guests)
    .where(inOrg(guests, organisationId, eq(guests.id, actor.guestId)));
  return guest?.name ?? null;
}

/**
 * Tell members something happened: one row each, shaped by their preferences. Pass the
 * transaction that makes the change, so the two commit together; mail goes out afterwards.
 */
export async function recordNotification(db: Db, event: NotificationEvent) {
  const self = event.actor && "userId" in event.actor ? event.actor.userId : null;
  const ids = [...new Set(event.recipients)].filter((id) => id !== self);
  const recipients = await reachable(db, event.organisationId, ids, event.projectId);
  if (recipients.length === 0) return [];
  const prefs = new Map(
    (
      await db
        .select()
        .from(notificationPreferences)
        .where(
          inOrg(
            notificationPreferences,
            event.organisationId,
            inArray(notificationPreferences.userId, recipients),
          ),
        )
    ).map((p) => [p.userId, p]),
  );
  const name = await actorName(db, event.organisationId, event.actor);
  const values = recipients.flatMap((userId) => {
    const pref = prefs.get(userId) ?? defaultNotificationPreferences;
    const channels = channelsFor(pref, event.kind);
    if (!channels.app && !channels.mail) return [];
    return [
      {
        organisationId: event.organisationId,
        userId,
        kind: event.kind,
        actorUserId: event.actor && "userId" in event.actor ? event.actor.userId : null,
        actorGuestId: event.actor && "guestId" in event.actor ? event.actor.guestId : null,
        actorName: name,
        projectId: event.projectId ?? null,
        reviewId: event.reviewId ?? null,
        fileId: event.fileId ?? null,
        trackId: event.trackId ?? null,
        commentId: event.commentId ?? null,
        text: event.text,
        detail: event.detail ?? null,
        link: event.link,
        mail: event.mail ?? null,
        inApp: channels.app,
        mailMode: channels.mail ? pref.mailMode : null,
      },
    ];
  });
  if (values.length === 0) return [];
  // One failure notice per file and person (a unique index); a second is dropped.
  return db.insert(notifications).values(values).onConflictDoNothing().returning();
}

/** A notification as one line: "Mira Solberg approved Album masters". */
export const lineOf = (n: Pick<NotificationRow, "actorName" | "text">) =>
  n.actorName ? `${n.actorName} ${n.text}` : n.text.charAt(0).toUpperCase() + n.text.slice(1);

const settingsPath = "/account/notifications";

/** The one thing each kind of mail asks you to do. */
const actionLabel: Record<NotificationKind, string> = {
  review_requested: "Open the review",
  decision: "See the review",
  reply: "Open the thread",
  mention: "Open the comment",
  version: "Open the version",
  processing_failed: "Open the file",
  guest_opened: "See the review",
  deletion_requested: "Open the project's settings",
  due_soon: "Open the review",
  assigned: "Open your comments",
};

/** Why each kind of mail came. */
const whyFoot: Record<NotificationKind, string> = {
  review_requested: "You get this because you were asked to review.",
  decision: "You get this because you requested the review or follow it.",
  reply: "You get this because you took part in the thread.",
  mention: "You get this because someone mentioned you.",
  version: "You get this because you follow the track.",
  processing_failed: "You get this because you uploaded the file.",
  guest_opened: "You get this because you requested the review.",
  deletion_requested:
    "You get this because deleting a project needs a workspace owner's confirmation.",
  due_soon: "A reminder, sent once, the day before the due date.",
  assigned: "You get this because the comments are assigned to you.",
};

/** The workspace a mail comes from: its name, and its own subject lines. */
export interface MailWorkspace {
  name: string;
  subjects: EmailSubjects;
}

/**
 * One notification by mail, sent as it happens. A kind with a workspace template takes the
 * workspace's subject line; the rest say what happened.
 */
export function instantMail(n: NotificationRow, publicUrl: string, workspace: MailWorkspace) {
  const base = publicUrl.replace(/\/$/, "");
  const line = lineOf(n);
  const subject = n.mail
    ? subjectFor(n.mail.template, workspace.subjects, {
        // Who acted, unless the event captured someone else (a manager asking for a review).
        reviewer: n.actorName ?? "",
        requester: n.actorName ?? "",
        ...n.mail.values,
        workspace: workspace.name,
      })
    : line.length > 120
      ? `${line.slice(0, 117)}...`
      : line;
  // A share asks nothing (#138): its mail neither asks for a review nor says one was asked.
  const shared = n.mail?.template === "shared";
  return render({
    workspace: workspace.name,
    subject,
    heading: line,
    body: n.detail ? n.detail.split(/\n{2,}/) : [],
    action: {
      label: shared ? "Open what was shared" : actionLabel[n.kind],
      url: `${base}${n.link}`,
    },
    foot: shared ? "You get this because something was shared with you." : whyFoot[n.kind],
    settingsUrl: `${base}${settingsPath}`,
  });
}

/** Several notifications gathered into one mail, oldest first. */
export function digestMail(rows: NotificationRow[], workspace: string, publicUrl: string) {
  const base = publicUrl.replace(/\/$/, "");
  const count = `${rows.length} update${rows.length === 1 ? "" : "s"}`;
  return render({
    workspace,
    subject: `${count} in ${workspace}`,
    heading: `${count} in ${workspace}`,
    body: [],
    list: rows.map(lineOf),
    action: { label: "Open your inbox", url: `${base}/inbox` },
    foot: "You get these gathered together, as you chose.",
    settingsUrl: `${base}${settingsPath}`,
  });
}

/**
 * Whether someone's digest is due. Hourly ones go every run; daily ones at the set hour, or
 * whenever the last went more than a day ago (a missed run, a server that was down).
 */
export function digestDue(frequency: DigestFrequency, lastDigestAt: Date | null, now: Date) {
  if (frequency === "hourly") return true;
  const dayAgo = now.getTime() - 24 * 60 * 60 * 1000;
  if (lastDigestAt && lastDigestAt.getTime() < dayAgo) return true;
  if (now.getUTCHours() !== DAILY_DIGEST_HOUR_UTC) return false;
  return !lastDigestAt || lastDigestAt.getTime() < now.getTime() - 60 * 60 * 1000;
}

async function mailWorkspace(db: Db, n: NotificationRow): Promise<MailWorkspace> {
  const [workspace] = await db
    .select({ name: organisations.name, settings: organisations.settings })
    .from(organisations)
    .where(eq(organisations.id, n.organisationId));
  return {
    name: workspace?.name ?? "Hekate",
    subjects: workspaceSettingsOf(workspace?.settings).emailSubjects,
  };
}

async function emailOf(db: Db, userId: string) {
  const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
  return user?.email ?? null;
}

/**
 * Send one notification's mail, once. The row is claimed by marking it sent before the
 * mail goes, in one statement, so a second sender (the queue, or another run) finds it
 * taken; a mail that fails releases the claim for the next run to try again.
 */
async function sendOnce(db: Database, mailer: Mailer, publicUrl: string, n: NotificationRow) {
  const claimedAt = new Date();
  const [claimed] = await db
    .update(notifications)
    .set({ emailedAt: claimedAt, updatedAt: claimedAt })
    .where(
      inOrg(
        notifications,
        n.organisationId,
        eq(notifications.id, n.id),
        isNull(notifications.emailedAt),
      ),
    )
    .returning({ id: notifications.id });
  if (!claimed) return false;
  const to = await emailOf(db, n.userId);
  try {
    if (to) await mailer.send({ to, ...instantMail(n, publicUrl, await mailWorkspace(db, n)) });
    return true;
  } catch (error) {
    console.warn(`Could not send a notification by mail: ${String(error)}`);
    await db
      .update(notifications)
      .set({ emailedAt: null, updatedAt: new Date() })
      .where(inOrg(notifications, n.organisationId, eq(notifications.id, n.id)));
    throw error;
  }
}

/** The workspaces, for jobs that work through each one's queue in turn. */
const workspaces = async (db: Database) =>
  (await db.select({ id: organisations.id }).from(organisations)).map((o) => o.id);

/**
 * Send the mail waiting to go at once, workspace by workspace, a batch at a time. Each
 * row is claimed before it is sent, so nothing goes twice; a mail server that fails ends
 * the run, and what is left goes next time.
 */
export async function deliverInstant(
  db: Database,
  mailer: Mailer,
  publicUrl: string,
  now = new Date(),
) {
  let sent = 0;
  for (const organisationId of await workspaces(db)) {
    const due = await db
      .select()
      .from(notifications)
      .where(
        inOrg(
          notifications,
          organisationId,
          eq(notifications.mailMode, "instant" satisfies MailMode),
          isNull(notifications.emailedAt),
          lte(notifications.createdAt, now),
        ),
      )
      .orderBy(asc(notifications.createdAt))
      .limit(100);
    for (const n of due) {
      try {
        if (await sendOnce(db, mailer, publicUrl, n)) sent++;
      } catch {
        return sent;
      }
    }
  }
  return sent;
}

/** Send each digest that is due: one mail per member and workspace. */
export async function deliverDigests(
  db: Database,
  mailer: Mailer,
  publicUrl: string,
  now = new Date(),
) {
  // Who has a digest waiting, workspace by workspace.
  const waiting: { organisationId: string; userId: string }[] = [];
  for (const organisationId of await workspaces(db)) {
    const users = await db
      .selectDistinct({ userId: notifications.userId })
      .from(notifications)
      .where(
        inOrg(
          notifications,
          organisationId,
          eq(notifications.mailMode, "digest" satisfies MailMode),
          isNull(notifications.emailedAt),
          lte(notifications.createdAt, now),
        ),
      );
    waiting.push(...users.map((u) => ({ organisationId, userId: u.userId })));
  }
  let sent = 0;
  for (const { organisationId, userId } of waiting) {
    await db.transaction(async (tx) => {
      const [pref] = await tx
        .select()
        .from(notificationPreferences)
        .where(
          inOrg(
            notificationPreferences,
            organisationId,
            eq(notificationPreferences.userId, userId),
          ),
        )
        .for("update");
      const frequency = pref?.digest ?? defaultNotificationPreferences.digest;
      if (!digestDue(frequency, pref?.lastDigestAt ?? null, now)) return;
      const rows = await tx
        .select()
        .from(notifications)
        .where(
          inOrg(
            notifications,
            organisationId,
            eq(notifications.userId, userId),
            eq(notifications.mailMode, "digest" satisfies MailMode),
            isNull(notifications.emailedAt),
            lte(notifications.createdAt, now),
          ),
        )
        .orderBy(asc(notifications.createdAt))
        .for("update", { skipLocked: true });
      if (rows.length === 0) return;
      const [workspace] = await tx
        .select({ name: organisations.name })
        .from(organisations)
        .where(eq(organisations.id, organisationId));
      const to = await emailOf(tx, userId);
      try {
        if (to)
          await mailer.send({ to, ...digestMail(rows, workspace?.name ?? "Hekate", publicUrl) });
      } catch (error) {
        console.warn(`Could not send a notification digest: ${String(error)}`);
        return;
      }
      await tx
        .update(notifications)
        .set({ emailedAt: now, updatedAt: now })
        .where(
          inOrg(
            notifications,
            organisationId,
            inArray(
              notifications.id,
              rows.map((r) => r.id),
            ),
          ),
        );
      await tx
        .insert(notificationPreferences)
        .values({ organisationId, userId, lastDigestAt: now })
        .onConflictDoUpdate({
          target: [notificationPreferences.organisationId, notificationPreferences.userId],
          set: { lastDigestAt: now, updatedAt: now },
        });
      sent++;
    });
  }
  return sent;
}

/**
 * Record a notification and send its mail at once where that is how it goes, for writers
 * that run after their change has committed. A mail that fails here is left queued for
 * the next delivery run.
 */
export async function notifyNow(
  deps: { db: Database; mailer: Mailer; publicUrl: string },
  event: NotificationEvent,
) {
  const rows = await recordNotification(deps.db, event);
  for (const n of rows) {
    if (n.mailMode !== "instant") continue;
    // A failure leaves it queued for the delivery job.
    await sendOnce(deps.db, deps.mailer, deps.publicUrl, n).catch(() => false);
  }
  return rows;
}

/** The members who follow a track or a review. */
export async function followersOf(
  db: Db,
  organisationId: string,
  thing: { trackId: string } | { reviewId: string },
) {
  const { follows } = schema;
  const rows = await db
    .select({ userId: follows.userId })
    .from(follows)
    .where(
      inOrg(
        follows,
        organisationId,
        "trackId" in thing
          ? eq(follows.trackId, thing.trackId)
          : eq(follows.reviewId, thing.reviewId),
      ),
    );
  return rows.map((r) => r.userId);
}

/** Follow a track or a review, once. */
export async function follow(
  db: Db,
  organisationId: string,
  userId: string,
  thing: { trackId: string } | { reviewId: string },
) {
  const { follows } = schema;
  await db
    .insert(follows)
    .values({ organisationId, userId, ...thing })
    .onConflictDoNothing();
}

/** The members who may see a project, by name: whom a comment there can mention. */
export async function projectPeople(db: Db, organisationId: string, projectId: string) {
  const everyone = await db
    .select({ id: users.id, name: users.name })
    .from(members)
    .innerJoin(users, eq(users.id, members.userId))
    .where(inOrg(members, organisationId));
  const seeing = new Set(
    await reachable(
      db,
      organisationId,
      everyone.map((p) => p.id),
      projectId,
    ),
  );
  return everyone.filter((p) => seeing.has(p.id));
}

/**
 * Tell whoever uploaded a file that it could not be processed, once per file: the jobs that
 * fail on it (probing, packaging, analysis, drawing pages) say so only the first time.
 */
export async function tellProcessingFailed(db: Database, organisationId: string, fileId: string) {
  const { files } = schema;
  const [file] = await db
    .select({ name: files.name, projectId: files.projectId, uploadedBy: files.uploadedBy })
    .from(files)
    .where(inOrg(files, organisationId, eq(files.id, fileId)));
  if (!file?.uploadedBy) return;
  const [told] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      inOrg(
        notifications,
        organisationId,
        eq(notifications.fileId, fileId),
        eq(notifications.kind, "processing_failed"),
      ),
    )
    .limit(1);
  if (told) return;
  await recordNotification(db, {
    organisationId,
    kind: "processing_failed",
    recipients: [file.uploadedBy],
    actor: null,
    projectId: file.projectId,
    fileId,
    text: `${file.name} could not be processed`,
    detail: "Replace the file with a fresh export, or ask whoever made it to check it.",
    link: `/files/${fileId}`,
  });
}
