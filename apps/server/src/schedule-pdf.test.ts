import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScheduleRow } from "@hekate/shared";
import { afterAll, describe, expect, it } from "vitest";
import { run } from "./media/ffmpeg.ts";
import { textPdfOf } from "./media/pdf.ts";
import {
  longDate,
  SCHEDULE_PAGE,
  type ScheduleExport,
  schedulePages,
  scheduleSheets,
} from "./schedule-pdf.ts";

const hasPoppler = spawnSync("pdftotext", ["-v"]).status === 0;

const row = (over: Partial<ScheduleRow>): ScheduleRow => ({
  id: "r",
  kind: "slot",
  start: null,
  minutes: 60,
  label: "",
  allRepertoire: false,
  workIds: [],
  trackIds: [],
  personnel: "",
  notes: "",
  done: false,
  ...over,
});

const sample = (rows = 4): ScheduleExport => ({
  project: "Joplin Rags",
  days: [
    {
      id: "d1",
      label: "Day 1",
      date: "2026-09-12",
      venueId: "v1",
      start: "09:00",
      rows: [
        row({ kind: "get-in", label: "Get-in and rig", personnel: "Engineer" }),
        row({ workIds: ["w"], personnel: "Trio", notes: "Sections A and B first." }),
        row({ kind: "break", label: "Lunch", start: "13:00" }),
        ...Array.from({ length: rows - 3 }, () => row({ trackIds: ["t2"], minutes: 10 })),
      ],
    },
    { id: "d2", label: "Day 2", date: "2026-09-13", venueId: null, start: "10:00", rows: [] },
  ],
  works: [
    {
      id: "w",
      title: "Rags",
      composer: "Scott Joplin",
      forces: "Piano trio",
      abbreviation: "RAGS",
      trackIds: ["t1"],
    },
  ],
  tracks: [
    { id: "t1", name: "Maple Leaf Rag" },
    { id: "t2", name: "The Entertainer" },
    { id: "t3", name: "Solace" },
  ],
  venues: [{ id: "v1", name: "Endless Hall", address: "Mill Lane\nBristol" }],
  personnel: [
    {
      id: "p1",
      name: "Endless Hall Strings",
      kind: "ensemble",
      role: "",
      agreement: true,
      headphones: false,
      link: null,
      seating: "",
      sections: [
        {
          id: "s1",
          name: "Violin I",
          count: 4,
          divisi: "",
          members: [{ id: "m1", name: "Tomas Varga", agreement: true, headphones: false }],
        },
      ],
    },
    {
      id: "p2",
      name: "Mira Solberg",
      kind: "artist",
      role: "Conductor",
      agreement: true,
      headphones: false,
      link: null,
      seating: "",
      sections: [],
    },
  ],
});

describe("the schedule as a PDF", () => {
  const dir = mkdtempSync(join(tmpdir(), "hekate-schedule-pdf-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("writes dates in full", () => {
    expect(longDate("2026-09-12")).toBe("Saturday, 2026-09-12");
    expect(longDate("2026-09-12", "day-month-year")).toBe("Saturday 12 Sep 2026");
  });

  it("has a front page, a page a day and the breakdown, a long day carried over", () => {
    const pages = schedulePages(sample());
    expect(pages).toHaveLength(4);
    expect(pages[0]).toContain("(Endless Hall) Tj");
    expect(pages[0]).toContain("(Scott Joplin \\267 Piano trio) Tj");
    // The front page shares no notes.
    expect(pages[0]).not.toContain("Sections A and B");
    expect(pages[1]).toContain("(RAGS) Tj");
    // Its words as the page and the workbook have them.
    expect(pages[1]).toContain("(Lunch) Tj");
    expect(pages[1]).not.toContain("Break:");
    expect(pages[1]).toContain("(13:00\\22614:00) Tj");
    expect(pages[3]).toContain("(Endless Hall Strings \\267 4) Tj");
    const long = schedulePages(sample(80));
    expect(long.length).toBeGreaterThan(4);
    expect(long[2]).toContain("\\(cont.\\)");
    expect(long.at(-1)).toContain(`(Page ${long.length} of ${long.length}) Tj`);
  });

  it("lists every row, the coverage and the ensembles in a workbook", () => {
    const [rows, covered, ensembles] = scheduleSheets(sample());
    expect(rows?.rows[1]).toEqual([
      "Day 1",
      "2026-09-12",
      "Endless Hall",
      "09:00",
      "10:00",
      "Get-in",
      "Get-in and rig",
      60,
      "Engineer",
      "",
      "",
    ]);
    expect(covered?.rows).toContainEqual(["Maple Leaf Rag", "Day 1 10:00", 60]);
    expect(covered?.rows).toContainEqual(["Solace", "No slot", 0]);
    expect(ensembles?.rows[1]).toEqual(["Endless Hall Strings", "Violin I", 4, "Tomas Varga"]);
  });

  it.runIf(hasPoppler || process.env.CI)("writes a PDF a reader finds the days in", async () => {
    const pdf = textPdfOf(
      schedulePages(sample()).map((content) => ({ points: SCHEDULE_PAGE, content })),
    );
    const path = join(dir, "schedule.pdf");
    writeFileSync(path, pdf);
    const { stdout } = await run("pdftotext", ["-layout", path, "-"]);
    expect(stdout).toContain("Saturday, 2026-09-12 to Sunday, 2026-09-13");
    expect(stdout).toMatch(/10:00–11:00\s+RAGS\s+Trio\s+60/);
    expect(stdout).toContain("Ensemble breakdown");
  });
});
