import { type Database, inOrg, schema } from "@hekate/db";
import {
  deliveryFindings,
  deliveryProfiles,
  orderFindings,
  type QaFinding,
  suggestedProfile,
} from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { canOnFile } from "../access.ts";
import { NotFound } from "../errors.ts";
import type { ViewerVariables } from "../guests.ts";

const { files, loudness, projects, qaFindings } = schema;

const idParam = zValidator("param", z.object({ id: z.uuid() }));

/**
 * `GET /api/files/:id/qa`: a recording's quality checks (#41). The signal checks measured
 * when it was analysed, and the delivery checks read now against the project's profile (or
 * the one its channels suggest). An engineer's tool: a guest needs the meters.
 */
export const fileQaRoutes = (db: Database) =>
  new Hono<{ Variables: ViewerVariables }>().get("/:id/qa", idParam, async (c) => {
    const { id } = c.req.valid("param");
    const access = await canOnFile(db, c.var.actor, "view", id);
    if (access.grant && !access.grant.tools.includes("qa")) {
      throw new HTTPException(403, { message: "This review does not include that tool" });
    }
    const organisationId = c.var.organisationId;
    const [file] = await db
      .select({
        kind: files.kind,
        mediaInfo: files.mediaInfo,
        analysisStatus: files.analysisStatus,
        deliveryProfile: projects.deliveryProfile,
      })
      .from(files)
      .innerJoin(
        projects,
        and(eq(projects.id, files.projectId), eq(projects.organisationId, organisationId)),
      )
      .where(inOrg(files, organisationId, eq(files.id, id)));
    if (!file) throw new NotFound("File");
    const channels = file.mediaInfo?.audio?.channels;
    if (!channels) throw new HTTPException(409, { message: "Only audio is checked" });

    const profileId = file.deliveryProfile ?? suggestedProfile(channels);
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
    const findings: QaFinding[] = [
      ...deliveryFindings(deliveryProfiles[profileId], file.mediaInfo, measured?.summary ?? null),
      ...signal,
    ];
    return c.json({
      status: file.analysisStatus,
      profile: {
        id: profileId,
        label: deliveryProfiles[profileId].label,
        /** Chosen for the project, or suggested by the file's channels. */
        chosen: file.deliveryProfile !== null,
      },
      findings: orderFindings(findings),
    });
  });
