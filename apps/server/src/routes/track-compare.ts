import { type Database, inOrg, schema } from "@hekate/db";
import {
  type AlignmentPoints,
  type CompareAlignment,
  compareAlignment,
  compareQuery,
  findingChanges,
  type HopState,
  invertAlignment,
  mapTime,
  type QaFinding,
} from "@hekate/shared";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { actorOf, can } from "../access.ts";
import { alignmentsFrom } from "../alignment-graph.ts";
import { NotFound } from "../errors.ts";
import type { Jobs } from "../jobs.ts";
import { zValidator } from "../openapi/validator.ts";
import type { TenantVariables } from "../tenancy.ts";
import { qaReportOf } from "./qa.ts";

const { alignments, comments, files, tracks, variants, versions } = schema;

const idParam = zValidator("param", z.object({ id: z.uuid() }));

type Org = string;

/** The track, as the member may compare its versions: 404 unseen, 403 without compare. */
async function comparable(db: Database, vars: TenantVariables, trackId: string) {
  const [track] = await db
    .select({ id: tracks.id, projectId: tracks.projectId, name: tracks.name })
    .from(tracks)
    .where(inOrg(tracks, vars.organisationId, eq(tracks.id, trackId)));
  if (!track) throw new NotFound("Track");
  const access = await can(db, actorOf(vars), "view", track.projectId).catch((error: unknown) => {
    if (error instanceof NotFound) throw new NotFound("Track");
    throw error;
  });
  if (!access.tools.has("compare")) {
    throw new HTTPException(403, {
      message: "Your role in this project does not include that tool",
    });
  }
  return { track, access };
}

/** The track's versions, oldest first, each with its variants' files. */
async function versionsOf(db: Database, org: Org, trackId: string) {
  const rows = await db
    .select({
      id: versions.id,
      number: versions.number,
      notes: versions.notes,
      fileId: variants.fileId,
      name: variants.name,
      isPrimary: variants.isPrimary,
      position: variants.position,
      streamStatus: files.streamStatus,
      mediaInfo: files.mediaInfo,
    })
    .from(versions)
    .innerJoin(variants, and(eq(variants.versionId, versions.id), eq(variants.organisationId, org)))
    .innerJoin(files, and(eq(files.id, variants.fileId), eq(files.organisationId, org)))
    .where(inOrg(versions, org, eq(versions.trackId, trackId)))
    .orderBy(asc(versions.number), asc(variants.position));
  const byNumber = new Map<
    number,
    {
      id: string;
      number: number;
      notes: string | null;
      files: string[];
      primary: { fileId: string; name: string; streamStatus: string; duration: number | null };
    }
  >();
  for (const r of rows) {
    const v = byNumber.get(r.number) ?? {
      id: r.id,
      number: r.number,
      notes: r.notes,
      files: [],
      primary: {
        fileId: r.fileId,
        name: r.name,
        streamStatus: r.streamStatus,
        duration: r.mediaInfo?.duration ?? null,
      },
    };
    v.files.push(r.fileId);
    if (r.isPrimary)
      v.primary = {
        fileId: r.fileId,
        name: r.name,
        streamStatus: r.streamStatus,
        duration: r.mediaInfo?.duration ?? null,
      };
    byNumber.set(r.number, v);
  }
  return [...byNumber.values()];
}

/** The alignment rows between each pair of neighbouring versions from one to the other. */
async function hopsBetween(
  db: Database,
  org: Org,
  list: Awaited<ReturnType<typeof versionsOf>>,
  lower: number,
  upper: number,
) {
  const between = list.filter((v) => v.number >= lower && v.number <= upper);
  const hops: { from: (typeof between)[number]; to: (typeof between)[number]; rows: HopRow[] }[] =
    [];
  for (let i = 0; i + 1 < between.length; i++) {
    const from = between[i] as (typeof between)[number];
    const to = between[i + 1] as (typeof between)[number];
    const rows = await db
      .select({
        id: alignments.id,
        status: alignments.status,
        quality: alignments.quality,
      })
      .from(alignments)
      .where(
        inOrg(
          alignments,
          org,
          inArray(alignments.fromFileId, from.files),
          inArray(alignments.toFileId, to.files),
        ),
      );
    hops.push({ from, to, rows });
  }
  return hops;
}
type HopRow = { id: string; status: HopState["rows"][number]["status"]; quality: number | null };

/**
 * `/api/tracks/:id/compare`: two versions of a track side by side (#137). Where the same music
 * sits in each, how well that is known, what the quality checks found fixed and new, and the
 * earlier version's comments where they fall in the later one. A member's tool, as compare is.
 */
export const trackCompareRoutes = (db: Database, jobs: Pick<Jobs, "send">) =>
  new Hono<{ Variables: TenantVariables }>()
    .get("/:id/compare", idParam, zValidator("query", compareQuery), async (c) => {
      const org = c.var.organisationId;
      const { track, access } = await comparable(db, c.var, c.req.valid("param").id);
      const list = await versionsOf(db, org, track.id);
      const query = c.req.valid("query");
      // Unless asked, the latest two that can be played: a version still being processed, or
      // one that failed, is chosen only when there is nothing else.
      const ready = list.filter((v) => v.primary.streamStatus === "ready");
      const pick = (besides?: number) => {
        const latest = (among: typeof list) =>
          among.filter((v) => v.number !== besides).at(-1)?.number;
        return latest(ready) ?? latest(list);
      };
      let { a, b } = query;
      if (a === undefined && b === undefined) {
        const one = pick();
        const two = pick(one);
        // The earlier of the two is A.
        [a, b] = one !== undefined && two !== undefined && two > one ? [one, two] : [two, one];
      } else {
        b ??= pick(a);
        a ??= pick(b);
      }
      const va = list.find((v) => v.number === a);
      const vb = list.find((v) => v.number === b);
      if (!va || !vb || va.number === vb.number) {
        throw new HTTPException(422, { message: "Two versions of this track are needed" });
      }
      const [earlier, later] = va.number < vb.number ? [va, vb] : [vb, va];
      const hops = await hopsBetween(db, org, list, earlier.number, later.number);
      const reached = (await alignmentsFrom(db, org, va.primary.fileId)).find(
        (r) => r.fileId === vb.primary.fileId,
      );
      const alignment: CompareAlignment = compareAlignment(
        hops.map((h) => ({ rows: h.rows })),
        reached?.points ?? null,
      );
      // From A's times to B's, once the music is known to line up.
      const points: AlignmentPoints | null = alignment.status === "ready" ? alignment.points : null;
      const aToB = (t: number) => (points ? mapTime(points, t) : t);
      const back = points ? invertAlignment(points) : null;
      // The earlier version's times, carried to the later one's, whichever side it is.
      const toLater = (t: number) => (earlier === va ? aToB(t) : back ? mapTime(back, t) : t);

      // What the checks found fixed and new in the later version.
      const [qaEarlier, qaLater] = await Promise.all([
        qaReportOf(db, org, earlier.primary.fileId),
        qaReportOf(db, org, later.primary.fileId),
      ]);
      const measured = Boolean(
        qaEarlier && qaLater && qaEarlier.status === "ready" && qaLater.status === "ready",
      );
      const changes: { fixed: QaFinding[]; new: QaFinding[] } =
        qaEarlier && qaLater
          ? findingChanges(qaEarlier.findings, qaLater.findings, toLater)
          : { fixed: [], new: [] };

      // A's threads at a moment, and where that moment is in B, for those who may read them.
      const threads = !access.permissions.has("read_comments")
        ? []
        : await db
            .select({ id: comments.id, body: comments.body, anchor: comments.anchor })
            .from(comments)
            .where(
              inOrg(
                comments,
                org,
                eq(comments.fileId, va.primary.fileId),
                isNull(comments.parentId),
                isNull(comments.resolvedAt),
              ),
            )
            .orderBy(asc(comments.createdAt));
      const timed = threads.flatMap((t) =>
        t.anchor?.kind === "time"
          ? [
              {
                id: t.id,
                body: t.body.length > 140 ? `${t.body.slice(0, 139)}…` : t.body,
                start: t.anchor.start,
                mapped: points ? aToB(t.anchor.start) : null,
              },
            ]
          : [],
      );
      const side = (v: (typeof list)[number]) => ({
        versionId: v.id,
        number: v.number,
        notes: v.notes,
        fileId: v.primary.fileId,
        name: v.primary.name,
        ready: v.primary.streamStatus === "ready",
        failed: v.primary.streamStatus === "failed",
        duration: v.primary.duration,
      });
      return c.json({
        track: { id: track.id, name: track.name, projectId: track.projectId },
        versions: list.map((v) => ({ number: v.number, name: v.primary.name })),
        a: side(va),
        b: side(vb),
        alignment,
        findings: {
          /** Both versions measured, so nothing found means nothing there. */
          measured,
          laterNumber: later.number,
          fixed: changes.fixed,
          new: changes.new,
        },
        comments: timed,
      });
    })
    // Work out again where the music sits, between each pair of neighbouring versions from A
    // to B whose alignment failed or came out too poor to follow, or was never made.
    .post(
      "/:id/compare/realign",
      idParam,
      zValidator("json", z.object({ a: z.number().int().min(1), b: z.number().int().min(1) })),
      async (c) => {
        const org = c.var.organisationId;
        const { track, access } = await comparable(db, c.var, c.req.valid("param").id);
        if (!access.permissions.has("upload")) {
          throw new HTTPException(403, {
            message: "Your role in this project does not allow that",
          });
        }
        const { a, b } = c.req.valid("json");
        const list = await versionsOf(db, org, track.id);
        if (!list.some((v) => v.number === a) || !list.some((v) => v.number === b) || a === b) {
          throw new HTTPException(422, { message: "Two versions of this track are needed" });
        }
        const hops = await hopsBetween(db, org, list, Math.min(a, b), Math.max(a, b));
        const queued: string[] = [];
        const now = new Date();
        for (const hop of hops) {
          const state = compareAlignment([{ rows: hop.rows }], null);
          if (state.status === "ready" || state.status === "aligning") continue;
          if (hop.rows.length === 0) {
            const [made] = await db
              .insert(alignments)
              .values({
                organisationId: org,
                fromFileId: hop.from.primary.fileId,
                toFileId: hop.to.primary.fileId,
              })
              .onConflictDoNothing()
              .returning({ id: alignments.id });
            if (made) queued.push(made.id);
            continue;
          }
          for (const row of hop.rows) {
            await db
              .update(alignments)
              .set({ status: "pending", points: null, quality: null, updatedAt: now })
              .where(inOrg(alignments, org, eq(alignments.id, row.id)));
            queued.push(row.id);
          }
        }
        for (const alignmentId of queued) {
          await jobs
            .send(
              "media-align",
              { organisationId: org, alignmentId },
              { singletonKey: alignmentId },
            )
            .catch((error: unknown) =>
              console.warn(`Could not queue alignment ${alignmentId} now: ${String(error)}`),
            );
        }
        return c.json({ queued: queued.length }, 202);
      },
    );
