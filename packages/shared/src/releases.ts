import { z } from "zod";

/**
 * Releases (#158): what the instance runs, and the releases newer than it, read once a day
 * from the project's public releases feed when the operator turns the check on. Nothing about
 * the instance is sent. Every release is a new image; nothing is patched in place (decision 003).
 */

export const updateChannels = ["stable", "beta"] as const;
export type UpdateChannel = (typeof updateChannels)[number];

/** A release as the instance keeps it from the feed. */
export const releaseInput = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/),
  name: z.string().max(200),
  publishedAt: z.iso.datetime({ offset: true }),
  /** A release candidate: shown on the beta channel only. */
  prerelease: z.boolean(),
  /** The notes as written, cut to a length the page shows. */
  notes: z.string().max(4000),
  url: z.url(),
});
export type Release = z.infer<typeof releaseInput>;

/** The GitHub releases feed, each entry checked, drafts and malformed tags left out. */
export function releasesOfFeed(feed: unknown): Release[] {
  const entries = z.array(z.unknown()).safeParse(feed);
  if (!entries.success) return [];
  return entries.data.flatMap((entry) => {
    const raw = z
      .object({
        tag_name: z.string(),
        name: z.string().nullable().optional(),
        published_at: z.string().nullable(),
        prerelease: z.boolean(),
        draft: z.boolean(),
        body: z.string().nullable().optional(),
        html_url: z.string(),
      })
      .safeParse(entry);
    if (!raw.success || raw.data.draft || !raw.data.published_at) return [];
    const version = raw.data.tag_name.replace(/^v/, "");
    const release = releaseInput.safeParse({
      version,
      name: (raw.data.name || `Release ${version}`).slice(0, 200),
      publishedAt: raw.data.published_at,
      prerelease: raw.data.prerelease,
      notes: (raw.data.body ?? "").slice(0, 4000),
      url: raw.data.html_url,
    });
    return release.success ? [release.data] : [];
  });
}

/** Semantic version order: 0.10.0 after 0.9.0, a release after its candidates. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = "", pre] = v.split("-", 2);
    return { core: core.split(".").map(Number), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d !== 0) return d;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre.localeCompare(y.pre, "en", { numeric: true });
}

/** The releases newer than the one running, newest first, on the channel chosen. */
export function newerReleases(
  running: string,
  releases: Release[],
  channel: UpdateChannel,
): Release[] {
  return releases
    .filter((r) => (channel === "beta" || !r.prerelease) && compareVersions(r.version, running) > 0)
    .sort((a, b) => compareVersions(b.version, a.version));
}

/** System information (#158), as the instance's page shows it. */
export interface SystemInformation {
  version: string;
  /** The commit the image was built from, or "dev". */
  build: string;
  channel: UpdateChannel;
  check: {
    /** HEKATE_UPDATE_CHECK: off, the instance asks nothing of anyone. */
    on: boolean;
    checkedAt: string | null;
    /** Why the last check failed, when it did. */
    failed: string | null;
  };
  /** Newer than the running release, on the channel. */
  available: Release[];
  /** Every release this instance has started, newest first. */
  history: { version: string; firstStartedAt: string }[];
  environment: { name: string; value: string }[];
}
