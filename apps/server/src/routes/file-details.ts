import { type Database, inOrg, schema } from "@hekate/db";
import { and, asc, count, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { canOnFile } from "../access.ts";
import { NotFound } from "../errors.ts";
import type { ViewerVariables } from "../guests.ts";
import { zValidator } from "../openapi/validator.ts";

const {
  files,
  blobs,
  users,
  organisationKeys,
  renditions,
  renditionSegments,
  filePages,
  peakLevels,
  loudness,
  spectrograms,
  variations,
  versions,
  tracks,
  takes,
  reviewItems,
  reviews,
} = schema;

/**
 * `/api/files/:id/details`: everything known about one file, for its details sheet. Where it
 * is stored and how (never the key or the location), what has been made from it, where it is
 * used, and what the viewer may do with it. Members only: guests see files through reviews.
 */
export const fileDetailRoutes = (db: Database) =>
  new Hono<{ Variables: ViewerVariables }>().get(
    "/:id/details",
    zValidator("param", z.object({ id: z.uuid() })),
    async (c) => {
      const actor = c.var.actor;
      if (actor.kind === "guest") {
        throw new HTTPException(403, { message: "Guests see files through their reviews" });
      }
      const fileId = c.req.valid("param").id;
      const access = await canOnFile(db, actor, "view", fileId);
      const org = actor.organisationId;

      const [file] = await db
        .select({
          id: files.id,
          projectId: files.projectId,
          folderId: files.folderId,
          name: files.name,
          kind: files.kind,
          contentType: files.contentType,
          byteSize: files.byteSize,
          mediaInfo: files.mediaInfo,
          pageCount: files.pageCount,
          filmstripFrames: files.filmstripFrames,
          streamStatus: files.streamStatus,
          analysisStatus: files.analysisStatus,
          createdAt: files.createdAt,
          uploadedById: users.id,
          uploadedBy: users.name,
          backend: blobs.backend,
          sha256: blobs.sha256,
          keyVersion: blobs.keyVersion,
          takeId: files.takeId,
        })
        .from(files)
        .innerJoin(blobs, and(eq(blobs.id, files.blobId), eq(blobs.organisationId, org)))
        .leftJoin(users, eq(users.id, files.uploadedBy))
        .where(inOrg(files, org, eq(files.id, fileId)));
      if (!file) throw new NotFound("File");

      const [[key], made, [pages], [peaks], [measured], [spectrum], usedInVersions, take] =
        await Promise.all([
          db
            .select({ createdAt: organisationKeys.createdAt })
            .from(organisationKeys)
            .where(inOrg(organisationKeys, org, eq(organisationKeys.version, file.keyVersion))),
          db
            .select({
              name: renditions.name,
              codecs: renditions.codecs,
              bandwidth: renditions.bandwidth,
              width: renditions.width,
              height: renditions.height,
              segments: count(renditionSegments.index),
            })
            .from(renditions)
            .leftJoin(
              renditionSegments,
              and(
                eq(renditionSegments.renditionId, renditions.id),
                eq(renditionSegments.organisationId, org),
              ),
            )
            .where(inOrg(renditions, org, eq(renditions.fileId, fileId)))
            .groupBy(renditions.id)
            .orderBy(asc(renditions.bandwidth)),
          db
            .select({ n: count() })
            .from(filePages)
            .where(inOrg(filePages, org, eq(filePages.fileId, fileId))),
          db
            .select({ n: count() })
            .from(peakLevels)
            .where(inOrg(peakLevels, org, eq(peakLevels.fileId, fileId))),
          db
            .select({ n: count() })
            .from(loudness)
            .where(inOrg(loudness, org, eq(loudness.fileId, fileId))),
          db
            .select({ n: count() })
            .from(spectrograms)
            .where(inOrg(spectrograms, org, eq(spectrograms.fileId, fileId))),
          db
            .select({
              trackId: tracks.id,
              track: tracks.name,
              versionId: versions.id,
              number: versions.number,
              variation: variations.name,
              primary: variations.isPrimary,
              latest: sql<boolean>`${versions.number} = (select max(v2.number) from versions v2
                where v2.track_id = ${tracks.id} and v2.organisation_id = ${org})`,
            })
            .from(variations)
            .innerJoin(
              versions,
              and(eq(versions.id, variations.versionId), eq(versions.organisationId, org)),
            )
            .innerJoin(tracks, and(eq(tracks.id, versions.trackId), eq(tracks.organisationId, org)))
            .where(inOrg(variations, org, eq(variations.fileId, fileId))),
          // A take's place, for those who may see takes (#21).
          file.takeId && access.permissions.has("view_takes")
            ? db
                .select({
                  number: takes.number,
                  label: takes.label,
                  trackId: tracks.id,
                  track: tracks.name,
                })
                .from(takes)
                .innerJoin(
                  tracks,
                  and(eq(tracks.id, takes.trackId), eq(tracks.organisationId, org)),
                )
                .where(inOrg(takes, org, eq(takes.id, file.takeId)))
            : Promise.resolve([]),
        ]);

      // Reviews that ask about this file: as itself, as the version it is part of, or as its
      // track's latest while that is the version it is in.
      const versionIds = usedInVersions.map((v) => v.versionId);
      const latestOf = usedInVersions.filter((v) => v.latest).map((v) => v.trackId);
      const asked = await db
        .selectDistinct({ id: reviews.id, title: reviews.title, status: reviews.status })
        .from(reviewItems)
        .innerJoin(
          reviews,
          and(eq(reviews.id, reviewItems.reviewId), eq(reviews.organisationId, org)),
        )
        .where(
          inOrg(
            reviewItems,
            org,
            or(
              eq(reviewItems.fileId, fileId),
              versionIds.length ? inArray(reviewItems.versionId, versionIds) : undefined,
              latestOf.length
                ? and(inArray(reviewItems.trackId, latestOf), isNull(reviewItems.versionId))
                : undefined,
            ),
          ),
        );

      const { keyVersion, backend, sha256, takeId, filmstripFrames, ...rest } = file;
      const [inTake] = take;
      const admin = actor.organisationRole === "owner" || actor.organisationRole === "admin";
      return c.json({
        file: { ...rest, createdAt: rest.createdAt.toISOString() },
        storage: {
          backend,
          sha256,
          // Every stored object is encrypted under its own key (docs/security.md).
          encrypted: true,
          keyVersion,
          keySince: key?.createdAt.toISOString() ?? null,
        },
        renditions: made,
        pages: file.pageCount === null ? null : { total: file.pageCount, drawn: pages?.n ?? 0 },
        filmstrip: filmstripFrames,
        analysis: {
          status: file.analysisStatus,
          peaks: (peaks?.n ?? 0) > 0,
          loudness: (measured?.n ?? 0) > 0,
          spectrogram: (spectrum?.n ?? 0) > 0,
        },
        usedIn: {
          versions: usedInVersions.map(({ versionId: _, ...v }) => v),
          take: inTake && takeId ? inTake : null,
          reviews: asked,
        },
        can: {
          organise: access.permissions.has("organise"),
          upload: access.permissions.has("upload"),
          // The access log is for those who run the workspace (docs/security.md).
          log: admin,
          // A file in a version or a review stays (decision 027).
          delete:
            access.permissions.has("organise") && usedInVersions.length === 0 && asked.length === 0,
        },
      });
    },
  );
