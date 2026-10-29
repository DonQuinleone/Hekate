import { type Database, inOrg, schema } from "@hekate/db";
import { activeReviewers, withinWindow, workspaceSettingsOf } from "@hekate/shared";
import { and, eq, gt, inArray, isNull, lte } from "drizzle-orm";
import type { Audit } from "./audit.ts";
import { workspaceDateFormats } from "./dates.ts";
import { workspaceEmail } from "./email/templates.ts";
import { issueGuestLink } from "./guests.ts";
import { type LinkRoots, linkBase } from "./hosts.ts";
import { type Mailer, sendEmail } from "./mail.ts";
import { recordNotification } from "./notifications.ts";
import { reviewersOf } from "./routes/reviews.ts";

const { reviews, reviewReviewers, projects, organisations } = schema;
const DAY_MS = 24 * 60 * 60 * 1000;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Mark reviewers reminded, those not already; returns the ones this call claimed. */
async function claim(db: Database | Tx, organisationId: string, ids: string[], now: Date) {
  if (ids.length === 0) return [];
  const rows = await db
    .update(reviewReviewers)
    .set({ remindedAt: now, updatedAt: now })
    .where(
      inOrg(
        reviewReviewers,
        organisationId,
        inArray(reviewReviewers.id, ids),
        isNull(reviewReviewers.remindedAt),
      ),
    )
    .returning({ id: reviewReviewers.id });
  return rows.map((r) => r.id);
}

/**
 * The day before a review is due, remind each reviewer it still waits on, once: members in
 * their inbox and by mail as they prefer, guests by mail with a fresh link. Each reviewer is
 * claimed before they are told, so two runs never remind anyone twice; a guest's mail that
 * fails releases the claim for the next run.
 */
export async function remindDue(
  deps: { db: Database; mailer: Mailer; audit: Audit } & LinkRoots,
  now = new Date(),
) {
  const { db } = deps;
  let reminded = 0;
  for (const workspace of await db
    .select({
      id: organisations.id,
      name: organisations.name,
      slug: organisations.slug,
      settings: organisations.settings,
    })
    .from(organisations)) {
    // A guest's link opens at the workspace's own address with subdomains on (#437).
    const base = linkBase(deps, workspace.slug);
    // Its dates as the workspace reads them (#481).
    const { dateFormat } = await workspaceDateFormats(db, workspace.id, workspace.settings);
    type Due = { reviewerId: string; review: (typeof due)[number] & { dueAt: Date } };
    const guests = new Map<string, { email: string; due: Due[] }>();
    const due = await db
      .select({
        id: reviews.id,
        title: reviews.title,
        kind: reviews.kind,
        order: reviews.order,
        dueAt: reviews.dueAt,
        projectId: reviews.projectId,
        project: projects.name,
      })
      .from(reviews)
      .innerJoin(
        projects,
        and(eq(projects.id, reviews.projectId), eq(projects.organisationId, workspace.id)),
      )
      .where(
        inOrg(
          reviews,
          workspace.id,
          eq(reviews.status, "open"),
          eq(reviews.remind, true),
          gt(reviews.dueAt, now),
          lte(reviews.dueAt, new Date(now.getTime() + DAY_MS)),
        ),
      );
    for (const review of due) {
      if (!review.dueAt) continue;
      const { rows, facts } = await reviewersOf(db, workspace.id, review.id);
      const waiting = activeReviewers(review.order, facts);
      for (const reviewer of rows) {
        if (!waiting.has(reviewer.id) || !withinWindow(reviewer.permissions, now)) continue;
        if (reviewer.guestId) {
          // Gathered, so a guest with several reviews due gets one link that works for all.
          const theirs = guests.get(reviewer.guestId) ?? { email: reviewer.email, due: [] };
          theirs.due.push({ reviewerId: reviewer.id, review: { ...review, dueAt: review.dueAt } });
          guests.set(reviewer.guestId, theirs);
          continue;
        }
        if (!reviewer.userId) continue;
        const userId = reviewer.userId;
        const what = review.kind === "approval" ? "decision" : "feedback";
        // The claim and the notification commit together: neither stands without the other.
        const told = await db.transaction(async (tx) => {
          if (!(await claim(tx, workspace.id, [reviewer.id], now)).length) return false;
          await recordNotification(tx, {
            organisationId: workspace.id,
            kind: "due_soon",
            recipients: [userId],
            actor: null,
            projectId: review.projectId,
            reviewId: review.id,
            text: `your ${what} on "${review.title}" is due tomorrow`,
            link: `/reviews/${review.id}`,
            mail: {
              template: "due_soon",
              values: { review: review.title, project: review.project },
            },
          });
          return true;
        });
        if (told) reminded++;
      }
    }
    for (const [guestId, { email, due }] of guests) {
      const claimed = new Set(
        await claim(
          db,
          workspace.id,
          due.map((d) => d.reviewerId),
          now,
        ),
      );
      const mine = due.filter((d) => claimed.has(d.reviewerId));
      const [first, ...others] = mine;
      if (!first) continue;
      try {
        const issued = await issueGuestLink(db, workspace.id, guestId, now);
        for (const d of mine) {
          await deps.audit.record(workspace.id, await deps.audit.guest(guestId), {
            action: "guest.link",
            projectId: d.review.projectId,
            reviewId: d.review.id,
          });
        }
        await sendEmail(
          deps.mailer,
          email,
          workspaceEmail(
            "due_soon",
            {
              workspace: workspace.name,
              review: first.review.title,
              kind: first.review.kind,
              project: first.review.project,
              dueAt: first.review.dueAt,
              others: others.map((d) => d.review.title),
              url: `${base}/guest/${issued.token}`,
              guestLinkDays: issued.days,
            },
            workspaceSettingsOf(workspace.settings).emailSubjects,
            dateFormat,
          ),
          workspace.id,
        );
        reminded += mine.length;
      } catch (error) {
        console.warn(`Could not remind a guest that a review is due: ${String(error)}`);
        await db
          .update(reviewReviewers)
          .set({ remindedAt: null, updatedAt: new Date() })
          .where(
            inOrg(
              reviewReviewers,
              workspace.id,
              inArray(
                reviewReviewers.id,
                mine.map((d) => d.reviewerId),
              ),
            ),
          );
      }
    }
  }
  return reminded;
}
