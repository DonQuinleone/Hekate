import { type Database, inOrg, schema } from "@hekate/db";
import {
  foldersBeneath,
  mayCoverWorkspace,
  type OrganisationRole,
  type ReviewScope,
} from "@hekate/shared";
import { and, asc, desc, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
import { listedFile } from "./take-files.ts";

const { files, folders, projectMembers, projectRoles, projects, tracks, variants, versions } =
  schema;

type Db = Pick<Database, "select">;

/** A review item that names a place rather than a thing (#501), with the review's project. */
export interface ScopeItem {
  projectId: string;
  folderId: string | null;
  scope: ReviewScope | null;
}

/** One file a scope covers now: where it is and, for a track's, which track at which version. */
export interface CoveredFile {
  fileId: string;
  projectId: string;
  projectName: string;
  name: string;
  kind: (typeof files.$inferSelect)["kind"];
  /** The track whose latest version the file is a variant of, if any. */
  track: { id: string; name: string; versionNumber: number } | null;
}

/** The name a workspace-wide item goes by. */
export const workspaceItemName = "Everything in this workspace";

/**
 * What a folder or workspace item covers as it is now (#501): every track beneath it at its
 * latest version (the variants of that version), then every loose file (one that is no
 * version's variant, no take's and not replaced by a later file), tracks and files by name.
 * A folder covers itself and the folders beneath it, within the review's project; the
 * workspace covers every project not archived. Everything is read within the organisation,
 * so another workspace's files never appear.
 */
export async function coveredBy(
  db: Db,
  organisationId: string,
  item: ScopeItem,
): Promise<CoveredFile[]> {
  let folderIds: string[] | null;
  if (item.scope === "workspace") {
    folderIds = null;
  } else if (item.folderId) {
    const tree = await db
      .select({ id: folders.id, parentId: folders.parentId })
      .from(folders)
      .where(inOrg(folders, organisationId, eq(folders.projectId, item.projectId)));
    folderIds = [...foldersBeneath(tree, item.folderId)];
    if (folderIds.length === 0) return [];
  } else {
    return [];
  }
  const named = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(
      inOrg(
        projects,
        organisationId,
        folderIds ? eq(projects.id, item.projectId) : isNull(projects.archivedAt),
      ),
    );
  const projectNames = new Map(named.map((p) => [p.id, p.name]));
  const projectIds = [...projectNames.keys()];
  if (projectIds.length === 0) return [];
  const within = (column: typeof files.folderId | typeof tracks.folderId) =>
    folderIds ? inArray(column, folderIds) : undefined;

  // Each track beneath, at its latest version.
  const trackRows = await db
    .select({ id: tracks.id, name: tracks.name })
    .from(tracks)
    .where(
      inOrg(tracks, organisationId, inArray(tracks.projectId, projectIds), within(tracks.folderId)),
    )
    .orderBy(asc(tracks.name), asc(tracks.id));
  const latest = new Map<string, { id: string; number: number }>();
  if (trackRows.length > 0) {
    const versionRows = await db
      .select({ id: versions.id, trackId: versions.trackId, number: versions.number })
      .from(versions)
      .where(
        inOrg(
          versions,
          organisationId,
          inArray(
            versions.trackId,
            trackRows.map((t) => t.id),
          ),
        ),
      )
      .orderBy(desc(versions.number));
    for (const v of versionRows) if (!latest.has(v.trackId)) latest.set(v.trackId, v);
  }
  const ofTracks: CoveredFile[] = [];
  if (latest.size > 0) {
    const variantRows = await db
      .select({
        versionId: variants.versionId,
        fileId: variants.fileId,
        primary: variants.isPrimary,
        name: files.name,
        kind: files.kind,
        projectId: files.projectId,
      })
      .from(variants)
      .innerJoin(
        files,
        and(eq(files.id, variants.fileId), eq(files.organisationId, organisationId)),
      )
      .where(
        inOrg(
          variants,
          organisationId,
          inArray(
            variants.versionId,
            [...latest.values()].map((v) => v.id),
          ),
        ),
      )
      .orderBy(desc(variants.isPrimary), asc(variants.createdAt));
    for (const track of trackRows) {
      const version = latest.get(track.id);
      if (!version) continue;
      for (const v of variantRows.filter((x) => x.versionId === version.id)) {
        ofTracks.push({
          fileId: v.fileId,
          projectId: v.projectId,
          projectName: projectNames.get(v.projectId) ?? "",
          name: v.name,
          kind: v.kind,
          track: { id: track.id, name: track.name, versionNumber: version.number },
        });
      }
    }
  }

  // Then the loose files: no version's, no take's, and the last of their chain.
  const later = sql`(select 1 from ${files} as later where later.previous_file_id = ${files.id})`;
  const inVersion = sql`(select 1 from ${variants} where ${variants.fileId} = ${files.id})`;
  const loose = await db
    .select({ id: files.id, name: files.name, kind: files.kind, projectId: files.projectId })
    .from(files)
    .where(
      inOrg(
        files,
        organisationId,
        inArray(files.projectId, projectIds),
        within(files.folderId),
        listedFile,
        notExists(inVersion),
        notExists(later),
      ),
    )
    .orderBy(asc(files.name), asc(files.id));
  return [
    ...ofTracks,
    ...loose.map((f) => ({
      fileId: f.id,
      projectId: f.projectId,
      projectName: projectNames.get(f.projectId) ?? "",
      name: f.name,
      kind: f.kind,
      track: null,
    })),
  ];
}

/**
 * Whether a member may ask a review of everything in the workspace (#501): an owner or admin,
 * or someone whose role in every project not archived has the Reviews: Manage level. Says how
 * many projects that is, for the page to say what the choice covers.
 */
export async function workspaceCoverage(
  db: Db,
  actor: { userId: string; organisationId: string; organisationRole: OrganisationRole },
): Promise<{ allowed: boolean; projects: number }> {
  const rows = await db
    .select({ id: projects.id, permissions: projectRoles.permissions })
    .from(projects)
    .leftJoin(
      projectMembers,
      and(
        eq(projectMembers.projectId, projects.id),
        eq(projectMembers.organisationId, actor.organisationId),
        eq(projectMembers.userId, actor.userId),
      ),
    )
    .leftJoin(
      projectRoles,
      and(
        eq(projectRoles.id, projectMembers.roleId),
        eq(projectRoles.organisationId, actor.organisationId),
      ),
    )
    .where(inOrg(projects, actor.organisationId, isNull(projects.archivedAt)));
  return {
    allowed: mayCoverWorkspace(
      actor.organisationRole,
      rows.map((r) => r.permissions),
    ),
    projects: rows.length,
  };
}
