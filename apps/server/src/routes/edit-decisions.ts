import { type Database, inOrg, schema } from "@hekate/db";
import {
  type EditDecisions,
  type EdlTake,
  editDecisionsQuery,
  fileStart,
  matchEdl,
  parseCmx3600,
} from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { actorOf, can } from "../access.ts";
import { readEdlFile } from "../edl-file.ts";
import { NotFound } from "../errors.ts";
import type { Storage } from "../storage.ts";
import type { TenantVariables } from "../tenancy.ts";

const { files, takes, tracks, versions } = schema;

/**
 * A track's edit decisions (#56), under `/api/tracks/:id/edit-decisions`: the edit decision
 * list attached to a version (the latest that has one, or the one asked for) read and matched
 * to the track's takes, so the takes view can say which take each stretch of the version
 * comes from. Seeing it needs `view_takes`, as the takes do.
 */
export const editDecisionRoutes = (db: Database, storage: Storage) =>
  new Hono<{ Variables: TenantVariables }>().get(
    "/:id/edit-decisions",
    zValidator("param", z.object({ id: z.uuid() })),
    zValidator("query", editDecisionsQuery),
    async (c) => {
      const organisationId = c.var.organisationId;
      const [track] = await db
        .select({ id: tracks.id, projectId: tracks.projectId })
        .from(tracks)
        .where(inOrg(tracks, organisationId, eq(tracks.id, c.req.valid("param").id)));
      if (!track) throw new NotFound("Track");
      await can(db, actorOf(c.var), "view_takes", track.projectId);
      const query = c.req.valid("query");

      const [version] = await db
        .select({ id: versions.id, number: versions.number, edlFileId: versions.edlFileId })
        .from(versions)
        .where(
          inOrg(
            versions,
            organisationId,
            and(
              eq(versions.trackId, track.id),
              isNotNull(versions.edlFileId),
              query.version ? eq(versions.id, query.version) : undefined,
            ),
          ),
        )
        .orderBy(desc(versions.number))
        .limit(1);
      if (!version?.edlFileId) return c.json({ decisions: null });

      const list = await readEdlFile(db, storage, organisationId, version.edlFileId);
      if (!list) return c.json({ decisions: null });
      const edl = parseCmx3600(list.text, query.rate);

      const rows = await db
        .select({
          id: takes.id,
          number: takes.number,
          label: takes.label,
          inPoint: takes.inPoint,
          outPoint: takes.outPoint,
          barFrom: takes.barFrom,
          barTo: takes.barTo,
        })
        .from(takes)
        .where(inOrg(takes, organisationId, eq(takes.trackId, track.id)))
        .orderBy(asc(takes.number));
      const mixes =
        rows.length === 0
          ? []
          : await db
              .select({ takeId: files.takeId, name: files.name, mediaInfo: files.mediaInfo })
              .from(files)
              .where(
                inOrg(
                  files,
                  organisationId,
                  inArray(
                    files.takeId,
                    rows.map((r) => r.id),
                  ),
                ),
              )
              .orderBy(asc(files.createdAt));
      const candidates: EdlTake[] = rows.flatMap((row) => {
        const mix = mixes.find((m) => m.takeId === row.id);
        if (!mix) return [];
        const info = mix.mediaInfo;
        return [
          {
            ...row,
            fileName: mix.name,
            start: fileStart(info?.metadata, info?.audio?.sampleRate),
            duration: info?.duration ?? null,
          },
        ];
      });

      const decisions: EditDecisions = {
        version: { id: version.id, number: version.number },
        fileName: list.name,
        title: edl.title,
        fps: edl.fps,
        fpsGuessed: edl.fpsGuessed,
        dropFrame: edl.dropFrame,
        uses: matchEdl(edl, candidates),
      };
      return c.json({ decisions });
    },
  );
