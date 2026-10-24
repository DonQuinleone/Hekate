/**
 * Right-to-left text for the PDF writers (decision 238): Arabic letters joined into the forms
 * they take beside each other, and a line put in the order it is drawn, left to right, by the
 * Unicode bidirectional algorithm without explicit embeddings (enough for a name, a note or a
 * table cell; a PDF writer has no paragraphs that nest). Pure functions, no fonts.
 */

type Joining = "D" | "R" | "U" | "C" | "T";

/** For each letter (or lam-alef pair), its presentation forms: isolated, final, initial, medial. */
let formsTable: Map<string, number[]> | undefined;

/**
 * Read from Unicode's own presentation-form blocks: a letter's forms sit together, isolated,
 * final, initial, medial, and each says which letter it is (its compatibility decomposition).
 */
function forms(): Map<string, number[]> {
  if (formsTable) return formsTable;
  const table = new Map<string, number[]>();
  const scan = (from: number, to: number) => {
    let c = from;
    while (c <= to) {
      const base = String.fromCodePoint(c).normalize("NFKC");
      const arabic = /^[ؠ-ۿ]+$/.test(base);
      const pair = [...base].length === 2;
      if (!arabic || (pair && !base.startsWith("ل"))) {
        c++;
        continue;
      }
      let n = c + 1;
      while (n <= to && String.fromCodePoint(n).normalize("NFKC") === base) n++;
      const group = Array.from({ length: n - c }, (_, i) => c + i);
      if (!table.has(base) && [1, 2, 4].includes(group.length)) table.set(base, group);
      c = n;
    }
  };
  scan(0xfe80, 0xfefc);
  scan(0xfb50, 0xfbff);
  formsTable = table;
  return table;
}

function joiningOf(unit: string): Joining {
  if (unit === "ـ" || unit === "‍") return "C";
  if (/^[\p{Mn}\p{Me}]$/u.test(unit)) return "T";
  const f = forms().get(unit);
  if (!f) return "U";
  return f.length === 4 ? "D" : f.length === 2 ? "R" : "U";
}

const ALEFS = new Set(["آ", "أ", "إ", "ا"]);

/**
 * Arabic letters in the forms they take where they meet (initial, medial, final or isolated),
 * and lam before alef as its ligature, as presentation-form characters; a form the font cannot
 * draw (`drawable` says) stays the plain letter. Other text is returned as it came.
 */
export function shapeArabic(text: string, drawable: (codePoint: number) => boolean): string {
  if (!/[ؠ-ۿ]/.test(text)) return text;
  const chars = [...text];
  // Units: a letter, or lam and the alef after it (marks between them follow the pair).
  const units: { text: string; marks: string[] }[] = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string;
    if (joiningOf(ch) === "T" && units.length > 0) {
      units.at(-1)?.marks.push(ch);
      continue;
    }
    if (ch === "ل") {
      let j = i + 1;
      const marks: string[] = [];
      while (j < chars.length && joiningOf(chars[j] as string) === "T")
        marks.push(chars[j++] as string);
      const next = chars[j];
      if (next && ALEFS.has(next) && forms().has(ch + next)) {
        units.push({ text: ch + next, marks });
        i = j;
        continue;
      }
    }
    units.push({ text: ch, marks: [] });
  }
  const type = units.map((u) => joiningOf(u.text));
  let out = "";
  units.forEach((unit, i) => {
    const t = type[i];
    const before = type[i - 1];
    const after = type[i + 1];
    const joinsBefore = (t === "D" || t === "R" || t === "C") && (before === "D" || before === "C");
    const joinsAfter =
      (t === "D" || t === "C") && (after === "D" || after === "R" || after === "C");
    const f = forms().get(unit.text);
    let form: number | undefined;
    if (f && t === "D")
      form = f[joinsBefore && joinsAfter ? 3 : joinsBefore ? 1 : joinsAfter ? 2 : 0];
    else if (f && t === "R") form = f[joinsBefore ? 1 : 0];
    const shown = form !== undefined && drawable(form) ? String.fromCodePoint(form) : unit.text;
    out += shown + unit.marks.join("");
  });
  return out;
}

type Bidi = "L" | "R" | "AL" | "EN" | "AN" | "ES" | "ET" | "CS" | "NSM" | "WS" | "ON";

const R_SCRIPTS =
  /[\p{Script=Hebrew}\p{Script=Samaritan}\p{Script=Mandaic}\p{Script=Nko}\p{Script=Adlam}\p{Script=Hanifi_Rohingya}]/u;
const AL_SCRIPTS = /[\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}]/u;

function classOf(ch: string): Bidi {
  const c = ch.codePointAt(0) ?? 0;
  if (/[\p{Mn}\p{Me}]/u.test(ch)) return "NSM";
  if ((c >= 0x660 && c <= 0x669) || c === 0x66b || c === 0x66c) return "AN";
  if (/\p{Nd}/u.test(ch)) return "EN";
  if (ch === "+" || ch === "-" || ch === "−") return "ES";
  if (/[#%°‰\p{Sc}]/u.test(ch)) return "ET";
  if (/[,.:/ ،]/.test(ch)) return "CS";
  if (/\s/u.test(ch)) return "WS";
  if (AL_SCRIPTS.test(ch)) return "AL";
  if (R_SCRIPTS.test(ch) || (c >= 0xfb1d && c <= 0xfb4f)) return "R";
  if (/[\p{L}\p{Mc}]/u.test(ch)) return "L";
  return "ON";
}

const MIRROR: Record<string, string> = {
  "(": ")",
  ")": "(",
  "[": "]",
  "]": "[",
  "{": "}",
  "}": "{",
  "<": ">",
  ">": "<",
  "«": "»",
  "»": "«",
  "‹": "›",
  "›": "‹",
};

/** Whether text holds anything written right to left. */
export const hasRightToLeft = (text: string) =>
  [...text].some((ch) => {
    const k = classOf(ch);
    return k === "R" || k === "AL" || k === "AN";
  });

/**
 * A line in the order it is drawn, left to right: right-to-left runs reversed (a combining mark
 * staying after its letter, brackets mirrored), numbers in them kept left to right. The line's
 * direction is its first strong letter's.
 */
export function visualOrder(text: string): string {
  if (!hasRightToLeft(text)) return text;
  const chars = [...text];
  const types = chars.map(classOf);
  const first = types.find((t) => t === "L" || t === "R" || t === "AL");
  const level = first === "R" || first === "AL" ? 1 : 0;
  const sos: Bidi = level ? "R" : "L";
  const n = types.length;
  // W1: a mark takes the type of what it marks.
  for (let i = 0; i < n; i++)
    if (types[i] === "NSM") types[i] = i === 0 ? sos : (types[i - 1] as Bidi);
  // W2, W3: a European number after Arabic letters is an Arabic number; Arabic letters are R.
  let strong: Bidi = sos;
  for (let i = 0; i < n; i++) {
    const t = types[i];
    if (t === "L" || t === "R" || t === "AL") strong = t;
    else if (t === "EN" && strong === "AL") types[i] = "AN";
  }
  for (let i = 0; i < n; i++) if (types[i] === "AL") types[i] = "R";
  // W4: one separator between two numbers of a kind joins them.
  for (let i = 1; i < n - 1; i++) {
    const [a, t, b] = [types[i - 1], types[i], types[i + 1]];
    if (t === "ES" && a === "EN" && b === "EN") types[i] = "EN";
    else if (t === "CS" && a === b && (a === "EN" || a === "AN")) types[i] = a as Bidi;
  }
  // W5: currency and percent signs beside a number belong to it.
  for (let i = 0; i < n; i++) {
    if (types[i] !== "ET") continue;
    let j = i;
    while (j < n && types[j] === "ET") j++;
    if (types[i - 1] === "EN" || types[j] === "EN") for (let k = i; k < j; k++) types[k] = "EN";
    i = j - 1;
  }
  // W6, W7: other separators are neutral; a number after a Latin letter is Latin.
  for (let i = 0; i < n; i++) {
    const t = types[i];
    if (t === "ES" || t === "ET" || t === "CS") types[i] = "ON";
  }
  strong = sos;
  for (let i = 0; i < n; i++) {
    const t = types[i];
    if (t === "L" || t === "R") strong = t;
    else if (t === "EN" && strong === "L") types[i] = "L";
  }
  // N1, N2: neutrals between two of a direction take it; others the line's direction.
  const direction = (t: Bidi | undefined): "L" | "R" | null =>
    t === "L" ? "L" : t === "R" || t === "EN" || t === "AN" ? "R" : null;
  for (let i = 0; i < n; i++) {
    if (types[i] !== "WS" && types[i] !== "ON") continue;
    let j = i;
    while (j < n && (types[j] === "WS" || types[j] === "ON")) j++;
    const before = i === 0 ? sos : direction(types[i - 1]);
    const after = j === n ? sos : direction(types[j]);
    const resolved = before === after && before ? before : sos;
    for (let k = i; k < j; k++) types[k] = resolved;
    i = j - 1;
  }
  // I1, I2: the levels.
  const levels = types.map((t) => {
    if (level === 0) return t === "R" ? 1 : t === "AN" || t === "EN" ? 2 : 0;
    return t === "L" || t === "EN" || t === "AN" ? 2 : 1;
  });
  // L1: spaces at the end of the line return to its level.
  for (let i = n - 1; i >= 0 && /\s/u.test(chars[i] as string); i--) levels[i] = level;
  // L2, L3: reverse runs from the highest level down, a letter and its marks as one.
  const units: { text: string; level: number }[] = [];
  chars.forEach((ch, i) => {
    const lv = levels[i] ?? level;
    const shown = lv % 2 === 1 ? (MIRROR[ch] ?? ch) : ch;
    const last = units.at(-1);
    if (last && /[\p{Mn}\p{Me}]/u.test(ch)) last.text += shown;
    else units.push({ text: shown, level: lv });
  });
  const top = Math.max(...units.map((u) => u.level));
  for (let lv = top; lv >= 1; lv--) {
    for (let i = 0; i < units.length; i++) {
      if ((units[i]?.level ?? 0) < lv) continue;
      let j = i;
      while (j < units.length && (units[j]?.level ?? 0) >= lv) j++;
      const run = units.slice(i, j).reverse();
      units.splice(i, j - i, ...run);
      i = j - 1;
    }
  }
  return units.map((u) => u.text).join("");
}
