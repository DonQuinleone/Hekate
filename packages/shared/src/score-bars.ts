/**
 * Going to a bar on a score (#52): the bar numbers the score prints, read from its text layer,
 * placed by page and by a point on the page (0 to 1 across and down, from the top left).
 */
export interface PrintedBar {
  page: number;
  x: number;
  y: number;
  bar: number;
}

/** Page numbers sit in the margins at the top and foot of a page; bar numbers never do. */
const MARGIN = 0.05;
/** Fewer bar numbers than this is too little to tell them from anything else on the page. */
const FEWEST = 3;
/** More numbers than any score prints in its text; past these, the rest are not read. */
const MOST = 4000;
/** A system's number is printed at its start, before the clef: near the page's left edge. */
const SYSTEM_START = 0.14;

/** Within a few hundredths down the page, two numbers are on one line: across decides. */
const line = (y: number) => Math.round(y * 40);
const before = (a: PrintedBar, b: PrintedBar) =>
  a.page - b.page || line(a.y) - line(b.y) || a.x - b.x;

/**
 * The bar numbers among the numbers printed on a score: the longest run of them that rises
 * through the score in reading order, the earliest such where there are several. A score
 * numbers its bars upwards, at each system or every few bars; fingerings, tuplets and rehearsal
 * figures rise and fall, and so drop out, and page numbers are left out with the margins.
 * The numbers at the start of each system come first: a run of fingerings (1, 2, 3, 4, 5) also
 * rises, but sits among the notes. Only a score that numbers its bars along the systems, and
 * not at their starts, is read from every number. Nothing when too few are found to trust.
 */
export function barNumbersOf(numbers: PrintedBar[]): PrintedBar[] {
  const words = numbers
    .filter((n) => Number.isInteger(n.bar) && n.bar >= 1 && n.bar <= 99_999)
    .filter((n) => n.y >= MARGIN && n.y <= 1 - MARGIN)
    .sort(before)
    .slice(0, MOST);
  // The first number on each line, where it is at the line's start.
  const lines = new Set<string>();
  const starts = words.filter((n) => {
    const key = `${n.page}:${line(n.y)}`;
    const first = !lines.has(key);
    lines.add(key);
    return first && n.x <= SYSTEM_START;
  });
  const atStarts = risingRun(starts);
  return atStarts.length > 0 ? atStarts : risingRun(words);
}

/** The longest run that rises, in the order given, the earliest such; nothing if too short. */
function risingRun(words: PrintedBar[]): PrintedBar[] {
  // From each number, how long a rising run it starts; then the earliest of the longest
  // runs, taking the earliest number at each step, so a fingering just after a bar number
  // never stands in for it.
  const longest = new Array<number>(words.length).fill(1);
  for (let i = words.length - 1; i >= 0; i--) {
    for (let j = i + 1; j < words.length; j++) {
      if ((words[j]?.bar ?? 0) > (words[i]?.bar ?? 0))
        longest[i] = Math.max(longest[i] ?? 1, (longest[j] ?? 0) + 1);
    }
  }
  const most = Math.max(0, ...longest);
  if (most < FEWEST) return [];
  const run: PrintedBar[] = [];
  let want = most;
  let floor = 0;
  for (const [i, word] of words.entries()) {
    if (want > 0 && longest[i] === want && word.bar > floor) {
      run.push(word);
      floor = word.bar;
      want--;
    }
  }
  return run;
}

/**
 * Where a bar is, from the bars known on the score, in order: at the last number at or before
 * it, which `from` names. A bar before the first number is on that number's page, at its top,
 * since a score leaves its first system unnumbered. Nothing when no bar is known.
 */
export function placeOfBar(
  known: PrintedBar[],
  bar: number,
): { page: number; y: number; from: number | null } | null {
  const first = known[0];
  if (!first) return null;
  if (bar < first.bar) return { page: first.page, y: 0, from: null };
  let at = first;
  for (const b of known) {
    if (b.bar > bar) break;
    at = b;
  }
  return { page: at.page, y: at.y, from: at.bar };
}

/** How far from its system's number a mark may be carried; past it, it sits on the system. */
const REACH = 0.25;

/**
 * Where something placed at a bar on one edition of a score goes on another (#52), when the
 * score is swapped: to that bar in the new edition, as far below or above its system's number
 * as it was in the old. Nothing when either edition has no bars to go by.
 */
export function movedToBar(
  from: PrintedBar[],
  to: PrintedBar[],
  bar: number,
  at: { page: number; y: number },
): { page: number; y: number } | null {
  const was = placeOfBar(from, bar);
  const now = placeOfBar(to, bar);
  if (!was || !now) return null;
  const offset = was.page === at.page ? Math.min(REACH, Math.max(-REACH, at.y - was.y)) : 0;
  return { page: now.page, y: Math.min(1, Math.max(0, now.y + offset)) };
}
