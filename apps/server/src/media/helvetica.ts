/**
 * The standard Helvetica the PDF writers set text in (score overlays, the patch list): its
 * advance widths, from Adobe's metrics, and the text as WinAnsi can hold it.
 */

const ASCII = 32;
/** Advance widths of the ASCII characters from the space to the tilde, in thousandths. */
const REGULAR = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667,
  611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556,
  278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];
/** Past ASCII, the characters whose width is not their base letter's. */
const WIDER: Record<string, [number, number]> = {
  "…": [1000, 1000],
  "—": [1000, 1000],
  "–": [556, 556],
  "€": [556, 556],
  "‘": [222, 278],
  "’": [222, 278],
  "“": [333, 500],
  "”": [333, 500],
  "•": [350, 350],
  "·": [278, 278],
  "°": [400, 400],
  "×": [584, 584],
  Æ: [1000, 1000],
  æ: [889, 889],
  Ø: [778, 778],
  ø: [611, 611],
  ß: [611, 611],
  "©": [737, 737],
  "®": [737, 737],
};

/** WinAnsi codes for the characters past Latin-1 it holds. */
const WIN_ANSI: Record<string, number> = {
  "€": 0x80,
  "…": 0x85,
  "‘": 0x91,
  "’": 0x92,
  "“": 0x93,
  "”": 0x94,
  "•": 0x95,
  "–": 0x96,
  "—": 0x97,
  Œ: 0x8c,
  œ: 0x9c,
  Š: 0x8a,
  š: 0x9a,
  Ž: 0x8e,
  ž: 0x9e,
  Ÿ: 0x9f,
};

/** Latin letters that do not come apart into a letter and an accent. */
const PLAIN: Record<string, string> = { Ł: "L", ł: "l", Đ: "D", đ: "d", ı: "i", Ħ: "H", ħ: "h" };

const held = (ch: string) => {
  const code = ch.codePointAt(0) ?? 0;
  return (code >= 32 && code < 127) || (code >= 0xa0 && code <= 0xff) || ch in WIN_ANSI;
};

/**
 * Text as WinAnsi can hold it: a Latin letter it lacks (Dvořák's ř, Łódź's Ł) as its plain
 * letter, so a name stays readable; anything else it lacks, such as Cyrillic, as a question mark.
 */
export function winAnsi(words: string): string {
  let out = "";
  for (const ch of words) {
    if (held(ch)) out += ch;
    else if (PLAIN[ch]) out += PLAIN[ch];
    else {
      const base = ch.normalize("NFD").replace(/\p{M}/gu, "");
      out += base && [...base].every(held) ? base : "?";
    }
  }
  return out;
}

/**
 * Words as a PDF string in WinAnsi, all in ASCII: brackets and backslashes escaped, anything
 * else outside ASCII as an octal code.
 */
export function pdfString(words: string): string {
  let out = "";
  for (const ch of winAnsi(words)) {
    const code = ch.codePointAt(0) ?? 63;
    if (ch === "\\" || ch === "(" || ch === ")") out += `\\${ch}`;
    else if (code >= 32 && code < 127) out += ch;
    else out += `\\${(WIN_ANSI[ch] ?? code).toString(8).padStart(3, "0")}`;
  }
  return `(${out})`;
}

function advance(ch: string, bold: boolean): number {
  const table = bold ? BOLD : REGULAR;
  const code = ch.codePointAt(0) ?? 0;
  if (code >= ASCII && code < ASCII + table.length) return table[code - ASCII] ?? 556;
  const wide = WIDER[ch];
  if (wide) return wide[bold ? 1 : 0];
  // An accented letter is as wide as the letter under it.
  const base = ch.normalize("NFD")[0];
  if (base && base !== ch) return advance(base, bold);
  return 556;
}

/** How wide words set in Helvetica are, as they will print, at a size in points. */
export function widthOf(words: string, size: number, bold = false): number {
  let sum = 0;
  for (const ch of winAnsi(words)) sum += advance(ch, bold);
  return (sum / 1000) * size;
}
