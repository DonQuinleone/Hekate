import { type Database, inOrg, schema } from "@hekate/db";
import {
  activeReviewers,
  createReviewInput,
  decisionInput,
  guestInput,
  type ReviewDecision,
  type ReviewerFacts,
  type ReviewerInput,
  type ReviewKind,
  reviewerState,
  reviewOutcome,
} from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { and, asc, desc, eq, inArray, max, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  type Actor,
  actorOf,
  can,
  type MemberActor,
  projectAccess,
  reviewAccess,
} from "../access.ts";
import { type Audit, requestInfo } from "../audit.ts";
import { NotFound } from "../errors.ts";
import { issueGuestLink, revokeGuest, type ViewerVariables } from "../guests.ts";
import type { Mailer } from "../mail.ts";
import type { TenantVariables } from "../tenancy.ts";

const {
  reviews,
  reviewItems,
  reviewReviewers,
  reviewDecisionLog,
  tracks,
  versions,
  variations,
  files,
  users,
  members,
  guests,
} = schema;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

const idParam = zValidator("param", z.object({ id: z.uuid() }));
/** One more reviewer: a member by user id, or a guest by name and email. */
const addReviewerInput = z.union([z.object({ userId: z.string().min(1).max(64) }), guestInput]);
const reviewerParam = zValidator("param", z.object({ id: z.uuid(), reviewerId: z.uuid() }));

export interface ReviewDeps {
  db: Database;
  audit: Audit;
  mailer: Mailer;
  publicUrl: string;
  trustProxy: boolean;
}

/** The reviewers of a review, in order, members and guests alike, with what the rules need. */
async function reviewersOf(db: Database | Tx, organisationId: string, reviewId: string) {
  const rows = await db
    .select({
      id: reviewReviewers.id,
      userId: reviewReviewers.userId,
      guestId: reviewReviewers.guestId,
      name: sql<string>`coalesce(${users.name}, ${guests.name})`,
      email: sql<string>`coalesce(${users.email}, ${guests.email})`,
      label: guests.label,
      position: reviewReviewers.position,
      viewedAt: reviewReviewers.viewedAt,
      startedAt: reviewReviewers.startedAt,
      submittedAt: reviewReviewers.submittedAt,
    })
    .from(reviewReviewers)
    .leftJoin(users, eq(users.id, reviewReviewers.userId))
    .leftJoin(guests, eq(guests.id, reviewReviewers.guestId))
    .where(inOrg(reviewReviewers, organisationId, eq(reviewReviewers.reviewId, reviewId)))
    .orderBy(asc(reviewReviewers.position));
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
    submitted: r.submittedAt !== null,
    decision: latest.get(r.id) ?? null,
    viewed: r.viewedAt !== null,
    started: r.startedAt !== null,
  }));
  return { rows, decisions, facts };
}
type ReviewerRow = Awaited<ReturnType<typeof reviewersOf>>["rows"][number];

/** The actor's own row among a review's reviewers, if they are one. */
const mineOf = (rows: ReviewerRow[], actor: Actor) =>
  rows.find((r) =>
    actor.kind === "guest" ? r.guestId === actor.guestId : r.userId === actor.userId,
  );

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
  const outcome = reviewOutcome(review.kind, review.rule, facts);
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
      const [primary] = version
        ? await db
            .select({ fileId: variations.fileId })
            .from(variations)
            .where(
              inOrg(
                variations,
                organisationId,
                eq(variations.versionId, version.id),
                eq(variations.isPrimary, true),
              ),
            )
        : [];
      return {
        id: item.id,
        kind: "track" as const,
        trackId: item.trackId,
        name: item.trackName,
        follows: item.versionId ? ("version" as const) : ("latest" as const),
        version: version ?? null,
        fileId: primary?.fileId ?? null,
      };
    }),
  );
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
  return {
    ...r,
    createdByName: review.createdByName,
    items: await itemsOf(db, actor.organisationId, reviewId),
    reviewers: rows.map((row, i) => ({
      id: row.id,
      userId: row.userId,
      guest: row.guestId !== null,
      name: row.name,
      label: row.label,
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
      active: me ? active.has(me.id) : false,
      // Changing your decision stays possible while the review is open.
      canDecide:
        Boolean(me) &&
        r.kind === "approval" &&
        r.status === "open" &&
        access.permissions.has("decide") &&
        (active.has(me?.id ?? "") || Boolean(me?.submittedAt)),
      canSubmit:
        Boolean(me) && r.kind === "feedback" && r.status === "open" && active.has(me?.id ?? ""),
      canManage: member && r.status === "open" && access.permissions.has("request_reviews"),
      canManageReviewers:
        member && r.status === "open" && access.permissions.has("manage_reviewers"),
    },
  };
}

/** A member's name, for the opening of a review request. */
async function nameOf(db: Database, userId: string) {
  const [user] = await db.select({ name: users.name }).from(users).where(eq(users.id, userId));
  return user?.name ?? "A colleague";
}

/** What to ask for, in a sentence: "approve" or "give feedback on" the review. */
const ask = (review: { kind: string; title: string }) =>
  `${review.kind === "approval" ? "approve" : "give feedback on"} "${review.title}"`;

type ReviewForMail = {
  id: string;
  organisationId: string;
  projectId: string;
  title: string;
  kind: string;
  message: string | null;
  dueAt: Date | null;
};

/**
 * Tell reviewers they have something to review. Members get a link to the review; guests
 * get a fresh magic link, logged. A mail that fails is logged, never fatal: the review
 * stands, and a guest's link can be re-sent.
 */
async function notify(
  deps: ReviewDeps,
  people: Pick<ReviewerRow, "email" | "guestId">[],
  review: ReviewForMail,
  opening: string,
) {
  const base = deps.publicUrl.replace(/\/$/, "");
  for (const person of people) {
    let link = `${base}/reviews/${review.id}`;
    if (person.guestId) {
      link = `${base}/guest/${await issueGuestLink(deps.db, review.organisationId, person.guestId)}`;
      await deps.audit.record(review.organisationId, await deps.audit.guest(person.guestId), {
        action: "guest.link",
        projectId: review.projectId,
        reviewId: review.id,
      });
    }
    const lines = [
      opening,
      ...(review.message ? ["", review.message] : []),
      ...(review.dueAt ? ["", `Due ${review.dueAt.toUTCString().slice(0, 16)}.`] : []),
      "",
      link,
      ...(person.guestId
        ? ["", "The link signs you in on this device and works once, for three days."]
        : []),
    ];
    await deps.mailer
      .send({ to: person.email, subject: `Review: ${review.title}`, text: lines.join("\n") })
      .catch((error: unknown) =>
        console.warn(`Could not send the review request to a reviewer: ${String(error)}`),
      );
  }
}

/** Reviewers newly able to act after a change: in a sequence, the next one. */
function newlyActive(before: Set<string>, after: Set<string>) {
  return [...after].filter((id) => !before.has(id));
}

/**
 * Who a reviewer entry names: a member who can see the project (and, for an approval,
 * decide), or a guest found (or created) by email in the organisation. Guests may always
 * decide: the review sets what they can do.
 */
async function resolveReviewer(
  tx: Database | Tx,
  actor: MemberActor,
  review: { projectId: string; kind: ReviewKind },
  entry: ReviewerInput,
): Promise<{ userId: string; guestId?: undefined } | { guestId: string; userId?: undefined }> {
  if (typeof entry !== "string") {
    const [found] = await tx
      .insert(guests)
      .values({
        organisationId: actor.organisationId,
        name: entry.name,
        email: entry.email,
        label: entry.label || null,
        createdBy: actor.userId,
      })
      .onConflictDoUpdate({
        target: [guests.organisationId, guests.email],
        // Keep their details current with the latest invitation.
        set: { name: entry.name, label: entry.label || null, updatedAt: new Date() },
      })
      .returning({ id: guests.id });
    if (!found) throw new Error("Guest upsert returned no row");
    return { guestId: found.id };
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
      return c.json({
        reviews: rows.map((r) => {
          const mine = counts.filter((x) => x.reviewId === r.id);
          return {
            ...r,
            reviewers: mine.length,
            submitted: mine.filter((x) => x.submittedAt).length,
            youReview: mine.some((x) => x.userId === c.var.userId),
          };
        }),
      });
    })
    .post("/:id/reviews", idParam, zValidator("json", createReviewInput), async (c) => {
      const organisationId = c.var.organisationId;
      const actor = actorOf(c.var);
      const { projectId } = await can(deps.db, actor, "request_reviews", c.req.valid("param").id);
      const input = c.req.valid("json");

      // Every item must be in this project.
      for (const item of input.items) {
        if ("fileId" in item) {
          const [file] = await deps.db
            .select({ id: files.id })
            .from(files)
            .where(
              inOrg(
                files,
                organisationId,
                eq(files.id, item.fileId),
                eq(files.projectId, projectId),
              ),
            );
          if (!file) throw new HTTPException(422, { message: "Items must come from this project" });
        } else {
          const [track] = await deps.db
            .select({ id: tracks.id })
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
        }
      }

      const who = await deps.audit.member(c.var.userId);
      const review = await deps.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(reviews)
          .values({
            organisationId,
            projectId,
            kind: input.kind,
            title: input.title,
            message: input.message || null,
            dueAt: input.dueAt ? new Date(input.dueAt) : null,
            order: input.order,
            rule: input.rule,
            createdBy: c.var.userId,
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
        const people = [];
        for (const entry of input.reviewers) {
          people.push(await resolveReviewer(tx, actor, { projectId, kind: input.kind }, entry));
        }
        await tx.insert(reviewReviewers).values(
          people.map((person, position) => ({
            organisationId,
            reviewId: created.id,
            userId: person.userId ?? null,
            guestId: person.guestId ?? null,
            position,
          })),
        );
        await deps.audit.record(
          organisationId,
          who,
          {
            action: "review.create",
            projectId,
            reviewId: created.id,
            details: { kind: created.kind, reviewers: input.reviewers.length },
          },
          requestInfo(c, deps.trustProxy),
          tx,
        );
        return created;
      });
      // Ask whoever can act now: everyone, or the first in a sequence.
      const { rows, facts } = await reviewersOf(deps.db, organisationId, review.id);
      const now = activeReviewers(review.order, facts);
      const requester = await nameOf(deps.db, c.var.userId);
      await notify(
        deps,
        rows.filter((r) => now.has(r.id)),
        review,
        `${requester} asks you to ${ask(review)}.`,
      );
      return c.json({ review: await reviewView(deps.db, actor, review.id) }, 201);
    });

/**
 * `/api/reviews/:id`: one review, and taking part in it, for members and guests alike;
 * managing it (cancelling, reviewers, guests' links) is for members whose role allows it.
 */
export const reviewRoutes = (deps: ReviewDeps) =>
  new Hono<{ Variables: ViewerVariables }>()
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
      if (next.length > 0) await notify(deps, next, review, `It is your turn to ${ask(review)}.`);
      return c.json({ review: await reviewView(deps.db, actor, review.id) });
    })
    .post("/:id/submit", idParam, async (c) => {
      const actor = c.var.actor;
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
      if (next.length > 0) await notify(deps, next, review, `It is your turn to ${ask(review)}.`);
      return c.json({ review: await reviewView(deps.db, actor, review.id) });
    })
    .post("/:id/cancel", idParam, async (c) => {
      const actor = memberOnly(c.var.actor);
      const who = await deps.audit.member(actor.userId);
      const review = await deps.db.transaction(async (tx) => {
        const { review } = await lockReview(tx, actor, c.req.valid("param").id);
        await can(tx, actor, "request_reviews", review.projectId);
        if (review.status !== "open") {
          throw new HTTPException(409, { message: `This review is ${review.status}` });
        }
        await tx
          .update(reviews)
          .set({ status: "cancelled", completedAt: new Date(), updatedAt: new Date() })
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
    // Add a reviewer, member or guest, at the end of the order while the review is open.
    .post("/:id/reviewers", idParam, zValidator("json", addReviewerInput), async (c) => {
      const actor = memberOnly(c.var.actor);
      const body = c.req.valid("json");
      const entry: ReviewerInput = "userId" in body ? body.userId : body;
      const { review, added, activeNow } = await deps.db.transaction(async (tx) => {
        const { review } = await lockReview(tx, actor, c.req.valid("param").id);
        await can(tx, actor, "manage_reviewers", review.projectId);
        if (review.status !== "open") {
          throw new HTTPException(409, { message: `This review is ${review.status}` });
        }
        const person = await resolveReviewer(tx, actor, review, entry);
        const [last] = await tx
          .select({ position: max(reviewReviewers.position) })
          .from(reviewReviewers)
          .where(
            inOrg(reviewReviewers, actor.organisationId, eq(reviewReviewers.reviewId, review.id)),
          );
        const [added] = await tx
          .insert(reviewReviewers)
          .values({
            organisationId: actor.organisationId,
            reviewId: review.id,
            userId: person.userId ?? null,
            guestId: person.guestId ?? null,
            position: (last?.position ?? -1) + 1,
          })
          .onConflictDoNothing()
          .returning({ id: reviewReviewers.id });
        if (!added) throw new HTTPException(409, { message: "They are already a reviewer" });
        const { rows, facts } = await reviewersOf(tx, actor.organisationId, review.id);
        return {
          review,
          added: rows.find((r) => r.id === added.id) as ReviewerRow,
          activeNow: activeReviewers(review.order, facts).has(added.id),
        };
      });
      if (activeNow) {
        const requester = await nameOf(deps.db, actor.userId);
        await notify(deps, [added], review, `${requester} asks you to ${ask(review)}.`);
      }
      return c.json({ review: await reviewView(deps.db, actor, review.id) }, 201);
    })
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
      const requester = await nameOf(deps.db, actor.userId);
      await notify(deps, [guest], review, `${requester} asks you to ${ask(review)}.`);
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
        const { facts } = await reviewersOf(tx, actor.organisationId, review.id);
        if (facts.length <= 1) {
          throw new HTTPException(409, {
            message: "A review needs a reviewer; cancel it instead",
          });
        }
        const before = activeReviewers(review.order, facts);
        await tx
          .delete(reviewReviewers)
          .where(inOrg(reviewReviewers, actor.organisationId, eq(reviewReviewers.id, reviewerId)));
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
      if (next.length > 0) await notify(deps, next, review, `It is your turn to ${ask(review)}.`);
      return c.json({ review: await reviewView(deps.db, actor, id) });
    });

/** A guest's open and past reviews, newest first, for their landing page. */
export async function guestReviews(db: Database, organisationId: string, guestId: string) {
  return db
    .select({
      id: reviews.id,
      kind: reviews.kind,
      title: reviews.title,
      status: reviews.status,
      outcome: reviews.outcome,
      dueAt: reviews.dueAt,
      createdAt: reviews.createdAt,
      submittedAt: reviewReviewers.submittedAt,
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
}
