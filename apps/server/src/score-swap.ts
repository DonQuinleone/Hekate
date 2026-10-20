import { type Database, inOrg, schema } from "@hekate/db";
import { movedToBar, type PrintedBar } from "@hekate/shared";
import { and, eq, inArray, isNotNull } from "drizzle-orm";

const { files, scoreMarks, takes } = schema;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** What swapping a track's score did to what was placed on the old one (#52). */
export interface Rehomed {
  /** Marks and takes carried to their bars in the new score. */
  marks: number;
  takes: number;
  /** Marks that name no bar, or whose bar neither score could find: left where they were. */
  stayed: number;
}

/**
 * When a track's score is swapped for another edition (#52), carry its score marks and its
 * takes' score pages to their bars in the new one, by the bar numbers both scores print. What
 * names no bar, or a score without printed bars, stays on the page and point it had. Run in
 * the transaction that swaps the score.
 */
export async function rehomeOnSwap(
  tx: Tx,
  organisationId: string,
  trackId: string,
  from: string,
  to: string,
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
    // A region keeps its height on the page, and ink its shape, moved down or up as one.
    const y = Math.min(place.y, 1 - (m.height ?? 0));
    const dy = y - m.y;
    await tx
      .update(scoreMarks)
      .set({
        page: place.page,
        y,
        points: m.points?.map(([px, py]) => [px, Math.min(1, Math.max(0, py + dy))]) ?? null,
        updatedAt: new Date(),
      })
      .where(inOrg(scoreMarks, organisationId, eq(scoreMarks.id, m.id)));
    moved++;
  }

  const placed = await tx
    .select({ id: takes.id, page: takes.page, barFrom: takes.barFrom })
    .from(takes)
    .where(inOrg(takes, organisationId, and(eq(takes.trackId, trackId), isNotNull(takes.page))))
    .for("update");
  let movedTakes = 0;
  for (const t of placed) {
    if (t.barFrom == null || t.page == null) continue;
    const place = movedToBar(old, engraved, t.barFrom, { page: t.page, y: 0 });
    if (!place || place.page === t.page) continue;
    await tx
      .update(takes)
      .set({ page: place.page, updatedAt: new Date() })
      .where(inOrg(takes, organisationId, eq(takes.id, t.id)));
    movedTakes++;
  }
  return { marks: moved, takes: movedTakes, stayed: marks.length - moved };
}
