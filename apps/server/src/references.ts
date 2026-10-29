import { type Database, inOrg, schema } from "@hekate/db";
import { type CommentReferences, effectiveReferences, type ProjectProfile } from "@hekate/shared";
import { and, asc, eq } from "drizzle-orm";

const { tracks, variants, versions } = schema;

type Reader = Pick<Database, "select">;

/**
 * The references a comment on this file may name (#240): its track's own, else its project's,
 * else its profile's. A file belongs to a track as a variant of one of its versions, or as the
 * score the track follows.
 */
export async function referencesOfFile(
  db: Reader,
  organisationId: string,
  fileId: string,
  project: { profile: ProjectProfile; commentReferences: unknown },
): Promise<CommentReferences> {
  const [variant] = await db
    .select({ references: tracks.commentReferences })
    .from(variants)
    .innerJoin(
      versions,
      and(eq(versions.id, variants.versionId), eq(versions.organisationId, organisationId)),
    )
    .innerJoin(
      tracks,
      and(eq(tracks.id, versions.trackId), eq(tracks.organisationId, organisationId)),
    )
    .where(inOrg(variants, organisationId, eq(variants.fileId, fileId)))
    .limit(1);
  const [score] = variant
    ? []
    : await db
        .select({ references: tracks.commentReferences })
        .from(tracks)
        .where(inOrg(tracks, organisationId, eq(tracks.scoreFileId, fileId)))
        // A score several tracks follow takes the first one's, in the project's track order.
        .orderBy(asc(tracks.position), asc(tracks.createdAt), asc(tracks.id))
        .limit(1);
  return effectiveReferences(
    { track: (variant ?? score)?.references ?? null, project: project.commentReferences },
    project.profile,
  );
}
