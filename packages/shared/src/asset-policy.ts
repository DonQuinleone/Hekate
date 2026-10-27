import { z } from "zod";
import type { DownloadLevel } from "./downloads.ts";
import type { OrganisationRole } from "./organisation.ts";
import type { ProjectPermission } from "./roles.ts";

/**
 * A project's downloads and deletion (decision 257): who may take files away, whether anyone
 * may have an original, who may delete, whether a file in a review stays, and whether the
 * project's recordings carry the workspace's inaudible mark. Each narrows what the roles and
 * reviews give; none widens it. Whatever is chosen, a download is still made for its
 * recipient, marked and logged (docs/security.md).
 */

/** Who may download: those the roles (or a guest's review) allow, or nobody at all. */
export const downloadPolicies = ["roles", "nobody"] as const;
/** Who may have an original: as the roles allow, only the workspace's owners and admins, or never. */
export const originalPolicies = ["roles", "owners", "never"] as const;
/** Who may delete files and folders: the roles that allow it, or only the workspace's owners and admins. */
export const deletionPolicies = ["roles", "owners"] as const;

export const assetPolicy = z
  .object({
    downloads: z.enum(downloadPolicies),
    originals: z.enum(originalPolicies),
    deletion: z.enum(deletionPolicies),
    /** A file that is an item of a review cannot be deleted (decision 027). */
    keepReviewed: z.boolean(),
    /** Recordings' downloads carry the inaudible mark, where the workspace marks them (decision 239). */
    forensicDownloads: z.boolean(),
  })
  .strict();
export type AssetPolicy = z.infer<typeof assetPolicy>;
export type DownloadPolicy = AssetPolicy["downloads"];
export type OriginalPolicy = AssetPolicy["originals"];
export type DeletionPolicy = AssetPolicy["deletion"];

/** As before projects chose: the roles decide, a reviewed file stays, and downloads are marked. */
export const defaultAssetPolicy: AssetPolicy = {
  downloads: "roles",
  originals: "roles",
  deletion: "roles",
  keepReviewed: true,
  forensicDownloads: true,
};

/** A project's policy as stored, or the default where it has chosen none. */
export function assetPolicyOf(stored: unknown): AssetPolicy {
  const parsed = assetPolicy.safeParse(stored);
  return parsed.success ? parsed.data : defaultAssetPolicy;
}

export const downloadPolicyWords: Record<DownloadPolicy, string> = {
  roles: "Roles that allow downloads",
  nobody: "Nobody",
};

export const originalPolicyWords: Record<OriginalPolicy, string> = {
  roles: "Roles that allow originals",
  owners: "Workspace owners and admins",
  never: "Never",
};

export const deletionPolicyWords: Record<DeletionPolicy, string> = {
  roles: "Roles that allow deleting",
  owners: "Workspace owners and admins",
};

const runsWorkspace = (role: OrganisationRole | null) => role === "owner" || role === "admin";

/**
 * What someone may do in a project once its policy has narrowed what their role grants: no
 * downloads where nobody downloads, no original where originals are never given (or only to
 * the workspace's owners and admins), no deleting where only they delete.
 */
export function narrowedByPolicy(
  granted: ReadonlySet<ProjectPermission>,
  policy: AssetPolicy,
  organisationRole: OrganisationRole,
): Set<ProjectPermission> {
  const out = new Set(granted);
  const runner = runsWorkspace(organisationRole);
  if (policy.downloads === "nobody") {
    out.delete("download_proxy");
    out.delete("download_original");
  }
  if (policy.originals === "never" || (policy.originals === "owners" && !runner))
    out.delete("download_original");
  if (policy.deletion === "owners" && !runner) out.delete("delete_files");
  return out;
}

/** A guest's download level, from their review, as the project's policy lets it stand. */
export function cappedDownload(level: DownloadLevel, policy: AssetPolicy): DownloadLevel {
  if (policy.downloads === "nobody") return "none";
  // A guest is never one of the workspace's owners or admins.
  if (level === "original" && policy.originals !== "roles") return "proxy";
  return level;
}
