import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StageItem, StagePlan } from "@hekate/shared";
import { afterAll, describe, expect, it } from "vitest";
import { run } from "./media/ffmpeg.ts";
import { textPdfOf } from "./media/pdf.ts";
import { printScale, STAGE_PAPER, stagePlanPage } from "./stage-pdf.ts";

const hasPoppler = spawnSync("pdftotext", ["-v"]).status === 0;

const item = (over: Partial<StageItem>): StageItem => ({
  id: over.label ?? "x",
  kind: "rect",
  label: "",
  x: 1,
  y: 1,
  w: 1,
  h: 1,
  rotation: 0,
  patchRowId: null,
  personnelId: null,
  group: "",
  ...over,
});
const plan: StagePlan = {
  id: "p",
  name: "Endless Hall",
  underlay: null,
  width: 12,
  depth: 8,
  grid: 0.5,
  items: [
    item({ kind: "wall", label: "Rear wall", x: 0, y: 0, w: 12, h: 0.2 }),
    item({ kind: "piano", label: "Piano", x: 4.5, y: 2, w: 2.7, h: 1.6, rotation: -20 }),
    item({ kind: "performer", label: "Violin", x: 7.8, y: 3.4, w: 0.6, h: 0.6 }),
    item({
      kind: "mic",
      label: "",
      x: 5.2,
      y: 5.6,
      w: 0.3,
      h: 0.3,
      patchRowId: "c1",
      group: "Main pair",
    }),
    item({ kind: "cable", label: "Multicore", x: 1, y: 7, w: 4, h: -1 }),
  ],
};
const channels = [
  { id: "c1", box: "Stage box A", direction: "input" as const, channel: 1, source: "Main L" },
];

describe("the stage plan as a PDF", () => {
  const dir = mkdtempSync(join(tmpdir(), "hekate-stage-pdf-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("prints at the largest standard scale that fits", () => {
    expect(printScale(12, 8, { width: 1000, height: 650 }).ratio).toBe(50);
    expect(printScale(12, 8, { width: 700, height: 450 }).ratio).toBe(75);
    expect(printScale(60, 30, { width: 700, height: 450 }).ratio).toBe(250);
    // Too big for any: drawn to fit, and said so.
    const huge = printScale(400, 300, { width: 700, height: 450 });
    expect(huge.ratio).toBeNull();
    expect(huge.perMetre).toBeCloseTo(1.5);
  });

  it("labels a microphone by its channel, unless its group is hidden", () => {
    const shown = stagePlanPage("Joplin Rags", plan, channels, "a3").content;
    expect(shown).toContain("(Main L) Tj");
    expect(shown).toContain("(Stage box A, in 1) Tj");
    const hidden = stagePlanPage("Joplin Rags", plan, channels, "a3", ["Main pair"]).content;
    expect(hidden).not.toContain("(Main L) Tj");
    expect(hidden).toContain("(Violin) Tj");
  });

  it("names an ensemble by who it is on the personnel", () => {
    const strings = item({ kind: "ensemble", label: "Strings", personnelId: "pe" });
    const page = stagePlanPage(
      "Joplin Rags",
      { ...plan, items: [strings] },
      [],
      "a3",
      [],
      [{ id: "pe", name: "Endless Hall Strings", kind: "ensemble", players: 12 }],
    ).content;
    expect(page).toContain("(Endless Hall Strings) Tj");
  });

  it.runIf(hasPoppler || process.env.CI)("writes a PDF a reader finds the plan in", async () => {
    for (const paper of ["a3", "a4"] as const) {
      const pdf = textPdfOf([stagePlanPage("Joplin Rags", plan, channels, paper)]);
      const path = join(dir, `stage-${paper}.pdf`);
      writeFileSync(path, pdf);
      const { stdout } = await run("pdftotext", ["-layout", path, "-"]);
      expect(stdout).toContain("Joplin Rags · Endless Hall");
      expect(stdout).toContain(paper === "a3" ? "1:50 on A3" : "1:75 on A4");
      expect(stdout).toContain("Main L");
      expect(stdout).toContain("Audience");
      const { stdout: info } = await run("pdfinfo", [path]);
      const size = STAGE_PAPER[paper];
      expect(info).toContain(
        `${Math.round(size.width * 100) / 100} x ${Math.round(size.height * 100) / 100} pts`,
      );
    }
  });
});
