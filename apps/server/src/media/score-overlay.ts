import type { DrawingColour, ScoreMark } from "@hekate/shared";
import { showText, widthOf } from "./pdf-text.ts";

/**
 * The score marks drawn over a page of the score (#52), for the annotated score PDF: PDF
 * drawing operators in the page's points, in vectors and the standard Helvetica, so they print
 * sharp whatever the page's resolution. Each kind is drawn as the score marking page shows it:
 * issues and regions in their category's colour, edit points as filled pills, ink as its stroke.
 */

export type OverlayMark = Pick<
  ScoreMark,
  | "kind"
  | "x"
  | "y"
  | "width"
  | "height"
  | "points"
  | "text"
  | "categoryId"
  | "fixedBy"
  | "resolved"
  | "from"
  | "to"
>;

type Rgb = readonly [number, number, number];

/**
 * The drawing colours as they print: the screen's are made for a dark room, so on white paper
 * blue and green are taken darker, and paper (light on screen) prints as graphite.
 */
const PRINT: Record<DrawingColour, Rgb> = {
  signal: [0.94, 0.46, 0.18],
  paper: [0.33, 0.33, 0.33],
  blue: [0.18, 0.44, 0.84],
  green: [0.18, 0.55, 0.37],
};
const WHITE: Rgb = [1, 1, 1];
const INK: Rgb = [0.1, 0.1, 0.1];
const NOTE: Rgb = [0.98, 0.95, 0.8];

/** A resolved issue is drawn paler, as the page shows it at lower opacity. */
const paler = ([r, g, b]: Rgb): Rgb => [r / 2 + 0.5, g / 2 + 0.5, b / 2 + 0.5];

const num = (n: number) => String(Math.round(n * 100) / 100);
const fill = (c: Rgb) => `${c.map(num).join(" ")} rg`;
const stroke = (c: Rgb) => `${c.map(num).join(" ")} RG`;

/** A circle of radius r about (x, y), in four curves. */
function circle(x: number, y: number, r: number): string {
  const k = 0.5523 * r;
  return [
    `${num(x + r)} ${num(y)} m`,
    `${num(x + r)} ${num(y + k)} ${num(x + k)} ${num(y + r)} ${num(x)} ${num(y + r)} c`,
    `${num(x - k)} ${num(y + r)} ${num(x - r)} ${num(y + k)} ${num(x - r)} ${num(y)} c`,
    `${num(x - r)} ${num(y - k)} ${num(x - k)} ${num(y - r)} ${num(x)} ${num(y - r)} c`,
    `${num(x + k)} ${num(y - r)} ${num(x + r)} ${num(y - k)} ${num(x + r)} ${num(y)} c`,
  ].join(" ");
}

/** A pill w wide and 2r high, centred on (x, y). */
function pill(x: number, y: number, w: number, r: number): string {
  if (w <= 2 * r) return circle(x, y, r);
  const k = 0.5523 * r;
  const l = x - w / 2 + r;
  const g = x + w / 2 - r;
  return [
    `${num(l)} ${num(y - r)} m`,
    `${num(g)} ${num(y - r)} l`,
    `${num(g + k)} ${num(y - r)} ${num(g + r)} ${num(y - k)} ${num(g + r)} ${num(y)} c`,
    `${num(g + r)} ${num(y + k)} ${num(g + k)} ${num(y + r)} ${num(g)} ${num(y + r)} c`,
    `${num(l)} ${num(y + r)} l`,
    `${num(l - k)} ${num(y + r)} ${num(l - r)} ${num(y + k)} ${num(l - r)} ${num(y)} c`,
    `${num(l - r)} ${num(y - k)} ${num(l - k)} ${num(y - r)} ${num(l)} ${num(y - r)} c h`,
  ].join(" ");
}

const text = (font: "H" | "HO", size: number, x: number, y: number, words: string, c: Rgb) =>
  showText(font === "HO" ? "oblique" : "regular", size, x, y, words, fill(c));

/** A pill's label, as the score marking page puts it on the mark. */
function labelOf(m: OverlayMark): string {
  if (m.kind === "edit") return m.from == null ? `T${m.to}` : `${m.from}T${m.to}`;
  if (m.kind === "take-start") return `[ T${m.to}`;
  if (m.kind === "take-end") return `T${m.to} ]`;
  if (m.kind === "punch-in") return `P T${m.to}`;
  return "!";
}

/** Words split into lines of at most `width` characters, at most `lines` of them. */
export function wrap(words: string, width: number, lines: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of words.split(/\s+/).filter(Boolean)) {
    const piece = word.length > width ? `${word.slice(0, width - 1)}…` : word;
    if (line && line.length + 1 + piece.length > width) {
      out.push(line);
      line = piece;
    } else line = line ? `${line} ${piece}` : piece;
  }
  if (line) out.push(line);
  if (out.length <= lines) return out;
  const kept = out.slice(0, lines);
  const last = kept[lines - 1] ?? "";
  kept[lines - 1] = `${last.length >= width ? last.slice(0, width - 1) : last}…`;
  return kept;
}

/**
 * The drawing for one page's marks, on a page `points` in size; nothing for a page without
 * marks. `colourOf` gives an issue's category colour.
 */
export function scoreOverlay(
  marks: OverlayMark[],
  colourOf: (categoryId: string | null) => DrawingColour,
  points: { width: number; height: number },
): string {
  if (marks.length === 0) return "";
  const { width: W, height: H } = points;
  // Sized to the page, so a mark looks the same on an A4 part and an A3 full score.
  const size = Math.min(W, H) * 0.016;
  const r = size * 0.95;
  const line = Math.max(0.75, size * 0.14);
  const px = (x: number) => x * W;
  const py = (y: number) => H * (1 - y);
  const colour = (m: OverlayMark) => {
    const c = PRINT[m.kind === "issue" ? colourOf(m.categoryId) : "signal"];
    return m.kind === "issue" && m.resolved ? paler(c) : c;
  };
  const ops: string[] = ["q 1 J 1 j"];

  // Regions first, then strokes, so the pills and notes sit on top of both.
  for (const m of marks) {
    if (m.width == null || m.height == null) continue;
    ops.push(
      `${stroke(colour(m))} ${num(line * 1.4)} w`,
      `${num(px(m.x))} ${num(py(m.y + m.height))} ${num(m.width * W)} ${num(m.height * H)} re S`,
    );
  }
  for (const m of marks) {
    if (m.kind !== "ink" || !m.points || m.points.length < 2) continue;
    const [first, ...rest] = m.points;
    ops.push(
      `${stroke(PRINT.signal)} ${num(line * 1.4)} w`,
      [
        `${num(px(first?.[0] ?? 0))} ${num(py(first?.[1] ?? 0))} m`,
        ...rest.map(([x, y]) => `${num(px(x))} ${num(py(y))} l`),
        "S",
      ].join(" "),
    );
  }
  for (const m of marks) {
    const x = px(m.x);
    const y = py(m.y);
    const c = colour(m);
    if (m.kind === "ink") continue;
    if (m.kind === "wrong-note") {
      const d = r * 0.8;
      ops.push(
        `${stroke(c)} ${num(line * 1.6)} w`,
        `${num(x - d)} ${num(y - d)} m ${num(x + d)} ${num(y + d)} l`,
        `${num(x - d)} ${num(y + d)} m ${num(x + d)} ${num(y - d)} l S`,
      );
      continue;
    }
    if (m.kind === "dynamic") {
      // A circled dynamic: the marking, in italics, ringed.
      // A long one ("cresc.") is ringed by an oval rather than a large circle.
      const words = m.text ?? "";
      const w = widthOf(words, size * 1.1);
      ops.push(
        `${stroke(c)} ${num(line)} w ${pill(x, y, w + size * 1.2, r * 1.15)} S`,
        text("HO", size * 1.1, x - w / 2, y - size * 0.38, words, INK),
      );
      continue;
    }
    if (m.kind === "note") {
      // A sticky note hangs from its point, kept on the page.
      const fs = size * 0.85;
      const lines = wrap(m.text ?? "", 28, 6);
      const boxW = Math.max(...lines.map((l) => widthOf(l, fs)), fs * 4) + fs * 0.9;
      const boxH = fs * 1.3 * lines.length + fs * 0.9;
      const left = Math.min(Math.max(x, 2), W - boxW - 2);
      const top = Math.min(Math.max(y, boxH + 2), H - 2);
      ops.push(
        `${fill(NOTE)} ${stroke([0.6, 0.55, 0.4])} ${num(line * 0.7)} w`,
        `${num(left)} ${num(top - boxH)} ${num(boxW)} ${num(boxH)} re B`,
        ...lines.map((l, i) =>
          text("H", fs, left + fs * 0.45, top - fs * 0.45 - fs * 1.3 * (i + 1) + fs * 0.3, l, INK),
        ),
      );
      continue;
    }
    // A pill: edits filled in the signal colour, the rest white with a coloured edge.
    const label = labelOf(m);
    const filled = m.kind === "edit";
    const w = Math.max(2 * r, widthOf(label, size) + size * 0.9);
    ops.push(
      `${fill(filled ? PRINT.signal : WHITE)} ${stroke(c)} ${num(line * 1.4)} w ${pill(x, y, w, r)} B`,
      text("H", size, x - widthOf(label, size) / 2, y - size * 0.36, label, filled ? WHITE : INK),
    );
    if (m.kind === "issue" && (m.text || m.fixedBy != null)) {
      // What went wrong, and which take fixed it, beside the mark.
      const said = [m.text, m.fixedBy != null ? `fixed in T${m.fixedBy}` : null]
        .filter(Boolean)
        .join(", ");
      const words = said.length > 60 ? `${said.slice(0, 59)}…` : said;
      const fs = size * 0.85;
      const long = widthOf(words, fs);
      const gap = w / 2 + size * 0.35;
      // Right of the mark, or left of it where the page ends first; never off the page.
      const left = Math.max(2, x + gap + long <= W - 2 ? x + gap : x - gap - long);
      // On white, so neither a staff nor the region's edge runs through the words.
      ops.push(
        `${fill(WHITE)} ${num(left - fs * 0.2)} ${num(y - fs * 0.65)} ${num(long + fs * 0.4)} ${num(fs * 1.3)} re f`,
        text("H", fs, left, y - size * 0.3, words, c),
      );
    }
  }
  ops.push("Q");
  return ops.join("\n");
}
