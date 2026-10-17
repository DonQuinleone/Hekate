import { type Database, inOrg, schema } from "@hekate/db";
import {
  applyQaSettings,
  deliveryFindings,
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
import { canOnFile, mayUseTool, toolRefused } from "../access.ts";
import { profilesForFiles } from "../delivery-profiles.ts";
import { NotFound } from "../errors.ts";
import type { ViewerVariables } from "../guests.ts";

const { files, loudness, projects, qaFindings } = schema;

const idParam = zValidator("param", z.object({ id: z.uuid() }));

/**
 * A recording's quality report: the signal checks measured when it was analysed, and the
 * delivery checks read now against its profile, as its project wants them. Null for a file
 * without audio, which is not checked.
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
  const channels = file.mediaInfo?.audio?.channels;
  if (!channels) return null;

  // The file's own profile, else its track's, its project's or the workspace's (#144).
  const profiles = await profilesForFiles(db, organisationId, [id]);
  const chosen = profiles.of(id, channels);
  const inherited = profiles.inherited(id, channels);
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
  new Hono<{ Variables: ViewerVariables }>().get("/:id/qa", idParam, async (c) => {
    const { id } = c.req.valid("param");
    const access = await canOnFile(db, c.var.actor, "view", id);
    if (!mayUseTool(access, "qa")) throw toolRefused(access);
    const report = await qaReportOf(db, c.var.organisationId, id);
    if (!report) throw new HTTPException(409, { message: "Only audio is checked" });
    return c.json(report);
  });
