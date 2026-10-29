import { type Database, inOrg, schema } from "@hekate/db";
import {
  type CustomProfile,
  customIdOf,
  customRef,
  type DeliveryProfile,
  effectiveProfile,
  type ProfileRef,
  type ProfileSource,
  workspaceSettingsOf,
} from "@hekate/shared";
import { and, asc, eq, inArray } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";

const { deliveryProfiles, files, organisations, projects, tracks, variants, versions } = schema;

type Reader = Pick<Database, "select">;

/** A workspace's own delivery profiles (#144), by name. */
export async function customProfilesOf(db: Reader, organisationId: string) {
  const rows = await db
    .select()
    .from(deliveryProfiles)
    .where(inOrg(deliveryProfiles, organisationId))
    .orderBy(asc(deliveryProfiles.label));
  return rows.map((r): CustomProfile => ({ id: r.id, label: r.label, ...r.spec }));
}

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Refuses a reference to a custom profile this workspace does not have; a built-in one has
 * already been checked by the shared schema. Call it in the transaction that writes the
 * reference, before taking any other lock: the profile stays locked until it commits, so a
 * removal (which locks the profile first too) either waits and then clears the new choice, or
 * finishes first and the choice is refused.
 */
export async function assertProfileRef(
  tx: Tx,
  organisationId: string,
  ref: ProfileRef | null | undefined,
) {
  const id = ref ? customIdOf(ref) : null;
  if (!id) return;
  const [found] = await tx
    .select({ id: deliveryProfiles.id })
    .from(deliveryProfiles)
    .where(inOrg(deliveryProfiles, organisationId, eq(deliveryProfiles.id, id)))
    .for("share");
  if (!found) throw new HTTPException(422, { message: "This workspace has no such profile" });
}

/** The workspace's own choice, where nothing nearer chooses. */
async function workspaceRef(db: Reader, organisationId: string) {
  const [row] = await db
    .select({ settings: organisations.settings })
    .from(organisations)
    .where(eq(organisations.id, organisationId));
  return workspaceSettingsOf(row?.settings).deliveryProfile;
}

/**
 * What each of some files is measured against: the nearest choice among the file's own,
 * its track's (as a variant of one of its versions), its project's and the workspace's,
 * else the profile its channels suggest.
 */
export async function profilesForFiles(db: Reader, organisationId: string, fileIds: string[]) {
  const [customs, workspace, rows] = await Promise.all([
    customProfilesOf(db, organisationId),
    workspaceRef(db, organisationId),
    fileIds.length === 0
      ? []
      : db
          .select({
            id: files.id,
            file: files.deliveryProfile,
            project: projects.deliveryProfile,
            track: tracks.deliveryProfile,
          })
          .from(files)
          .innerJoin(
            projects,
            and(eq(projects.id, files.projectId), eq(projects.organisationId, organisationId)),
          )
          .leftJoin(
            variants,
            and(eq(variants.fileId, files.id), eq(variants.organisationId, organisationId)),
          )
          .leftJoin(
            versions,
            and(eq(versions.id, variants.versionId), eq(versions.organisationId, organisationId)),
          )
          .leftJoin(
            tracks,
            and(eq(tracks.id, versions.trackId), eq(tracks.organisationId, organisationId)),
          )
          .where(inOrg(files, organisationId, inArray(files.id, fileIds))),
  ]);
  const refs = new Map(rows.map((r) => [r.id, { ...r, workspace }]));
  return {
    customs,
    /** The profile a file with these channels is measured against, and where it comes from. */
    of(
      fileId: string,
      channels: number,
      /** Whether it is an ADM master (#74), which suggests Atmos. */
      adm = false,
    ): { ref: ProfileRef; profile: DeliveryProfile; source: ProfileSource } {
      return effectiveProfile(refs.get(fileId) ?? { workspace }, channels, customs, adm);
    },
    /** What it would be measured against without a choice of its own. */
    inherited(fileId: string, channels: number, adm = false) {
      return effectiveProfile(
        { ...(refs.get(fileId) ?? { workspace }), file: null },
        channels,
        customs,
        adm,
      );
    },
  };
}

/**
 * Removes a workspace's own profile, and every choice of it: projects, tracks, files and the
 * workspace then measure against the next choice up, as if it had never been chosen.
 */
export async function deleteCustomProfile(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  organisationId: string,
  id: string,
) {
  const ref = customRef(id);
  const [gone] = await tx
    .delete(deliveryProfiles)
    .where(inOrg(deliveryProfiles, organisationId, eq(deliveryProfiles.id, id)))
    .returning({ id: deliveryProfiles.id });
  if (!gone) return false;
  for (const table of [projects, tracks, files] as const) {
    await tx
      .update(table)
      .set({ deliveryProfile: null })
      .where(inOrg(table, organisationId, eq(table.deliveryProfile, ref)));
  }
  const [org] = await tx
    .select({ settings: organisations.settings })
    .from(organisations)
    .where(eq(organisations.id, organisationId))
    .for("update");
  const settings = (org?.settings ?? {}) as Record<string, unknown>;
  if (settings.deliveryProfile === ref) {
    await tx
      .update(organisations)
      .set({ settings: { ...settings, deliveryProfile: null } })
      .where(eq(organisations.id, organisationId));
  }
  return true;
}
