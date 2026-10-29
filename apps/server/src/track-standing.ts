import { type Database, inOrg, schema } from "@hekate/db";
import {
  activeReviewers,
  type ReviewOrder,
  type TrackReviewItem,
  type TrackState,
  trackState,
} from "@hekate/shared";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { reviewersOf } from "./routes/reviews.ts";

const { tracks, versions, variants, reviews, reviewItems } = schema;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export interface Person {
  id: string;
  name: string;
}

/**
 * Who each of the given open reviews waits on now: the reviewers of its current step who are
 * asked to act (in a sequence, later steps have not begun; observers decide nothing), by name,
 * members and guests alike.
 */
export async function waitingOnReviews(
  db: Database,
  organisationId: string,
  open: { id: string; order: ReviewOrder }[],
): Promise<Map<string, Person[]>> {
  const out = new Map<string, Person[]>();
  for (const r of open) {
    const { rows, facts } = await reviewersOf(db, organisationId, r.id);
    const active = activeReviewers(r.order, facts);
    out.set(
      r.id,
      rows
        .filter((row) => active.has(row.id))
        .flatMap((row) => {
          const id = row.userId ?? row.guestId;
          return id && row.name ? [{ id, name: row.name }] : [];
        }),
    );
  }
  return out;
}

/**
 * Where each of a project's tracks stands: its latest version and that version's primary
 * file, its state (see `trackState`) and, while in review, who it waits on. Also the project's
 * open reviews and who each waits on, which callers need beside it.
 */
export async function trackStandings(db: Database, organisationId: string, projectId: string) {
  const [trackRows, itemRows, openReviews] = await Promise.all([
    // Each track with its latest version and that version's primary file.
    db
      .select({
        id: tracks.id,
        name: tracks.name,
        versionId: versions.id,
        number: versions.number,
        versionAt: versions.createdAt,
        fileId: variants.fileId,
      })
      .from(tracks)
      .leftJoin(
        versions,
        and(
          eq(versions.trackId, tracks.id),
          eq(versions.organisationId, organisationId),
          sql`${versions.number} = (select max(v2.number) from versions v2
            where v2.track_id = ${tracks.id} and v2.organisation_id = ${organisationId})`,
        ),
      )
      .leftJoin(
        variants,
        and(
          eq(variants.versionId, versions.id),
          eq(variants.organisationId, organisationId),
          eq(variants.isPrimary, true),
        ),
      )
      .where(inOrg(tracks, organisationId, eq(tracks.projectId, projectId)))
      .orderBy(asc(tracks.position), asc(tracks.createdAt)),
    db
      .select({
        trackId: reviewItems.trackId,
        reviewId: reviews.id,
        versionId: reviewItems.versionId,
        kind: reviews.kind,
        status: reviews.status,
        outcome: reviews.outcome,
        completedAt: reviews.completedAt,
      })
      .from(reviewItems)
      .innerJoin(
        reviews,
        and(eq(reviews.id, reviewItems.reviewId), eq(reviews.organisationId, organisationId)),
      )
      .where(
        inOrg(
          reviewItems,
          organisationId,
          eq(reviews.projectId, projectId),
          sql`${reviewItems.trackId} is not null`,
        ),
      ),
    db
      .select({
        id: reviews.id,
        title: reviews.title,
        dueAt: reviews.dueAt,
        order: reviews.order,
      })
      .from(reviews)
      .where(
        inOrg(
          reviews,
          organisationId,
          eq(reviews.projectId, projectId),
          eq(reviews.status, "open"),
        ),
      )
      .orderBy(asc(reviews.dueAt), desc(reviews.createdAt)),
  ]);
  const waitingOn = await waitingOnReviews(db, organisationId, openReviews);
  const itemsBy = new Map<string, (TrackReviewItem & { reviewId: string })[]>();
  for (const i of itemRows) {
    if (!i.trackId) continue;
    itemsBy.set(i.trackId, [
      ...(itemsBy.get(i.trackId) ?? []),
      { ...i, completedAt: iso(i.completedAt) },
    ]);
  }
  const standings = trackRows.map((t) => {
    const latest =
      t.versionId && t.versionAt ? { id: t.versionId, createdAt: t.versionAt.toISOString() } : null;
    const items = itemsBy.get(t.id) ?? [];
    const state: TrackState = trackState(latest, items);
    // Those yet to answer an open review of it.
    const people = new Map<string, Person>();
    if (state === "in_review") {
      for (const i of items)
        if (i.status === "open")
          for (const p of waitingOn.get(i.reviewId) ?? []) people.set(p.id, p);
    }
    return {
      id: t.id,
      name: t.name,
      version:
        latest && t.number !== null
          ? { id: latest.id, number: t.number, createdAt: latest.createdAt, fileId: t.fileId }
          : null,
      state,
      waitingOn: [...people.values()],
    };
  });
  return { tracks: standings, openReviews, waitingOn };
}
