import { type Database, inOrg, schema } from "@hekate/db";
import {
  applyQaSettings,
  deliveryFindings,
  findingChanges,
  mapTime,
  orderFindings,
  type QaFinding,
  qaSettingsOf,
  ruleFindings,
} from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { canOnFile, fileAccess, mayUseTool, toolRefused } from "../access.ts";
import { alignmentsFrom } from "../alignment-graph.ts";
import { profilesForFiles } from "../delivery-profiles.ts";
import { NotFound } from "../errors.ts";
import type { ViewerVariables } from "../guests.ts";
import { qaReport, qaReportFormats } from "../qa-report.ts";
import { requesterOf } from "../requester.ts";
import { attachment } from "./comments.ts";

const { files, loudness, organisations, projects, qaFindings, variations, versions } = schema;

const idParam = zValidator("param", z.object({ id: z.uuid() }));

/**
 * A recording's quality report: the signal checks measured when it was analysed (a video's
 * picture among them, #42), and the delivery checks read now against its profile, as its
 * project wants them. Null for a file with neither sound nor a video's picture, which is not
 * checked.
 */
export async function qaReportOf(db: Database, organisationId: string, id: string) {
  const [file] = await db
    .select({
      name: files.name,
      kind: files.kind,
      mediaInfo: files.mediaInfo,
      analysisStatus: files.analysisStatus,
      qaSettings: projects.qaSettings,
    })
    .from(files)
    .innerJoin(
      projects,
      and(eq(projects.id, files.projectId), eq(projects.organisationId, organisationId)),
    )
    .where(inOrg(files, organisationId, eq(files.id, id)));
  if (!file) throw new NotFound("File");
  const channels = file.mediaInfo?.audio?.channels ?? 0;
  if (!channels && !(file.kind === "video" && file.mediaInfo?.video)) return null;
  const adm = Boolean(file.mediaInfo?.metadata?.adm);

  // The file's own profile, else its track's, its project's or the workspace's (#144).
  const profiles = await profilesForFiles(db, organisationId, [id]);
  const chosen = profiles.of(id, channels, adm);
  const inherited = profiles.inherited(id, channels, adm);
  const [measured] = await db
    .select({ summary: loudness.summary })
    .from(loudness)
    .where(inOrg(loudness, organisationId, eq(loudness.fileId, id)));
  const signal = await db
    .select({
      check: qaFindings.check,
      severity: qaFindings.severity,
      summary: qaFindings.summary,
      channel: qaFindings.channel,
      start: qaFindings.start,
      end: qaFindings.end,
      details: qaFindings.details,
    })
    .from(qaFindings)
    .where(inOrg(qaFindings, organisationId, eq(qaFindings.fileId, id)));
  // As the project wants them (#144): its switches and severities, and its own rules.
  const settings = qaSettingsOf(file.qaSettings);
  const findings: QaFinding[] = [
    ...applyQaSettings(
      [...deliveryFindings(chosen.profile, file.mediaInfo, measured?.summary ?? null), ...signal],
      settings,
    ),
    ...ruleFindings(settings.rules, file, file.mediaInfo, measured?.summary ?? null),
  ];
  return {
    status: file.analysisStatus,
    profile: {
      id: chosen.ref,
      label: chosen.profile.label,
      /** Where it was chosen: the file, its track, project or workspace, or suggested. */
      source: chosen.source,
      /** Chosen by someone, rather than suggested by the file's channels. */
      chosen: chosen.source !== "suggested",
    },
    /** What the file would be measured against without a profile of its own. */
    inherited: {
      id: inherited.ref,
      label: inherited.profile.label,
      source: inherited.source,
    },
    findings: orderFindings(findings),
  };
}

/**
 * `GET /api/files/:id/qa`: a recording's quality checks (#41), as `qaReportOf` reads them. An
 * engineer's tool: a guest needs the meters.
 */
export const fileQaRoutes = (db: Database) =>
  new Hono<{ Variables: ViewerVariables }>()
    .get("/:id/qa", idParam, async (c) => {
      const { id } = c.req.valid("param");
      const access = await canOnFile(db, c.var.actor, "view", id);
      if (!mayUseTool(access, "qa")) throw toolRefused(access);
      const report = await qaReportOf(db, c.var.organisationId, id);
      if (!report)
        throw new HTTPException(409, { message: "Only recordings and videos are checked" });
      return c.json(report);
    })
    // What the checks found fixed and new since the previous version of the same track
    // (#43), as the compare page says it: the earlier version's times carried to this one's
    // by the alignment, where there is one. Only for those who may open the earlier version.
    .get("/:id/qa/changes", idParam, async (c) => {
      const { id } = c.req.valid("param");
      const org = c.var.organisationId;
      const access = await canOnFile(db, c.var.actor, "view", id);
      if (!mayUseTool(access, "qa")) throw toolRefused(access);
      const none = { previous: null, measured: false, fixed: [], new: [] };
      const [mine] = await db
        .select({ trackId: versions.trackId, number: versions.number, name: variations.name })
        .from(variations)
        .innerJoin(
          versions,
          and(eq(versions.id, variations.versionId), eq(versions.organisationId, org)),
        )
        .where(inOrg(variations, org, eq(variations.fileId, id)));
      if (!mine) return c.json(none);
      // The version just before, and in it the variation of the same name, else its primary.
      const earlier = await db
        .select({
          number: versions.number,
          fileId: variations.fileId,
          name: variations.name,
          isPrimary: variations.isPrimary,
        })
        .from(versions)
        .innerJoin(
          variations,
          and(eq(variations.versionId, versions.id), eq(variations.organisationId, org)),
        )
        .where(inOrg(versions, org, eq(versions.trackId, mine.trackId)));
      const previousNumber = Math.max(
        0,
        ...earlier.filter((v) => v.number < mine.number).map((v) => v.number),
      );
      const candidates = earlier.filter((v) => v.number === previousNumber);
      const previous =
        candidates.find((v) => v.name === mine.name) ?? candidates.find((v) => v.isPrimary);
      // Only where the viewer may open the earlier version too: a guest's review may not give it.
      if (!previous || !(await fileAccess(db, c.var.actor, previous.fileId))) return c.json(none);
      const [before, now] = await Promise.all([
        qaReportOf(db, org, previous.fileId),
        qaReportOf(db, org, id),
      ]);
      if (!before || !now) return c.json(none);
      const reached = (await alignmentsFrom(db, org, previous.fileId)).find((r) => r.fileId === id);
      const changes = findingChanges(
        before.findings,
        now.findings,
        reached?.points ? (t) => mapTime(reached.points, t) : undefined,
      );
      return c.json({
        previous: { number: previous.number, name: previous.name },
        /** Both versions measured, so nothing found means nothing there. */
        measured: before.status === "ready" && now.status === "ready",
        fixed: changes.fixed,
        new: changes.new,
      });
    })
    // The same report to take away (#43): PDF to read, CSV for a spreadsheet, JSON for a
    // program, stamped with the workspace, the project and who asked for it.
    .get(
      "/:id/qa/report",
      idParam,
      zValidator("query", z.object({ format: z.enum(qaReportFormats).default("pdf") })),
      async (c) => {
        const { id } = c.req.valid("param");
        const org = c.var.organisationId;
        const access = await canOnFile(db, c.var.actor, "view", id);
        if (!mayUseTool(access, "qa")) throw toolRefused(access);
        const report = await qaReportOf(db, org, id);
        if (!report)
          throw new HTTPException(409, { message: "Only recordings and videos are checked" });
        const [where] = await db
          .select({
            name: files.name,
            mediaInfo: files.mediaInfo,
            projectId: projects.id,
            project: projects.name,
            workspace: organisations.name,
          })
          .from(files)
          .innerJoin(
            projects,
            and(eq(projects.id, files.projectId), eq(projects.organisationId, org)),
          )
          .innerJoin(organisations, eq(organisations.id, files.organisationId))
          .where(inOrg(files, org, eq(files.id, id)));
        if (!where) throw new NotFound("File");
        const [variation] = await db
          .select({ number: versions.number, name: variations.name })
          .from(variations)
          .innerJoin(
            versions,
            and(eq(versions.id, variations.versionId), eq(versions.organisationId, org)),
          )
          .where(inOrg(variations, org, eq(variations.fileId, id)));
        const [measured] = await db
          .select({ summary: loudness.summary })
          .from(loudness)
          .where(inOrg(loudness, org, eq(loudness.fileId, id)));
        const out = qaReport(
          {
            file: {
              name: where.name,
              version: variation ? `V${variation.number} · ${variation.name}` : null,
            },
            workspace: where.workspace,
            project: where.project,
            requestedBy: await requesterOf(db, c.var.actor, where.projectId),
            generatedAt: new Date(),
            profile: { label: report.profile.label },
            status: report.status,
            loudness: measured?.summary ?? null,
            format: where.mediaInfo,
            findings: report.findings,
          },
          c.req.valid("query").format,
        );
        return c.body(new Uint8Array(Buffer.from(out.body)), 200, {
          "content-type": out.contentType,
          "content-disposition": attachment(out.filename),
          "cache-control": "no-store",
        });
      },
    );
