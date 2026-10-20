import { describe, expect, it } from "vitest";
import { upgradeNotes, upgradeNotesPage } from "./upgrade-notes.ts";

const changelog = `# Changelog

## [0.3.0](https://github.com/DonQuinleone/Hekate/compare/v0.2.0...v0.3.0) (2026-11-20)


### ⚠ BREAKING CHANGES

* **db:** venue notes are dropped; copy any you need first.

### Features

* the schedule ([#392](https://github.com/DonQuinleone/Hekate/issues/392))

### Upgrade notes

Set \`MAIL_FROM\` before starting.

## [0.2.0](https://github.com/DonQuinleone/Hekate/compare/v0.1.0...v0.2.0) (2026-11-01)


### Fixes

* a fix
`;

describe("upgrade notes", () => {
  it("gathers each release's breaking changes and upgrade notes, newest first", () => {
    expect(upgradeNotes(changelog)).toEqual([
      {
        release: "0.3.0 (2026-11-20)",
        notes:
          "* **db:** venue notes are dropped; copy any you need first.\n\nSet `MAIL_FROM` before starting.",
      },
    ]);
  });

  it("says so when no release has needed any", () => {
    expect(upgradeNotesPage(null)).toContain("No release has needed upgrade notes yet.");
    expect(upgradeNotesPage(changelog)).toContain("## 0.3.0 (2026-11-20)");
  });
});
