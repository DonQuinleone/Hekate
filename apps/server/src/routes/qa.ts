import { type Database, inOrg, schema } from "@hekate/db";
import {
  applyQaSettings,
  audible,
  decodeLoudness,
  decodePeaks,
  deliveryFindings,
  findingChanges,
  formatDate,
  formatDateTime,
  type LoudnessSummary,
  lightAccent,
  type MediaInfo,
  mapTime,
  orderFindings,
  type PeakLevel,
  type QaDocument,
  type QaFinding,
  qaDocument,
  qaSettingsOf,
  ruleFindings,
  signalColours,
  storedBrandingOf,
  watermarkOf,
} from "@hekate/shared";
import { and, asc, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { encode } from "uqr";
import { z } from "zod";
import { type Actor, canOnFile, fileAccess, mayUseTool, toolRefused } from "../access.ts";
import { alignmentsFrom } from "../alignment-graph.ts";
import { type Audit, requestInfo } from "../audit.ts";
import { workspaceDateFormats } from "../dates.ts";
import { profilesForFiles } from "../delivery-profiles.ts";
import { NotFound } from "../errors.ts";
import type { ViewerVariables } from "../guests.ts";
import { type LinkRoots, workspaceLinkBase } from "../hosts.ts";
import { pdfImageOfPng } from "../media/png.ts";
import { zValidator } from "../openapi/validator.ts";
import { qaReport, qaReportFilename, qaReportFormats } from "../qa-report.ts";
import { qaReportPdf } from "../qa-report-pdf.ts";
import { requesterOf } from "../requester.ts";
import type { Storage } from "../storage.ts";
import { viewerMark } from "../viewer-mark.ts";
import { attachment } from "./comments.ts";

const {
  files,
  loudness,
  organisations,
  peakLevels,
  projects,
  qaFindings,
  tracks,
  variants,
  versions,
} = schema;

const idParam = zValidator("param", z.object({ id: z.uuid() }));

/**
 * A recording's quality report: the signal checks measured when it was analysed (a video's
 * picture among them, #42), and the delivery checks read now against its profile, as its
 * project wants them. Null for a file with neither sound nor a video's picture, which is not
 * checked.
 */
export async function qaReportOf(db: Database, organisationId: string, id: string) {
  const facts = await qaFactsOf(db, organisationId, id);
  if (!facts) return null;
  const { chosen, inherited } = facts;
  return {
    status: facts.status,
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
    findings: facts.findings,
  };
}

/** What a recording's QA is read from: its profile, the project's rules, and the findings. */
async function qaFactsOf(db: Database, organisationId: string, id: string) {
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
    chosen,
    inherited,
    rules: settings.rules,
    loudness: measured?.summary ?? null,
    findings: orderFindings(findings),
  };
}

/** The most of a file's peaks read for a report's crops: the finest level within it. */
const PEAKS_BYTES = 8 * 1024 * 1024;

/** What the QA report routes need beside the database. */
export interface QaRouteDeps {
  db: Database;
  storage: Storage;
  audit: Audit;
  trustProxy: boolean;
  links: LinkRoots;
}

/**
 * A recording's QA report as a document (#515): its findings, measures and appendices from
 * `qaFactsOf`, the file's place (track, version, variant, project, workspace), who asked and
 * when, the waveform's peaks for the crops and the short-term loudness for the curve.
 */
export async function qaDocumentOf(
  deps: Pick<QaRouteDeps, "db" | "storage" | "links">,
  actor: Actor,
  organisationId: string,
  id: string,
  /** Read the peaks and the loudness series for the crops and the curve; not for a CSV. */
  illustrate = true,
): Promise<{
  doc: QaDocument;
  projectId: string;
  watermark: unknown;
  branding: unknown;
  facts: { findings: QaFinding[]; loudness: LoudnessSummary | null; format: MediaInfo | null };
} | null> {
  const { db, storage } = deps;
  const org = organisationId;
  const facts = await qaFactsOf(db, org, id);
  if (!facts) return null;
  const [where] = await db
    .select({
      name: files.name,
      mediaInfo: files.mediaInfo,
      projectId: projects.id,
      project: projects.name,
      watermark: projects.watermark,
      workspace: organisations.name,
      settings: organisations.settings,
      branding: organisations.branding,
    })
    .from(files)
    .innerJoin(projects, and(eq(projects.id, files.projectId), eq(projects.organisationId, org)))
    .innerJoin(organisations, eq(organisations.id, files.organisationId))
    .where(inOrg(files, org, eq(files.id, id)));
  if (!where) throw new NotFound("File");
  const [variant] = await db
    .select({ number: versions.number, name: variants.name, track: tracks.name })
    .from(variants)
    .innerJoin(versions, and(eq(versions.id, variants.versionId), eq(versions.organisationId, org)))
    .innerJoin(tracks, and(eq(tracks.id, versions.trackId), eq(tracks.organisationId, org)))
    .where(inOrg(variants, org, eq(variants.fileId, id)));
  const [series] = await db
    .select({ blobId: loudness.blobId, createdAt: loudness.createdAt })
    .from(loudness)
    .where(inOrg(loudness, org, eq(loudness.fileId, id)));
  const levels = await db
    .select({
      blobId: peakLevels.blobId,
      count: peakLevels.peakCount,
      channels: peakLevels.channels,
    })
    .from(peakLevels)
    .where(inOrg(peakLevels, org, eq(peakLevels.fileId, id)))
    .orderBy(asc(peakLevels.samplesPerPeak));
  const read = async (blobId: string) =>
    Buffer.concat(await (await storage.open(org, blobId)).stream.toArray());
  // The finest level small enough to read whole: fine enough for a click's crop.
  const level = illustrate
    ? levels.find((l) => l.count * l.channels * 2 <= PEAKS_BYTES)
    : undefined;
  let peaks: PeakLevel | null = null;
  if (level) {
    try {
      peaks = decodePeaks(await read(level.blobId));
    } catch {
      peaks = null;
    }
  }
  let shortTerm: { values: (number | null)[]; secondsPerFrame: number } | null = null;
  if (series && illustrate) {
    try {
      const decoded = decodeLoudness(await read(series.blobId));
      shortTerm = {
        values: Array.from(decoded.shortTerm, audible),
        secondsPerFrame: decoded.samplesPerFrame / decoded.sampleRate,
      };
    } catch {
      shortTerm = null;
    }
  }
  const dates = await workspaceDateFormats(db, org, where.settings);
  const now = new Date();
  const doc = qaDocument({
    file: {
      id,
      name: where.name,
      track: variant?.track ?? null,
      version: variant?.number ?? null,
      variant: variant?.name ?? null,
    },
    workspace: where.workspace,
    project: where.project,
    preparedBy: await requesterOf(db, actor, where.projectId),
    preparedAt: now,
    preparedOn: `${formatDateTime(dates, now, { timeZone: "UTC" })} UTC`,
    measuredOn: series ? formatDate(dates.dateFormat, series.createdAt, { timeZone: "UTC" }) : null,
    profile: facts.chosen.profile,
    rules: facts.rules,
    status: facts.status,
    loudness: facts.loudness,
    format: where.mediaInfo,
    findings: facts.findings,
    peaks,
    shortTerm,
    link: `${await workspaceLinkBase(db, deps.links, org)}/files/${id}?view=qa`,
  });
  return {
    doc,
    projectId: where.projectId,
    watermark: where.watermark,
    branding: where.branding,
    facts: { findings: facts.findings, loudness: facts.loudness, format: where.mediaInfo },
  };
}

/** The workspace's logo as a PDF draws it, or null to use Hekate's mark. */
async function logoOf(storage: Storage, organisationId: string, branding: unknown) {
  const logo = storedBrandingOf(branding).logo;
  if (!logo) return null;
  try {
    const { stream } = await storage.open(organisationId, logo.blobId);
    return pdfImageOfPng(Buffer.concat(await stream.toArray()));
  } catch {
    return null;
  }
}

/** The access log's actor for whoever asked. */
const loggedActor = (audit: Audit, actor: Actor) =>
  audit.actor(
    actor.kind === "guest" ? { kind: "guest", guestId: actor.guestId } : { userId: actor.userId },
  );

/**
 * `GET /api/files/:id/qa`: a recording's quality checks (#41), as `qaReportOf` reads them. An
 * engineer's tool: a guest needs the meters.
 */
export const fileQaRoutes = (deps: QaRouteDeps) => {
  const { db } = deps;
  return (
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
          .select({ trackId: versions.trackId, number: versions.number, name: variants.name })
          .from(variants)
          .innerJoin(
            versions,
            and(eq(versions.id, variants.versionId), eq(versions.organisationId, org)),
          )
          .where(inOrg(variants, org, eq(variants.fileId, id)));
        if (!mine) return c.json(none);
        // The version just before, and in it the variant of the same name, else its primary.
        const earlier = await db
          .select({
            number: versions.number,
            fileId: variants.fileId,
            name: variants.name,
            isPrimary: variants.isPrimary,
          })
          .from(versions)
          .innerJoin(
            variants,
            and(eq(variants.versionId, versions.id), eq(variants.organisationId, org)),
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
        const reached = (await alignmentsFrom(db, org, previous.fileId)).find(
          (r) => r.fileId === id,
        );
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
      // The report as a document to read in the app (#515): the same content the PDF sets, from
      // the same structure, for those who may see the file's QA.
      .get("/:id/qa/document", idParam, async (c) => {
        const { id } = c.req.valid("param");
        const access = await canOnFile(db, c.var.actor, "view", id);
        if (!mayUseTool(access, "qa")) throw toolRefused(access);
        const made = await qaDocumentOf(deps, c.var.actor, c.var.organisationId, id);
        if (!made)
          throw new HTTPException(409, { message: "Only recordings and videos are checked" });
        return c.json({ document: made.doc }, 200, { "cache-control": "no-store" });
      })
      // The same report to take away (#43): PDF to read, CSV for a spreadsheet, JSON for a
      // program, stamped with the workspace, the project and who asked for it. The PDF is the
      // document (#515), branded and marked for whoever asked; every format is in the access log
      // before it leaves, as a download is.
      .get(
        "/:id/qa/report",
        idParam,
        zValidator("query", z.object({ format: z.enum(qaReportFormats).default("pdf") })),
        async (c) => reportResponse(c, deps, c.req.valid("param").id, c.req.valid("query").format),
      )
  );
};

async function reportResponse(
  c: Context<{ Variables: ViewerVariables }>,
  deps: QaRouteDeps,
  id: string,
  format: (typeof qaReportFormats)[number],
) {
  const { db } = deps;
  const org = c.var.organisationId;
  const actor = c.var.actor;
  const access = await canOnFile(db, actor, "view", id);
  if (!mayUseTool(access, "qa")) throw toolRefused(access);
  const made = await qaDocumentOf(deps, actor, org, id, format === "pdf");
  if (!made) throw new HTTPException(409, { message: "Only recordings and videos are checked" });
  const { doc } = made;
  let out: { body: string | Buffer; filename: string; contentType: string };
  if (format === "pdf") {
    // Branded with the workspace's logo and accent, and marked for whoever asked.
    const stored = storedBrandingOf(made.branding);
    const mark = (await viewerMark(db, actor)) ?? `${doc.preparedBy.name}\n${doc.workspace}`;
    out = {
      body: qaReportPdf(doc, {
        accent: stored.accent ? lightAccent(stored.accent) : signalColours.light,
        logo: await logoOf(deps.storage, org, made.branding),
        mark: { text: mark, style: watermarkOf(made.watermark) },
        qr: encode(doc.appendix.link, { ecc: "M", border: 0 }).data,
      }),
      filename: qaReportFilename(doc.file.name, format),
      contentType: "application/pdf",
    };
  } else
    out = qaReport(
      {
        file: {
          name: doc.file.name,
          version: doc.file.version !== null ? `V${doc.file.version} · ${doc.file.variant}` : null,
        },
        workspace: doc.workspace,
        project: doc.project,
        requestedBy: doc.preparedBy,
        generatedAt: new Date(doc.preparedAt),
        profile: { label: doc.profile },
        status: doc.status,
        loudness: made.facts.loudness,
        format: made.facts.format,
        findings: made.facts.findings,
      },
      format,
    );
  await deps.audit.record(
    org,
    await loggedActor(deps.audit, actor),
    {
      action: "file.qa_report",
      projectId: made.projectId,
      fileId: id,
      details: { format },
    },
    requestInfo(c, deps.trustProxy),
  );
  return c.body(new Uint8Array(Buffer.from(out.body)), 200, {
    "content-type": out.contentType,
    "content-disposition": attachment(out.filename),
    "cache-control": "no-store",
  });
}
