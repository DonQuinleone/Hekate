// Copies the operator pages that live in docs/ into the site, with the frontmatter Starlight
// needs, so each has one source. The copies are generated and not committed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { upgradeNotesPage } from "./upgrade-notes.ts";

const root = join(import.meta.dirname, "../../..");
const pages = [
  {
    from: "docs/configuration.md",
    to: "install/configuration.md",
    description: "Every environment variable Hekate reads, its default, and what it does.",
  },
  {
    from: "docs/backup.md",
    to: "operate/backup.md",
    description: "Back up the database, the storage and the master key; restore and verify.",
  },
  {
    from: "docs/security.md",
    to: "security/model.md",
    description:
      "How Hekate protects unreleased material: encryption, delivery, watermarks, the access log.",
  },
  {
    from: "SECURITY.md",
    to: "security/reporting.md",
    description: "How to report a vulnerability, and how findings are kept at zero.",
  },
];

for (const page of pages) {
  const text = readFileSync(join(root, page.from), "utf8");
  const heading = /^# (.+)$/m.exec(text);
  const title = heading?.[1] ?? page.to;
  const body = text
    .replace(/^# .+\n+/m, "")
    // Links between the copied pages point at their places on the site.
    .replace(/docs\/configuration\.md/g, "../../install/configuration/")
    .replace(/docs\/backup\.md/g, "../../operate/backup/")
    .replace(/docs\/security\.md/g, "../../security/model/");
  const target = join(import.meta.dirname, "../src/content/docs", page.to);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(
    target,
    `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(page.description)}\neditUrl: https://github.com/DonQuinleone/Hekate/edit/master/${page.from}\n---\n\n<!-- Copied from ${page.from} at build time; edit it there. -->\n\n${body}`,
  );
}
// The upgrade notes, gathered from the changelog Release Please writes (#154).
const changelog = join(root, "CHANGELOG.md");
writeFileSync(
  join(import.meta.dirname, "../src/content/docs/operate/upgrade-notes.md"),
  `---\ntitle: "Upgrade notes"\ndescription: "What to do before or after upgrading to each release."\n---\n\n<!-- Gathered from CHANGELOG.md at build time. -->\n\n${upgradeNotesPage(existsSync(changelog) ? readFileSync(changelog, "utf8") : null)}`,
);
console.log(`docs: ${pages.length} pages copied in, and the upgrade notes`);
