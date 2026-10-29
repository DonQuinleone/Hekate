import { type Database, inOrg, schema } from "@hekate/db";
import {
  type AlignmentPoints,
  composeAlignments,
  invertAlignment,
  usableAlignment,
} from "@hekate/shared";
import { and, eq, inArray } from "drizzle-orm";

const { alignments, variants, versions } = schema;

export interface Reached {
  fileId: string;
  /** From the starting file's times to this file's. */
  points: AlignmentPoints;
  /** The weakest alignment on the way. */
  quality: number;
}

/**
 * Every file of the same track that alignments reach from this one, each with the map from
 * this file's times to its own. Alignments join successive versions; variants of one
 * version are one edit, so they share their times. Walking both, V3 reaches V1 through V2,
 * and a wet mix reaches the previous version's dry mix through its own dry mix.
 */
export async function alignmentsFrom(
  db: Pick<Database, "select">,
  organisationId: string,
  fileId: string,
): Promise<Reached[]> {
  const [mine] = await db
    .select({ trackId: versions.trackId })
    .from(variants)
    .innerJoin(versions, eq(versions.id, variants.versionId))
    .where(inOrg(variants, organisationId, eq(variants.fileId, fileId)));
  // A loose file has only its own alignments; one in a track can walk the track.
  const family = mine
    ? await db
        .select({ fileId: variants.fileId, versionId: variants.versionId })
        .from(variants)
        .innerJoin(versions, eq(versions.id, variants.versionId))
        .where(inOrg(variants, organisationId, eq(versions.trackId, mine.trackId)))
    : [{ fileId, versionId: "" }];
  const ids = family.map((f) => f.fileId);
  const rows = await db
    .select({
      fromFileId: alignments.fromFileId,
      toFileId: alignments.toFileId,
      points: alignments.points,
      quality: alignments.quality,
    })
    .from(alignments)
    .where(
      inOrg(
        alignments,
        organisationId,
        eq(alignments.status, "ready"),
        mine
          ? and(inArray(alignments.fromFileId, ids), inArray(alignments.toFileId, ids))
          : inArray(alignments.fromFileId, [fileId]),
      ),
    );
  const loose = mine
    ? []
    : await db
        .select({
          fromFileId: alignments.fromFileId,
          toFileId: alignments.toFileId,
          points: alignments.points,
          quality: alignments.quality,
        })
        .from(alignments)
        .where(
          inOrg(
            alignments,
            organisationId,
            eq(alignments.status, "ready"),
            eq(alignments.toFileId, fileId),
          ),
        );

  // Who is next to whom: an alignment either way, or the same version (null: same times).
  const edges = new Map<
    string,
    { to: string; points: AlignmentPoints | null; quality: number }[]
  >();
  const link = (from: string, to: string, points: AlignmentPoints | null, quality: number) => {
    const list = edges.get(from) ?? [];
    list.push({ to, points, quality });
    edges.set(from, list);
  };
  for (const r of [...rows, ...loose]) {
    if (!usableAlignment(r.quality) || !r.points) continue;
    link(r.fromFileId, r.toFileId, r.points, r.quality as number);
    link(r.toFileId, r.fromFileId, invertAlignment(r.points), r.quality as number);
  }
  for (const a of family) {
    for (const b of family) {
      if (a.fileId !== b.fileId && a.versionId && a.versionId === b.versionId) {
        link(a.fileId, b.fileId, null, 1);
      }
    }
  }

  // Breadth first, so each file is reached by the fewest alignments.
  const seen = new Map<string, { points: AlignmentPoints | null; quality: number }>([
    [fileId, { points: null, quality: 1 }],
  ]);
  const queue = [fileId];
  while (queue.length > 0) {
    const at = queue.shift() as string;
    const here = seen.get(at) as { points: AlignmentPoints | null; quality: number };
    for (const edge of edges.get(at) ?? []) {
      if (seen.has(edge.to)) continue;
      const points =
        here.points && edge.points
          ? composeAlignments(here.points, edge.points)
          : (here.points ?? edge.points);
      seen.set(edge.to, { points, quality: Math.min(here.quality, edge.quality) });
      queue.push(edge.to);
    }
  }
  // Only files reached through at least one real alignment; siblings simply share times.
  return [...seen]
    .filter(([id, r]) => id !== fileId && r.points)
    .map(([id, r]) => ({ fileId: id, points: r.points as AlignmentPoints, quality: r.quality }));
}
