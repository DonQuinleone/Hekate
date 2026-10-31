import {
  type CropWindow,
  decibels,
  formatClock,
  type LoudnessCurve,
  type LoudnessGauge,
  type QaDocument,
  type QaSeverity,
  type QaVerdictTone,
  qaSeverityNames,
  type ReportFinding,
  type RuleLine,
  scaleAt,
  type WatermarkSettings,
} from "@hekate/shared";
import { type PdfImage, textPdfOf } from "./media/pdf.ts";
import { type Face, showText, widthOf } from "./media/pdf-text.ts";
import { fitted } from "./patch-pdf.ts";

/**
 * The QA report as a PDF (#515, decision 293): A4, set by Hekate's own writer in Helvetica
 * (the one face every reader has, standing in for Schibsted Grotesk, which is variable and
 * would need instancing to embed) in the colours of Signal's light theme, the theme made for
 * paper, with the workspace's accent where it has one. A cover with the verdict, a summary,
 * the findings and the appendices, all from the one `QaDocument` the app's page shows. Every
 * page carries the brand at its head (the workspace's logo, or Hekate's mark and the
 * workspace's name), Hekate at its foot, and the mark of whoever it was made for.
 */

export const QA_REPORT_PAGE = { width: 595.28, height: 841.89 };
const H = QA_REPORT_PAGE.height;
const M = 48;
const W = QA_REPORT_PAGE.width - 2 * M;
/** Where a page's content starts, and the least room left above its foot, from the top. */
const TOP = 96;
const LAST = H - 74;

/** The light theme's tokens (apps/web/src/styles/themes.css), as paper takes them. */
export const PRINT = {
  ink: "#111113",
  ink2: "#45454c",
  ink3: "#5f5f67",
  /** The brand's ground, under a logo made for it. */
  ground: "#0a0a0b",
  hairline: "#dcdcd7",
  raised: "#f0f0ed",
  /** Signal's own colour in the light theme, where the workspace has no accent. */
  signal: "#b53c0a",
} as const;

export interface ReportLook {
  /** The accent as paper shows it: the workspace's light-theme cut, or the signal's. */
  accent: string;
  /**
   * The workspace's logo; without one, Hekate's mark and the workspace's name. A light one
   * (made for the dark sign-in page) is set on a plate of the brand's ground.
   */
  logo: (PdfImage & { light?: boolean }) | null;
  /** The recipient's mark (the visible watermark's words) and how the project draws it. */
  mark: { text: string; style: Pick<WatermarkSettings, "position" | "opacity"> };
  /** The link back to the file as a QR code's modules, true for dark. */
  qr: boolean[][] | null;
}

const n = (v: number) => String(Math.round(v * 100) / 100);
const rgb = (hex: string) =>
  [1, 3, 5].map((i) => n(Number.parseInt(hex.slice(i, i + 2), 16) / 255)).join(" ");
const fill = (hex: string) => `${rgb(hex)} rg`;
const stroke = (hex: string) => `${rgb(hex)} RG`;
/** A colour mixed towards white: `share` of the colour, the rest paper. */
export function tint(hex: string, share: number): string {
  const c = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  return `#${c
    .map((v) =>
      Math.round(255 - (255 - v) * share)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}
/** Words as Helvetica sets them: a minus sign, which WinAnsi lacks, as an en dash. */
const printable = (words: string) => words.replaceAll("−", "–");
const Y = (top: number) => H - top;

/** Words broken into lines no wider than `width` at a size, on spaces where they can be. */
export function wrapped(words: string, width: number, size: number, bold = false): string[] {
  const out: string[] = [];
  for (const paragraph of printable(words).split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const tried = line ? `${line} ${word}` : word;
      if (widthOf(tried, size, bold) <= width) line = tried;
      else {
        if (line) out.push(line);
        line = widthOf(word, size, bold) <= width ? word : fitted(word, width, size, bold);
      }
    }
    out.push(line);
  }
  return out;
}

/** A page under construction: its drawing, and the words set on it. */
interface Page {
  ops: string[];
  words: SetWords[];
  cover: boolean;
}

/** Words as they were set on a page, in points from its top left: for checking the layout. */
export interface SetWords {
  words: string;
  x: number;
  /** The baseline. */
  top: number;
  width: number;
  size: number;
}

/**
 * The pages' drawings, A4 portrait, for a QA report as `look` brands and marks it; with
 * `layout`, each page's words as set (the mark's aside) are added to it, a list a page.
 */
export function qaReportPages(doc: QaDocument, look: ReportLook, layout?: SetWords[][]): string[] {
  const pages: Page[] = [];
  let ops: string[] = [];
  let placed: SetWords[] = [];
  let y = TOP;
  const accent = look.accent;

  const text = (
    face: Face,
    size: number,
    x: number,
    top: number,
    said: string,
    colour: string = PRINT.ink,
  ) => {
    const set = printable(said);
    ops.push(showText(face, size, x, Y(top), set, fill(colour)));
    placed.push({ words: set, x, top, width: widthOf(set, size, face === "bold"), size });
  };
  const right = (face: Face, size: number, x: number, top: number, words: string, colour: string) =>
    text(face, size, x - widthOf(printable(words), size, face === "bold"), top, words, colour);
  const rule = (top: number, colour: string = PRINT.hairline, from = M, to = M + W, width = 0.5) =>
    ops.push(`${stroke(colour)} ${n(width)} w ${n(from)} ${n(Y(top))} m ${n(to)} ${n(Y(top))} l S`);
  const box = (x: number, top: number, w: number, h: number, colour: string) =>
    ops.push(`${fill(colour)} ${n(x)} ${n(Y(top + h))} ${n(w)} ${n(h)} re f`);
  /** A paragraph from `top`, its lines `leading` apart; where it ends. */
  const paragraph = (
    words: string,
    x: number,
    top: number,
    width: number,
    size: number,
    colour: string = PRINT.ink,
    face: Face = "regular",
    leading = size * 1.4,
  ) => {
    const lines = wrapped(words, width, size, face === "bold");
    lines.forEach((line, i) => {
      text(face, size, x, top + size + i * leading, line, colour);
    });
    return top + size + (lines.length - 1) * leading + size * 0.4;
  };
  const newPage = (cover = false) => {
    ops = [];
    placed = [];
    pages.push({ ops, words: placed, cover });
    y = TOP;
  };
  /** Room for something `height` tall, on a new page when this one has not. */
  const need = (height: number) => {
    if (y + height > LAST) newPage();
  };

  // The cover.
  newPage(true);
  coverPage();

  // The summary.
  newPage();
  heading("Summary");
  summary();

  // The findings, by severity then time.
  newPage();
  heading("Findings");
  findings();

  // The appendices.
  newPage();
  heading("Appendix");
  appendix();

  const total = pages.length;
  return pages.map((page, i) => {
    ops = [];
    watermark();
    const body = ops;
    ops = [];
    placed = page.words;
    if (!page.cover) pageHead();
    pageFoot(i + 1, total);
    layout?.push(page.words);
    return [...body, ...page.ops, ...ops].join("\n");
  });

  // Drawing, by part.

  function circle(cx: number, cy: number, r: number) {
    const k = 0.5523 * r;
    const yy = Y(cy);
    return [
      `${n(cx + r)} ${n(yy)} m`,
      `${n(cx + r)} ${n(yy + k)} ${n(cx + k)} ${n(yy + r)} ${n(cx)} ${n(yy + r)} c`,
      `${n(cx - k)} ${n(yy + r)} ${n(cx - r)} ${n(yy + k)} ${n(cx - r)} ${n(yy)} c`,
      `${n(cx - r)} ${n(yy - k)} ${n(cx - k)} ${n(yy - r)} ${n(cx)} ${n(yy - r)} c`,
      `${n(cx + k)} ${n(yy - r)} ${n(cx + r)} ${n(yy - k)} ${n(cx + r)} ${n(yy)} c`,
    ].join(" ");
  }

  /** A severity's mark, as the app draws it: by shape and fill, never a traffic light. */
  function dot(severity: QaSeverity | QaVerdictTone, cx: number, cy: number, r = 3.5) {
    if (severity === "fail") ops.push(`${fill(accent)} ${circle(cx, cy, r)} f`);
    else if (severity === "warn")
      ops.push(`${stroke(accent)} ${n(r * 0.36)} w ${circle(cx, cy, r * 0.82)} S`);
    else if (severity === "info" || severity === "pending")
      ops.push(`${stroke(PRINT.ink3)} ${n(r * 0.36)} w ${circle(cx, cy, r * 0.82)} S`);
    else ops.push(`${fill(PRINT.ink3)} ${circle(cx, cy, r * 0.7)} f`);
  }

  /** Hekate's mark, `size` tall, from its top left: two stems and the point (docs/brand.md). */
  function hekateMark(x: number, top: number, size: number, point: string = accent) {
    const u = size / 24;
    const stem = (sx: number) =>
      `${fill(PRINT.ink)} ${n(x + sx * u)} ${n(Y(top + 21 * u))} ${n(3.4 * u)} ${n(18 * u)} re f`;
    ops.push(
      stem(5.5),
      stem(15.1),
      `${fill(point)} ${circle(x + 12 * u, top + 11.82 * u, 2 * u)} f`,
    );
  }

  /** The workspace's logo, fitted within a box from its top left; its width drawn. */
  function logo(x: number, top: number, maxWidth: number, maxHeight: number): number {
    const image = look.logo;
    if (!image) return 0;
    // A light logo sits on the ground it was made for, inset as the sign-in page shows it.
    const pad = image.light ? maxHeight * 0.22 : 0;
    const scale = Math.min(
      (maxWidth - 2 * pad) / image.width,
      (maxHeight - 2 * pad) / image.height,
    );
    const w = image.width * scale;
    const h = image.height * scale;
    if (image.light) plate(x, top + (maxHeight - h) / 2 - pad, w + 2 * pad, h + 2 * pad, 4);
    ops.push(
      `q ${n(w)} 0 0 ${n(h)} ${n(x + pad)} ${n(Y(top + (maxHeight + h) / 2))} cm /Logo Do Q`,
    );
    return w + 2 * pad;
  }

  /** A rounded rectangle of the brand's ground, from its top left. */
  function plate(x: number, top: number, w: number, h: number, r: number) {
    const k = 0.5523 * r;
    const [l, t, rr, b] = [x, Y(top), x + w, Y(top + h)];
    ops.push(
      [
        fill(PRINT.ground),
        `${n(l + r)} ${n(t)} m ${n(rr - r)} ${n(t)} l`,
        `${n(rr - r + k)} ${n(t)} ${n(rr)} ${n(t - r + k)} ${n(rr)} ${n(t - r)} c`,
        `${n(rr)} ${n(b + r)} l ${n(rr)} ${n(b + r - k)} ${n(rr - r + k)} ${n(b)} ${n(rr - r)} ${n(b)} c`,
        `${n(l + r)} ${n(b)} l ${n(l + r - k)} ${n(b)} ${n(l)} ${n(b + r - k)} ${n(l)} ${n(b + r)} c`,
        `${n(l)} ${n(t - r)} l ${n(l)} ${n(t - r + k)} ${n(l + r - k)} ${n(t)} ${n(l + r)} ${n(t)} c f`,
      ].join(" "),
    );
  }

  /** The brand at the head of every page but the cover, and what the page belongs to. */
  function pageHead() {
    if (look.logo) logo(M, 28, 130, 24);
    else {
      hekateMark(M - 3, 30, 20);
      text("bold", 9.5, M + 22, 44, fitted(doc.workspace, W / 2 - 24, 9.5, true));
    }
    const what = doc.file.track ?? doc.file.name;
    right("regular", 8.5, M + W, 44, fitted(`QA report · ${what}`, W / 2, 8.5), PRINT.ink3);
    rule(60);
  }

  /** At the foot of every page: whose copy it is, Hekate, and the page's number. */
  function pageFoot(page: number, total: number) {
    rule(H - 54);
    const count = `Page ${page} of ${total}`;
    right("regular", 7.5, M + W, H - 38, count, PRINT.ink3);
    const made = "Made with Hekate";
    const madeAt = M + W - widthOf(count, 7.5) - 14 - widthOf(made, 7.5);
    text("regular", 7.5, madeAt, H - 38, made, PRINT.ink3);
    hekateMark(madeAt - 13, H - 46.5, 11, PRINT.ink3);
    const mine = `Prepared for ${look.mark.text.replace(/\n/g, " · ")}`;
    text("regular", 7.5, M, H - 38, fitted(printable(mine), madeAt - M - 22, 7.5), PRINT.ink3);
  }

  /**
   * The recipient's mark across the page, under everything else, as the project draws its
   * marks: in staggered rows, once across the middle, or once in the corner, at its opacity.
   */
  function watermark() {
    const words = printable(look.mark.text.replace(/\n/g, "  ·  "));
    const grey = "0.5 0.5 0.5 rg";
    const turned = (size: number, x: number, top: number) => {
      const r = (30 * Math.PI) / 180;
      const c = n(Math.cos(r));
      const s = n(Math.sin(r));
      ops.push(
        `q /Mark gs ${c} ${s} ${n(-Math.sin(r))} ${c} ${n(x)} ${n(Y(top))} cm ${showText("regular", size, 0, 0, words, grey)} Q`,
      );
    };
    if (look.mark.style.position === "corner") {
      const lines = look.mark.text.split("\n").map(printable);
      lines.forEach((line, i) => {
        ops.push(
          `q /Mark gs ${showText("regular", 8, M + W - widthOf(line, 8), Y(H - 66 + i * 10), line, grey)} Q`,
        );
      });
    } else if (look.mark.style.position === "centre") turned(18, M + 20, H / 2 + 150);
    else
      for (let i = 0, top = 200; top < H + 260; i++, top += 160) turned(14, i % 2 ? 60 : -40, top);
  }

  function heading(title: string) {
    text("bold", 20, M, y + 20, title);
    y += 40;
  }

  function subheading(title: string, aside?: string) {
    need(40);
    text("bold", 11, M, y + 11, title);
    if (aside) right("regular", 9, M + W, y + 11, aside, PRINT.ink3);
    y += 18;
    rule(y);
    y += 12;
  }

  function coverPage() {
    // The brand, large.
    if (look.logo) logo(M, 56, 180, 44);
    else {
      hekateMark(M - 5, 58, 44);
      text("bold", 15, M + 46, 86, fitted(doc.workspace, W - 50, 15, true));
    }
    // What it is about.
    let top = 236;
    text("bold", 10, M, top, "QA report", accent);
    top += 14;
    const title = doc.file.track ?? doc.file.name.replace(/\.[^.]+$/, "");
    const lines = wrapped(title, W, 34, true).slice(0, 2);
    lines.forEach((line, i) => {
      text("bold", 34, M, top + 34 + i * 40, line);
    });
    top += 34 + (lines.length - 1) * 40 + 14;
    const version = [
      doc.file.version !== null ? `Version ${doc.file.version}` : null,
      doc.file.variant,
    ]
      .filter(Boolean)
      .join(" · ");
    if (version) {
      text("regular", 15, M, top + 15, version, PRINT.ink2);
      top += 24;
    }
    text("regular", 9.5, M, top + 10, fitted(doc.file.name, W, 9.5), PRINT.ink3);
    top += 54;

    // The verdict, in one line.
    // Balanced: a last word alone on its line pulls the lines in until it has company.
    let words = wrapped(doc.verdict.words, W - 34, 17, true);
    for (
      let narrower = 0.9;
      narrower > 0.6 && words.length > 1 && !words.at(-1)?.includes(" ");
      narrower -= 0.1
    )
      words = wrapped(doc.verdict.words, (W - 34) * narrower, 17, true);
    const height = 24 + words.length * 22;
    box(M, top, 3, height, doc.verdict.tone === "pass" ? PRINT.ink3 : accent);
    dot(doc.verdict.tone, M + 20, top + 20.5, 5);
    words.forEach((line, i) => {
      text("bold", 17, M + 32, top + 26 + i * 22, line);
    });
    text("regular", 9.5, M + 32, top + height + 4, `Measured against ${doc.profile}`, PRINT.ink2);

    // Who, where and when.
    const facts: [string, string][] = [
      ["Project", doc.project],
      ["Workspace", doc.workspace],
      [
        "Prepared by",
        `${doc.preparedBy.name}${doc.preparedBy.role ? `, ${doc.preparedBy.role}` : ""}`,
      ],
      ["Prepared", doc.preparedOn],
      ["Measured", doc.measuredOn ?? "Not yet"],
    ];
    const column = W / 3;
    facts.forEach(([label, value], i) => {
      const x = M + (i % 3) * column;
      const at = 640 + Math.floor(i / 3) * 56;
      rule(at, PRINT.hairline, x, x + column - 16);
      text("regular", 8, x, at + 16, label, PRINT.ink3);
      text("regular", 10.5, x, at + 32, fitted(printable(value), column - 16, 10.5));
    });
  }

  function summary() {
    const s = doc.summary;
    // Loudness against the profile.
    subheading("Loudness", `Against ${doc.profile}`);
    if (s.integrated !== null) {
      const big = decibels(s.integrated);
      text("bold", 30, M, y + 28, big);
      text(
        "regular",
        10,
        M + widthOf(printable(big), 30, true) + 6,
        y + 28,
        "LUFS integrated",
        PRINT.ink2,
      );
      const off = s.gauge?.target != null ? s.integrated - s.gauge.target : null;
      if (off !== null && s.gauge?.target != null)
        right(
          "regular",
          10,
          M + W,
          y + 28,
          Math.abs(off) <= (s.gauge.tolerance ?? 0)
            ? `On the ${decibels(s.gauge.target, 0)} LUFS target`
            : `${decibels(Math.abs(off))} LU ${off > 0 ? "above" : "below"} the ${decibels(s.gauge.target, 0)} LUFS target`,
          PRINT.ink2,
        );
      y += 44;
    } else {
      text("regular", 11, M, y + 14, "Integrated loudness was not measured.", PRINT.ink2);
      y += 26;
    }
    if (s.gauge) {
      gauge(s.gauge, y);
      y += 62;
    }
    // True peak, range and the loudest moment, side by side.
    const stats: [string, string, string, QaSeverity | null][] = [
      [
        "True peak",
        s.truePeak === null ? "Not measured" : `${decibels(s.truePeak)} dBTP`,
        `Ceiling ${decibels(s.ceiling)} dBTP${s.truePeak !== null ? (s.truePeak > s.ceiling ? ", over it" : ", within it") : ""}`,
        s.truePeak === null ? null : s.truePeak > s.ceiling ? "fail" : "pass",
      ],
      [
        "Loudness range",
        s.range === null ? "Not measured" : `${decibels(s.range)} LU`,
        "LRA, EBU Tech 3342",
        null,
      ],
      [
        "Short-term max",
        s.shortTermMax === null ? "Not measured" : `${decibels(s.shortTermMax)} LUFS`,
        "Over 3 seconds",
        null,
      ],
    ];
    need(70);
    const column = W / 3;
    stats.forEach(([label, value, caption, severity], i) => {
      const x = M + i * column + (i > 0 ? 14 : 0);
      if (i > 0)
        ops.push(
          `${stroke(PRINT.hairline)} 0.5 w ${n(M + i * column)} ${n(Y(y))} m ${n(M + i * column)} ${n(Y(y + 58))} l S`,
        );
      text("regular", 8.5, x, y + 10, label, PRINT.ink3);
      text("bold", 16, x, y + 32, value);
      if (severity) dot(severity, x + 3, y + 46.5, 3);
      text(
        "regular",
        8.5,
        x + (severity ? 11 : 0),
        y + 49,
        fitted(caption, column - 30, 8.5),
        PRINT.ink2,
      );
    });
    y += 82;

    // How many findings of each severity.
    subheading("Findings");
    const order: QaSeverity[] = ["fail", "warn", "info", "pass"];
    const quarter = W / 4;
    order.forEach((severity, i) => {
      const x = M + i * quarter;
      dot(severity, x + 4, y + 14, 4);
      text("bold", 20, x + 14, y + 21, String(s.counts[severity]));
      text("regular", 8.5, x + 14, y + 36, qaSeverityNames[severity], PRINT.ink2);
    });
    y += 58;

    // The format and what the file says about itself.
    const half = (W - 24) / 2;
    const start = y;
    subheadingAt("Format", M, half);
    let left = y;
    left = table(s.format.length > 0 ? s.format : [["Format", "Not read"]], M, left, half, 8);
    y = start;
    subheadingAt("Metadata", M + half + 24, half);
    const shown = s.metadata.slice(0, 9);
    let rightEnd = table(
      shown.length > 0 ? shown : [["Metadata", "None read"]],
      M + half + 24,
      y,
      half,
      9,
    );
    if (s.metadata.length > shown.length) {
      text("regular", 8, M + half + 24, rightEnd + 10, "The rest is in the appendix.", PRINT.ink3);
      rightEnd += 14;
    }
    y = Math.max(left, rightEnd) + 10;
  }

  function subheadingAt(title: string, x: number, width: number) {
    text("bold", 11, x, y + 11, title);
    y += 18;
    rule(y, PRINT.hairline, x, x + width);
    y += 4;
  }

  /** Rows of a label and its value, the value wrapped; where the table ends. */
  function table(rows: [string, string][], x: number, top: number, width: number, maxRows: number) {
    let at = top;
    const labelWidth = Math.min(110, width * 0.4);
    for (const [label, value] of rows.slice(0, maxRows)) {
      const lines = wrapped(value, width - labelWidth - 8, 9).slice(0, 3);
      const height = 8 + lines.length * 12.5;
      text("regular", 8.5, x, at + 14, fitted(label, labelWidth - 6, 8.5), PRINT.ink3);
      lines.forEach((line, i) => {
        text("regular", 9, x + labelWidth, at + 14 + i * 12.5, line);
      });
      at += height;
      rule(at, PRINT.hairline, x, x + width);
    }
    return at;
  }

  /** Integrated loudness on its scale: the target's band, the value's needle, the numbers. */
  function gauge(g: LoudnessGauge, top: number) {
    const at = (v: number) => M + scaleAt(g, v) * W;
    const trackTop = top + 18;
    const height = 12;
    box(M, trackTop, W, height, PRINT.raised);
    for (const zone of g.zones) {
      if (zone.to <= zone.from) continue;
      box(
        at(zone.from),
        trackTop,
        at(zone.to) - at(zone.from),
        height,
        zone.tone === "pass" ? tint(accent, 0.28) : tint(accent, 0.12),
      );
    }
    for (const t of g.ticks) {
      const x = at(t);
      ops.push(
        `${stroke(PRINT.ink3)} 0.5 w ${n(x)} ${n(Y(trackTop + height))} m ${n(x)} ${n(Y(trackTop + height + 4))} l S`,
      );
      const label = decibels(t, 0);
      const isTarget = g.target !== null && t === g.target;
      text(
        isTarget ? "bold" : "regular",
        7.5,
        x - widthOf(printable(label), 7.5, isTarget) / 2,
        trackTop + height + 14,
        label,
        isTarget ? accent : PRINT.ink3,
      );
    }
    if (g.target !== null) {
      const x = at(g.target);
      ops.push(
        `${stroke(accent)} 1 w ${n(x)} ${n(Y(trackTop - 3))} m ${n(x)} ${n(Y(trackTop + height + 3))} l S`,
      );
    }
    if (g.value !== null) {
      const x = at(g.value);
      ops.push(
        `${stroke(PRINT.ink)} 1.6 w ${n(x)} ${n(Y(trackTop - 1))} m ${n(x)} ${n(Y(trackTop + height + 1))} l S`,
        `${fill(PRINT.ink)} ${n(x - 4.5)} ${n(Y(trackTop - 9))} m ${n(x + 4.5)} ${n(Y(trackTop - 9))} l ${n(x)} ${n(Y(trackTop - 2))} l f`,
      );
      const label = `${decibels(g.value)} LUFS`;
      const w = widthOf(printable(label), 8, true);
      const lx = Math.min(M + W - w, Math.max(M, x - w / 2));
      text("bold", 8, lx, trackTop - 12, label);
    }
  }

  /** A crop of the waveform with the finding's stretch marked in the accent. */
  function crop(
    c: CropWindow & { envelope: [number, number][] | null },
    x: number,
    top: number,
    width: number,
    height: number,
  ) {
    const span = c.to - c.from || 1;
    const at = (t: number) => x + ((t - c.from) / span) * width;
    box(x, top, width, height, tint(PRINT.raised, 0.6));
    const markX = at(c.markFrom);
    const markW = Math.max(1.2, at(c.markTo) - markX);
    box(markX, top, markW, height, tint(accent, 0.16));
    const mid = top + height / 2;
    const envelope = c.envelope;
    if (envelope && envelope.length > 0) {
      const step = width / envelope.length;
      const inside: string[] = [];
      const outside: string[] = [];
      envelope.forEach(([low, high], i) => {
        const cx = x + (i + 0.5) * step;
        const t = c.from + ((i + 0.5) / envelope.length) * span;
        const a = mid - high * (height / 2 - 2);
        const b = mid - low * (height / 2 - 2);
        const seg = `${n(cx)} ${n(Y(a))} m ${n(cx)} ${n(Y(Math.max(b, a + 0.4)))} l`;
        (t >= c.markFrom && t <= c.markTo ? inside : outside).push(seg);
      });
      const w = n(Math.max(0.5, step * 0.7));
      if (outside.length) ops.push(`${stroke(PRINT.ink3)} ${w} w ${outside.join(" ")} S`);
      if (inside.length) ops.push(`${stroke(accent)} ${w} w ${inside.join(" ")} S`);
    } else {
      rule(mid, PRINT.hairline, x, x + width);
      text("regular", 7.5, x + 6, mid - 4, "No waveform for this file yet.", PRINT.ink3);
    }
    ops.push(
      `${stroke(accent)} 0.75 w ${n(markX)} ${n(Y(top))} m ${n(markX)} ${n(Y(top + height))} l S`,
      `${stroke(accent)} 0.75 w ${n(markX + markW)} ${n(Y(top))} m ${n(markX + markW)} ${n(Y(top + height))} l S`,
    );
    text("regular", 7, x, top + height + 9, formatClock(c.from), PRINT.ink3);
    right("regular", 7, x + width, top + height + 9, formatClock(c.to), PRINT.ink3);
  }

  function findings() {
    if (doc.status !== "ready") {
      paragraph(doc.verdict.words, M, y, W, 11, PRINT.ink2);
      return;
    }
    if (doc.groups.length === 0) {
      paragraph("Nothing to report: every check passes.", M, y, W, 11, PRINT.ink2);
      y += 30;
    }
    for (const group of doc.groups) {
      need(120);
      dot(group.severity, M + 4, y + 7, 4.5);
      text("bold", 12, M + 15, y + 11, group.label);
      right("regular", 9, M + W, y + 11, `${group.findings.length}`, PRINT.ink3);
      y += 18;
      rule(y, PRINT.ink3);
      y += 4;
      for (const f of group.findings) finding(f);
      y += 18;
    }
  }

  function finding(f: ReportFinding) {
    const gutter = 118;
    const x = M + gutter;
    const width = W - gutter;
    if (!f.illustrated) {
      const heard = wrapped(f.heard, width, 9);
      need(10 + heard.length * 12.5);
      text("regular", 8.5, M, y + 13, fitted(f.at, gutter - 10, 8.5), PRINT.ink2);
      heard.forEach((line, i) => {
        text("regular", 9, x, y + 13 + i * 12.5, line, PRINT.ink2);
      });
      y += 8 + heard.length * 12.5;
      rule(y);
      return;
    }
    const heard = wrapped(f.heard, width, 9.5);
    const advice = wrapped(f.advice, width, 9);
    const cropHeight = f.crop ? 72 : 0;
    const height = 16 + 14 + heard.length * 13 + cropHeight + 16 + advice.length * 12.5 + 12;
    need(height);
    const top = y;
    // Where: the moment or stretch, and the channel.
    text("bold", 9, M, top + 16, fitted(f.at, gutter - 10, 9, true));
    if (f.channel) text("regular", 8.5, M, top + 29, f.channel, PRINT.ink3);
    // What, what was heard, the crop, and what to do.
    text("bold", 10.5, x, top + 16, fitted(f.name, width, 10.5, true));
    let at = top + 22;
    heard.forEach((line, i) => {
      text("regular", 9.5, x, at + 10 + i * 13, line, PRINT.ink2);
    });
    at += 14 + heard.length * 13 - 4;
    if (f.crop) {
      crop(f.crop, x, at + 4, width, 46);
      at += cropHeight;
    }
    text("bold", 8, x, at + 10, "What to do", PRINT.ink3);
    advice.forEach((line, i) => {
      text("regular", 9, x, at + 23 + i * 12.5, line);
    });
    at += 23 + (advice.length - 1) * 12.5 + 12;
    y = at;
    rule(y);
  }

  function appendix() {
    subheading("A. Loudness over the whole file", "Short-term, LUFS");
    if (doc.appendix.curve) {
      need(200);
      curve(doc.appendix.curve, y);
      y += 200;
    } else {
      text("regular", 9.5, M, y + 10, "Not measured.", PRINT.ink2);
      y += 24;
    }

    y += 10;
    subheading("B. Format and metadata");
    const rows =
      doc.appendix.format.length > 0
        ? doc.appendix.format
        : ([["Format", "Not read"]] as [string, string][]);
    for (const row of rows) {
      const lines = wrapped(row[1], W - 150, 9);
      need(8 + lines.length * 12.5);
      y = table([row], M, y, W, 1);
    }

    y += 22;
    subheading("C. Rules checked");
    const sources: [RuleLine["source"], string][] = [
      ["profile", `Delivery profile: ${doc.profile}`],
      ["signal", "Signal checks"],
      ["project", "The project's own rules"],
    ];
    for (const [source, title] of sources) {
      const lines = doc.appendix.rules.filter((r) => r.source === source);
      if (lines.length === 0) continue;
      need(40);
      text("bold", 9, M, y + 12, title, PRINT.ink2);
      y += 18;
      for (const line of lines) ruleRow(line);
      y += 10;
    }

    y += 12;
    need(140);
    subheading("D. The file in Hekate");
    const size = 96;
    if (look.qr) qr(look.qr, M, y + 4, size);
    const x = look.qr ? M + size + 20 : M;
    const end = paragraph(
      "Open the file to listen at each finding, compare versions and reply to the team. The link opens for those who may see the project.",
      x,
      y + 4,
      W - (x - M),
      9.5,
      PRINT.ink2,
    );
    wrapped(doc.appendix.link, W - (x - M), 9).forEach((line, i) => {
      text("regular", 9, x, end + 16 + i * 12, line, accent);
    });
    y += size + 12;
  }

  function ruleRow(line: RuleLine) {
    const asked = wrapped(line.asked, W - 300, 9);
    const height = 8 + asked.length * 12.5;
    need(height);
    text("regular", 9, M, y + 14, fitted(line.label, 170, 9));
    asked.forEach((part, i) => {
      text("regular", 9, M + 180, y + 14 + i * 12.5, part, PRINT.ink2);
    });
    const result = line.result ? qaSeverityNames[line.result] : "Not measured";
    if (line.result) dot(line.result, M + W - 104, y + 11, 3);
    text("regular", 9, M + W - 96, y + 14, result, line.result ? PRINT.ink : PRINT.ink3);
    y += height;
    rule(y);
  }

  function curve(c: LoudnessCurve, top: number) {
    const left = M + 30;
    const width = W - 30;
    const height = 160;
    const at = (v: number) => top + (1 - scaleAt(c, v)) * height;
    if (c.target !== null && c.tolerance !== null)
      box(
        left,
        at(c.target + c.tolerance),
        width,
        at(c.target - c.tolerance) - at(c.target + c.tolerance),
        tint(accent, 0.16),
      );
    for (const t of c.ticks) {
      rule(at(t), PRINT.hairline, left, left + width);
      right("regular", 7, left - 6, at(t) + 2.5, decibels(t, 0), PRINT.ink3);
    }
    if (c.target !== null)
      ops.push(
        `${stroke(accent)} 0.8 w [3 2] 0 d ${n(left)} ${n(Y(at(c.target)))} m ${n(left + width)} ${n(Y(at(c.target)))} l S [] 0 d`,
      );
    const step = width / Math.max(1, c.points.length);
    let path = "";
    let open = false;
    c.points.forEach((v, i) => {
      if (v === null) {
        open = false;
        return;
      }
      const px = left + (i + 0.5) * step;
      const py = Y(at(Math.max(c.min, Math.min(c.max, v))));
      path += `${n(px)} ${n(py)} ${open ? "l" : "m"} `;
      open = true;
    });
    if (path) ops.push(`${stroke(PRINT.ink)} 1 w 1 j ${path}S`);
    // Time along the foot, at a round step.
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
    const every = steps.find((s) => c.duration / s <= 8) ?? 3600;
    for (let t = 0; t <= c.duration + 0.001; t += every) {
      const x = left + (t / (c.duration || 1)) * width;
      const label = formatClock(t).replace(/\.\d+$/, "");
      const w = widthOf(label, 7);
      text(
        "regular",
        7,
        Math.min(left + width - w, Math.max(left, x - w / 2)),
        top + height + 14,
        label,
        PRINT.ink3,
      );
    }
    if (c.target !== null)
      text(
        "regular",
        7.5,
        left + 4,
        at(c.target) - 4,
        `Target ${decibels(c.target, 0)} LUFS`,
        accent,
      );
  }

  function qr(modules: boolean[][], x: number, top: number, size: number) {
    const count = modules.length;
    // A quiet zone of a module's width all round is the paper the page already is.
    const unit = size / count;
    const rects: string[] = [];
    modules.forEach((row, r) => {
      row.forEach((dark, col) => {
        if (dark)
          rects.push(
            `${n(x + col * unit)} ${n(Y(top + (r + 1) * unit))} ${n(unit + 0.05)} ${n(unit + 0.05)} re`,
          );
      });
    });
    ops.push(`${fill(PRINT.ink)} ${rects.join(" ")} f`);
  }
}

/** The report's bytes as a PDF. */
export function qaReportPdf(doc: QaDocument, look: ReportLook): Buffer {
  return textPdfOf(
    qaReportPages(doc, look).map((content) => ({ points: QA_REPORT_PAGE, content })),
    {
      images: look.logo ? { Logo: look.logo } : {},
      opacities: { Mark: Math.min(0.8, Math.max(0.1, look.mark.style.opacity / 100)) },
    },
  );
}
