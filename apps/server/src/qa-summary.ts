import { type Database, inOrg, schema } from "@hekate/db";
import {
  applyQaSettings,
  deliveryFindings,
  orderFindings,
  type QaFinding,
  qaSettingsOf,
  ruleFindings,
} from "@hekate/shared";
import { and, eq } from "drizzle-orm";
import { profilesForFiles } from "./delivery-profiles.ts";

const { files, loudness, projects, qaFindings } = schema;

/**
 * A project's audio files that fail a check, each with its worst finding's summary: the same
 * findings the file's QA page shows, delivery checks against each file's profile (its own, its
 * track's, the project's or the workspace's, or the one its channels suggest) and the signal
 * checks stored when it was analysed.
 */
export async function failingChecks(
  db: Database,
  organisationId: string,
  projectId: string,
): Promise<{ id: string; name: string; summary: string }[]> {
  const [[project], audio, signal] = await Promise.all([
    db
      .select({ qaSettings: projects.qaSettings })
      .from(projects)
      .where(inOrg(projects, organisationId, eq(projects.id, projectId))),
    db
      .select({
        id: files.id,
        name: files.name,
        mediaInfo: files.mediaInfo,
        measured: loudness.summary,
      })
      .from(files)
      .leftJoin(
        loudness,
        and(eq(loudness.fileId, files.id), eq(loudness.organisationId, organisationId)),
      )
      .where(inOrg(files, organisationId, eq(files.projectId, projectId), eq(files.kind, "audio"))),
    db
      .select({
        fileId: qaFindings.fileId,
        check: qaFindings.check,
        severity: qaFindings.severity,
        summary: qaFindings.summary,
        channel: qaFindings.channel,
        start: qaFindings.start,
        end: qaFindings.end,
        details: qaFindings.details,
      })
      .from(qaFindings)
      .innerJoin(
        files,
        and(eq(files.id, qaFindings.fileId), eq(files.organisationId, organisationId)),
      )
      .where(inOrg(qaFindings, organisationId, eq(files.projectId, projectId))),
  ]);
  const signalBy = new Map<string, QaFinding[]>();
  for (const { fileId, ...finding } of signal)
    signalBy.set(fileId, [...(signalBy.get(fileId) ?? []), finding]);
  const settings = qaSettingsOf(project?.qaSettings);
  const profiles = await profilesForFiles(
    db,
    organisationId,
    audio.map((f) => f.id),
  );
  const out: { id: string; name: string; summary: string }[] = [];
  for (const f of audio) {
    const channels = f.mediaInfo?.audio?.channels;
    // As on the QA page: only audio with channels is checked.
    if (!channels) continue;
    const { profile } = profiles.of(f.id, channels, Boolean(f.mediaInfo?.metadata?.adm));
    const findings = orderFindings([
      ...applyQaSettings(
        [
          ...deliveryFindings(profile, f.mediaInfo, f.measured ?? null),
          ...(signalBy.get(f.id) ?? []),
        ],
        settings,
      ),
      ...ruleFindings(settings.rules, f, f.mediaInfo, f.measured ?? null),
    ]);
    const fail = findings.find((x) => x.severity === "fail");
    if (fail) out.push({ id: f.id, name: f.name, summary: fail.summary });
  }
  return out;
}
