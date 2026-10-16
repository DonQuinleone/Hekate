import { type Database, inOrg, schema } from "@hekate/db";
import { activeReviewers, withinWindow, workspaceSettingsOf } from "@hekate/shared";
import { and, eq, gt, isNull, lte } from "drizzle-orm";
import type { Audit } from "./audit.ts";
import { workspaceEmail } from "./email/templates.ts";
import { issueGuestLink } from "./guests.ts";
import { type Mailer, sendEmail } from "./mail.ts";
import { recordNotification } from "./notifications.ts";
import { reviewersOf } from "./routes/reviews.ts";

const { reviews, reviewReviewers, projects, organisations } = schema;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The day before a review is due, remind each reviewer it still waits on, once: members in
 * their inbox and by mail as they prefer, guests by mail with a fresh link. Each reviewer is
 * claimed before they are told, so two runs never remind anyone twice; a guest's mail that
 * fails releases the claim for the next run.
 */
export async function remindDue(
  deps: { db: Database; mailer: Mailer; audit: Audit; publicUrl: string },
  now = new Date(),
) {
  const { db } = deps;
  const base = deps.publicUrl.replace(/\/$/, "");
  let reminded = 0;
  for (const workspace of await db
    .select({ id: organisations.id, name: organisations.name, settings: organisations.settings })
    .from(organisations)) {
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
        const [claimed] = await db
          .update(reviewReviewers)
          .set({ remindedAt: now, updatedAt: now })
          .where(
            inOrg(
              reviewReviewers,
              workspace.id,
              eq(reviewReviewers.id, reviewer.id),
              isNull(reviewReviewers.remindedAt),
            ),
          )
          .returning({ id: reviewReviewers.id });
        if (!claimed) continue;
        const what = review.kind === "approval" ? "decision" : "feedback";
        if (reviewer.userId) {
          await recordNotification(db, {
            organisationId: workspace.id,
            kind: "due_soon",
            recipients: [reviewer.userId],
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
          reminded++;
          continue;
        }
        if (!reviewer.guestId) continue;
        try {
          const issued = await issueGuestLink(db, workspace.id, reviewer.guestId, now);
          await deps.audit.record(workspace.id, await deps.audit.guest(reviewer.guestId), {
            action: "guest.link",
            projectId: review.projectId,
            reviewId: review.id,
          });
          await sendEmail(
            deps.mailer,
            reviewer.email,
            workspaceEmail(
              "due_soon",
              {
                workspace: workspace.name,
                review: review.title,
                kind: review.kind,
                project: review.project,
                dueAt: review.dueAt,
                url: `${base}/guest/${issued.token}`,
                guestLinkDays: issued.days,
              },
              workspaceSettingsOf(workspace.settings).emailSubjects,
            ),
          );
          reminded++;
        } catch (error) {
          console.warn(`Could not remind a guest that a review is due: ${String(error)}`);
          await db
            .update(reviewReviewers)
            .set({ remindedAt: null, updatedAt: new Date() })
            .where(inOrg(reviewReviewers, workspace.id, eq(reviewReviewers.id, reviewer.id)));
        }
      }
    }
  }
  return reminded;
}
