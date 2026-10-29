import type { StreamStatus } from "./queries";

/** What the switch above the player needs of a track's versions and their variations. */
export interface StripVariation {
  fileId: string;
  name: string;
  isPrimary: boolean;
  streamStatus: StreamStatus;
}

export interface StripVersion {
  id: string;
  number: number;
  variations: StripVariation[];
}

/** One entry of the version menu: the file it opens, and the quiet word beside it. */
export interface VersionChoice {
  versionId: string;
  number: number;
  fileId: string;
  hint: string | undefined;
  current: boolean;
  latest: boolean;
}

/** What a recording still being prepared, or one that could not be, says beside its name. */
const stateHint = (status: StreamStatus) =>
  status === "pending" ? "analysing" : status === "failed" ? "failed" : undefined;

/**
 * The version menu above the player (#15), newest first, as the prototype draws it. Each
 * version opens the variation of the same name as the one being heard (the wet mix of V1
 * from the wet mix of V2), else its primary; one still being prepared says so, and the
 * newest says it is the latest.
 */
export function versionChoices(
  versions: readonly StripVersion[],
  current: { versionId: string; variationName: string },
): VersionChoice[] {
  const newest = Math.max(...versions.map((v) => v.number));
  return [...versions]
    .sort((a, b) => b.number - a.number)
    .flatMap((v) => {
      const target =
        v.variations.find((x) => x.name === current.variationName) ??
        v.variations.find((x) => x.isPrimary) ??
        v.variations[0];
      if (!target) return [];
      const latest = v.number === newest;
      return [
        {
          versionId: v.id,
          number: v.number,
          fileId: target.fileId,
          hint: stateHint(target.streamStatus) ?? (latest ? "latest" : undefined),
          current: v.id === current.versionId,
          latest,
        },
      ];
    });
}

/** The variations of a version as the switch shows them, in order, with their state. */
export function variationChoices(version: StripVersion) {
  return version.variations.map((v) => ({
    value: v.fileId,
    label: v.name,
    hint: stateHint(v.streamStatus),
  }));
}

/** The file a version opens with: its primary variation, else its first. */
export const primaryOf = <V extends { isPrimary: boolean }>(version: {
  variations: readonly V[];
}): V | undefined => version.variations.find((v) => v.isPrimary) ?? version.variations[0];

/** What suggesting a variation's name needs of a project's tracks: when each version was added, and what its variations are called. */
export interface NamedVersion {
  createdAt: string;
  variations: readonly { name: string }[];
}

/**
 * The names a project's variations go by (Dry, Wet, Instrumental), to suggest for a new one
 * (#486): each name once, as the most recent version to use it spelt it, the most recently
 * used first, leaving out those the version already has. At most `limit` of them.
 */
export function variationNames(
  tracks: readonly { versions: readonly NamedVersion[] }[],
  taken: readonly string[] = [],
  limit = 6,
): string[] {
  const have = new Set(taken.map((n) => n.trim().toLowerCase()));
  const names: string[] = [];
  const versions = tracks
    .flatMap((t) => t.versions)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const version of versions) {
    for (const { name } of version.variations) {
      const key = name.trim().toLowerCase();
      if (!key || have.has(key)) continue;
      have.add(key);
      names.push(name.trim());
      if (names.length === limit) return names;
    }
  }
  return names;
}
