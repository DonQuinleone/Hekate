import { type Database, inOrg, schema } from "@hekate/db";
import {
  attachmentName,
  CAPTION_FILE_MAX_BYTES,
  CAPTION_TRACKS_MAX,
  CaptionError,
  type CaptionTrack,
  captionContentTypes,
  captionExportQuery,
  captionedKinds,
  captionFileName,
  captionFormatOf,
  captionKindOf,
  captionLanguageOf,
  captionUpdate,
  captionUploadQuery,
  downloadLevelOf,
  parseCaptions,
  writeCaptions,
} from "@hekate/shared";
import { asc, count, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { canOnFile, fileAccess } from "../access.ts";
import { type Audit, requestInfo } from "../audit.ts";
import { NotFound } from "../errors.ts";
import type { ViewerVariables } from "../guests.ts";
import { zValidator } from "../openapi/validator.ts";
import type { Storage } from "../storage.ts";
import { attachment } from "./comments.ts";

const { captionTracks, files } = schema;

export interface CaptionDeps {
  db: Database;
  storage: Storage;
  audit: Audit;
  trustProxy: boolean;
}

/** A caption file's text: UTF-8, or UTF-16 where it begins by saying so. */
export function captionText(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes);
  return new TextDecoder("utf-8").decode(bytes);
}

const shown = (row: typeof captionTracks.$inferSelect): CaptionTrack => ({
  id: row.id,
  label: row.label,
  language: row.language,
  kind: row.kind,
  name: row.name,
  format: row.format,
  cues: row.cues,
  createdAt: row.createdAt.toISOString(),
});

/** The file, refused unless it plays: a video or a recording carries captions, nothing else. */
async function playableOf(db: Pick<Database, "select">, organisationId: string, fileId: string) {
  const [file] = await db
    .select({ kind: files.kind, name: files.name })
    .from(files)
    .where(inOrg(files, organisationId, eq(files.id, fileId)));
  if (!file) throw new NotFound("File");
  if (!captionedKinds.includes(file.kind))
    throw new HTTPException(409, { message: "Only a video or a recording carries captions" });
  return file;
}

const params = zValidator("param", z.object({ id: z.uuid(), captionId: z.uuid() }));

/**
 * A file's caption tracks (#146, #201), under `/api/files/:id`: read by whoever may view the
 * video or recording, as cues the player shows and the transcript lists; added, renamed and
 * removed by whoever may upload; exported, as SubRip, WebVTT or TTML, by whoever may download
 * from the file, each export in the access log. The sidecar itself is stored encrypted, as it
 * came, and never sent back: an export is written afresh from the cues.
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
      zValidator("query", captionUploadQuery),
      async (c) => {
        const { db, storage, audit } = deps;
        const organisationId = c.var.organisationId;
        const actor = c.var.actor;
        const { id: fileId } = c.req.valid("param");
        const query = c.req.valid("query");
        const access = await canOnFile(db, actor, "upload", fileId);
        await playableOf(db, organisationId, fileId);
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
        // What the uploader said, else what the file says of itself.
        const language = query.language ?? captionLanguageOf(named.data, text, format);
        const kind = query.kind ?? captionKindOf(named.data) ?? "subtitles";
        const blob = await storage.put(organisationId, bytes, {
          contentType: captionContentTypes[format],
          projectId: access.projectId,
        });
        try {
          const row = await db.transaction(async (tx) => {
            // One addition at a time per file, so two at once cannot pass the limit together;
            // and a file moved to another workspace meanwhile (a project transfer rewrites its
            // row) is no longer here to caption.
            const [locked] = await tx
              .select({ id: files.id })
              .from(files)
              .where(inOrg(files, organisationId, eq(files.id, fileId)))
              .for("update");
            if (!locked) throw new NotFound("File");
            const [held] = await tx
              .select({ n: count() })
              .from(captionTracks)
              .where(inOrg(captionTracks, organisationId, eq(captionTracks.fileId, fileId)));
            if ((held?.n ?? 0) >= CAPTION_TRACKS_MAX)
              throw new HTTPException(409, {
                message: `A file can carry at most ${CAPTION_TRACKS_MAX} caption tracks`,
              });
            const [made] = await tx
              .insert(captionTracks)
              .values({
                organisationId,
                fileId,
                blobId: blob.id,
                label: query.label,
                language,
                kind,
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
                details: {
                  captionId: made.id,
                  name: named.data,
                  label: query.label,
                  language,
                  kind,
                  cues: cues.length,
                },
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
    .patch("/:id/captions/:captionId", params, zValidator("json", captionUpdate), async (c) => {
      const { db, audit } = deps;
      const organisationId = c.var.organisationId;
      const actor = c.var.actor;
      const { id: fileId, captionId } = c.req.valid("param");
      const change = c.req.valid("json");
      const access = await canOnFile(db, actor, "upload", fileId);
      const who = await audit.actor(actor);
      const row = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(captionTracks)
          .set({
            ...(change.label !== undefined ? { label: change.label } : {}),
            ...(change.language !== undefined ? { language: change.language } : {}),
            ...(change.kind !== undefined ? { kind: change.kind } : {}),
          })
          .where(
            inOrg(
              captionTracks,
              organisationId,
              eq(captionTracks.id, captionId),
              eq(captionTracks.fileId, fileId),
            ),
          )
          .returning();
        if (!updated) throw new NotFound("Captions");
        await audit.record(
          organisationId,
          who,
          {
            action: "file.captions_update",
            projectId: access.projectId,
            fileId,
            details: { captionId, ...change },
          },
          requestInfo(c, deps.trustProxy),
          tx,
        );
        return updated;
      });
      return c.json({ caption: shown(row) });
    })
    /**
     * A track written out as SubRip, WebVTT or TTML (#201), whichever it came as, for whoever
     * may download from the file in any form: a sidecar for an edit suite or a deliverable.
     * In the access log before it is sent.
     */
    .get(
      "/:id/captions/:captionId/export",
      params,
      zValidator("query", captionExportQuery),
      async (c) => {
        const { db, audit } = deps;
        const organisationId = c.var.organisationId;
        const actor = c.var.actor;
        const { id: fileId, captionId } = c.req.valid("param");
        const { format } = c.req.valid("query");
        const access = await fileAccess(db, actor, fileId);
        if (!access || !access.permissions.has("view")) throw new NotFound("File");
        const level = access.grant ? access.grant.download : downloadLevelOf(access.permissions);
        if (level === "none")
          throw new HTTPException(403, { message: "You may not download from this file" });
        const file = await playableOf(db, organisationId, fileId);
        const [track] = await db
          .select()
          .from(captionTracks)
          .where(
            inOrg(
              captionTracks,
              organisationId,
              eq(captionTracks.id, captionId),
              eq(captionTracks.fileId, fileId),
            ),
          );
        if (!track) throw new NotFound("Captions");
        const body = writeCaptions(track.cues, format, track.language);
        const filename = captionFileName(file.name, track, format);
        await audit.record(
          organisationId,
          await audit.actor(actor),
          {
            action: "file.captions_export",
            projectId: access.projectId,
            fileId,
            details: { captionId, label: track.label, format, filename },
          },
          requestInfo(c, deps.trustProxy),
        );
        return c.body(body, 200, {
          "content-type": `${captionContentTypes[format]}; charset=utf-8`,
          "content-disposition": attachment(filename),
          "cache-control": "no-store",
        });
      },
    )
    .delete("/:id/captions/:captionId", params, async (c) => {
      const { db, storage, audit } = deps;
      const organisationId = c.var.organisationId;
      const actor = c.var.actor;
      const { id: fileId, captionId } = c.req.valid("param");
      const access = await canOnFile(db, actor, "upload", fileId);
      const who = await audit.actor(actor);
      // Gone and logged together, or neither.
      const row = await db.transaction(async (tx) => {
        const [removed] = await tx
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
        if (!removed) throw new NotFound("Captions");
        await audit.record(
          organisationId,
          who,
          {
            action: "file.captions_remove",
            projectId: access.projectId,
            fileId,
            details: { captionId, name: removed.name, label: removed.label },
          },
          requestInfo(c, deps.trustProxy),
          tx,
        );
        return removed;
      });
      // Bytes left behind if this fails are found and removed by storage reconciliation.
      await storage
        .remove(organisationId, row.blobId)
        .catch((error: unknown) =>
          console.warn(`Could not remove the bytes of captions ${row.id}: ${String(error)}`),
        );
      return c.body(null, 204);
    });
