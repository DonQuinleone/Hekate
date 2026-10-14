import { type Database, inOrg, schema } from "@hekate/db";
import { unwrapKey } from "@hekate/storage";
import { zValidator } from "@hono/zod-validator";
import { asc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { type Audit, requestInfo } from "../audit.ts";
import { NotFound } from "../errors.ts";
import type { Keyring } from "../keyring.ts";
import {
  keyRateLimiter,
  PLAYBACK_LIFETIME_SECONDS,
  type PlaybackClaims,
  signPlayback,
  verifyPlayback,
} from "../playback.ts";
import type { Storage } from "../storage.ts";
import { membershipOf, type SessionVariables, type TenantVariables } from "../tenancy.ts";

const { files, renditions, renditionSegments } = schema;

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

/** `POST /api/files/:id/playback`: start watching or listening. */
export const fileRoutes = (deps: PlaybackDeps) =>
  new Hono<{ Variables: TenantVariables }>().post(
    "/:id/playback",
    zValidator("param", z.object({ id: z.uuid() })),
    async (c) => {
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
      const expiresAt = Math.floor(Date.now() / 1000) + PLAYBACK_LIFETIME_SECONDS;
      const token = signPlayback(deps.secret, {
        sessionId: c.var.sessionId,
        organisationId,
        fileId: file.id,
        expiresAt,
      });
      await deps.audit.record(
        organisationId,
        await deps.audit.member(c.var.userId),
        { action: "stream.session", projectId: file.projectId, fileId: file.id },
        requestInfo(c, deps.trustProxy),
      );
      return c.json(
        { url: `/api/play/${token}/master.m3u8`, expiresAt: new Date(expiresAt * 1000) },
        201,
      );
    },
  );

type PlayVariables = SessionVariables & { playback: PlaybackClaims };

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
    if (!(await membershipOf(deps.db, c.var.userId, claims.organisationId))) {
      throw new HTTPException(403, { message: "This playback link is not valid for you" });
    }
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
          .select({ blobId: renditionSegments.blobId })
          .from(renditionSegments)
          .where(
            inOrg(
              renditionSegments,
              claims.organisationId,
              eq(renditionSegments.renditionId, rendition.id),
              eq(renditionSegments.index, index),
            ),
          );
        if (!row) throw new NotFound("Segment");
        return sendBlob(
          rendition.organisationId,
          row.blobId,
          rendition.height ? "video/mp4" : "audio/mp4",
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
        await deps.audit.member(c.var.userId),
        {
          action: "stream.key",
          fileId: claims.fileId,
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
