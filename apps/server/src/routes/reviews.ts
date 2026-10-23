import { type Database, inOrg, schema } from "@hekate/db";
import {
  activeReviewers,
  applyPermissions,
  cancelReviewInput,
  createReviewInput,
  decisionInput,
  type GuestInput,
  guestInput,
  guestLabelInput,
  invitedGrant,
  type PersonInput,
  type ReviewDecision,
  type ReviewerFacts,
  type ReviewerInput,
  type ReviewerPermissions,
  type ReviewerPermissionsChange,
  type ReviewKind,
  type ReviewStepInput,
  readGrant,
  remindInput,
  reviewerDefaults,
  reviewerPermissionsChange,
  reviewerState,
  reviewOutcome,
  reviewTitleFor,
  shareGrant,
  standingGrant,
  submitFeedbackInput,
  updateReviewInput,
  withinWindow,
  workspaceSettingsOf,
} from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { and, asc, count, desc, eq, gte, inArray, isNull, lte, max, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  type Actor,
  actorOf,
  can,
  lockLiveProject,
  type MemberActor,
  projectAccess,
  reviewAccess,
} from "../access.ts";
import { type Audit, type RequestInfo, requestInfo } from "../audit.ts";
import { decisionWords, longDate, subjectValues, workspaceEmail } from "../email/templates.ts";
import { NotFound } from "../errors.ts";
import { emitEvent } from "../events.ts";
import { issueGuestLink, revokeGuest, type ViewerVariables } from "../guests.ts";
import { type LinkRoots, linkBase } from "../hosts.ts";
import { type Mailer, sendEmail } from "../mail.ts";
import { followersOf, notifyNow } from "../notifications.ts";
import { admit, tooMany } from "../rate-limit.ts";
import type { TenantVariables } from "../tenancy.ts";

const {
  reviews,
  reviewItems,
  reviewReviewers,
  reviewDecisionLog,
  reviewItemOpens,
  accessEvents,
  comments,
  tracks,
  versions,
  variations,
  files,
  users,
  members,
  guests,
  groups,
  groupMembers,
  guestLinks,
  guestSessions,
  projects,
  projectReviewerGrants,
} = schema;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const idParam = zValidator("param", z.object({ id: z.uuid() }));
/** One more reviewer: a member by user id, a guest by name and email, or a group. */
const addReviewerInput = z.union([
  z.object({ userId: z.string().min(1).max(64) }),
  z.object({ groupId: z.uuid() }),
  guestInput,
]);
const reviewerParam = zValidator("param", z.object({ id: z.uuid(), reviewerId: z.uuid() }));
const projectGuestParam = zValidator("param", z.object({ id: z.uuid(), guestId: z.uuid() }));

const reviewerGrantParam = zValidator(
  "param",
  z.object({
    id: z.uuid(),
    kind: z.enum(["member", "guest"]),
    personId: z.string().min(1).max(100),
  }),
);

/**
 * Someone a standing grant can be set for (#55), or 404: a member of the workspace, or a guest
 * this project knows.
 */
async function grantee(
  db: Database,
  organisationId: string,
  projectId: string,
  kind: "member" | "guest",
  personId: string,
) {
  if (kind === "guest") {
    if (!z.uuid().safeParse(personId).success) throw new NotFound("Guest");
    await projectGuest(db, organisationId, projectId, personId);
    return;
  }
  const [member] = await db
    .select({ id: members.id })
    .from(members)
    .where(inOrg(members, organisationId, eq(members.userId, personId)));
  if (!member) throw new NotFound("Member");
}

/**
 * A guest this project knows, through its reviews or its groups, or 404: a project's People
 * page acts only on its own guests.
 */
async function projectGuest(
  db: Database,
  organisationId: string,
  projectId: string,
  guestId: string,
) {
  const [known] = await db
    .select({ id: guests.id })
    .from(guests)
    .where(
      inOrg(
        guests,
        organisationId,
        eq(guests.id, guestId),
        or(
          sql`exists (select 1 from ${reviewReviewers} join ${reviews}
            on ${reviews.id} = ${reviewReviewers.reviewId}
            and ${reviews.organisationId} = ${organisationId}
            where ${reviewReviewers.guestId} = ${guests.id}
            and ${reviewReviewers.organisationId} = ${organisationId}
            and ${reviews.projectId} = ${projectId})`,
          sql`exists (select 1 from ${groupMembers} join ${groups}
            on ${groups.id} = ${groupMembers.groupId}
            and ${groups.organisationId} = ${organisationId}
            where ${groupMembers.guestId} = ${guests.id}
            and ${groupMembers.organisationId} = ${organisationId}
            and ${groups.projectId} = ${projectId})`,
        ),
      ),
    );
  if (!known) throw new NotFound("Guest");
}

export interface ReviewDeps extends LinkRoots {
  db: Database;
  audit: Audit;
  mailer: Mailer;
  trustProxy: boolean;
  /** Told when a review completes, so a workflow stage that asked for it moves on (#25). */
  onSettled?: (
    review: typeof reviews.$inferSelect,
    by: { userId: string | null; kind: "member" | "guest" },
  ) => Promise<void>;
}

/** Whoever completed a review, as its workflow's conditions see them. */
const settledBy = (actor: Actor) =>
  actor.kind === "guest"
    ? { userId: null, kind: "guest" as const }
    : { userId: actor.userId, kind: "member" as const };

/** The reviewers of a review, in order, members and guests alike, with what the rules need. */
export async function reviewersOf(db: Database | Tx, organisationId: string, reviewId: string) {
  const rows = await db
    .select({
      id: reviewReviewers.id,
      userId: reviewReviewers.userId,
      guestId: reviewReviewers.guestId,
      name: sql<string>`coalesce(${users.name}, ${guests.name})`,
      email: sql<string>`coalesce(${users.email}, ${guests.email})`,
      label: guests.label,
      position: reviewReviewers.position,
      groupId: reviewReviewers.groupId,
      groupName: groups.name,
      viewedAt: reviewReviewers.viewedAt,
      startedAt: reviewReviewers.startedAt,
      submittedAt: reviewReviewers.submittedAt,
      feedbackNote: reviewReviewers.feedbackNote,
      permissions: reviewReviewers.permissions,
      kind: reviews.kind,
    })
    .from(reviewReviewers)
    .innerJoin(
      reviews,
      and(eq(reviews.id, reviewReviewers.reviewId), eq(reviews.organisationId, organisationId)),
    )
    .leftJoin(users, eq(users.id, reviewReviewers.userId))
    .leftJoin(
      guests,
      and(eq(guests.id, reviewReviewers.guestId), eq(guests.organisationId, organisationId)),
    )
    .leftJoin(
      groups,
      and(eq(groups.id, reviewReviewers.groupId), eq(groups.organisationId, organisationId)),
    )
    .where(inOrg(reviewReviewers, organisationId, eq(reviewReviewers.reviewId, reviewId)))
    .orderBy(
      asc(reviewReviewers.position),
      asc(reviewReviewers.createdAt),
      asc(reviewReviewers.id),
    );
  const decisions = await db
    .select({
      id: reviewDecisionLog.id,
      reviewerId: reviewDecisionLog.reviewerId,
      decision: reviewDecisionLog.decision,
      note: reviewDecisionLog.note,
      createdAt: reviewDecisionLog.createdAt,
    })
    .from(reviewDecisionLog)
    .where(inOrg(reviewDecisionLog, organisationId, eq(reviewDecisionLog.reviewId, reviewId)))
    .orderBy(asc(reviewDecisionLog.createdAt), asc(reviewDecisionLog.id));
  const latest = new Map<string, ReviewDecision>();
  for (const d of decisions) latest.set(d.reviewerId, d.decision);
  const facts: ReviewerFacts[] = rows.map((r) => ({
    id: r.id,
    step: r.position,
    submitted: r.submittedAt !== null,
    decision: latest.get(r.id) ?? null,
    viewed: r.viewedAt !== null,
    started: r.startedAt !== null,
    // An approval that asks them for no decision goes on without them; a share (#138) asks
    // nothing of anyone, so nothing waits on its people.
    observer: (r.kind === "approval" && !r.permissions.decide) || r.kind === "share",
  }));
  return { rows, decisions, facts };
}
type ReviewerRow = Awaited<ReturnType<typeof reviewersOf>>["rows"][number];

/** The actor's own row among a review's reviewers, if they are one. */
const mineOf = (rows: ReviewerRow[], actor: Actor) =>
  rows.find((r) =>
    actor.kind === "guest" ? r.guestId === actor.guestId : r.userId === actor.userId,
  );

/**
 * Whether a reviewer's own permissions let them act in the review now: their access window
 * is open and, for a decision, the review asks them for one. A member's role still applies.
 */
function mayAct(me: ReviewerRow, act: "decide" | "submit" | "comment", now = new Date()) {
  if (!withinWindow(me.permissions, now)) return false;
  return act === "decide"
    ? me.permissions.decide
    : act === "comment"
      ? me.permissions.comment
      : true;
}

/** Only members manage reviews; a guest asking gets the same refusal as a lesser role. */
function memberOnly(actor: Actor): MemberActor {
  if (actor.kind === "guest") {
    throw new HTTPException(403, { message: "Guests can take part in a review, not manage it" });
  }
  return actor;
}

/**
 * Settle a review after any change: once the rules give an outcome, it is complete. Runs
 * inside the transaction that made the change, with the review row locked.
 */
async function settle(tx: Tx, review: typeof reviews.$inferSelect) {
  if (review.status !== "open") return review;
  const { facts } = await reviewersOf(tx, review.organisationId, review.id);
  const outcome = reviewOutcome(review.kind, review.rule, facts, review.share);
  if (!outcome) return review;
  const [done] = await tx
    .update(reviews)
    .set({ status: "completed", outcome, completedAt: new Date(), updatedAt: new Date() })
    .where(inOrg(reviews, review.organisationId, eq(reviews.id, review.id)))
    .returning();
  return done ?? review;
}

/** Lock a review for a change, or 404 when the actor may not see it. */
async function lockReview(tx: Tx, actor: Actor, reviewId: string) {
  const [review] = await tx
    .select()
    .from(reviews)
    .where(inOrg(reviews, actor.organisationId, eq(reviews.id, reviewId)))
    .for("update");
  const access = review ? await reviewAccess(tx, actor, review) : null;
  if (!review || !access) throw new NotFound("Review");
  return { review, access };
}

const cannotDecide =
  "Every reviewer of an approval must have a role in this project that can decide";

/** The items as a reviewer opens them: for a track, the version under review and its primary file. */
async function itemsOf(db: Database, organisationId: string, reviewId: string) {
  const rows = await db
    .select({
      id: reviewItems.id,
      trackId: reviewItems.trackId,
      versionId: reviewItems.versionId,
      fileId: reviewItems.fileId,
      trackName: tracks.name,
      fileName: files.name,
      fileKind: files.kind,
    })
    .from(reviewItems)
    .leftJoin(
      tracks,
      and(eq(tracks.id, reviewItems.trackId), eq(tracks.organisationId, organisationId)),
    )
    .leftJoin(
      files,
      and(eq(files.id, reviewItems.fileId), eq(files.organisationId, organisationId)),
    )
    .where(inOrg(reviewItems, organisationId, eq(reviewItems.reviewId, reviewId)))
    .orderBy(asc(reviewItems.position));
  return Promise.all(
    rows.map(async (item) => {
      if (!item.trackId) {
        return {
          id: item.id,
          kind: "file" as const,
          fileId: item.fileId,
          name: item.fileName,
          fileKind: item.fileKind,
          /** Every file the item covers, for what reviewers opened and said about it. */
          fileIds: item.fileId ? [item.fileId] : [],
        };
      }
      // A specific version, or the track's latest as it is now.
      const [version] = await db
        .select({ id: versions.id, number: versions.number })
        .from(versions)
        .where(
          inOrg(
            versions,
            organisationId,
            item.versionId ? eq(versions.id, item.versionId) : eq(versions.trackId, item.trackId),
          ),
        )
        .orderBy(desc(versions.number))
        .limit(1);
      const treatments = version
        ? await db
            .select({
              fileId: variations.fileId,
              name: variations.name,
              primary: variations.isPrimary,
            })
            .from(variations)
            .where(inOrg(variations, organisationId, eq(variations.versionId, version.id)))
            .orderBy(desc(variations.isPrimary), asc(variations.createdAt))
        : [];
      const primary = treatments.find((t) => t.primary) ?? treatments[0];
      return {
        id: item.id,
        kind: "track" as const,
        trackId: item.trackId,
        name: item.trackName,
        follows: item.versionId ? ("version" as const) : ("latest" as const),
        version: version ? { ...version, variations: treatments.map((t) => t.name) } : null,
        fileId: primary?.fileId ?? null,
        fileIds: treatments.map((t) => t.fileId),
      };
    }),
  );
}

/** What the review page's activity lists from the access log; decisions come from their own log. */
const activityActions = [
  "review.create",
  "review.submit",
  "review.cancel",
  "review.remind",
  "review.due",
  "review.reviewer_add",
  "review.reviewer_remove",
  "guest.link",
  "guest.view",
  "guest.revoke",
] as const;

/**
 * A review's activity, newest first: who asked, reminded, changed the date, added or removed
 * whom, who was sent a link and opened it, and every decision and submission with its note.
 * Names only: the addresses and network details in the access log stay there.
 */
async function activityOf(
  db: Database,
  organisationId: string,
  review: typeof reviews.$inferSelect,
  rows: ReviewerRow[],
  decisions: {
    id: string;
    reviewerId: string;
    decision: ReviewDecision;
    note: string | null;
    createdAt: Date;
  }[],
) {
  const events = await db
    .select({
      id: accessEvents.id,
      action: accessEvents.action,
      at: accessEvents.occurredAt,
      label: accessEvents.actorLabel,
      userId: accessEvents.userId,
      guestId: accessEvents.guestId,
      details: accessEvents.details,
    })
    .from(accessEvents)
    .where(
      inOrg(
        accessEvents,
        organisationId,
        eq(accessEvents.reviewId, review.id),
        inArray(accessEvents.action, [...activityActions]),
      ),
    )
    .orderBy(desc(accessEvents.id))
    .limit(200);
  // The log keeps "Name <address>", and "(guest)" for guests: the page shows the name.
  const nameOfLabel = (label: string) => {
    let name = label.trim();
    if (name.endsWith(" (guest)")) name = name.slice(0, -" (guest)".length).trimEnd();
    const address = name.lastIndexOf(" <");
    if (address >= 0 && name.endsWith(">")) name = name.slice(0, address);
    return name.trim();
  };
  const reviewerOf = (e: { userId: string | null; guestId: string | null }) =>
    rows.find((row) => (e.guestId ? row.guestId === e.guestId : row.userId === e.userId));
  const detail = (e: (typeof events)[number], key: string) => {
    const value = e.details?.[key];
    return typeof value === "string" ? value : null;
  };
  const entries = events.map((e) => {
    const guestId = detail(e, "guestId");
    return {
      id: e.id,
      action: e.action,
      name: nameOfLabel(e.label),
      at: e.at,
      decision: null as ReviewDecision | null,
      /** Who it concerned: the reviewer added, removed, reminded or revoked. */
      subject:
        detail(e, "name") ??
        (guestId ? (rows.find((row) => row.guestId === guestId)?.name ?? null) : null),
      note:
        e.action === "review.submit"
          ? (reviewerOf(e)?.feedbackNote ?? null)
          : e.action === "review.cancel"
            ? review.cancelReason
            : null,
      dueAt: e.action === "review.due" ? detail(e, "dueAt") : null,
    };
  });
  for (const d of decisions) {
    entries.push({
      id: d.id,
      action: "review.decision",
      name: rows.find((row) => row.id === d.reviewerId)?.name ?? "A former member",
      at: d.createdAt,
      decision: d.decision,
      subject: null,
      note: d.note,
      dueAt: null,
    });
  }
  return entries.sort((a, b) => b.at.getTime() - a.at.getTime() || b.id.localeCompare(a.id));
}

/** Everything the review page shows, from the point of view of whoever is asking. */
async function reviewView(db: Database, actor: Actor, reviewId: string) {
  const [review] = await db
    .select({ review: reviews, createdByName: users.name })
    .from(reviews)
    .leftJoin(users, eq(users.id, reviews.createdBy))
    .where(inOrg(reviews, actor.organisationId, eq(reviews.id, reviewId)));
  const access = review ? await reviewAccess(db, actor, review.review) : null;
  if (!review || !access) throw new NotFound("Review");
  const { rows, decisions, facts } = await reviewersOf(db, actor.organisationId, reviewId);
  const r = review.review;
  const active = r.status === "open" ? activeReviewers(r.order, facts) : new Set<string>();
  const latest = new Map(decisions.map((d) => [d.reviewerId, d]));
  const me = mineOf(rows, actor);
  const member = actor.kind !== "guest";
  const org = actor.organisationId;
  // A guest sees the items their review shows them, when it names some (#55).
  const shown = actor.kind === "guest" && me ? readGrant(me.permissions).items : null;
  const items = (await itemsOf(db, org, reviewId)).filter((i) => !shown || shown.includes(i.id));
  const covered = [...new Set(items.flatMap((i) => i.fileIds))];
  // Which items each reviewer has opened.
  const opens =
    rows.length > 0
      ? await db
          .select({ reviewerId: reviewItemOpens.reviewerId, itemId: reviewItemOpens.itemId })
          .from(reviewItemOpens)
          .where(
            inOrg(
              reviewItemOpens,
              org,
              inArray(
                reviewItemOpens.reviewerId,
                rows.map((row) => row.id),
              ),
            ),
          )
      : [];
  // What each reviewer said on the files under review since it was asked, and where it
  // starts; members only, as a guest's view of others' comments follows their review.
  const said =
    member && covered.length > 0
      ? await db
          .select({
            userId: comments.authorId,
            guestId: comments.guestAuthorId,
            count: count(),
            fileId: sql<string>`(array_agg(${comments.fileId} order by ${comments.createdAt}))[1]`,
            commentId: sql<string>`(array_agg(${comments.id} order by ${comments.createdAt}))[1]`,
          })
          .from(comments)
          .where(
            inOrg(
              comments,
              org,
              inArray(comments.fileId, covered),
              isNull(comments.parentId),
              gte(comments.createdAt, r.createdAt),
            ),
          )
          .groupBy(comments.authorId, comments.guestAuthorId)
      : [];
  // Open threads on each item's file, for those who triage them.
  const primaries = items.flatMap((i) => (i.fileId ? [i.fileId] : []));
  const open =
    member && primaries.length > 0
      ? await db
          .select({ fileId: comments.fileId, count: count() })
          .from(comments)
          .where(
            inOrg(
              comments,
              org,
              inArray(comments.fileId, primaries),
              isNull(comments.parentId),
              isNull(comments.resolvedAt),
            ),
          )
          .groupBy(comments.fileId)
      : [];
  // A share's people, as those who run it see them (#138): how often each played and took
  // away what was shared.
  const usage =
    r.kind === "share" && member && access.permissions.has("manage_reviewers")
      ? await shareUsage(db, org, r, rows, covered)
      : null;
  // Its project's profile, so a guest's page names its items in the project's words (#16).
  const [project] = await db
    .select({ profile: projects.profile })
    .from(projects)
    .where(inOrg(projects, org, eq(projects.id, r.projectId)));
  return {
    ...r,
    profile: project?.profile ?? "general",
    createdByName: review.createdByName,
    cancelledByName: r.cancelledBy ? await nameOf(db, r.cancelledBy) : null,
    items: items.map(({ fileIds: _, ...item }) => ({
      ...item,
      openComments: member ? (open.find((o) => o.fileId === item.fileId)?.count ?? 0) : null,
    })),
    activity: member ? await activityOf(db, org, r, rows, decisions) : [],
    reviewers: rows.map((row, i) => ({
      id: row.id,
      userId: row.userId,
      guest: row.guestId !== null,
      name: row.name,
      label: row.label,
      /** The group they were asked through, if any: its members share one step. */
      group: row.groupId ? { id: row.groupId, name: row.groupName } : null,
      step: row.position,
      // Guests see who else is reviewing, but not their addresses.
      email: member ? row.email : null,
      state:
        r.status === "open"
          ? reviewerState(r.order, facts, facts[i] as ReviewerFacts)
          : row.submittedAt
            ? "submitted"
            : "waiting",
      decision: latest.get(row.id)?.decision ?? null,
      decidedAt: latest.get(row.id)?.createdAt ?? null,
      submittedAt: row.submittedAt,
      viewedAt: row.viewedAt,
      /** Their latest decision's note, or what they said with their feedback. */
      note: latest.get(row.id)?.note ?? row.feedbackNote ?? null,
      /** Their comments on the items since the review was asked, and the first of them. */
      comments: (() => {
        const theirs = said.find((c) =>
          row.guestId ? c.guestId === row.guestId : c.userId === row.userId,
        );
        return theirs
          ? { count: theirs.count, fileId: theirs.fileId, commentId: theirs.commentId }
          : null;
      })(),
      /** A share's plays and downloads by this person, for those who run it; else null. */
      usage: usage ? (usage.get(row.id) ?? { plays: 0, downloads: 0 }) : null,
      // Each reviewer's permissions are for those who manage reviewers, and for themselves.
      permissions:
        (member && access.permissions.has("manage_reviewers")) || row.id === me?.id
          ? row.permissions
          : null,
    })),
    decisions: decisions
      .map((d) => ({
        ...d,
        reviewerName: rows.find((row) => row.id === d.reviewerId)?.name ?? null,
      }))
      .reverse(),
    /** What the viewer can do here now; the server checks again on every action. */
    you: {
      guest: !member,
      reviewerId: me?.id ?? null,
      /** The items they have opened. */
      opened: opens.filter((o) => o.reviewerId === me?.id).map((o) => o.itemId),
      active: me ? active.has(me.id) : false,
      // Changing your decision stays possible while the review is open.
      canDecide:
        Boolean(me) &&
        r.kind === "approval" &&
        r.status === "open" &&
        access.permissions.has("decide") &&
        Boolean(me && mayAct(me, "decide")) &&
        (active.has(me?.id ?? "") || Boolean(me?.submittedAt)),
      canSubmit:
        Boolean(me && mayAct(me, "submit")) &&
        r.kind === "feedback" &&
        r.status === "open" &&
        active.has(me?.id ?? ""),
      permissions: me?.permissions ?? null,
      canManage: member && r.status === "open" && access.permissions.has("request_reviews"),
      canManageReviewers:
        member && r.status === "open" && access.permissions.has("manage_reviewers"),
      // A reviewer their grant lets invite others (#55), while the review is open to them.
      canInvite:
        Boolean(me?.permissions.invite) &&
        r.status === "open" &&
        Boolean(me && withinWindow(me.permissions, new Date())),
    },
  };
}

/**
 * How often each of a share's people played and downloaded what it shares (#138), from the
 * access log. A guest's plays and downloads carry the share; a member's carry only the file,
 * so theirs are the shared files' since it was shared, until it ended.
 */
async function shareUsage(
  db: Database,
  organisationId: string,
  review: { id: string; createdAt: Date; completedAt: Date | null },
  rows: ReviewerRow[],
  fileIds: string[],
) {
  const counted = ["stream.session", "download"] as const;
  const guests = rows.flatMap((r) => (r.guestId ? [r.guestId] : []));
  const members = rows.flatMap((r) => (r.userId ? [r.userId] : []));
  const ended = review.completedAt;
  const [byGuest, byMember] = await Promise.all([
    guests.length > 0
      ? db
          .select({ who: accessEvents.guestId, action: accessEvents.action, n: count() })
          .from(accessEvents)
          .where(
            inOrg(
              accessEvents,
              organisationId,
              eq(accessEvents.reviewId, review.id),
              inArray(accessEvents.guestId, guests),
              inArray(accessEvents.action, [...counted]),
            ),
          )
          .groupBy(accessEvents.guestId, accessEvents.action)
      : [],
    members.length > 0 && fileIds.length > 0
      ? db
          .select({ who: accessEvents.userId, action: accessEvents.action, n: count() })
          .from(accessEvents)
          .where(
            inOrg(
              accessEvents,
              organisationId,
              inArray(accessEvents.userId, members),
              inArray(accessEvents.fileId, fileIds),
              inArray(accessEvents.action, [...counted]),
              gte(accessEvents.occurredAt, review.createdAt),
              ...(ended ? [lte(accessEvents.occurredAt, ended)] : []),
            ),
          )
          .groupBy(accessEvents.userId, accessEvents.action)
      : [],
  ]);
  const out = new Map<string, { plays: number; downloads: number }>();
  for (const row of rows) {
    const theirs = row.guestId
      ? byGuest.filter((e) => e.who === row.guestId)
      : byMember.filter((e) => e.who === row.userId);
    out.set(row.id, {
      plays: theirs.find((e) => e.action === "stream.session")?.n ?? 0,
      downloads: theirs.find((e) => e.action === "download")?.n ?? 0,
    });
  }
  return out;
}

/** A member's name, for the opening of a review request. */
async function nameOf(db: Database, userId: string) {
  const [user] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId));
  return user?.name ?? "A colleague";
}

/** What to ask for, in a sentence: "approve" or "give feedback on" the review. */
const ask = (review: { kind: string; title: string }, follow = false) =>
  `${follow ? "follow" : review.kind === "approval" ? "approve" : "give feedback on"} "${review.title}"`;

/**
 * Whether someone told of an approval only follows it (#221): they may not decide, so they
 * hold nothing up and are asked to follow, never to approve.
 */
const follows = (
  review: { kind: string },
  person: { permissions?: Partial<Pick<ReviewerPermissions, "decide">> | null },
) => review.kind === "approval" && person.permissions?.decide === false;

type ReviewForMail = {
  id: string;
  createdBy: string | null;
  organisationId: string;
  projectId: string;
  title: string;
  kind: string;
  message: string | null;
  dueAt: Date | null;
};

/**
 * Tell reviewers they have something to review. Members are notified, in the app and by
 * mail as they prefer; guests get a fresh magic link by mail, logged. A mail that fails is
 * logged, never fatal: the review stands, and a guest's link can be re-sent.
 */
async function notify(
  deps: ReviewDeps,
  people: SharePerson[],
  review: ReviewForMail,
  /** In a sequence, whether those before them have responded. */
  turn: boolean,
  /**
   * Who is asking, when not whoever requested the review: the notification is from them. A
   * guest who invites someone (#55) has no account, so no user.
   */
  asking?: { userId: string | null; name: string },
  /** A reminder of a review they were already asked about, rather than the first ask. */
  reminder = false,
) {
  if (review.kind === "share") return notifyShare(deps, people, review, asking);
  const context = await mailContext(deps.db, review);
  // A guest's link opens at the workspace's own address with subdomains on (#437).
  const base = linkBase(deps, context?.slug);
  const requester =
    asking?.name ?? (review.createdBy ? await nameOf(deps.db, review.createdBy) : "A colleague");
  const from = asking ? asking.userId : review.createdBy;
  const data = {
    workspace: context?.workspace ?? "Hekate",
    requester,
    review: review.title,
    kind: review.kind as ReviewKind,
    project: context?.project ?? "",
    dueAt: review.dueAt,
  };
  // An observer has no turn: nothing waits on them.
  const messageFor = (follow: boolean) =>
    [
      reminder ? `A reminder from ${requester}: this review is still waiting on you.` : null,
      review.message,
      turn && !reminder && !follow ? "Those before you have responded; it is your turn." : null,
    ]
      .filter(Boolean)
      .join("\n\n");
  for (const follow of [false, true]) {
    const members = people.flatMap((p) =>
      p.userId && follows(review, p) === follow ? [p.userId] : [],
    );
    if (members.length === 0) continue;
    await notifyNow(deps, {
      organisationId: review.organisationId,
      kind: "review_requested",
      recipients: members,
      actor: from ? { userId: from } : null,
      projectId: review.projectId,
      reviewId: review.id,
      text: reminder
        ? `reminds you to ${ask(review, follow)}`
        : `asks you to ${ask(review, follow)}`,
      detail:
        [review.message, review.dueAt ? `Due ${longDate(review.dueAt)}.` : null]
          .filter(Boolean)
          .join("\n\n") || null,
      link: `/reviews/${review.id}`,
      mail: {
        template: "review_requested",
        values: subjectValues("review_requested", {
          ...data,
          message: messageFor(follow),
          url: "",
          ...(follow ? { follow: { comment: true } } : {}),
        }),
      },
    }).catch((error: unknown) =>
      console.warn(`Could not tell a reviewer about a review: ${String(error)}`),
    );
  }
  for (const person of people) {
    if (!person.guestId) continue;
    const issued = await issueGuestLink(deps.db, review.organisationId, person.guestId);
    await deps.audit.record(review.organisationId, await deps.audit.guest(person.guestId), {
      action: "guest.link",
      projectId: review.projectId,
      reviewId: review.id,
    });
    const email = workspaceEmail(
      "review_requested",
      {
        ...data,
        message: messageFor(follows(review, person)),
        url: `${base}/guest/${issued.token}`,
        guestLinkDays: issued.days,
        ...(follows(review, person)
          ? { follow: { comment: person.permissions?.comment !== false } }
          : {}),
      },
      workspaceSettingsOf(context?.settings).emailSubjects,
    );
    await sendEmail(deps.mailer, person.email, email, review.organisationId).catch(
      (error: unknown) =>
        console.warn(`Could not send the review request to a reviewer: ${String(error)}`),
    );
  }
}

/** Someone told of a review: who they are, and what they may do in it. */
type SharePerson = Pick<ReviewerRow, "email" | "guestId" | "userId"> & {
  /** What they may do: an approval's observer is asked to follow it; a share says how long. */
  permissions?: Partial<
    Pick<ReviewerPermissions, "decide" | "comment" | "expiresAt" | "download" | "maxPlays">
  > | null;
};

/** The workspace and project a review's mail speaks for. */
async function mailContext(db: Database, review: ReviewForMail) {
  const [context] = await db
    .select({
      workspace: schema.organisations.name,
      slug: schema.organisations.slug,
      settings: schema.organisations.settings,
      project: schema.projects.name,
    })
    .from(schema.projects)
    .innerJoin(schema.organisations, eq(schema.organisations.id, schema.projects.organisationId))
    .where(inOrg(schema.projects, review.organisationId, eq(schema.projects.id, review.projectId)));
  return context;
}

/**
 * Tell people something has been shared with them (#138): members in the app and by mail as
 * they prefer, guests with a fresh link, logged. Nothing is asked of them, so the words say
 * how long it is theirs, how often they may play it and what they may take away.
 */
async function notifyShare(
  deps: ReviewDeps,
  people: SharePerson[],
  review: ReviewForMail,
  asking?: { userId: string | null; name: string },
) {
  const context = await mailContext(deps.db, review);
  const base = linkBase(deps, context?.slug);
  const requester =
    asking?.name ?? (review.createdBy ? await nameOf(deps.db, review.createdBy) : "A colleague");
  const from = asking ? asking.userId : review.createdBy;
  const subjects = workspaceSettingsOf(context?.settings).emailSubjects;
  const dataFor = (person: SharePerson) => ({
    workspace: context?.workspace ?? "Hekate",
    requester,
    review: review.title,
    project: context?.project ?? "",
    message: review.message,
    expiresAt: person.permissions?.expiresAt ? new Date(person.permissions.expiresAt) : null,
    download: person.permissions?.download ?? "none",
    maxPlays: person.permissions?.maxPlays ?? null,
  });
  for (const person of people) {
    if (!person.userId) continue;
    const data = dataFor(person);
    await notifyNow(deps, {
      organisationId: review.organisationId,
      kind: "review_requested",
      recipients: [person.userId],
      actor: from ? { userId: from } : null,
      projectId: review.projectId,
      reviewId: review.id,
      text: `shared "${review.title}" with you`,
      // The share's own words, as a guest's mail has them: until when, how often, what to keep.
      detail: workspaceEmail("shared", { ...data, url: "" }, subjects).body.join("\n\n"),
      link: `/reviews/${review.id}`,
      mail: { template: "shared", values: subjectValues("shared", { ...data, url: "" }) },
    }).catch((error: unknown) =>
      console.warn(`Could not tell someone about a share: ${String(error)}`),
    );
  }
  for (const person of people) {
    if (!person.guestId) continue;
    const issued = await issueGuestLink(deps.db, review.organisationId, person.guestId);
    await deps.audit.record(review.organisationId, await deps.audit.guest(person.guestId), {
      action: "guest.link",
      projectId: review.projectId,
      reviewId: review.id,
    });
    const email = workspaceEmail(
      "shared",
      { ...dataFor(person), url: `${base}/guest/${issued.token}`, guestLinkDays: issued.days },
      subjects,
    );
    await sendEmail(deps.mailer, person.email, email, review.organisationId).catch(
      (error: unknown) => console.warn(`Could not send a share to someone: ${String(error)}`),
    );
  }
}

/** Who acted, as an event names them. */
const eventActor = (actor: Actor) =>
  actor.kind === "guest" ? { guestId: actor.guestId } : { userId: actor.userId };

const decisionText: Record<ReviewDecision, (title: string) => string> = {
  approved: (title) => `approved "${title}"`,
  changes_requested: (title) => `requested changes on "${title}"`,
};

/** Tell whoever asked for a review, and anyone following it, that a reviewer has acted. */
async function tellRequester(
  deps: ReviewDeps,
  review: ReviewForMail,
  actor: Actor,
  decision: ReviewDecision | "feedback",
  note?: string | null,
) {
  const followers = await followersOf(deps.db, review.organisationId, { reviewId: review.id });
  const [project] = await deps.db
    .select({ name: schema.projects.name })
    .from(schema.projects)
    .where(inOrg(schema.projects, review.organisationId, eq(schema.projects.id, review.projectId)));
  const text =
    decision === "feedback"
      ? `gave feedback on "${review.title}"`
      : decisionText[decision](review.title);
  await notifyNow(deps, {
    organisationId: review.organisationId,
    kind: "decision",
    recipients: [...(review.createdBy ? [review.createdBy] : []), ...followers],
    actor: actor.kind === "guest" ? { guestId: actor.guestId } : { userId: actor.userId },
    projectId: review.projectId,
    reviewId: review.id,
    text,
    detail: note?.trim() || null,
    link: `/reviews/${review.id}`,
    mail: {
      template: "decision",
      values: {
        review: review.title,
        decision: decisionWords[decision],
        project: project?.name ?? "",
      },
    },
  }).catch((error: unknown) =>
    console.warn(`Could not tell the requester about a decision: ${String(error)}`),
  );
}

/** Reviewers newly able to act after a change: in a sequence, the next one. */
function newlyActive(before: Set<string>, after: Set<string>) {
  return [...after].filter((id) => !before.has(id));
}

type Person = { userId: string; guestId?: undefined } | { guestId: string; userId?: undefined };

/**
 * Who an entry names: a member who can see the project (and, for an approval, decide), a
 * guest found (or created) by email in the organisation, or a guest already on file.
 * Guests may always decide: the review sets what they can do. With no kind (a group being
 * saved), any role that can see the project will do.
 */
/** How many people one reviewer may invite to reviews in an hour. */
const INVITES_PER_HOUR = 10;

/** A guest by email, made or brought up to date with the details given. Returns their id. */
async function upsertGuest(
  tx: Database | Tx,
  organisationId: string,
  entry: GuestInput,
  /** The member who asked them; null when another reviewer invited them. */
  createdBy: string | null,
) {
  const [found] = await tx
    .insert(guests)
    .values({
      organisationId,
      name: entry.name,
      email: entry.email,
      label: entry.label || null,
      createdBy,
    })
    .onConflictDoUpdate({
      target: [guests.organisationId, guests.email],
      // Keep their details current with the latest invitation.
      set: { name: entry.name, label: entry.label || null, updatedAt: new Date() },
    })
    .returning({ id: guests.id });
  if (!found) throw new Error("Guest upsert returned no row");
  return found.id;
}

export async function resolvePerson(
  tx: Database | Tx,
  actor: MemberActor,
  review: { projectId: string; kind: ReviewKind | null },
  entry: PersonInput | { guestId: string },
): Promise<Person> {
  if (typeof entry !== "string" && "guestId" in entry) {
    const [found] = await tx
      .select({ id: guests.id })
      .from(guests)
      .where(inOrg(guests, actor.organisationId, eq(guests.id, entry.guestId)));
    if (!found) throw new HTTPException(422, { message: "That guest is not known here" });
    return { guestId: found.id };
  }
  if (typeof entry !== "string") {
    return { guestId: await upsertGuest(tx, actor.organisationId, entry, actor.userId) };
  }
  const [person] = await tx
    .select({ role: members.role })
    .from(members)
    .where(inOrg(members, actor.organisationId, eq(members.userId, entry)));
  const sees =
    person &&
    (await projectAccess(
      tx,
      { userId: entry, organisationId: actor.organisationId, organisationRole: person.role },
      review.projectId,
    ));
  if (!sees) {
    throw new HTTPException(422, {
      message: "Every member reviewer must be able to see this project",
    });
  }
  if (review.kind === "approval" && !sees.permissions.has("decide")) {
    throw new HTTPException(422, { message: cannotDecide });
  }
  return { userId: entry };
}

/**
 * The reviewer rows for some entries, from the given step on: each entry is a step, and a
 * group is all of its members, as they are now, at one step. Someone named twice (alone
 * and in a group, or in two groups) is asked once, at their first step.
 */
async function expandReviewers(
  tx: Tx,
  actor: MemberActor,
  review: { projectId: string; kind: ReviewKind },
  entries: ReviewStepInput[],
  firstStep: number,
) {
  const rows: (Person & { position: number; groupId: string | null })[] = [];
  const seen = new Set<string>();
  const add = (person: Person, position: number, groupId: string | null) => {
    const key = person.userId ? `u:${person.userId}` : `g:${person.guestId}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ ...person, position, groupId });
  };
  // Each step is one position in the order: everyone in it, groups included, is asked together.
  const flat = entries.flatMap((step, i) =>
    (Array.isArray(step) ? step : [step]).map((entry) => ({ entry, position: firstStep + i })),
  );
  for (const { entry, position } of flat) {
    if (typeof entry === "string" || !("groupId" in entry)) {
      add(await resolvePerson(tx, actor, review, entry), position, null);
      continue;
    }
    const [group] = await tx
      .select({ id: groups.id, name: groups.name })
      .from(groups)
      .where(
        inOrg(
          groups,
          actor.organisationId,
          eq(groups.id, entry.groupId),
          eq(groups.projectId, review.projectId),
        ),
      );
    if (!group) throw new HTTPException(422, { message: "Groups must come from this project" });
    const people = await tx
      .select({ userId: groupMembers.userId, guestId: groupMembers.guestId })
      .from(groupMembers)
      .where(inOrg(groupMembers, actor.organisationId, eq(groupMembers.groupId, group.id)))
      .orderBy(asc(groupMembers.position));
    if (people.length === 0) {
      throw new HTTPException(422, { message: `${group.name} has no one in it` });
    }
    for (const p of people) {
      const person = await resolvePerson(
        tx,
        actor,
        review,
        p.userId ? p.userId : { guestId: p.guestId as string },
      ).catch((error: unknown) => {
        if (!(error instanceof HTTPException)) throw error;
        throw new HTTPException(422, { message: `In ${group.name}: ${error.message}` });
      });
      add(person, position, group.id);
    }
  }
  return rows;
}

/**
 * What each person starts with in a review of this project: what the review grants everyone,
 * with what the project's People page says for them on top (#55). The more particular wins.
 */
async function standingFor(
  tx: Tx,
  organisationId: string,
  projectId: string,
  people: Pick<Person, "userId" | "guestId">[],
  granted: ReviewerPermissions,
): Promise<ReviewerPermissions[]> {
  const userIds = people.flatMap((p) => (p.userId ? [p.userId] : []));
  const guestIds = people.flatMap((p) => (p.guestId ? [p.guestId] : []));
  if (userIds.length === 0 && guestIds.length === 0) return people.map(() => granted);
  const standing = await tx
    .select({
      userId: projectReviewerGrants.userId,
      guestId: projectReviewerGrants.guestId,
      grant: projectReviewerGrants.grant,
    })
    .from(projectReviewerGrants)
    .where(
      inOrg(
        projectReviewerGrants,
        organisationId,
        eq(projectReviewerGrants.projectId, projectId),
        or(
          userIds.length ? inArray(projectReviewerGrants.userId, userIds) : sql`false`,
          guestIds.length ? inArray(projectReviewerGrants.guestId, guestIds) : sql`false`,
        ),
      ),
    );
  return people.map((person) => {
    const theirs = standing.find((g) =>
      person.userId ? g.userId === person.userId : g.guestId === person.guestId,
    );
    // A standing grant has no dates, so it always fits what the review grants.
    return theirs ? (applyPermissions(granted, theirs.grant).data ?? granted) : granted;
  });
}

/**
 * Each person's permissions in a new review: what the request grants everyone, then what the
 * project's People page says for them, then any override given for them in the request (by
 * `reviewerKey`: a member by user id, a guest by email). An approval reviewer left unable to
 * decide only follows it.
 */
async function overridden(
  tx: Tx,
  organisationId: string,
  projectId: string,
  people: Person[],
  granted: ReviewerPermissions,
  overrides: Record<string, ReviewerPermissionsChange>,
) {
  const bases = await standingFor(tx, organisationId, projectId, people, granted);
  if (Object.keys(overrides).length === 0) return bases;
  const guestIds = people.flatMap((p) => (p.guestId ? [p.guestId] : []));
  const emails = new Map(
    guestIds.length
      ? (
          await tx
            .select({ id: guests.id, email: guests.email })
            .from(guests)
            .where(inOrg(guests, organisationId, inArray(guests.id, guestIds)))
        ).map((g) => [g.id, g.email])
      : [],
  );
  return people.map((person, i) => {
    const base = bases[i] ?? granted;
    const key = person.userId
      ? `member:${person.userId}`
      : `guest:${(person.guestId && emails.get(person.guestId)) || ""}`;
    const change = overrides[key];
    if (!change) return base;
    const result = applyPermissions(base, change);
    if (!result.success) {
      throw new HTTPException(422, {
        message: result.error.issues[0]?.message ?? "Those permissions do not fit together",
      });
    }
    return result.data;
  });
}

/**
 * Asks for a review (#20): the items, checked to be in the project, the reviewers expanded from
 * people, guests and groups, each one's permissions, the audit entry, and the first reviewers
 * told. The route asks it for a member who may request reviews; a workflow's stage (#25) asks
 * it for the member its run started with, and the review is linked to that stage.
 */
export async function requestReview(
  deps: ReviewDeps,
  actor: MemberActor,
  projectId: string,
  input: z.infer<typeof createReviewInput>,
  request: RequestInfo,
  link?: { runId: string; nodeId: string },
) {
  const organisationId = actor.organisationId;

  // Every item must be in this project. Their names title a request that has none.
  const names: string[] = [];
  for (const item of input.items) {
    if ("fileId" in item) {
      const [file] = await deps.db
        .select({ id: files.id, name: files.name })
        .from(files)
        .where(
          inOrg(files, organisationId, eq(files.id, item.fileId), eq(files.projectId, projectId)),
        );
      if (!file) throw new HTTPException(422, { message: "Items must come from this project" });
      names.push(file.name);
    } else {
      const [track] = await deps.db
        .select({ id: tracks.id, name: tracks.name })
        .from(tracks)
        .where(
          inOrg(
            tracks,
            organisationId,
            eq(tracks.id, item.trackId),
            eq(tracks.projectId, projectId),
          ),
        );
      const version = item.versionId
        ? (
            await deps.db
              .select({ id: versions.id })
              .from(versions)
              .where(
                inOrg(
                  versions,
                  organisationId,
                  eq(versions.id, item.versionId),
                  eq(versions.trackId, item.trackId),
                ),
              )
          )[0]
        : true;
      if (!track || !version) {
        throw new HTTPException(422, { message: "Items must come from this project" });
      }
      names.push(track.name);
    }
  }

  // The workspace's defaults, with whatever the request says on top.
  const [workspace] = await deps.db
    .select({ settings: schema.organisations.settings })
    .from(schema.organisations)
    .where(eq(schema.organisations.id, organisationId));
  const granted = applyPermissions(
    // A default window runs from when access opens.
    reviewerDefaults(
      workspaceSettingsOf(workspace?.settings),
      input.permissions?.startsAt ? new Date(input.permissions.startsAt) : new Date(),
    ),
    input.permissions ?? {},
  );
  if (!granted.success) {
    throw new HTTPException(422, {
      message: granted.error.issues[0]?.message ?? "Those permissions do not fit together",
    });
  }
  // A share asks nothing (#138): its people listen and look, whatever the defaults say.
  if (input.kind === "share") granted.data = shareGrant(granted.data);
  const who = await deps.audit.member(actor.userId);
  const review = await deps.db.transaction(async (tx) => {
    // Not into a project being archived: archiving closes every open review.
    await lockLiveProject(tx, organisationId, projectId);
    if (link) {
      // A stage's review only while its run still waits on the stage: the run may have moved
      // past it since the stage began (another branch finished it, or someone ended it).
      const [run] = await tx
        .select({ state: schema.workflowRuns.state, engine: schema.workflowRuns.engine })
        .from(schema.workflowRuns)
        .where(inOrg(schema.workflowRuns, organisationId, eq(schema.workflowRuns.id, link.runId)))
        .for("update");
      if (run?.state !== "running" || !run.engine.active.includes(link.nodeId)) return null;
    }
    const [created] = await tx
      .insert(reviews)
      .values({
        organisationId,
        projectId,
        kind: input.kind,
        title: input.title ?? reviewTitleFor(names),
        message: input.message || null,
        dueAt: input.dueAt ? new Date(input.dueAt) : null,
        remind: input.remind,
        order: input.order,
        rule: input.rule,
        share: input.share,
        grant: granted.data,
        createdBy: actor.userId,
        workflowRunId: link?.runId ?? null,
        workflowNodeId: link?.nodeId ?? null,
      })
      .returning();
    if (!created) throw new Error("Review insert returned no row");
    await tx.insert(reviewItems).values(
      input.items.map((item, position) => ({
        organisationId,
        reviewId: created.id,
        position,
        ...("fileId" in item
          ? { fileId: item.fileId }
          : { trackId: item.trackId, versionId: item.versionId ?? null }),
      })),
    );
    const people = await expandReviewers(
      tx,
      actor,
      { projectId, kind: input.kind },
      input.reviewers,
      0,
    );
    const permissions = (
      await overridden(tx, organisationId, projectId, people, granted.data, input.overrides ?? {})
    ).map((p) => (input.kind === "share" && p ? shareGrant(p) : p));
    // Overrides may take the decision from everyone; such an approval would never end.
    if (
      input.kind === "approval" &&
      !people.some((_, i) => (permissions[i] ?? granted.data).decide)
    ) {
      throw new HTTPException(422, {
        // Asked once each reviewer's own permissions are known: the project's People page may
        // let someone decide where the workspace's defaults let nobody (#55).
        message:
          "An approval needs at least one reviewer who may decide: say that they may, here or on the project's People page, or ask for feedback.",
      });
    }
    await tx.insert(reviewReviewers).values(
      people.map((person, i) => ({
        organisationId,
        reviewId: created.id,
        userId: person.userId ?? null,
        guestId: person.guestId ?? null,
        groupId: person.groupId,
        position: person.position,
        permissions: permissions[i] ?? granted.data,
      })),
    );
    await deps.audit.record(
      organisationId,
      who,
      {
        action: "review.create",
        projectId,
        reviewId: created.id,
        details: { kind: created.kind, reviewers: people.length },
      },
      request,
      tx,
    );
    await emitEvent(tx, {
      organisationId,
      kind: "review.requested",
      actor: { userId: actor.userId },
      projectId,
      reviewId: created.id,
      path: `/reviews/${created.id}`,
    });
    return created;
  });
  if (!review) return null;
  // Ask whoever can act now: everyone, or the first in a sequence. Those who only follow
  // an approval hold nothing up, so they hear of it now, guests with the link they need.
  const { rows, facts } = await reviewersOf(deps.db, organisationId, review.id);
  const now = activeReviewers(review.order, facts);
  const following = new Set(facts.filter((f) => f.observer).map((f) => f.id));
  const requester = { userId: actor.userId, name: await nameOf(deps.db, actor.userId) };
  await notify(
    deps,
    rows.filter((r) => now.has(r.id) || following.has(r.id)),
    review,
    false,
    requester,
  );
  return review;
}

/** `/api/projects/:id/reviews`: a project's reviews, and requesting one. Members only. */
export const projectReviewRoutes = (deps: ReviewDeps) =>
  new Hono<{ Variables: TenantVariables }>()
    .get("/:id/reviews", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const { projectId } = await can(deps.db, actorOf(c.var), "view", c.req.valid("param").id);
      const rows = await deps.db
        .select({
          id: reviews.id,
          kind: reviews.kind,
          title: reviews.title,
          status: reviews.status,
          outcome: reviews.outcome,
          dueAt: reviews.dueAt,
          createdAt: reviews.createdAt,
        })
        .from(reviews)
        .where(inOrg(reviews, organisationId, eq(reviews.projectId, projectId)))
        .orderBy(desc(reviews.createdAt));
      const counts = rows.length
        ? await deps.db
            .select({
              reviewId: reviewReviewers.reviewId,
              userId: reviewReviewers.userId,
              submittedAt: reviewReviewers.submittedAt,
              viewedAt: reviewReviewers.viewedAt,
              expiresAt: sql<string | null>`${reviewReviewers.permissions}->>'expiresAt'`,
            })
            .from(reviewReviewers)
            .where(
              inOrg(
                reviewReviewers,
                organisationId,
                inArray(
                  reviewReviewers.reviewId,
                  rows.map((r) => r.id),
                ),
              ),
            )
        : [];
      // A share's list line says how much it shares, how many opened it, and until when.
      const itemCounts = rows.some((r) => r.kind === "share")
        ? await deps.db
            .select({ reviewId: reviewItems.reviewId, n: count() })
            .from(reviewItems)
            .where(
              inOrg(
                reviewItems,
                organisationId,
                inArray(
                  reviewItems.reviewId,
                  rows.filter((r) => r.kind === "share").map((r) => r.id),
                ),
              ),
            )
            .groupBy(reviewItems.reviewId)
        : [];
      return c.json({
        reviews: rows.map((r) => {
          const mine = counts.filter((x) => x.reviewId === r.id);
          const ends = mine.map((x) => x.expiresAt);
          return {
            ...r,
            reviewers: mine.length,
            submitted: mine.filter((x) => x.submittedAt).length,
            opened: mine.filter((x) => x.viewedAt).length,
            items: itemCounts.find((x) => x.reviewId === r.id)?.n ?? null,
            /** When the last of its people loses access; null while anyone's has no end. */
            until:
              ends.length > 0 && ends.every((e) => e)
                ? ((ends as string[]).sort().at(-1) ?? null)
                : null,
            youReview: mine.some((x) => x.userId === c.var.userId),
          };
        }),
      });
    })
    // The guests this project has asked before, in its reviews or its groups: whom a new
    // request can ask again without typing their address, and whom its People page lists,
    // with how many of its reviews ask them and whether a link still works for them. For
    // those who may see the project's people, or request reviews.
    .get("/:id/guests", idParam, async (c) => {
      const organisationId = c.var.organisationId;
      const access = await projectAccess(deps.db, actorOf(c.var), c.req.valid("param").id);
      if (!access) throw new NotFound("Project");
      if (!access.permissions.has("view_people") && !access.permissions.has("request_reviews")) {
        throw new HTTPException(403, { message: "Your role in this project does not allow that" });
      }
      const { projectId } = access;
      const fields = { id: guests.id, name: guests.name, email: guests.email, label: guests.label };
      const asked = await deps.db
        .selectDistinct(fields)
        .from(reviewReviewers)
        .innerJoin(reviews, eq(reviews.id, reviewReviewers.reviewId))
        .innerJoin(guests, eq(guests.id, reviewReviewers.guestId))
        .where(
          and(
            inOrg(reviewReviewers, organisationId),
            inOrg(reviews, organisationId, eq(reviews.projectId, projectId)),
            inOrg(guests, organisationId),
          ),
        );
      const grouped = await deps.db
        .selectDistinct(fields)
        .from(groupMembers)
        .innerJoin(groups, eq(groups.id, groupMembers.groupId))
        .innerJoin(guests, eq(guests.id, groupMembers.guestId))
        .where(
          and(
            inOrg(groupMembers, organisationId),
            inOrg(groups, organisationId, eq(groups.projectId, projectId)),
            inOrg(guests, organisationId),
          ),
        );
      const byId = new Map([...asked, ...grouped].map((g) => [g.id, g]));
      const ids = [...byId.keys()];
      // How many of this project's reviews ask each of them, and how many are still open.
      const counted =
        ids.length === 0
          ? []
          : await deps.db
              .select({
                guestId: reviewReviewers.guestId,
                reviews: count(),
                open: sql<number>`(count(*) filter (where ${reviews.status} = 'open'))::int`,
              })
              .from(reviewReviewers)
              .innerJoin(reviews, eq(reviews.id, reviewReviewers.reviewId))
              .where(
                and(
                  inOrg(reviewReviewers, organisationId, inArray(reviewReviewers.guestId, ids)),
                  inOrg(reviews, organisationId, eq(reviews.projectId, projectId)),
                ),
              )
              .groupBy(reviewReviewers.guestId);
      // When each was last sent a link, and whether a link or signed-in browser still works.
      const now = new Date().toISOString();
      const lastLink = deps.db
        .select({ guestId: guestLinks.guestId, at: max(guestLinks.createdAt).as("at") })
        .from(guestLinks)
        .where(eq(guestLinks.organisationId, organisationId))
        .groupBy(guestLinks.guestId)
        .as("last_link");
      const links =
        ids.length === 0
          ? []
          : await deps.db
              .select({
                guestId: guests.id,
                lastLinkAt: lastLink.at,
                live: sql<boolean>`exists (
                  select 1 from ${guestLinks} where ${guestLinks.guestId} = ${guests.id}
                    and ${guestLinks.organisationId} = ${organisationId}
                    and ${guestLinks.usedAt} is null and ${guestLinks.revokedAt} is null
                    and ${guestLinks.expiresAt} > ${now}
                ) or exists (
                  select 1 from ${guestSessions} where ${guestSessions.guestId} = ${guests.id}
                    and ${guestSessions.organisationId} = ${organisationId}
                    and ${guestSessions.revokedAt} is null and ${guestSessions.expiresAt} > ${now}
                )`,
              })
              .from(guests)
              // Joined, so the conditions below name the guest's columns in full.
              .leftJoin(lastLink, eq(lastLink.guestId, guests.id))
              .where(inOrg(guests, organisationId, inArray(guests.id, ids)));
      const countOf = new Map(counted.map((r) => [r.guestId, r]));
      const linkOf = new Map(links.map((r) => [r.guestId, r]));
      return c.json({
        guests: [...byId.values()]
          .map((g) => ({
            ...g,
            reviews: countOf.get(g.id)?.reviews ?? 0,
            openReviews: countOf.get(g.id)?.open ?? 0,
            lastLinkAt: linkOf.get(g.id)?.lastLinkAt ?? null,
            live: linkOf.get(g.id)?.live ?? false,
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      });
    })
    // Send a guest a fresh link for the newest open review in this project that asks them.
    .post("/:id/guests/:guestId/link", projectGuestParam, async (c) => {
      const actor = actorOf(c.var);
      const { id, guestId } = c.req.valid("param");
      const { projectId } = await can(deps.db, actor, "manage_reviewers", id);
      const [found] = await deps.db
        .select({
          review: {
            id: reviews.id,
            createdBy: reviews.createdBy,
            organisationId: reviews.organisationId,
            projectId: reviews.projectId,
            title: reviews.title,
            kind: reviews.kind,
            message: reviews.message,
            dueAt: reviews.dueAt,
          },
          email: guests.email,
          permissions: reviewReviewers.permissions,
        })
        .from(reviewReviewers)
        .innerJoin(reviews, eq(reviews.id, reviewReviewers.reviewId))
        .innerJoin(guests, eq(guests.id, reviewReviewers.guestId))
        .where(
          and(
            inOrg(reviewReviewers, actor.organisationId, eq(reviewReviewers.guestId, guestId)),
            inOrg(
              reviews,
              actor.organisationId,
              eq(reviews.projectId, projectId),
              eq(reviews.status, "open"),
            ),
            inOrg(guests, actor.organisationId),
          ),
        )
        .orderBy(desc(reviews.createdAt))
        .limit(1);
      if (!found) {
        throw new HTTPException(409, {
          message: "No open review in this project asks them; ask them in a review",
        });
      }
      const requester = { userId: actor.userId, name: await nameOf(deps.db, actor.userId) };
      await notify(
        deps,
        [{ email: found.email, guestId, userId: null, permissions: found.permissions }],
        found.review,
        false,
        requester,
      );
      return c.body(null, 204);
    })
    // How a guest appears beside their name. Guests belong to the workspace, so the label
    // follows them into its other projects.
    .patch(
      "/:id/guests/:guestId",
      projectGuestParam,
      zValidator("json", guestLabelInput),
      async (c) => {
        const actor = actorOf(c.var);
        const { id, guestId } = c.req.valid("param");
        const { projectId } = await can(deps.db, actor, "manage_reviewers", id);
        await projectGuest(deps.db, actor.organisationId, projectId, guestId);
        const { label } = c.req.valid("json");
        await deps.db
          .update(guests)
          .set({ label: label || null, updatedAt: new Date() })
          .where(inOrg(guests, actor.organisationId, eq(guests.id, guestId)));
        return c.body(null, 204);
      },
    )
    // What each person may do in this project's reviews, where its People page says (#55).
    .get("/:id/reviewer-grants", idParam, async (c) => {
      const actor = actorOf(c.var);
      const { projectId } = await can(deps.db, actor, "manage_reviewers", c.req.valid("param").id);
      const grants = await deps.db
        .select({
          userId: projectReviewerGrants.userId,
          guestId: projectReviewerGrants.guestId,
          grant: projectReviewerGrants.grant,
        })
        .from(projectReviewerGrants)
        .where(
          inOrg(
            projectReviewerGrants,
            actor.organisationId,
            eq(projectReviewerGrants.projectId, projectId),
          ),
        );
      return c.json({ grants });
    })
    // Set what one person may do in every review of this project they are asked into; a
    // review's own overrides still come on top.
    .put(
      "/:id/reviewer-grants/:kind/:personId",
      reviewerGrantParam,
      zValidator("json", standingGrant),
      async (c) => {
        const actor = actorOf(c.var);
        const { id, kind, personId } = c.req.valid("param");
        const { projectId } = await can(deps.db, actor, "manage_reviewers", id);
        await grantee(deps.db, actor.organisationId, projectId, kind, personId);
        const grant = c.req.valid("json");
        const who = await deps.audit.member(actor.userId);
        await deps.db.transaction(async (tx) => {
          const person =
            kind === "member"
              ? { userId: personId, guestId: null }
              : { userId: null, guestId: personId };
          await tx
            .insert(projectReviewerGrants)
            .values({ organisationId: actor.organisationId, projectId, ...person, grant })
            .onConflictDoUpdate({
              target: [
                projectReviewerGrants.organisationId,
                projectReviewerGrants.projectId,
                kind === "member" ? projectReviewerGrants.userId : projectReviewerGrants.guestId,
              ],
              set: { grant, updatedAt: new Date() },
            });
          await deps.audit.record(
            actor.organisationId,
            who,
            { action: "project.reviewer_grant", projectId, details: { ...person, grant } },
            requestInfo(c, deps.trustProxy),
            tx,
          );
        });
        return c.body(null, 204);
      },
    )
    // Back to the workspace's defaults.
    .delete("/:id/reviewer-grants/:kind/:personId", reviewerGrantParam, async (c) => {
      const actor = actorOf(c.var);
      const { id, kind, personId } = c.req.valid("param");
      const { projectId } = await can(deps.db, actor, "manage_reviewers", id);
      const who = await deps.audit.member(actor.userId);
      const person =
        kind === "member"
          ? { userId: personId, guestId: null }
          : { userId: null, guestId: personId };
      await deps.db.transaction(async (tx) => {
        const cleared = await tx
          .delete(projectReviewerGrants)
          .where(
            inOrg(
              projectReviewerGrants,
              actor.organisationId,
              eq(projectReviewerGrants.projectId, projectId),
              kind === "member"
                ? eq(projectReviewerGrants.userId, personId)
                : eq(projectReviewerGrants.guestId, personId),
            ),
          )
          .returning({ id: projectReviewerGrants.id });
        if (cleared.length === 0) return;
        await deps.audit.record(
          actor.organisationId,
          who,
          { action: "project.reviewer_grant", projectId, details: { ...person, grant: null } },
          requestInfo(c, deps.trustProxy),
          tx,
        );
      });
      return c.body(null, 204);
    })
    // End every link and signed-in browser a guest has, as revoking them from a review does.
    .post("/:id/guests/:guestId/revoke", projectGuestParam, async (c) => {
      const actor = actorOf(c.var);
      const { id, guestId } = c.req.valid("param");
      const who = await deps.audit.member(actor.userId);
      const { projectId } = await can(deps.db, actor, "manage_reviewers", id);
      await projectGuest(deps.db, actor.organisationId, projectId, guestId);
      await deps.db.transaction(async (tx) => {
        await revokeGuest(tx, actor.organisationId, guestId);
        await deps.audit.record(
          actor.organisationId,
          who,
          { action: "guest.revoke", projectId, details: { guestId } },
          requestInfo(c, deps.trustProxy),
          tx,
        );
      });
      return c.body(null, 204);
    })
    .post("/:id/reviews", idParam, zValidator("json", createReviewInput), async (c) => {
      const actor = actorOf(c.var);
      const { projectId } = await can(deps.db, actor, "request_reviews", c.req.valid("param").id);
      const review = await requestReview(
        deps,
        actor,
        projectId,
        c.req.valid("json"),
        requestInfo(c, deps.trustProxy),
      );
      // Only a workflow's stage, which this is not, is ever refused a review here.
      if (!review) throw new NotFound("Review");
      return c.json({ review: await reviewView(deps.db, actor, review.id) }, 201);
    });

/**
 * `/api/reviews/:id`: one review, and taking part in it, for members and guests alike;
 * managing it (cancelling, reviewers, guests' links) is for members whose role allows it.
 */
export const reviewRoutes = (deps: ReviewDeps) =>
  new Hono<{ Variables: ViewerVariables }>()
    // The reviews a member is asked to take part in, open ones first: the sidebar's inbox.
    .get("/", async (c) => {
      const actor = memberOnly(c.var.actor);
      return c.json({ reviews: await memberReviews(deps.db, actor) });
    })
    .get("/:id", idParam, async (c) =>
      c.json({ review: await reviewView(deps.db, c.var.actor, c.req.valid("param").id) }),
    )
    // A reviewer opened the review: invited becomes viewed.
    .post("/:id/viewed", idParam, async (c) => {
      const actor = c.var.actor;
      const first = await deps.db.transaction(async (tx) => {
        const { review } = await lockReview(tx, actor, c.req.valid("param").id);
        const { rows } = await reviewersOf(tx, actor.organisationId, review.id);
        const me = mineOf(rows, actor);
        if (!me || me.viewedAt) return null;
        await tx
          .update(reviewReviewers)
          .set({ viewedAt: new Date(), updatedAt: new Date() })
          .where(inOrg(reviewReviewers, actor.organisationId, eq(reviewReviewers.id, me.id)));
        return review;
      });
      // A guest's first look at a review is in the access log.
      if (first && actor.kind === "guest") {
        await deps.audit.record(
          actor.organisationId,
          await deps.audit.guest(actor.guestId),
          { action: "guest.view", projectId: first.projectId, reviewId: first.id },
          requestInfo(c, deps.trustProxy),
        );
        await notifyNow(deps, {
          organisationId: first.organisationId,
          kind: "guest_opened",
          recipients: [
            ...(first.createdBy ? [first.createdBy] : []),
            ...(await followersOf(deps.db, first.organisationId, { reviewId: first.id })),
          ],
          actor: { guestId: actor.guestId },
          projectId: first.projectId,
          reviewId: first.id,
          text: `opened "${first.title}"`,
          link: `/reviews/${first.id}`,
        }).catch((error: unknown) =>
          console.warn(`Could not tell the requester a guest opened a review: ${String(error)}`),
        );
      }
      return c.json({ review: await reviewView(deps.db, actor, c.req.valid("param").id) });
    })
    .post("/:id/decisions", idParam, zValidator("json", decisionInput), async (c) => {
      const actor = c.var.actor;
      const input = c.req.valid("json");
      const who = await deps.audit.actor(actor);
      const { review, next } = await deps.db.transaction(async (tx) => {
        const { review, access } = await lockReview(tx, actor, c.req.valid("param").id);
        if (review.kind !== "approval") {
          throw new HTTPException(409, { message: "Feedback reviews are submitted, not decided" });
        }
        if (review.status !== "open") {
          throw new HTTPException(409, { message: `This review is ${review.status}` });
        }
        if (!access.permissions.has("decide")) {
          throw new HTTPException(403, {
            message: "Your role in this project does not allow that",
          });
        }
        const { rows, facts } = await reviewersOf(tx, actor.organisationId, review.id);
        const me = mineOf(rows, actor);
        if (!me) throw new HTTPException(403, { message: "You are not a reviewer of this review" });
        if (!mayAct(me, "decide")) {
          throw new HTTPException(403, { message: "This review does not ask you for a decision" });
        }
        const before = activeReviewers(review.order, facts);
        // Once decided, a reviewer may change their mind while the review is open.
        if (!before.has(me.id) && !me.submittedAt) {
          throw new HTTPException(409, { message: "It is not your turn in this review yet" });
        }
        const now = new Date();
        await tx.insert(reviewDecisionLog).values({
          organisationId: actor.organisationId,
          reviewId: review.id,
          reviewerId: me.id,
          decision: input.decision,
          note: input.note || null,
        });
        await deps.audit.record(
          actor.organisationId,
          who,
          {
            action: "review.decision",
            projectId: review.projectId,
            reviewId: review.id,
            details: { decision: input.decision },
          },
          requestInfo(c, deps.trustProxy),
          tx,
        );
        await emitEvent(tx, {
          organisationId: actor.organisationId,
          kind: "decision.recorded",
          actor: eventActor(actor),
          projectId: review.projectId,
          reviewId: review.id,
          path: `/reviews/${review.id}`,
          details: { decision: input.decision },
        });
        await tx
          .update(reviewReviewers)
          .set({
            submittedAt: me.submittedAt ?? now,
            startedAt: now,
            viewedAt: me.viewedAt ?? now,
            updatedAt: now,
          })
          .where(inOrg(reviewReviewers, actor.organisationId, eq(reviewReviewers.id, me.id)));
        const settled = await settle(tx, review);
        const after = await reviewersOf(tx, actor.organisationId, review.id);
        const next =
          settled.status === "open"
            ? after.rows.filter((r) =>
                newlyActive(before, activeReviewers(review.order, after.facts)).includes(r.id),
              )
            : [];
        return { review: settled, next };
      });
      if (next.length > 0) await notify(deps, next, review, true);
      await tellRequester(deps, review, actor, input.decision, input.note);
      if (review.status === "completed") await deps.onSettled?.(review, settledBy(actor));
      return c.json({ review: await reviewView(deps.db, actor, review.id) });
    })
    .post("/:id/submit", idParam, zValidator("json", submitFeedbackInput), async (c) => {
      const actor = c.var.actor;
      const { note } = c.req.valid("json");
      const who = await deps.audit.actor(actor);
      const { review, next } = await deps.db.transaction(async (tx) => {
        const { review } = await lockReview(tx, actor, c.req.valid("param").id);
        if (review.kind !== "feedback") {
          throw new HTTPException(409, { message: "Approval reviews take a decision" });
        }
        if (review.status !== "open") {
          throw new HTTPException(409, { message: `This review is ${review.status}` });
        }
        const { rows, facts } = await reviewersOf(tx, actor.organisationId, review.id);
        const me = mineOf(rows, actor);
        if (!me) throw new HTTPException(403, { message: "You are not a reviewer of this review" });
        if (!mayAct(me, "submit")) {
          throw new HTTPException(403, { message: "Your access to this review is not open" });
        }
        const before = activeReviewers(review.order, facts);
        if (!before.has(me.id)) {
          throw new HTTPException(409, {
            message: me.submittedAt
              ? "You have already submitted"
              : "It is not your turn in this review yet",
          });
        }
        const now = new Date();
        await tx
          .update(reviewReviewers)
          .set({
            submittedAt: now,
            viewedAt: me.viewedAt ?? now,
            startedAt: me.startedAt ?? now,
            feedbackNote: note || null,
            updatedAt: now,
          })
          .where(inOrg(reviewReviewers, actor.organisationId, eq(reviewReviewers.id, me.id)));
        await deps.audit.record(
          actor.organisationId,
          who,
          { action: "review.submit", projectId: review.projectId, reviewId: review.id },
          requestInfo(c, deps.trustProxy),
          tx,
        );
        await emitEvent(tx, {
          organisationId: actor.organisationId,
          kind: "feedback.submitted",
          actor: eventActor(actor),
          projectId: review.projectId,
          reviewId: review.id,
          path: `/reviews/${review.id}`,
        });
        const settled = await settle(tx, review);
        const after = await reviewersOf(tx, actor.organisationId, review.id);
        const next =
          settled.status === "open"
            ? after.rows.filter((r) =>
                newlyActive(before, activeReviewers(review.order, after.facts)).includes(r.id),
              )
            : [];
        return { review: settled, next };
      });
      if (next.length > 0) await notify(deps, next, review, true);
      await tellRequester(deps, review, actor, "feedback");
      if (review.status === "completed") await deps.onSettled?.(review, settledBy(actor));
      return c.json({ review: await reviewView(deps.db, actor, review.id) });
    })
    .post("/:id/cancel", idParam, zValidator("json", cancelReviewInput), async (c) => {
      const actor = memberOnly(c.var.actor);
      const { reason } = c.req.valid("json");
      const who = await deps.audit.member(actor.userId);
      const review = await deps.db.transaction(async (tx) => {
        const { review } = await lockReview(tx, actor, c.req.valid("param").id);
        await can(tx, actor, "request_reviews", review.projectId);
        if (review.status !== "open") {
          throw new HTTPException(409, { message: `This review is ${review.status}` });
        }
        await tx
          .update(reviews)
          .set({
            status: "cancelled",
            completedAt: new Date(),
            cancelledBy: actor.userId,
            cancelReason: reason || null,
            updatedAt: new Date(),
          })
          .where(inOrg(reviews, actor.organisationId, eq(reviews.id, review.id)));
        await deps.audit.record(
          actor.organisationId,
          who,
          { action: "review.cancel", projectId: review.projectId, reviewId: review.id },
          requestInfo(c, deps.trustProxy),
          tx,
        );
        return review;
      });
      return c.json({ review: await reviewView(deps.db, actor, review.id) });
    })
    // Change the due date of an open review; those not yet reminded of it can be again.
    .patch("/:id", idParam, zValidator("json", updateReviewInput), async (c) => {
      const actor = memberOnly(c.var.actor);
      const { dueAt } = c.req.valid("json");
      const who = await deps.audit.member(actor.userId);
      await deps.db.transaction(async (tx) => {
        const { review } = await lockReview(tx, actor, c.req.valid("param").id);
        await can(tx, actor, "request_reviews", review.projectId);
        if (review.status !== "open") {
          throw new HTTPException(409, { message: `This review is ${review.status}` });
        }
        // A share asks nothing, so nothing is due: it lasts as long as each person's access.
        if (review.kind === "share" && dueAt) {
          throw new HTTPException(422, {
            message: "A share is not due; say until when each person may open it",
          });
        }
        const due = dueAt ? new Date(dueAt) : null;
        await tx
          .update(reviews)
          .set({ dueAt: due, updatedAt: new Date() })
          .where(inOrg(reviews, actor.organisationId, eq(reviews.id, review.id)));
        // The reminder the day before is due again for the new date.
        await tx
          .update(reviewReviewers)
          .set({ remindedAt: null, updatedAt: new Date() })
          .where(
            inOrg(reviewReviewers, actor.organisationId, eq(reviewReviewers.reviewId, review.id)),
          );
        await deps.audit.record(
          actor.organisationId,
          who,
          {
            action: "review.due",
            projectId: review.projectId,
            reviewId: review.id,
            details: { dueAt: due?.toISOString() ?? null },
          },
          requestInfo(c, deps.trustProxy),
          tx,
        );
      });
      return c.json({ review: await reviewView(deps.db, actor, c.req.valid("param").id) });
    })
    // Remind everyone the review is waiting on now, or one of them: a notification and a
    // mail for members, a fresh link for guests. A few a review an hour, so no one is pestered.
    .post("/:id/remind", idParam, zValidator("json", remindInput), async (c) => {
      const actor = memberOnly(c.var.actor);
      const { reviewerId } = c.req.valid("json");
      const id = c.req.valid("param").id;
      const { review, waiting } = await deps.db.transaction(async (tx) => {
        const { review } = await lockReview(tx, actor, id);
        await can(tx, actor, "manage_reviewers", review.projectId);
        if (review.status !== "open") {
          throw new HTTPException(409, { message: `This review is ${review.status}` });
        }
        if (review.kind === "share") {
          throw new HTTPException(409, {
            message: "A share asks nothing, so there is nothing to remind of",
          });
        }
        const { rows, facts } = await reviewersOf(tx, actor.organisationId, review.id);
        const active = activeReviewers(review.order, facts);
        const now = new Date();
        const waiting = rows.filter(
          (r) =>
            active.has(r.id) &&
            withinWindow(r.permissions, now) &&
            (!reviewerId || r.id === reviewerId),
        );
        if (reviewerId && !rows.some((r) => r.id === reviewerId)) throw new NotFound("Reviewer");
        if (waiting.length === 0) {
          throw new HTTPException(409, {
            message: reviewerId
              ? "The review is not waiting on them now"
              : "The review is not waiting on anyone now",
          });
        }
        return { review, waiting };
      });
      const { allowed, retryAfter } = await admit(deps.db, `review-remind:${review.id}`, {
        max: 5,
        windowMs: 60 * 60 * 1000,
      });
      if (!allowed) {
        c.header("Retry-After", String(retryAfter));
        throw new HTTPException(429, {
          message: "Reviewers have been reminded several times this hour; try again later",
        });
      }
      const requester = { userId: actor.userId, name: await nameOf(deps.db, actor.userId) };
      await notify(deps, waiting, review, false, requester, true);
      await deps.audit.record(
        actor.organisationId,
        await deps.audit.member(actor.userId),
        {
          action: "review.remind",
          projectId: review.projectId,
          reviewId: review.id,
          details: {
            reviewers: waiting.length,
            ...(reviewerId ? { name: waiting[0]?.name ?? null } : {}),
          },
        },
        requestInfo(c, deps.trustProxy),
      );
      return c.json({ reminded: waiting.length });
    })
    // Add a reviewer, member or guest, at the end of the order while the review is open.
    .post("/:id/reviewers", idParam, zValidator("json", addReviewerInput), async (c) => {
      const actor = memberOnly(c.var.actor);
      const body = c.req.valid("json");
      const entry: ReviewerInput = "userId" in body ? body.userId : body;
      const who = await deps.audit.member(actor.userId);
      const { review, added } = await deps.db.transaction(async (tx) => {
        const { review } = await lockReview(tx, actor, c.req.valid("param").id);
        await can(tx, actor, "manage_reviewers", review.projectId);
        if (review.status !== "open") {
          throw new HTTPException(409, { message: `This review is ${review.status}` });
        }
        const [last] = await tx
          .select({ position: max(reviewReviewers.position) })
          .from(reviewReviewers)
          .where(
            inOrg(reviewReviewers, actor.organisationId, eq(reviewReviewers.reviewId, review.id)),
          );
        const people = await expandReviewers(
          tx,
          actor,
          review,
          [entry],
          (last?.position ?? -1) + 1,
        );
        // Those asked later may do what the review granted everyone when it was asked.
        let grant = review.grant;
        if (!grant) {
          const [workspace] = await tx
            .select({ settings: schema.organisations.settings })
            .from(schema.organisations)
            .where(eq(schema.organisations.id, actor.organisationId));
          grant = reviewerDefaults(workspaceSettingsOf(workspace?.settings), new Date());
        }
        // With what the project's People page says for each of them (#55).
        const grants = await standingFor(tx, actor.organisationId, review.projectId, people, grant);
        const inserted = await tx
          .insert(reviewReviewers)
          .values(
            people.map((person, i) => ({
              organisationId: actor.organisationId,
              reviewId: review.id,
              userId: person.userId ?? null,
              guestId: person.guestId ?? null,
              groupId: person.groupId,
              position: person.position,
              permissions:
                review.kind === "share" ? shareGrant(grants[i] ?? grant) : (grants[i] ?? grant),
            })),
          )
          .onConflictDoNothing()
          .returning({ id: reviewReviewers.id });
        if (inserted.length === 0) {
          throw new HTTPException(409, {
            message:
              "groupId" in body
                ? "Everyone in that group is already a reviewer"
                : "They are already a reviewer",
          });
        }
        const { rows, facts } = await reviewersOf(tx, actor.organisationId, review.id);
        const active = activeReviewers(review.order, facts);
        await deps.audit.record(
          actor.organisationId,
          who,
          {
            action: "review.reviewer_add",
            projectId: review.projectId,
            reviewId: review.id,
            details: {
              name: rows
                .filter((r) => inserted.some((x) => x.id === r.id))
                .map((r) => r.name)
                .join(", "),
            },
          },
          requestInfo(c, deps.trustProxy),
          tx,
        );
        // Those asked now, rather than later in the sequence; and those who only follow an
        // approval, who hold nothing up and so hear of it at once (#221).
        const following = new Set(facts.filter((f) => f.observer).map((f) => f.id));
        return {
          review,
          added: rows.filter(
            (r) => inserted.some((x) => x.id === r.id) && (active.has(r.id) || following.has(r.id)),
          ),
        };
      });
      if (added.length > 0) {
        const requester = { userId: actor.userId, name: await nameOf(deps.db, actor.userId) };
        await notify(deps, added, review, false, requester);
      }
      return c.json({ review: await reviewView(deps.db, actor, review.id) }, 201);
    })
    // A reviewer whose grant allows it invites someone by email (#55): they join as a guest at
    // the inviter's step, with what the inviter may do but no decision and no inviting.
    .post("/:id/invite", idParam, zValidator("json", guestInput), async (c) => {
      const actor = c.var.actor;
      const entry = c.req.valid("json");
      // Each invitation sends an email: a few an hour per person is plenty.
      const asker = actor.kind === "guest" ? `guest:${actor.guestId}` : `member:${actor.userId}`;
      const { allowed, retryAfter } = await admit(deps.db, `review-invite:${asker}`, {
        max: INVITES_PER_HOUR,
        windowMs: 60 * 60_000,
      });
      if (!allowed)
        return tooMany(c, retryAfter, "Too many invitations this hour; try again later");
      const who = await deps.audit.actor(actor);
      const { review, added, inviter } = await deps.db.transaction(async (tx) => {
        const { review } = await lockReview(tx, actor, c.req.valid("param").id);
        if (review.status !== "open") {
          throw new HTTPException(409, { message: `This review is ${review.status}` });
        }
        const { rows } = await reviewersOf(tx, actor.organisationId, review.id);
        const me = mineOf(rows, actor);
        if (!me?.permissions.invite || !withinWindow(me.permissions, new Date())) {
          throw new HTTPException(403, { message: "This review does not let you invite others" });
        }
        const guestId = await upsertGuest(
          tx,
          actor.organisationId,
          entry,
          actor.kind === "guest" ? null : actor.userId,
        );
        const [inserted] = await tx
          .insert(reviewReviewers)
          .values({
            organisationId: actor.organisationId,
            reviewId: review.id,
            guestId,
            position: me.position,
            permissions: invitedGrant(me.permissions),
          })
          .onConflictDoNothing()
          .returning({ id: reviewReviewers.id });
        if (!inserted) throw new HTTPException(409, { message: "They are already a reviewer" });
        const after = await reviewersOf(tx, actor.organisationId, review.id);
        const row = after.rows.find((r) => r.id === inserted.id);
        await deps.audit.record(
          actor.organisationId,
          who,
          {
            action: "review.reviewer_add",
            projectId: review.projectId,
            reviewId: review.id,
            details: { name: row?.name ?? entry.name, invitedBy: me.name },
          },
          requestInfo(c, deps.trustProxy),
          tx,
        );
        // Asked at once, by the one inviting: they have no decision of their own, so no step
        // turning later would ever ask them.
        return { review, added: row ? [row] : [], inviter: me.name };
      });
      if (added.length > 0) {
        await notify(deps, added, review, false, {
          userId: actor.kind === "guest" ? null : actor.userId,
          name: inviter,
        });
      }
      return c.json({ review: await reviewView(deps.db, actor, review.id) }, 201);
    })
    // Adjust what one reviewer may do in this review.
    .patch(
      "/:id/reviewers/:reviewerId",
      reviewerParam,
      zValidator("json", z.object({ permissions: reviewerPermissionsChange })),
      async (c) => {
        const actor = memberOnly(c.var.actor);
        const { id, reviewerId } = c.req.valid("param");
        const changed = await deps.db.transaction(async (tx) => {
          const { review } = await lockReview(tx, actor, id);
          await can(tx, actor, "manage_reviewers", review.projectId);
          if (review.status !== "open") {
            throw new HTTPException(409, { message: `This review is ${review.status}` });
          }
          const [reviewer] = await tx
            .select({ id: reviewReviewers.id, permissions: reviewReviewers.permissions })
            .from(reviewReviewers)
            .where(
              inOrg(
                reviewReviewers,
                actor.organisationId,
                eq(reviewReviewers.id, reviewerId),
                eq(reviewReviewers.reviewId, review.id),
              ),
            );
          if (!reviewer) throw new NotFound("Reviewer");
          const next = applyPermissions(reviewer.permissions, c.req.valid("json").permissions);
          if (!next.success) {
            throw new HTTPException(422, {
              message: next.error.issues[0]?.message ?? "Those permissions do not fit together",
            });
          }
          // A share's people only listen and look (#138), whatever a change asks for.
          if (review.kind === "share") next.data = shareGrant(next.data);
          // The items a reviewer is shown are this review's own (#55).
          if (next.data.items !== null) {
            const own = new Set(
              (
                await tx
                  .select({ id: reviewItems.id })
                  .from(reviewItems)
                  .where(
                    inOrg(reviewItems, actor.organisationId, eq(reviewItems.reviewId, review.id)),
                  )
              ).map((i) => i.id),
            );
            if (next.data.items.length === 0 || next.data.items.some((i) => !own.has(i)))
              throw new HTTPException(422, {
                message: "Choose at least one of this review's items",
              });
          }
          const before = activeReviewers(
            review.order,
            (await reviewersOf(tx, actor.organisationId, review.id)).facts,
          );
          await tx
            .update(reviewReviewers)
            .set({ permissions: next.data, updatedAt: new Date() })
            .where(
              inOrg(reviewReviewers, actor.organisationId, eq(reviewReviewers.id, reviewer.id)),
            );
          // Taking a decision away can let the order move on, or settle the review.
          const settled = await settle(tx, review);
          const after = await reviewersOf(tx, actor.organisationId, review.id);
          // One still waiting their turn who now only follows the approval has not been told of
          // it, and holds nothing up any longer: they hear of it now (#221).
          const nowFollows =
            settled.status === "open" &&
            !follows(review, reviewer) &&
            follows(review, { permissions: next.data }) &&
            !before.has(reviewer.id);
          return {
            review: settled,
            next:
              settled.status === "open"
                ? after.rows.filter(
                    (r) =>
                      newlyActive(before, activeReviewers(review.order, after.facts)).includes(
                        r.id,
                      ) ||
                      (nowFollows && r.id === reviewer.id && !r.submittedAt),
                  )
                : [],
          };
        });
        if (changed.next.length > 0) {
          await notify(deps, changed.next, changed.review, true);
        }
        return c.json({ review: await reviewView(deps.db, actor, id) });
      },
    )
    // Send a guest reviewer a fresh magic link; any earlier unused one stops working.
    .post("/:id/reviewers/:reviewerId/link", reviewerParam, async (c) => {
      const actor = memberOnly(c.var.actor);
      const { id, reviewerId } = c.req.valid("param");
      const { review, guest } = await deps.db.transaction(async (tx) => {
        const { review } = await lockReview(tx, actor, id);
        await can(tx, actor, "manage_reviewers", review.projectId);
        if (review.status !== "open") {
          throw new HTTPException(409, { message: `This review is ${review.status}` });
        }
        const { rows } = await reviewersOf(tx, actor.organisationId, review.id);
        const guest = rows.find((r) => r.id === reviewerId);
        if (!guest) throw new NotFound("Reviewer");
        if (!guest.guestId) {
          throw new HTTPException(409, {
            message: "Members sign in themselves; only guests get links",
          });
        }
        return { review, guest };
      });
      const requester = { userId: actor.userId, name: await nameOf(deps.db, actor.userId) };
      await notify(deps, [guest], review, false, requester);
      return c.body(null, 204);
    })
    // Revoke a guest reviewer's links and signed-in browsers, everywhere in the organisation.
    .post("/:id/reviewers/:reviewerId/revoke", reviewerParam, async (c) => {
      const actor = memberOnly(c.var.actor);
      const { id, reviewerId } = c.req.valid("param");
      const who = await deps.audit.member(actor.userId);
      await deps.db.transaction(async (tx) => {
        const { review } = await lockReview(tx, actor, id);
        await can(tx, actor, "manage_reviewers", review.projectId);
        const { rows } = await reviewersOf(tx, actor.organisationId, review.id);
        const guest = rows.find((r) => r.id === reviewerId);
        if (!guest) throw new NotFound("Reviewer");
        if (!guest.guestId) throw new HTTPException(409, { message: "Only guests have links" });
        await revokeGuest(tx, actor.organisationId, guest.guestId);
        await deps.audit.record(
          actor.organisationId,
          who,
          {
            action: "guest.revoke",
            projectId: review.projectId,
            reviewId: review.id,
            details: { guestId: guest.guestId },
          },
          requestInfo(c, deps.trustProxy),
          tx,
        );
      });
      return c.body(null, 204);
    })
    // Remove a reviewer who has not yet submitted; the review may then be complete.
    .delete("/:id/reviewers/:reviewerId", reviewerParam, async (c) => {
      const actor = memberOnly(c.var.actor);
      const { id, reviewerId } = c.req.valid("param");
      const who = await deps.audit.member(actor.userId);
      const { review, next } = await deps.db.transaction(async (tx) => {
        const { review } = await lockReview(tx, actor, id);
        await can(tx, actor, "manage_reviewers", review.projectId);
        if (review.status !== "open") {
          throw new HTTPException(409, { message: `This review is ${review.status}` });
        }
        const [reviewer] = await tx
          .select({ submittedAt: reviewReviewers.submittedAt })
          .from(reviewReviewers)
          .where(
            inOrg(
              reviewReviewers,
              actor.organisationId,
              eq(reviewReviewers.id, reviewerId),
              eq(reviewReviewers.reviewId, review.id),
            ),
          );
        if (!reviewer) throw new NotFound("Reviewer");
        if (reviewer.submittedAt) {
          throw new HTTPException(409, {
            message: "A reviewer who has responded stays on the record",
          });
        }
        const { rows, facts } = await reviewersOf(tx, actor.organisationId, review.id);
        if (facts.length <= 1) {
          throw new HTTPException(409, {
            message: "A review needs a reviewer; cancel it instead",
          });
        }
        const before = activeReviewers(review.order, facts);
        await tx
          .delete(reviewReviewers)
          .where(inOrg(reviewReviewers, actor.organisationId, eq(reviewReviewers.id, reviewerId)));
        await deps.audit.record(
          actor.organisationId,
          who,
          {
            action: "review.reviewer_remove",
            projectId: review.projectId,
            reviewId: review.id,
            details: { name: rows.find((r) => r.id === reviewerId)?.name ?? null },
          },
          requestInfo(c, deps.trustProxy),
          tx,
        );
        const settled = await settle(tx, review);
        const after = await reviewersOf(tx, actor.organisationId, review.id);
        // In a sequence, removing whoever was up hands the turn to the next.
        const next =
          settled.status === "open"
            ? after.rows.filter((r) =>
                newlyActive(before, activeReviewers(review.order, after.facts)).includes(r.id),
              )
            : [];
        return { review: settled, next };
      });
      if (next.length > 0) await notify(deps, next, review, true);
      return c.json({ review: await reviewView(deps.db, actor, id) });
    });

/** A guest's open and past reviews, newest first, for their landing page. */
/**
 * The reviews a member is a reviewer of, in projects they can still see, with whether it is
 * their turn now. Open reviews first, then the most recent.
 */
export async function memberReviews(db: Database, actor: MemberActor) {
  const rows = await db
    .select({
      id: reviews.id,
      projectId: reviews.projectId,
      projectName: projects.name,
      kind: reviews.kind,
      title: reviews.title,
      status: reviews.status,
      outcome: reviews.outcome,
      order: reviews.order,
      dueAt: reviews.dueAt,
      createdAt: reviews.createdAt,
      reviewerId: reviewReviewers.id,
      submittedAt: reviewReviewers.submittedAt,
    })
    .from(reviewReviewers)
    .innerJoin(
      reviews,
      and(
        eq(reviews.id, reviewReviewers.reviewId),
        eq(reviews.organisationId, actor.organisationId),
      ),
    )
    .innerJoin(
      projects,
      and(eq(projects.id, reviews.projectId), eq(projects.organisationId, actor.organisationId)),
    )
    .where(inOrg(reviewReviewers, actor.organisationId, eq(reviewReviewers.userId, actor.userId)))
    // Open reviews come before the limit does, so one still waiting is never cut off.
    .orderBy(
      desc(sql`${reviews.status} = 'open' and ${reviewReviewers.submittedAt} is null`),
      desc(sql`${reviews.status} = 'open'`),
      desc(reviews.createdAt),
    )
    .limit(100);
  const visible = new Map<string, boolean>();
  const out = [];
  for (const row of rows) {
    if (!visible.has(row.projectId)) {
      visible.set(row.projectId, Boolean(await projectAccess(db, actor, row.projectId)));
    }
    if (!visible.get(row.projectId)) continue;
    let yourTurn = false;
    // A share asks nothing of anyone, so it is never anyone's turn (#138).
    if (row.status === "open" && !row.submittedAt && row.kind !== "share") {
      const { facts } = await reviewersOf(db, actor.organisationId, row.id);
      yourTurn = activeReviewers(row.order, facts).has(row.reviewerId);
    }
    const { reviewerId: _, ...rest } = row;
    out.push({ ...rest, yourTurn });
  }
  return out.sort((a, b) => Number(b.status === "open") - Number(a.status === "open"));
}

export async function guestReviews(db: Database, organisationId: string, guestId: string) {
  const rows = await db
    .select({
      id: reviews.id,
      kind: reviews.kind,
      title: reviews.title,
      status: reviews.status,
      outcome: reviews.outcome,
      dueAt: reviews.dueAt,
      createdAt: reviews.createdAt,
      submittedAt: reviewReviewers.submittedAt,
      permissions: reviewReviewers.permissions,
    })
    .from(reviewReviewers)
    .innerJoin(reviews, eq(reviews.id, reviewReviewers.reviewId))
    .where(
      and(
        inOrg(reviewReviewers, organisationId, eq(reviewReviewers.guestId, guestId)),
        eq(reviews.organisationId, organisationId),
      ),
    )
    .orderBy(desc(reviews.createdAt));
  // When each opens and closes to them, so the list can say so rather than fail on opening.
  const now = new Date();
  return rows.map(({ permissions, ...row }) => ({
    ...row,
    opensAt: permissions.startsAt,
    closesAt: permissions.expiresAt,
    accessOpen: withinWindow(permissions, now),
  }));
}

/**
 * A reviewer opened a file: every item of their open reviews that covers it counts as
 * opened, once. A file item covers its file; a track item, the files of the version it
 * reviews (any version, when it follows the latest).
 */
export async function noteOpened(db: Database, actor: Actor, fileId: string) {
  const org = actor.organisationId;
  const mine = await db
    .select({ id: reviewReviewers.id, reviewId: reviewReviewers.reviewId })
    .from(reviewReviewers)
    .innerJoin(
      reviews,
      and(
        eq(reviews.id, reviewReviewers.reviewId),
        eq(reviews.organisationId, org),
        eq(reviews.status, "open"),
      ),
    )
    .where(
      inOrg(
        reviewReviewers,
        org,
        actor.kind === "guest"
          ? eq(reviewReviewers.guestId, actor.guestId)
          : eq(reviewReviewers.userId, actor.userId),
      ),
    );
  if (mine.length === 0) return;
  const holding = await db
    .select({ versionId: variations.versionId, trackId: versions.trackId })
    .from(variations)
    .innerJoin(
      versions,
      and(eq(versions.id, variations.versionId), eq(versions.organisationId, org)),
    )
    .where(inOrg(variations, org, eq(variations.fileId, fileId)));
  const items = await db
    .select({ id: reviewItems.id, reviewId: reviewItems.reviewId })
    .from(reviewItems)
    .where(
      inOrg(
        reviewItems,
        org,
        inArray(
          reviewItems.reviewId,
          mine.map((m) => m.reviewId),
        ),
        or(
          eq(reviewItems.fileId, fileId),
          ...holding.map((h) =>
            and(
              eq(reviewItems.trackId, h.trackId),
              or(isNull(reviewItems.versionId), eq(reviewItems.versionId, h.versionId)),
            ),
          ),
        ),
      ),
    );
  const rows = items.flatMap((item) =>
    mine
      .filter((m) => m.reviewId === item.reviewId)
      .map((m) => ({ organisationId: org, reviewerId: m.id, itemId: item.id })),
  );
  if (rows.length > 0) await db.insert(reviewItemOpens).values(rows).onConflictDoNothing();
}
