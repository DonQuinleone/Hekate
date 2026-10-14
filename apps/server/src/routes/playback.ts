import { type Database, inOrg, schema } from "@hekate/db";
import type { ReviewerTool } from "@hekate/shared";
import { unwrapKey } from "@hekate/storage";
import { zValidator } from "@hono/zod-validator";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { type Actor, canOnFile, fileAccess, guestFileReviews } from "../access.ts";
import { alignmentsFrom } from "../alignment-graph.ts";
import { type Audit, requestInfo } from "../audit.ts";
import { NotFound } from "../errors.ts";
import type { PlaySessionVariables, ViewerVariables } from "../guests.ts";
import type { Keyring } from "../keyring.ts";
import {
  keyRateLimiter,
  PLAYBACK_LIFETIME_SECONDS,
  type PlaybackClaims,
  signPlayback,
  verifyPlayback,
} from "../playback.ts";
import type { Storage } from "../storage.ts";
import { membershipOf } from "../tenancy.ts";

const {
  filePages,
  files,
  renditions,
  renditionSegments,
  users,
  peakLevels,
  loudness,
  spectrograms,
  variations,
  versions,
  tracks,
} = schema;

export interface PlaybackDeps {
  db: Database;
  storage: Storage;
  keyring: Keyring;
  audit: Audit;
  secret: Buffer;
  trustProxy: boolean;
}

/** Nothing about playback may be cached or shared: every response is per viewer, per session. */
const PRIVATE = {
  "cache-control": "no-store, private",
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
} as const;

const fileParam = zValidator("param", z.object({ id: z.uuid() }));

/** `/api/files/:id`: one file's details, and `POST /api/files/:id/playback` to start watching or listening. */
/**
 * Every `/api/files/:id…` route here reads a file: its project must let the caller view it.
 * A file in a project they cannot see does not exist for them (404).
 */
const viewFile = (db: Database) =>
  createMiddleware<{ Variables: ViewerVariables }>(async (c, next) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) throw new NotFound("File");
    await canOnFile(db, c.var.actor, "view", id.data);
    await next();
  });

/**
 * As `viewFile`, for an engineer's tool: a guest whose review leaves the tool out is
 * refused it here, not only hidden in the interface.
 */
const toolFile = (db: Database, tool: ReviewerTool) =>
  createMiddleware<{ Variables: ViewerVariables }>(async (c, next) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) throw new NotFound("File");
    const access = await canOnFile(db, c.var.actor, "view", id.data);
    if (access.grant && !access.grant.tools.includes(tool)) {
      throw new HTTPException(403, { message: "This review does not include that tool" });
    }
    await next();
  });

export const fileRoutes = (deps: PlaybackDeps) =>
  new Hono<{ Variables: ViewerVariables }>()
    .use("/:id", viewFile(deps.db))
    .use("/:id/peaks/*", viewFile(deps.db))
    .use("/:id/peaks", viewFile(deps.db))
    .use("/:id/loudness/*", toolFile(deps.db, "meters"))
    .use("/:id/loudness", toolFile(deps.db, "meters"))
    .use("/:id/spectrograms/*", toolFile(deps.db, "spectrogram"))
    .use("/:id/spectrograms", toolFile(deps.db, "spectrogram"))
    .use("/:id/playback", viewFile(deps.db))
    .use("/:id/view", viewFile(deps.db))
    .use("/:id/alignments", viewFile(deps.db))
    .get("/:id", fileParam, async (c) => {
      // Metadata only: contents leave Hekate solely through protected delivery.
      const [file] = await deps.db
        .select({
          id: files.id,
          projectId: files.projectId,
          folderId: files.folderId,
          name: files.name,
          kind: files.kind,
          contentType: files.contentType,
          byteSize: files.byteSize,
          mediaInfo: files.mediaInfo,
          streamStatus: files.streamStatus,
          analysisStatus: files.analysisStatus,
          pageCount: files.pageCount,
          uploadedBy: users.name,
          createdAt: files.createdAt,
        })
        .from(files)
        .leftJoin(users, eq(files.uploadedBy, users.id))
        .where(inOrg(files, c.var.organisationId, eq(files.id, c.req.valid("param").id)));
      if (!file) throw new NotFound("File");
      // Where the file sits in the music model, if it is a variation of a track's version.
      const [variation] = await deps.db
        .select({
          id: variations.id,
          name: variations.name,
          isPrimary: variations.isPrimary,
          versionId: versions.id,
          versionNumber: versions.number,
          trackId: tracks.id,
          trackName: tracks.name,
        })
        .from(variations)
        .innerJoin(versions, eq(versions.id, variations.versionId))
        .innerJoin(tracks, eq(tracks.id, versions.trackId))
        .where(inOrg(variations, c.var.organisationId, eq(variations.fileId, file.id)));
      // A guest's review decides which tools and actions they have; members have their role.
      const access = await fileAccess(deps.db, c.var.actor, file.id);
      return c.json({
        file: { ...file, variation: variation ?? null, grant: access?.grant ?? null },
      });
    })
    // Where the same music sits in this file and the others it was aligned with, read from
    // this file's side. Members compare versions; guests see only their review's files.
    .get("/:id/alignments", fileParam, async (c) => {
      if (c.var.actor.kind === "guest") return c.json({ alignments: [] });
      return c.json({
        alignments: await alignmentsFrom(deps.db, c.var.organisationId, c.req.valid("param").id),
      });
    })
    // Waveform peaks: an 8-bit envelope per channel, from which no audio can be rebuilt, so
    // members fetch them directly rather than through playback tokens.
    .get("/:id/peaks", fileParam, async (c) => {
      const organisationId = c.var.organisationId;
      const [file] = await deps.db
        .select({ id: files.id, analysisStatus: files.analysisStatus })
        .from(files)
        .where(inOrg(files, organisationId, eq(files.id, c.req.valid("param").id)));
      if (!file) throw new NotFound("File");
      const levels = await deps.db
        .select({
          id: peakLevels.id,
          samplesPerPeak: peakLevels.samplesPerPeak,
          count: peakLevels.peakCount,
          channels: peakLevels.channels,
          sampleRate: peakLevels.sampleRate,
        })
        .from(peakLevels)
        .where(inOrg(peakLevels, organisationId, eq(peakLevels.fileId, file.id)))
        .orderBy(asc(peakLevels.samplesPerPeak));
      return c.json({ status: file.analysisStatus, levels }, 200, { "cache-control": "no-store" });
    })
    .get(
      "/:id/peaks/:levelId",
      zValidator("param", z.object({ id: z.uuid(), levelId: z.uuid() })),
      async (c) => {
        const { id, levelId } = c.req.valid("param");
        const organisationId = c.var.organisationId;
        const [level] = await deps.db
          .select({ blobId: peakLevels.blobId })
          .from(peakLevels)
          .where(
            inOrg(
              peakLevels,
              organisationId,
              eq(peakLevels.id, levelId),
              eq(peakLevels.fileId, id),
            ),
          );
        if (!level) throw new NotFound("Peaks");
        const { blob, stream } = await deps.storage.open(organisationId, level.blobId);
        return new Response(stream as unknown as ReadableStream, {
          headers: {
            ...PRIVATE,
            "content-type": "application/octet-stream",
            "content-length": String(blob.byteSize),
          },
        });
      },
    )
    // Loudness and levels: numbers about the audio, like peaks, so members fetch them directly.
    .get("/:id/loudness", fileParam, async (c) => {
      const organisationId = c.var.organisationId;
      const [file] = await deps.db
        .select({ id: files.id, analysisStatus: files.analysisStatus })
        .from(files)
        .where(inOrg(files, organisationId, eq(files.id, c.req.valid("param").id)));
      if (!file) throw new NotFound("File");
      const [row] = await deps.db
        .select({
          summary: loudness.summary,
          channels: loudness.channels,
          sampleRate: loudness.sampleRate,
          samplesPerFrame: loudness.samplesPerFrame,
          count: loudness.frameCount,
        })
        .from(loudness)
        .where(inOrg(loudness, organisationId, eq(loudness.fileId, file.id)));
      const { summary = null, ...series } = row ?? {};
      return c.json({ status: file.analysisStatus, summary, series: row ? series : null }, 200, {
        "cache-control": "no-store",
      });
    })
    .get("/:id/loudness/series", fileParam, async (c) => {
      const organisationId = c.var.organisationId;
      const [row] = await deps.db
        .select({ blobId: loudness.blobId })
        .from(loudness)
        .where(inOrg(loudness, organisationId, eq(loudness.fileId, c.req.valid("param").id)));
      if (!row) throw new NotFound("Loudness");
      const { blob, stream } = await deps.storage.open(organisationId, row.blobId);
      return new Response(stream as unknown as ReadableStream, {
        headers: {
          ...PRIVATE,
          "content-type": "application/octet-stream",
          "content-length": String(blob.byteSize),
        },
      });
    })
    // Spectrograms: band levels over time, from which no audio can be rebuilt (like peaks).
    .get("/:id/spectrograms", fileParam, async (c) => {
      const organisationId = c.var.organisationId;
      const [file] = await deps.db
        .select({ id: files.id, analysisStatus: files.analysisStatus })
        .from(files)
        .where(inOrg(files, organisationId, eq(files.id, c.req.valid("param").id)));
      if (!file) throw new NotFound("File");
      const rows = await deps.db
        .select({
          id: spectrograms.id,
          channel: spectrograms.channel,
          fftSize: spectrograms.fftSize,
          sampleRate: spectrograms.sampleRate,
          samplesPerColumn: spectrograms.samplesPerColumn,
          columns: spectrograms.columnCount,
          bands: spectrograms.bandCount,
        })
        .from(spectrograms)
        .where(inOrg(spectrograms, organisationId, eq(spectrograms.fileId, file.id)));
      return c.json({ status: file.analysisStatus, spectrograms: rows }, 200, {
        "cache-control": "no-store",
      });
    })
    .get(
      "/:id/spectrograms/:spectrogramId",
      zValidator("param", z.object({ id: z.uuid(), spectrogramId: z.uuid() })),
      async (c) => {
        const { id, spectrogramId } = c.req.valid("param");
        const organisationId = c.var.organisationId;
        const [row] = await deps.db
          .select({ blobId: spectrograms.blobId })
          .from(spectrograms)
          .where(
            inOrg(
              spectrograms,
              organisationId,
              eq(spectrograms.id, spectrogramId),
              eq(spectrograms.fileId, id),
            ),
          );
        if (!row) throw new NotFound("Spectrogram");
        const { blob, stream } = await deps.storage.open(organisationId, row.blobId);
        return new Response(stream as unknown as ReadableStream, {
          headers: {
            ...PRIVATE,
            "content-type": "application/octet-stream",
            "content-length": String(blob.byteSize),
          },
        });
      },
    )
    // Pages of a document or picture (#29): a session-bound link to each page the server
    // drew, never the file. Each page is logged as it is served.
    .post("/:id/view", fileParam, async (c) => {
      const { id } = c.req.valid("param");
      const organisationId = c.var.organisationId;
      const [file] = await deps.db
        .select({
          id: files.id,
          streamStatus: files.streamStatus,
          pageCount: files.pageCount,
          kind: files.kind,
        })
        .from(files)
        .where(inOrg(files, organisationId, eq(files.id, id)));
      if (!file) throw new NotFound("File");
      if ((file.kind !== "document" && file.kind !== "image") || file.streamStatus !== "ready") {
        throw new HTTPException(409, {
          message:
            file.streamStatus === "pending"
              ? "This file is still being prepared"
              : "This file has no pages to show",
        });
      }
      const pages = await deps.db
        .select({ page: filePages.page, width: filePages.width, height: filePages.height })
        .from(filePages)
        .where(inOrg(filePages, organisationId, eq(filePages.fileId, file.id)))
        .orderBy(asc(filePages.page));
      const actor = c.var.actor;
      const reviewId =
        actor.kind === "guest"
          ? (await guestFileReviews(deps.db, actor)).get(file.id)?.[0]
          : undefined;
      if (actor.kind === "guest" && !reviewId) throw new NotFound("File");
      const expiresAt = Math.floor(Date.now() / 1000) + PLAYBACK_LIFETIME_SECONDS;
      const token = signPlayback(deps.secret, {
        sessionId: c.var.sessionId,
        organisationId,
        fileId: file.id,
        ...(reviewId ? { reviewId } : {}),
        expiresAt,
      });
      return c.json(
        {
          expiresAt: new Date(expiresAt * 1000),
          pageCount: file.pageCount ?? pages.length,
          pages: pages.map((p) => ({
            ...p,
            url: `/api/play/${token}/pages/${p.page}/view`,
            thumbUrl: `/api/play/${token}/pages/${p.page}/thumb`,
          })),
        },
        201,
      );
    })
    .post("/:id/playback", fileParam, async (c) => {
      const { id } = c.req.valid("param");
      const organisationId = c.var.organisationId;
      const [file] = await deps.db
        .select({ id: files.id, projectId: files.projectId, streamStatus: files.streamStatus })
        .from(files)
        .where(inOrg(files, organisationId, eq(files.id, id)));
      if (!file) throw new NotFound("File");
      if (file.streamStatus !== "ready") {
        throw new HTTPException(409, {
          message:
            file.streamStatus === "pending"
              ? "This file is still being prepared"
              : "This file cannot be played",
        });
      }
      const available = await deps.db
        .select({
          id: renditions.id,
          name: renditions.name,
          codecs: renditions.codecs,
          bandwidth: renditions.bandwidth,
          width: renditions.width,
          height: renditions.height,
        })
        .from(renditions)
        .where(inOrg(renditions, organisationId, eq(renditions.fileId, file.id)))
        .orderBy(asc(renditions.bandwidth));
      const expiresAt = Math.floor(Date.now() / 1000) + PLAYBACK_LIFETIME_SECONDS;
      // A guest plays a file through a review: the newest open one that includes it.
      const actor = c.var.actor;
      const reviewId =
        actor.kind === "guest"
          ? (await guestFileReviews(deps.db, actor)).get(file.id)?.[0]
          : undefined;
      if (actor.kind === "guest" && !reviewId) throw new NotFound("File");
      const token = signPlayback(deps.secret, {
        sessionId: c.var.sessionId,
        organisationId,
        fileId: file.id,
        ...(reviewId ? { reviewId } : {}),
        expiresAt,
      });
      await deps.audit.record(
        organisationId,
        await deps.audit.actor(actor),
        {
          action: "stream.session",
          projectId: file.projectId,
          fileId: file.id,
          ...(reviewId ? { reviewId } : {}),
        },
        requestInfo(c, deps.trustProxy),
      );
      return c.json(
        {
          url: `/api/play/${token}/master.m3u8`,
          expiresAt: new Date(expiresAt * 1000),
          // So the player can name what it offers; the playlists carry the same ids.
          renditions: available,
        },
        201,
      );
    });

type PlayVariables = PlaySessionVariables & { playback: PlaybackClaims; actor: Actor };

/**
 * `/api/play/:token/...`: playlists, the initialisation section, segments and the key.
 * Every request needs a valid token, the session cookie it was issued to, and current
 * membership of the file's organisation. Segments are AES-128 ciphertext; the key
 * comes only from the key route, which is rate-limited and logged.
 */
export const playRoutes = (deps: PlaybackDeps) => {
  const allowKey = keyRateLimiter();

  const authorise = createMiddleware<{ Variables: PlayVariables }>(async (c, next) => {
    const claims = verifyPlayback(deps.secret, c.req.param("token") ?? "");
    // One answer for forged, expired and someone else's tokens: nothing to learn from it.
    if (!claims || claims.sessionId !== c.var.sessionId) {
      throw new HTTPException(403, { message: "This playback link is not valid for you" });
    }
    // Still in the organisation, and still allowed to view the file: a role taken away, or a
    // guest's review closed, ends playback at once.
    const who = c.var.who;
    let actor: Actor;
    if (who.kind === "guest") {
      // Still in the review the link was issued through, and that review still open.
      const through = (await guestFileReviews(deps.db, who)).get(claims.fileId) ?? [];
      if (
        who.organisationId !== claims.organisationId ||
        !claims.reviewId ||
        !through.includes(claims.reviewId)
      ) {
        throw new HTTPException(403, { message: "This playback link is not valid for you" });
      }
      actor = who;
    } else {
      const membership = await membershipOf(deps.db, who.userId, claims.organisationId);
      if (!membership) {
        throw new HTTPException(403, { message: "This playback link is not valid for you" });
      }
      actor = {
        kind: "member",
        userId: who.userId,
        organisationId: claims.organisationId,
        organisationRole: membership.role,
      };
    }
    if (!(await fileAccess(deps.db, actor, claims.fileId))) {
      throw new HTTPException(403, { message: "This playback link is not valid for you" });
    }
    c.set("actor", actor);
    c.set("playback", claims);
    await next();
  });

  const renditionsOf = (claims: PlaybackClaims) =>
    deps.db
      .select()
      .from(renditions)
      .where(inOrg(renditions, claims.organisationId, eq(renditions.fileId, claims.fileId)))
      .orderBy(asc(renditions.bandwidth));

  const renditionOf = async (claims: PlaybackClaims, renditionId: string) => {
    const [row] = await deps.db
      .select()
      .from(renditions)
      .where(
        inOrg(
          renditions,
          claims.organisationId,
          eq(renditions.id, renditionId),
          eq(renditions.fileId, claims.fileId),
        ),
      );
    if (!row) throw new NotFound("Rendition");
    return row;
  };

  const ridParam = zValidator("param", z.object({ token: z.string(), rid: z.uuid() }));

  const sendBlob = async (organisationId: string, blobId: string, contentType: string) => {
    const { blob, stream } = await deps.storage.open(organisationId, blobId);
    return new Response(stream as unknown as ReadableStream, {
      headers: { ...PRIVATE, "content-type": contentType, "content-length": String(blob.byteSize) },
    });
  };

  return new Hono<{ Variables: PlayVariables }>()
    .use("/:token/*", authorise)

    .get("/:token/master.m3u8", async (c) => {
      const rows = await renditionsOf(c.var.playback);
      if (rows.length === 0) throw new NotFound("Rendition");
      const lines = ["#EXTM3U", "#EXT-X-VERSION:7", "#EXT-X-INDEPENDENT-SEGMENTS"];
      for (const r of rows) {
        const resolution = r.width && r.height ? `,RESOLUTION=${r.width}x${r.height}` : "";
        lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${r.bandwidth},CODECS="${r.codecs}"${resolution}`);
        lines.push(`r/${r.id}/index.m3u8`);
      }
      return c.body(`${lines.join("\n")}\n`, 200, {
        ...PRIVATE,
        "content-type": "application/vnd.apple.mpegurl",
      });
    })

    .get("/:token/r/:rid/index.m3u8", ridParam, async (c) => {
      const claims = c.var.playback;
      const rendition = await renditionOf(claims, c.req.valid("param").rid);
      const segments = await deps.db
        .select({
          index: renditionSegments.index,
          duration: renditionSegments.duration,
          iv: renditionSegments.iv,
        })
        .from(renditionSegments)
        .where(
          inOrg(
            renditionSegments,
            claims.organisationId,
            eq(renditionSegments.renditionId, rendition.id),
          ),
        )
        .orderBy(asc(renditionSegments.index));
      const lines = [
        "#EXTM3U",
        "#EXT-X-VERSION:7",
        `#EXT-X-TARGETDURATION:${rendition.targetDuration}`,
        "#EXT-X-PLAYLIST-TYPE:VOD",
        "#EXT-X-INDEPENDENT-SEGMENTS",
        // The initialisation section is encrypted too, so its key tag must carry an IV (RFC 8216).
        `#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0x${rendition.initIv}`,
        '#EXT-X-MAP:URI="init.mp4"',
      ];
      for (const s of segments) {
        lines.push(`#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0x${s.iv}`);
        lines.push(`#EXTINF:${s.duration.toFixed(6)},`);
        lines.push(`seg/${s.index}.m4s`);
      }
      lines.push("#EXT-X-ENDLIST");
      return c.body(`${lines.join("\n")}\n`, 200, {
        ...PRIVATE,
        "content-type": "application/vnd.apple.mpegurl",
      });
    })

    .get("/:token/r/:rid/init.mp4", ridParam, async (c) => {
      const rendition = await renditionOf(c.var.playback, c.req.valid("param").rid);
      return sendBlob(
        rendition.organisationId,
        rendition.initBlobId,
        rendition.height ? "video/mp4" : "audio/mp4",
      );
    })

    .get(
      "/:token/r/:rid/seg/:segment",
      zValidator(
        "param",
        z.object({ token: z.string(), rid: z.uuid(), segment: z.string().regex(/^\d{1,6}\.m4s$/) }),
      ),
      async (c) => {
        const claims = c.var.playback;
        const { rid, segment } = c.req.valid("param");
        const rendition = await renditionOf(claims, rid);
        const index = Number.parseInt(segment, 10);
        const [row] = await deps.db
          .select({ blobId: renditionSegments.blobId, projectId: files.projectId })
          .from(renditionSegments)
          .innerJoin(files, inOrg(files, claims.organisationId, eq(files.id, claims.fileId)))
          .where(
            inOrg(
              renditionSegments,
              claims.organisationId,
              eq(renditionSegments.renditionId, rendition.id),
              eq(renditionSegments.index, index),
            ),
          );
        if (!row) throw new NotFound("Segment");
        // Logged before it is sent, like keys: which parts of a file reached whom.
        await deps.audit.record(
          claims.organisationId,
          await deps.audit.actor(c.var.actor),
          {
            action: "stream.segment",
            projectId: row.projectId,
            fileId: claims.fileId,
            ...(claims.reviewId ? { reviewId: claims.reviewId } : {}),
            details: { rendition: rendition.name, segment: index },
          },
          requestInfo(c, deps.trustProxy),
        );
        return sendBlob(
          rendition.organisationId,
          row.blobId,
          rendition.height ? "video/mp4" : "audio/mp4",
        );
      },
    )

    .get(
      "/:token/pages/:page/:size",
      zValidator(
        "param",
        z.object({
          token: z.string(),
          page: z.coerce.number().int().positive().max(10_000),
          size: z.enum(["view", "thumb"]),
        }),
      ),
      async (c) => {
        const claims = c.var.playback;
        const { page, size } = c.req.valid("param");
        const [row] = await deps.db
          .select({
            blobId: filePages.blobId,
            thumbBlobId: filePages.thumbBlobId,
            projectId: files.projectId,
          })
          .from(filePages)
          .innerJoin(files, inOrg(files, claims.organisationId, eq(files.id, claims.fileId)))
          .where(
            inOrg(
              filePages,
              claims.organisationId,
              eq(filePages.fileId, claims.fileId),
              eq(filePages.page, page),
            ),
          );
        if (!row) throw new NotFound("Page");
        // A page at review size is logged before it is sent: what was seen, by whom.
        if (size === "view") {
          await deps.audit.record(
            claims.organisationId,
            await deps.audit.actor(c.var.actor),
            {
              action: "page.render",
              projectId: row.projectId,
              fileId: claims.fileId,
              ...(claims.reviewId ? { reviewId: claims.reviewId } : {}),
              details: { page },
            },
            requestInfo(c, deps.trustProxy),
          );
        }
        return sendBlob(
          claims.organisationId,
          size === "view" ? row.blobId : row.thumbBlobId,
          "image/webp",
        );
      },
    )

    .get("/:token/r/:rid/key", ridParam, async (c) => {
      const claims = c.var.playback;
      if (!allowKey(c.var.sessionId)) {
        throw new HTTPException(429, { message: "Too many key requests; wait a minute" });
      }
      const rendition = await renditionOf(claims, c.req.valid("param").rid);
      const [file] = await deps.db
        .select({ projectId: files.projectId })
        .from(files)
        .where(inOrg(files, claims.organisationId, eq(files.id, claims.fileId)));
      // Logged before the key leaves: no record, no key.
      await deps.audit.record(
        claims.organisationId,
        await deps.audit.actor(c.var.actor),
        {
          action: "stream.key",
          fileId: claims.fileId,
          ...(claims.reviewId ? { reviewId: claims.reviewId } : {}),
          ...(file ? { projectId: file.projectId } : {}),
          details: { rendition: rendition.name },
        },
        requestInfo(c, deps.trustProxy),
      );
      const organisationKey = await deps.keyring.version(
        claims.organisationId,
        rendition.keyVersion,
      );
      const key = unwrapKey(organisationKey, rendition.wrappedKey, `rendition:${rendition.id}`);
      return c.body(new Uint8Array(key), 200, {
        ...PRIVATE,
        "content-type": "application/octet-stream",
      });
    });
};
