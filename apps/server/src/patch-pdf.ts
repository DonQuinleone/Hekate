import type { PatchRow, StageBox } from "@hekate/shared";
import { pdfString, widthOf } from "./media/helvetica.ts";

/**
 * The patch list as an engineer prints it (#54): A4, each stage box's inputs then outputs as a
 * table (channel, source, device, cable, notes), carried over pages as needed, and each page
 * saying what it is and its number.
 */

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 40;
const ROW = 15;
const SIZE = 9;
const COLUMNS: { key: keyof PatchRow; title: string; width: number }[] = [
  { key: "channel", title: "Ch", width: 30 },
  { key: "source", title: "Source", width: 140 },
  { key: "device", title: "Device", width: 120 },
  { key: "cable", title: "Cable", width: 60 },
  { key: "notes", title: "Notes", width: A4.width - 2 * MARGIN - 350 },
];

const num = (n: number) => String(Math.round(n * 100) / 100);
const text = (font: "H" | "HB", size: number, x: number, y: number, words: string, grey = 0) =>
  `BT /${font} ${num(size)} Tf ${grey} g ${num(x)} ${num(y)} Td ${pdfString(words)} Tj ET`;

/** Words cut to a width, ending in an ellipsis where they were cut. */
export function fitted(words: string, width: number, size = SIZE, bold = false): string {
  if (widthOf(words, size, bold) <= width) return words;
  const chars = [...words];
  while (chars.length > 0 && widthOf(`${chars.join("")}…`, size, bold) > width) chars.pop();
  const cut = chars.join("").trimEnd();
  return cut ? `${cut}…` : "";
}

/** The pages' drawings, A4 portrait, for a project's patch list. */
export function patchListPages(project: string, boxes: StageBox[]): string[] {
  const pages: string[][] = [];
  let ops: string[] = [];
  let y = 0;
  const top = A4.height - MARGIN - 34;
  const newPage = () => {
    ops = [];
    pages.push(ops);
    y = top;
  };
  const need = (height: number) => {
    if (y - height < MARGIN + 20) newPage();
  };
  const rule = (at: number, grey: number) =>
    ops.push(`${grey} G 0.5 w ${MARGIN} ${num(at)} m ${num(A4.width - MARGIN)} ${num(at)} l S`);
  const header = (title: string) => {
    let x = MARGIN;
    for (const c of COLUMNS) {
      ops.push(text("HB", SIZE, x + 2, y - 11, c.key === "channel" ? title : c.title));
      x += c.width;
    }
    y -= ROW;
    rule(y, 0.2);
  };
  newPage();
  if (boxes.length === 0) ops.push(text("H", 11, MARGIN, y, "No stage boxes yet.", 0.4));
  for (const box of boxes) {
    need(28 + ROW * 3);
    ops.push(text("HB", 13, MARGIN, y - 14, fitted(box.name, A4.width - 2 * MARGIN, 13, true)));
    y -= 26;
    for (const [rows, label] of [
      [box.inputs, "In"],
      [box.outputs, "Out"],
    ] as const) {
      need(ROW * 3);
      header(label);
      if (rows.length === 0) {
        ops.push(text("H", SIZE, MARGIN + 2, y - 11, "Nothing patched.", 0.45));
        y -= ROW;
      }
      for (const row of rows) {
        if (y - ROW < MARGIN + 20) {
          newPage();
          header(`${label} (cont.)`);
        }
        let x = MARGIN;
        for (const c of COLUMNS) {
          const value = String(row[c.key] ?? "");
          ops.push(
            text(
              "H",
              SIZE,
              x + 2,
              y - 11,
              fitted(value, c.width - 6),
              c.key === "notes" ? 0.35 : 0,
            ),
          );
          x += c.width;
        }
        y -= ROW;
        rule(y, 0.85);
      }
      y -= 12;
    }
    y -= 8;
  }
  return pages.map((page, i) =>
    [
      text(
        "HB",
        15,
        MARGIN,
        A4.height - MARGIN - 12,
        fitted(`${project} · Patch list`, A4.width - 2 * MARGIN - 80, 15, true),
      ),
      text(
        "H",
        8,
        A4.width - MARGIN - widthOf(`Page ${i + 1} of ${pages.length}`, 8),
        MARGIN - 4,
        `Page ${i + 1} of ${pages.length}`,
        0.45,
      ),
      ...page,
    ].join("\n"),
  );
}

export const PATCH_PAGE = A4;
