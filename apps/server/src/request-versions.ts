import { inOrg, schema } from "@hekate/db";
import { variantNameFrom } from "@hekate/shared";
import { and, eq, isNotNull, max } from "drizzle-orm";
import { carryThreads } from "./carry.ts";
import { emitEvent } from "./events.ts";
import type { LinkRoots } from "./hosts.ts";
import type { Mailer } from "./mail.ts";
import { followersOf, notifyNow } from "./notifications.ts";
import { versionChecksOf } from "./routes/tracks.ts";
import type { Storage } from "./storage.ts";
import { insertVariants, violatesOneVariantPerFile } from "./variants.ts";
import { type RunnerDeps, versionArrived } from "./workflow-runner.ts";

const { files, tracks, versions, variants, uploadRequests, uploadRequestFiles } = schema;

export interface RequestVersionDeps extends RunnerDeps, LinkRoots {
  storage: Storage;
  mailer: Mailer;
}

/** What became of a file sent through an upload request, as a track's next version. */
export type RequestVersionOutcome = "made" | "refused" | "none";

/**
 * A file sent through an upload request to a track (#425), once measured (or at once, for a file
 * that is never measured), becomes the track's next version: one version for each file, its one
 * variant named from the file, numbered as each is ready. The project's version checks hold as
 * for a member's version, and nobody can let a visitor's file through: one they refuse stays
 * beside the track as it arrived, and the requester is told why. Once only: a file already in a
 * version, or one sent to no track, is left alone.
 */
export async function versionFromRequest(
  deps: RequestVersionDeps,
  job: { organisationId: string; fileId: string },
): Promise<RequestVersionOutcome> {
  const { db } = deps;
  const { organisationId, fileId } = job;
  const [sent] = await db
    .select({
      file: { id: files.id, name: files.name, projectId: files.projectId },
      request: {
        id: uploadRequests.id,
        name: uploadRequests.name,
        trackId: uploadRequests.trackId,
        createdBy: uploadRequests.createdBy,
      },
      sender: uploadRequestFiles.sender,
    })
    .from(uploadRequestFiles)
    .innerJoin(
      uploadRequests,
      inOrg(
        uploadRequests,
        organisationId,
        eq(uploadRequests.id, uploadRequestFiles.requestId),
        isNotNull(uploadRequests.trackId),
      ),
    )
    .innerJoin(files, inOrg(files, organisationId, eq(files.id, uploadRequestFiles.fileId)))
    .where(inOrg(uploadRequestFiles, organisationId, eq(uploadRequestFiles.fileId, fileId)));
  const trackId = sent?.request.trackId;
  if (!sent || !trackId) return "none";
  const [already] = await db
    .select({ id: variants.id })
    .from(variants)
    .where(inOrg(variants, organisationId, eq(variants.fileId, fileId)));
  if (already) return "none";
  // The track, in the request's own project: anything else is no track of this request's.
  const [track] = await db
    .select()
    .from(tracks)
    .where(
      inOrg(
        tracks,
        organisationId,
        and(eq(tracks.id, trackId), eq(tracks.projectId, sent.file.projectId)),
      ),
    );
  if (!track) return "none";
  const told = (recipients: string[]) =>
    [...new Set(recipients.concat(sent.request.createdBy ?? []))].filter(Boolean);

  const { project, refusals } = await versionChecksOf(db, deps.storage, organisationId, track, {
    fileIds: [fileId],
    edlFileId: null,
  });
  if (refusals.length > 0) {
    await notifyNow(deps, {
      organisationId,
      kind: "upload_arrived",
      recipients: told([]),
      actor: null,
      projectId: track.projectId,
      fileId,
      trackId: track.id,
      text: `${sent.file.name} from ${sent.sender} did not become a version of ${track.name}`,
      detail: refusals.map((r) => r.message).join("\n\n"),
      link: `/files/${fileId}`,
    }).catch((error: unknown) =>
      console.warn(`Could not tell a requester a version was refused: ${String(error)}`),
    );
    return "refused";
  }

  let number = 0;
  let versionId = "";
  let aligning: string[] = [];
  try {
    aligning = await db.transaction(async (tx) => {
      // Lock the track so versions made at once take consecutive numbers.
      await tx
        .select({ id: tracks.id })
        .from(tracks)
        .where(inOrg(tracks, organisationId, eq(tracks.id, track.id)))
        .for("update");
      const [last] = await tx
        .select({ number: max(versions.number) })
        .from(versions)
        .where(inOrg(versions, organisationId, eq(versions.trackId, track.id)));
      number = (last?.number ?? 0) + 1;
      const [version] = await tx
        .insert(versions)
        .values({
          organisationId,
          trackId: track.id,
          number,
          notes: `Sent by ${sent.sender} through the upload request ${sent.request.name}.`,
          createdBy: null,
        })
        .returning({ id: versions.id });
      versionId = version?.id ?? "";
      await insertVariants(tx, [
        {
          organisationId,
          versionId,
          fileId,
          name: variantNameFrom(sent.file.name, track.name),
          isPrimary: true,
          position: 0,
        },
      ]);
      await emitEvent(tx, {
        organisationId,
        kind: "version.arrived",
        actor: null,
        projectId: track.projectId,
        trackId: track.id,
        path: `/tracks/${track.id}`,
        details: { version: number },
      });
      // The previous version's open threads come along, carried and shown as the project says.
      return carryThreads(
        tx,
        organisationId,
        { id: versionId, trackId: track.id, number },
        project?.shown ?? true,
      );
    });
  } catch (error) {
    // Made a version meanwhile, by another run or a member: once is enough.
    if (violatesOneVariantPerFile(error)) return "none";
    throw error;
  }
  for (const alignmentId of aligning) {
    await deps.jobs
      .send("media-align", { organisationId, alignmentId }, { singletonKey: alignmentId })
      .catch((error: unknown) =>
        console.warn(`Could not queue alignment ${alignmentId} now: ${String(error)}`),
      );
  }
  await notifyNow(deps, {
    organisationId,
    kind: "version",
    recipients: told(await followersOf(db, organisationId, { trackId: track.id })),
    actor: null,
    projectId: track.projectId,
    trackId: track.id,
    fileId,
    text: `${sent.sender} sent version ${number} of ${track.name}, through ${sent.request.name}`,
    link: `/tracks/${track.id}`,
  }).catch((error: unknown) =>
    console.warn(`Could not tell followers about a version sent in: ${String(error)}`),
  );
  // The project's workflows hear of it (#25), as of a member's version.
  await versionArrived(deps, {
    organisationId,
    projectId: track.projectId,
    trackId: track.id,
    versionId,
    userId: null,
  });
  return "made";
}

/** Whether a file's kind is measured after it arrives: audio and video are. */
export const measuredKind = (kind: string) => kind === "audio" || kind === "video";
