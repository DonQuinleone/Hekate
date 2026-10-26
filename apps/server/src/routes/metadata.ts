import { type Database, inOrg, schema } from "@hekate/db";
import {
  applyMetadataChanges,
  editableFields,
  type MetadataField,
  metadataChanges,
  metadataFieldSpecs,
  metadataFormatOf,
} from "@hekate/shared";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { canOnFile, mayUseTool, toolRefused } from "../access.ts";
import { type Audit, requestInfo } from "../audit.ts";
import { NotFound } from "../errors.ts";
import type { ViewerVariables } from "../guests.ts";
import { zValidator } from "../openapi/validator.ts";

const { files } = schema;

const idParam = zValidator("param", z.object({ id: z.uuid() }));

/** Correcting metadata is an engineer's work in a project: guests see files through reviews. */
const guestsRefused = () =>
  new HTTPException(403, { message: "Guests cannot correct a file's metadata" });

/**
 * `/api/files/:id/metadata`: a recording's corrections to its embedded metadata (decision 264).
 * Reading them is for whoever has the QA tool on the file; correcting them, for whoever may
 * also organise its files (`organise`, as for a file's name and its tags). The original's
 * bytes are never touched: the corrections are Hekate's record, `mediaInfo.metadata` reads
 * with them, and a download writes them in.
 */
export const fileMetadataRoutes = (db: Database, audit: Audit, trustProxy: boolean) =>
  new Hono<{ Variables: ViewerVariables }>()
    .get("/:id/metadata", idParam, async (c) => {
      const actor = c.var.actor;
      if (actor.kind === "guest") throw guestsRefused();
      const { id } = c.req.valid("param");
      const access = await canOnFile(db, actor, "view", id);
      if (!mayUseTool(access, "qa")) throw toolRefused(access);
      const [file] = await db
        .select({ mediaInfo: files.mediaInfo, corrections: files.metadataCorrections })
        .from(files)
        .where(inOrg(files, actor.organisationId, eq(files.id, id)));
      if (!file) throw new NotFound("File");
      const format = metadataFormatOf(file.mediaInfo);
      return c.json({
        /** How the file is written as it leaves; null where Hekate cannot write it. */
        format,
        /** The fields that may be corrected in a file of this format. */
        fields: format ? editableFields(format, file.mediaInfo?.audio?.sampleRate) : [],
        corrections: file.corrections ?? {},
        /** Whether this viewer may correct them. */
        editable: format !== null && access.permissions.has("organise"),
      });
    })
    .put("/:id/metadata", idParam, zValidator("json", metadataChanges), async (c) => {
      const actor = c.var.actor;
      if (actor.kind === "guest") throw guestsRefused();
      const { id } = c.req.valid("param");
      const access = await canOnFile(db, actor, "organise", id);
      if (!mayUseTool(access, "qa")) throw toolRefused(access);
      const { changes } = c.req.valid("json");
      const who = await audit.member(actor.userId);
      const result = await db.transaction(async (tx) => {
        const [file] = await tx
          .select({
            mediaInfo: files.mediaInfo,
            corrections: files.metadataCorrections,
          })
          .from(files)
          .where(inOrg(files, actor.organisationId, eq(files.id, id)))
          .for("update");
        if (!file) throw new NotFound("File");
        const format = metadataFormatOf(file.mediaInfo);
        const info = file.mediaInfo;
        if (!format || !info?.metadata)
          throw new HTTPException(409, {
            message: info?.metadata
              ? "Hekate cannot write metadata into this kind of file"
              : "This file's metadata has not been read yet",
          });
        const allowed = new Set(editableFields(format, info.audio?.sampleRate));
        const refused = (Object.keys(changes) as MetadataField[]).find((f) => !allowed.has(f));
        if (refused)
          throw new HTTPException(422, {
            message: `${metadataFieldSpecs[refused].label} cannot be written into this file`,
          });
        const applied = applyMetadataChanges(info.metadata, file.corrections ?? {}, changes);
        if (applied.changed.length === 0) return applied;
        const kept = Object.keys(applied.corrections).length > 0 ? applied.corrections : null;
        await tx
          .update(files)
          .set({
            mediaInfo: { ...info, metadata: applied.metadata },
            metadataCorrections: kept,
            updatedAt: new Date(),
          })
          .where(inOrg(files, actor.organisationId, eq(files.id, id)));
        // Every edit is in the access log, with what each field said and now says.
        await audit.record(
          actor.organisationId,
          who,
          {
            action: "file.metadata_edit",
            projectId: access.projectId,
            fileId: id,
            details: { changes: applied.changed },
          },
          requestInfo(c, trustProxy),
          tx,
        );
        return applied;
      });
      return c.json({ metadata: result.metadata, corrections: result.corrections });
    });
