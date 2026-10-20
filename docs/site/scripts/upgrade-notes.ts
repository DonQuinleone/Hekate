/**
 * The upgrade notes in CHANGELOG.md (#154), gathered for the docs site: under each release, the
 * "⚠ BREAKING CHANGES" Release Please writes from commits' `BREAKING CHANGE:` footers, and any
 * "Upgrade notes" section added to the release pull request by hand. Newest release first, as
 * the changelog has them; a release with neither is left out.
 */
export function upgradeNotes(changelog: string): { release: string; notes: string }[] {
  const releases = changelog.split(/^## /m).slice(1);
  return releases.flatMap((block) => {
    const [heading = "", ...rest] = block.split("\n");
    // "[0.4.0](https://github.com/…) (2026-11-02)" reads as "0.4.0 (2026-11-02)".
    const release = heading.replace(/\[([^\]]+)\]\([^)]*\)/, "$1").trim();
    const sections = rest.join("\n").split(/^### /m).slice(1);
    const notes = sections
      .filter((s) => /^(⚠ BREAKING CHANGES|Upgrade notes)\s*$/m.test(s.split("\n")[0] ?? ""))
      .map((s) => s.split("\n").slice(1).join("\n").trim())
      .filter(Boolean)
      .join("\n\n");
    return notes ? [{ release, notes }] : [];
  });
}

/** The Upgrade notes page, from the changelog, or saying none were needed yet. */
export function upgradeNotesPage(changelog: string | null): string {
  const found = changelog ? upgradeNotes(changelog) : [];
  const intro =
    "What to do before or after upgrading to a release, newest first: migrations that drop or rewrite data (started once with `MIGRATE_ALLOW_DESTRUCTIVE=true`, after a backup), settings that changed, anything else that needs a hand. A release not listed here needs nothing beyond the [usual upgrade](../upgrades/).";
  if (found.length === 0) return `${intro}\n\nNo release has needed upgrade notes yet.\n`;
  return `${intro}\n\n${found.map((r) => `## ${r.release}\n\n${r.notes}`).join("\n\n")}\n`;
}
