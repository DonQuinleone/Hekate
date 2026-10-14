import { type Database, inOrg, schema } from "@hekate/db";
import { type AlignmentPoints, type Anchor, carryTarget, mapTime } from "@hekate/shared";
import { and, desc, eq, inArray, isNull, lt } from "drizzle-orm";

const { alignments, comments, commentCarries, tracks, variations, versions } = schema;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Lock the track a file belongs to, if it is a variation. Creating a version holds the
 * same lock while it carries threads, so settling or reopening a thread never interleaves
 * with deciding which threads move on.
 */
export async function lockTrackOfFile(tx: Tx, organisationId: string, fileId: string) {
  await tx
    .select({ id: tracks.id })
    .from(tracks)
    .innerJoin(versions, eq(versions.trackId, tracks.id))
    .innerJoin(variations, eq(variations.versionId, versions.id))
    .where(inOrg(tracks, organisationId, eq(variations.fileId, fileId)))
    .for("update", { of: tracks });
}

/**
 * Carry the previous version's unresolved threads to a new version (docs/domain.md,
 * Comments across versions). A thread raised there, or carried there and still open or
 * not fixed, moves to the new version's variation of the same name, or else its primary.
 * Anchors keep their place until alignment between the versions (#33) maps them; the
 * editor can correct each one. Runs inside the transaction that creates the version, and
 * returns the alignments to compute: each earlier variation against its counterpart.
 */
export async function carryThreads(
  tx: Tx,
  organisationId: string,
  version: { id: string; trackId: string; number: number },
  shown: boolean,
): Promise<string[]> {
  const [previous] = await tx
    .select({ id: versions.id })
    .from(versions)
    .where(
      inOrg(
        versions,
        organisationId,
        eq(versions.trackId, version.trackId),
        lt(versions.number, version.number),
      ),
    )
    .orderBy(desc(versions.number))
    .limit(1);
  if (!previous) return [];

  const [before, after] = await Promise.all(
    [previous.id, version.id].map((versionId) =>
      tx
        .select({
          fileId: variations.fileId,
          name: variations.name,
          isPrimary: variations.isPrimary,
        })
        .from(variations)
        .where(inOrg(variations, organisationId, eq(variations.versionId, versionId))),
    ),
  );
  if (!before?.length || !after?.length) return [];
  const nameOf = new Map(before.map((v) => [v.fileId, v.name]));
  const fileIds = [...nameOf.keys()];

  // Threads raised on the previous version, and those carried there that are still live.
  const raised = await tx
    .select({ commentId: comments.id, fileId: comments.fileId, anchor: comments.anchor })
    .from(comments)
    .where(
      inOrg(
        comments,
        organisationId,
        inArray(comments.fileId, fileIds),
        isNull(comments.parentId),
        isNull(comments.resolvedAt),
      ),
    );
  const carried = await tx
    .select({
      commentId: commentCarries.commentId,
      fileId: commentCarries.fileId,
      anchor: commentCarries.anchor,
    })
    .from(commentCarries)
    .innerJoin(comments, eq(comments.id, commentCarries.commentId))
    .where(
      inOrg(
        commentCarries,
        organisationId,
        inArray(commentCarries.fileId, fileIds),
        inArray(commentCarries.status, ["open", "not_fixed"]),
        isNull(comments.resolvedAt),
      ),
    );

  const rows: {
    organisationId: string;
    commentId: string;
    fileId: string;
    anchor: Anchor | null;
    visible: boolean;
  }[] = [];
  for (const source of [...raised, ...carried]) {
    const target = carryTarget(nameOf.get(source.fileId) ?? "", after);
    if (!target) continue;
    rows.push({
      organisationId,
      commentId: source.commentId,
      fileId: target.fileId,
      anchor: source.anchor,
      visible: shown,
    });
  }
  if (rows.length > 0) await tx.insert(commentCarries).values(rows).onConflictDoNothing();

  // Each earlier variation is aligned with the one its threads move to.
  const pairs = before.flatMap((v) => {
    const target = carryTarget(v.name, after);
    return target ? [{ organisationId, fromFileId: v.fileId, toFileId: target.fileId }] : [];
  });
  if (pairs.length === 0) return [];
  const queued = await tx
    .insert(alignments)
    .values(pairs)
    .onConflictDoNothing()
    .returning({ id: alignments.id });
  return queued.map((a) => a.id);
}

/**
 * Once two files are aligned, move the threads carried from one to the other to where the
 * same music is, unless someone has already placed them by hand. Only time anchors move.
 */
export async function remapCarries(
  tx: Tx,
  organisationId: string,
  pair: { fromFileId: string; toFileId: string },
  points: AlignmentPoints,
) {
  const here = await tx
    .select({ id: commentCarries.id, commentId: commentCarries.commentId })
    .from(commentCarries)
    .where(
      inOrg(
        commentCarries,
        organisationId,
        eq(commentCarries.fileId, pair.toFileId),
        eq(commentCarries.anchorPlaced, false),
      ),
    );
  if (here.length === 0) return 0;
  const ids = here.map((c) => c.commentId);
  // Where each thread pointed on the earlier file: where it was raised, or carried to.
  const raised = await tx
    .select({ commentId: comments.id, anchor: comments.anchor })
    .from(comments)
    .where(
      inOrg(
        comments,
        organisationId,
        inArray(comments.id, ids),
        eq(comments.fileId, pair.fromFileId),
      ),
    );
  const carried = await tx
    .select({ commentId: commentCarries.commentId, anchor: commentCarries.anchor })
    .from(commentCarries)
    .where(
      inOrg(
        commentCarries,
        organisationId,
        inArray(commentCarries.commentId, ids),
        eq(commentCarries.fileId, pair.fromFileId),
      ),
    );
  const earlier = new Map([...raised, ...carried].map((r) => [r.commentId, r.anchor]));
  let moved = 0;
  for (const carry of here) {
    const anchor = earlier.get(carry.commentId);
    if (anchor?.kind !== "time") continue;
    const start = Math.round(mapTime(points, anchor.start) * 1000) / 1000;
    const end = Math.max(start, Math.round(mapTime(points, anchor.end) * 1000) / 1000);
    await tx
      .update(commentCarries)
      .set({ anchor: { kind: "time", start, end }, updatedAt: new Date() })
      .where(inOrg(commentCarries, organisationId, eq(commentCarries.id, carry.id)));
    moved++;
  }
  return moved;
}

/** Every version a set of threads was carried to, for each thread's history. */
export async function hopsOf(
  db: Pick<Database, "select"> | Tx,
  organisationId: string,
  commentIds: string[],
) {
  if (commentIds.length === 0) return [];
  return db
    .select({
      id: commentCarries.id,
      commentId: commentCarries.commentId,
      fileId: commentCarries.fileId,
      anchor: commentCarries.anchor,
      visible: commentCarries.visible,
      status: commentCarries.status,
      versionNumber: versions.number,
    })
    .from(commentCarries)
    .innerJoin(
      variations,
      and(
        eq(variations.fileId, commentCarries.fileId),
        eq(variations.organisationId, commentCarries.organisationId),
      ),
    )
    .innerJoin(versions, eq(versions.id, variations.versionId))
    .where(inOrg(commentCarries, organisationId, inArray(commentCarries.commentId, commentIds)))
    .orderBy(versions.number);
}

/** The version number of each file that is a variation, for naming where a thread began. */
export async function versionNumbersOf(
  db: Pick<Database, "select">,
  organisationId: string,
  fileIds: string[],
) {
  if (fileIds.length === 0) return new Map<string, number>();
  const rows = await db
    .select({ fileId: variations.fileId, number: versions.number })
    .from(variations)
    .innerJoin(versions, eq(versions.id, variations.versionId))
    .where(inOrg(variations, organisationId, inArray(variations.fileId, fileIds)));
  return new Map(rows.map((r) => [r.fileId, r.number]));
}
