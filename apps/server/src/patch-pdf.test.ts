import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StageBox } from "@hekate/shared";
import { afterAll, describe, expect, it } from "vitest";
import { run } from "./media/ffmpeg.ts";
import { textPdfOf } from "./media/pdf.ts";
import { fitted, PATCH_PAGE, patchListPages } from "./patch-pdf.ts";

const hasPoppler = spawnSync("pdftotext", ["-v"]).status === 0;

const row = (channel: number, source: string, notes = "") => ({
  id: `r${channel}`,
  channel,
  source,
  device: "DPA 4006",
  cable: `A${channel}`,
  notes,
});
const box = (name: string, inputs: number): StageBox => ({
  id: name,
  name,
  inputs: Array.from({ length: inputs }, (_, i) => row(i + 1, `Source ${i + 1}`)),
  outputs: [row(1, "Talkback", "To the piano")],
});

describe("the patch list as a PDF", () => {
  const dir = mkdtempSync(join(tmpdir(), "hekate-patch-pdf-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("cuts words to their column, with an ellipsis", () => {
    expect(fitted("Main L", 100)).toBe("Main L");
    const cut = fitted("A very long note about the lid of the piano", 60);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.length).toBeLessThan(20);
  });

  it("carries a long box over pages, numbering each", () => {
    expect(patchListPages("Joplin Rags", [box("Stage box A", 6)])).toHaveLength(1);
    const pages = patchListPages("Joplin Rags", [box("Stage box A", 80)]);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[1]).toContain("(In \\(cont.\\)) Tj");
    expect(pages.at(-1)).toContain(`(Page ${pages.length} of ${pages.length}) Tj`);
  });

  it("says so when there is nothing to list", () => {
    expect(patchListPages("Joplin Rags", [])[0]).toContain("(No stage boxes yet.) Tj");
  });

  it.runIf(hasPoppler || process.env.CI)("writes a PDF a reader finds the patch in", async () => {
    const pdf = textPdfOf(
      patchListPages("Joplin Rags", [box("Stage box A", 6), box("Stage box B", 2)]).map(
        (content) => ({ points: PATCH_PAGE, content }),
      ),
    );
    const path = join(dir, "patch.pdf");
    writeFileSync(path, pdf);
    const { stdout } = await run("pdftotext", ["-layout", path, "-"]);
    expect(stdout).toContain("Joplin Rags · Patch list");
    expect(stdout).toContain("Stage box B");
    expect(stdout).toMatch(/6\s+Source 6\s+DPA 4006\s+A6/);
    expect(stdout).toContain("To the piano");
  });
});
