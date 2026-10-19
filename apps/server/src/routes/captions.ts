import { type Database, inOrg, schema } from "@hekate/db";
import {
  attachmentName,
  CAPTION_FILE_MAX_BYTES,
  CAPTION_TRACKS_MAX,
  CaptionError,
  type CaptionFormat,
  type CaptionTrack,
  captionFormatOf,
  captionLabel,
  parseCaptions,
} from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { asc, count, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { canOnFile } from "../access.ts";
import { type Audit, requestInfo } from "../audit.ts";
import { NotFound } from "../errors.ts";
import type { ViewerVariables } from "../guests.ts";
import type { Storage } from "../storage.ts";

const { captionTracks, files } = schema;

export interface CaptionDeps {
  db: Database;
  storage: Storage;
  audit: Audit;
  trustProxy: boolean;
}

/** The type each format is stored as. */
const CONTENT_TYPES: Record<CaptionFormat, string> = {
  srt: "application/x-subrip",
  vtt: "text/vtt",
  ttml: "application/ttml+xml",
};

/** A caption file's text: UTF-8, or UTF-16 where it begins by saying so. */
export function captionText(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  return new TextDecoder("utf-8").decode(bytes);
}

const shown = (row: typeof captionTracks.$inferSelect): CaptionTrack => ({
  id: row.id,
  label: row.label,
  name: row.name,
  format: row.format,
  cues: row.cues,
  createdAt: row.createdAt.toISOString(),
});

/** Refuses unless the file is a video. */
async function videoOf(db: Pick<Database, "select">, organisationId: string, fileId: string) {
  const [file] = await db
    .select({ kind: files.kind })
    .from(files)
    .where(inOrg(files, organisationId, eq(files.id, fileId)));
  if (!file) throw new NotFound("File");
  if (file.kind !== "video")
    throw new HTTPException(409, { message: "Only a video carries captions" });
}

/**
 * A video's captions from sidecar files (#146), under `/api/files/:id`: read by whoever may
 * view the video, as cues the player lays over the picture; added and removed by whoever may
 * upload. The sidecar itself is stored encrypted, as it came, and never sent back.
 */
export const captionRoutes = (deps: CaptionDeps) =>
  new Hono<{ Variables: ViewerVariables }>()
    .get("/:id/captions", zValidator("param", z.object({ id: z.uuid() })), async (c) => {
      const organisationId = c.var.organisationId;
      const { id: fileId } = c.req.valid("param");
      await canOnFile(deps.db, c.var.actor, "view", fileId);
      const rows = await deps.db
        .select()
        .from(captionTracks)
        .where(inOrg(captionTracks, organisationId, eq(captionTracks.fileId, fileId)))
        .orderBy(asc(captionTracks.createdAt), asc(captionTracks.id));
      return c.json({ captions: rows.map(shown) });
    })
    .post(
      "/:id/captions",
      zValidator("param", z.object({ id: z.uuid() })),
      zValidator("query", z.object({ label: captionLabel })),
      async (c) => {
        const { db, storage, audit } = deps;
        const organisationId = c.var.organisationId;
        const actor = c.var.actor;
        const { id: fileId } = c.req.valid("param");
        const { label } = c.req.valid("query");
        const access = await canOnFile(db, actor, "upload", fileId);
        await videoOf(db, organisationId, fileId);
        const named = attachmentName.safeParse(
          decodeURIComponent(c.req.header("x-file-name") ?? ""),
        );
        if (!named.success)
          throw new HTTPException(400, { message: named.error.issues[0]?.message ?? "No name" });
        const bytes = Buffer.from(await c.req.arrayBuffer());
        if (bytes.length === 0) throw new HTTPException(400, { message: "The file is empty" });
        if (bytes.length > CAPTION_FILE_MAX_BYTES)
          throw new HTTPException(413, { message: "A caption file can be at most 2 MB" });
        const text = captionText(bytes);
        const format = captionFormatOf(named.data, text);
        if (!format)
          throw new HTTPException(422, {
            message: "Captions are read from SubRip (.srt), WebVTT (.vtt) or TTML (.ttml) files",
          });
        let cues: ReturnType<typeof parseCaptions>;
        try {
          cues = parseCaptions(text, format);
        } catch (error) {
          if (error instanceof CaptionError)
            throw new HTTPException(422, { message: error.message });
          throw error;
        }
        const blob = await storage.put(organisationId, bytes, {
          contentType: CONTENT_TYPES[format],
          projectId: access.projectId,
        });
        try {
          const row = await db.transaction(async (tx) => {
            // One addition at a time per video, so two at once cannot pass the limit together.
            await tx
              .select({ id: files.id })
              .from(files)
              .where(inOrg(files, organisationId, eq(files.id, fileId)))
              .for("update");
            const [held] = await tx
              .select({ n: count() })
              .from(captionTracks)
              .where(inOrg(captionTracks, organisationId, eq(captionTracks.fileId, fileId)));
            if ((held?.n ?? 0) >= CAPTION_TRACKS_MAX)
              throw new HTTPException(409, {
                message: `A video can carry at most ${CAPTION_TRACKS_MAX} caption files`,
              });
            const [made] = await tx
              .insert(captionTracks)
              .values({
                organisationId,
                fileId,
                blobId: blob.id,
                label,
                name: named.data,
                format,
                byteSize: bytes.length,
                cues,
                createdById: actor.kind === "member" ? actor.userId : null,
              })
              .returning();
            if (!made) throw new Error("The captions were not stored");
            await audit.record(
              organisationId,
              await audit.actor(actor),
              {
                action: "file.captions_add",
                projectId: access.projectId,
                fileId,
                details: { captionId: made.id, name: named.data, label, cues: cues.length },
              },
              requestInfo(c, deps.trustProxy),
              tx,
            );
            return made;
          });
          return c.json({ caption: shown(row) }, 201);
        } catch (error) {
          // Nothing points at the bytes: take them back.
          await storage.remove(organisationId, blob.id).catch(() => undefined);
          throw error;
        }
      },
    )
    .delete(
      "/:id/captions/:captionId",
      zValidator("param", z.object({ id: z.uuid(), captionId: z.uuid() })),
      async (c) => {
        const { db, storage, audit } = deps;
        const organisationId = c.var.organisationId;
        const actor = c.var.actor;
        const { id: fileId, captionId } = c.req.valid("param");
        const access = await canOnFile(db, actor, "upload", fileId);
        const [row] = await db
          .delete(captionTracks)
          .where(
            inOrg(
              captionTracks,
              organisationId,
              eq(captionTracks.id, captionId),
              eq(captionTracks.fileId, fileId),
            ),
          )
          .returning();
        if (!row) throw new NotFound("Captions");
        await audit.record(
          organisationId,
          await audit.actor(actor),
          {
            action: "file.captions_remove",
            projectId: access.projectId,
            fileId,
            details: { captionId, name: row.name, label: row.label },
          },
          requestInfo(c, deps.trustProxy),
        );
        // Bytes left behind if this fails are found and removed by storage reconciliation.
        await storage
          .remove(organisationId, row.blobId)
          .catch((error: unknown) =>
            console.warn(`Could not remove the bytes of captions ${row.id}: ${String(error)}`),
          );
        return c.body(null, 204);
      },
    );
