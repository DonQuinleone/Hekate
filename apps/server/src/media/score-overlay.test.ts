import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { run } from "./ffmpeg.ts";
import { jpegSize, pdfOf } from "./pdf.ts";
import { type OverlayMark, pdfString, scoreOverlay, wrap } from "./score-overlay.ts";

const hasTools =
  spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("pdftotext", ["-v"]).status === 0;

const mark = (m: Partial<OverlayMark>): OverlayMark => ({
  kind: "issue",
  x: 0.5,
  y: 0.5,
  width: null,
  height: null,
  points: null,
  text: null,
  categoryId: null,
  fixedBy: null,
  resolved: false,
  from: null,
  to: null,
  ...m,
});

const A4 = { width: 595, height: 842 };

describe("the score marks over a page", () => {
  const dir = mkdtempSync(join(tmpdir(), "hekate-overlay-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("writes words as WinAnsi in ASCII, escaping what a PDF string must", () => {
    expect(pdfString("Bars 9–12 (rushes)")).toBe("(Bars 9\\22612 \\(rushes\\))");
    expect(pdfString("Crème \\ brûlée")).toBe("(Cr\\350me \\\\ br\\373l\\351e)");
    expect(pdfString("Tempo ♩=88")).toBe("(Tempo ?=88)");
  });

  it("wraps a note into lines, ending one too long with an ellipsis", () => {
    expect(wrap("Breath before the trio, then a little faster", 16, 6)).toEqual([
      "Breath before",
      "the trio, then a",
      "little faster",
    ]);
    expect(wrap("one two three four", 9, 1)).toEqual(["one two…"]);
  });

  it("draws nothing on a page without marks", () => {
    expect(scoreOverlay([], () => "signal", A4)).toBe("");
  });

  it("places marks from the top of the page, regions in their category's colour", () => {
    const ops = scoreOverlay(
      [
        mark({ x: 0.1, y: 0.25, width: 0.5, height: 0.25, categoryId: "c1" }),
        mark({ kind: "edit", from: 3, to: 4, x: 0.5, y: 0.5 }),
      ],
      (id) => (id === "c1" ? "blue" : "signal"),
      A4,
    );
    // The region's lower left corner: 59.5 across, 842 × (1 − 0.5) up.
    expect(ops).toContain("59.5 421 297.5 210.5 re S");
    expect(ops).toContain("0.18 0.44 0.84 RG");
    expect(ops).toContain("(3T4) Tj");
    expect(ops.startsWith("q ")).toBe(true);
    expect(ops.endsWith("Q")).toBe(true);
    expect(ops).toMatch(/^[\x20-\x7e\n]*$/);
  });

  it("says which take fixed an issue beside it, and draws a resolved one paler", () => {
    const ops = scoreOverlay(
      [mark({ text: "Left hand rushes", fixedBy: 2, resolved: true })],
      () => "signal",
      A4,
    );
    expect(ops).toContain("(Left hand rushes, fixed in T2) Tj");
    expect(ops).toContain("0.97 0.73 0.59 RG");
  });

  it("keeps an issue's words on the page, left of a mark near its right edge", () => {
    const at = (x: number) => {
      const ops = scoreOverlay(
        [mark({ x, text: "Left hand rushes", fixedBy: 2 })],
        () => "signal",
        A4,
      );
      const [, left] = /BT \/H [\d.]+ Tf [\d. ]+ rg ([\d.]+) [\d.]+ Td \(Left/.exec(ops) ?? [];
      return Number(left);
    };
    expect(at(0.2)).toBeGreaterThan(0.2 * A4.width);
    const near = at(0.95);
    expect(near).toBeLessThan(0.95 * A4.width);
    expect(near).toBeGreaterThan(0);
  });

  it.runIf(hasTools || process.env.CI)("prints marks a PDF reader finds", async () => {
    const jpg = join(dir, "page.jpg");
    await run("ffmpeg", [
      ...["-hide_banner", "-nostdin", "-v", "error", "-f", "lavfi"],
      ...["-i", "color=white:s=595x842", "-frames:v", "1", "-pix_fmt", "yuvj444p", jpg],
    ]);
    const jpeg = readFileSync(jpg);
    const overlay = scoreOverlay(
      [
        mark({ kind: "edit", from: 3, to: 4, x: 0.3, y: 0.2 }),
        mark({ kind: "dynamic", text: "mp", x: 0.6, y: 0.4 }),
        mark({ kind: "note", text: "Breath before the trio", x: 0.2, y: 0.7 }),
        mark({
          kind: "ink",
          points: [
            [0.1, 0.9],
            [0.4, 0.95],
            [0.6, 0.9],
          ],
        }),
      ],
      () => "signal",
      A4,
    );
    async function* pages() {
      yield { jpeg, ...jpegSize(jpeg), points: A4, overlay };
    }
    const chunks: Buffer[] = [];
    for await (const chunk of pdfOf(pages())) chunks.push(chunk);
    const path = join(dir, "marked.pdf");
    writeFileSync(path, Buffer.concat(chunks));
    const { stdout } = await run("pdftotext", ["-layout", path, "-"]);
    expect(stdout).toContain("3T4");
    expect(stdout).toContain("mp");
    expect(stdout).toContain("Breath before the trio");
  });
});
