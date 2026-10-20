import { type Database, inOrg, schema } from "@hekate/db";
import { movedToBar, type PrintedBar } from "@hekate/shared";
import { and, eq, inArray, isNotNull } from "drizzle-orm";

const { files, scoreMarks, takeChanges, takes, tracks } = schema;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** What swapping a track's score did to what was placed on the old one (#52). */
export interface Rehomed {
  /** Marks and takes carried to their bars in the new score. */
  marks: number;
  takes: number;
  /** Marks that name no bar, or whose bar neither score could find: left where they were. */
  stayed: number;
  /** The new score is still being drawn: its marks follow their bars once it is. */
  waiting?: boolean;
}

/**
 * Swap a track's score for another edition (#52), in the transaction that writes the track:
 * what was placed on the edition its marks sit on follows its bars into the new one. A score
 * not yet drawn has no bars to read yet, so the move waits for it (`rehomePending`). Nothing
 * when there was no score before, or the score did not change.
 */
export async function swapScore(
  tx: Tx,
  organisationId: string,
  trackId: string,
  to: string | null,
  by: string | null,
): Promise<Rehomed | undefined> {
  const [track] = await tx
    .select({ scoreFileId: tracks.scoreFileId, rehomeFrom: tracks.rehomeFrom })
    .from(tracks)
    .where(inOrg(tracks, organisationId, eq(tracks.id, trackId)))
    .for("update");
  // A move still waiting starts from the edition the marks are on, not the one never drawn.
  const from = track?.rehomeFrom ?? track?.scoreFileId ?? null;
  const settle = (rehomeFrom: string | null) =>
    tx
      .update(tracks)
      .set({ rehomeFrom, rehomeById: rehomeFrom ? by : null })
      .where(inOrg(tracks, organisationId, eq(tracks.id, trackId)));
  if (!to || !from || from === to) {
    if (track?.rehomeFrom) await settle(null);
    return undefined;
  }
  const [next] = await tx
    .select({ status: files.streamStatus, bars: files.printedBars })
    .from(files)
    .where(inOrg(files, organisationId, eq(files.id, to)));
  if (next?.status === "pending" && next.bars == null) {
    await settle(from);
    return { marks: 0, takes: 0, stayed: 0, waiting: true };
  }
  if (track?.rehomeFrom) await settle(null);
  return rehome(tx, organisationId, trackId, from, to, by);
}

/**
 * After a score is drawn: the tracks that took it before it was, their marks carried to its
 * bars now that they are read. Each in its own transaction, under the track's lock.
 */
export async function rehomePending(db: Database, organisationId: string, fileId: string) {
  const waiting = await db
    .select({ id: tracks.id })
    .from(tracks)
    .where(
      inOrg(tracks, organisationId, eq(tracks.scoreFileId, fileId), isNotNull(tracks.rehomeFrom)),
    );
  for (const { id } of waiting) {
    await db.transaction(async (tx) => {
      const [track] = await tx
        .select({
          scoreFileId: tracks.scoreFileId,
          rehomeFrom: tracks.rehomeFrom,
          by: tracks.rehomeById,
        })
        .from(tracks)
        .where(inOrg(tracks, organisationId, eq(tracks.id, id)))
        .for("update");
      // Swapped again meanwhile: that swap decides.
      if (!track?.rehomeFrom || track.scoreFileId !== fileId) return;
      await tx
        .update(tracks)
        .set({ rehomeFrom: null, rehomeById: null })
        .where(inOrg(tracks, organisationId, eq(tracks.id, id)));
      await rehome(tx, organisationId, id, track.rehomeFrom, fileId, track.by);
    });
  }
}

/**
 * Carry a track's score marks and its takes' score pages from one edition to another, by the
 * bar numbers both print. What names no bar, or a score without printed bars, stays on the
 * page and point it had.
 */
async function rehome(
  tx: Tx,
  organisationId: string,
  trackId: string,
  from: string,
  to: string,
  by: string | null,
): Promise<Rehomed> {
  const editions = await tx
    .select({ id: files.id, bars: files.printedBars })
    .from(files)
    .where(inOrg(files, organisationId, inArray(files.id, [from, to])));
  const barsOf = (id: string): PrintedBar[] => editions.find((e) => e.id === id)?.bars ?? [];
  const old = barsOf(from);
  const engraved = barsOf(to);

  const marks = await tx
    .select()
    .from(scoreMarks)
    .where(inOrg(scoreMarks, organisationId, eq(scoreMarks.trackId, trackId)))
    .for("update");
  let moved = 0;
  for (const m of marks) {
    const place = m.barFrom == null ? null : movedToBar(old, engraved, m.barFrom, m);
    if (!place) continue;
    // One shift for the whole mark, kept on the page: a region keeps its height, ink its shape.
    const ys = m.points?.map(([, py]) => py) ?? [];
    const top = Math.min(m.y, ...ys);
    const bottom = Math.max(m.y + (m.height ?? 0), ...ys);
    const dy = Math.min(1 - bottom, Math.max(-top, place.y - m.y));
    await tx
      .update(scoreMarks)
      .set({
        page: place.page,
        y: m.y + dy,
        points: m.points?.map(([px, py]) => [px, py + dy]) ?? null,
        updatedAt: new Date(),
      })
      .where(inOrg(scoreMarks, organisationId, eq(scoreMarks.id, m.id)));
    moved++;
  }

  // A take sits on one page of the score, the page its first bar is on.
  const placed = await tx
    .select({ id: takes.id, page: takes.page, barFrom: takes.barFrom })
    .from(takes)
    .where(inOrg(takes, organisationId, and(eq(takes.trackId, trackId), isNotNull(takes.page))))
    .for("update");
  let movedTakes = 0;
  const now = new Date();
  for (const t of placed) {
    if (t.barFrom == null || t.page == null) continue;
    const place = movedToBar(old, engraved, t.barFrom, { page: t.page, y: 0 });
    if (!place || place.page === t.page) continue;
    await tx
      .update(takes)
      .set({ page: place.page, updatedAt: now })
      .where(inOrg(takes, organisationId, eq(takes.id, t.id)));
    // In the take's history as whoever swapped the score, as any change to it is.
    await tx.insert(takeChanges).values({
      organisationId,
      takeId: t.id,
      field: "page",
      before: t.page,
      after: place.page,
      changedById: by,
      writtenAt: now,
    });
    movedTakes++;
  }
  return { marks: moved, takes: movedTakes, stayed: marks.length - moved };
}
