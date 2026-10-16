import { type Database, inOrg, schema } from "@hekate/db";
import {
  type DeliveryProfileId,
  deliveryFindings,
  deliveryProfiles,
  orderFindings,
  type QaFinding,
  suggestedProfile,
} from "@hekate/shared";
import { and, eq } from "drizzle-orm";

const { projects, files, loudness, qaFindings } = schema;

/**
 * A project's audio files that fail a check, each with its worst finding's summary: the same
 * findings the file's QA page shows, delivery checks against the project's profile (or the one
 * its channels suggest) and the signal checks stored when it was analysed.
 */
export async function failingChecks(
  db: Database,
  organisationId: string,
  projectId: string,
): Promise<{ id: string; name: string; summary: string }[]> {
  const [[project], audio, signal] = await Promise.all([
    db
      .select({ deliveryProfile: projects.deliveryProfile })
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
  const chosen: DeliveryProfileId | null = project?.deliveryProfile ?? null;
  const out: { id: string; name: string; summary: string }[] = [];
  for (const f of audio) {
    const channels = f.mediaInfo?.audio?.channels;
    // As on the QA page: only audio with channels is checked.
    if (!channels) continue;
    const profile = deliveryProfiles[chosen ?? suggestedProfile(channels)];
    const findings = orderFindings([
      ...deliveryFindings(profile, f.mediaInfo, f.measured ?? null),
      ...(signalBy.get(f.id) ?? []),
    ]);
    const fail = findings.find((x) => x.severity === "fail");
    if (fail) out.push({ id: f.id, name: f.name, summary: fail.summary });
  }
  return out;
}
