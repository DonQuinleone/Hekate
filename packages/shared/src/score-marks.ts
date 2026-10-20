import { z } from "zod";
import { drawingColours } from "./anchor.ts";

/**
 * Score marks (#52, docs/domain.md): the producer's pencil on a track's score. A mark belongs
 * to the track, not to the score file, so a score swapped mid-project keeps every mark: it is
 * placed by page and by a point on the page (0 to 1 across and down), and by bar where known.
 */
export const scoreMarkKinds = [
  "issue",
  "edit",
  "take-start",
  "take-end",
  "punch-in",
  "wrong-note",
  "dynamic",
  "note",
  "ink",
] as const;
export type ScoreMarkKind = (typeof scoreMarkKinds)[number];

/** Each kind as the toolbar names it, with its single key. */
export const scoreMarkTools: Record<ScoreMarkKind, { name: string; key: string }> = {
  issue: { name: "Issue", key: "i" },
  edit: { name: "Edit point", key: "e" },
  "take-start": { name: "Take start", key: "[" },
  "take-end": { name: "Take end", key: "]" },
  "punch-in": { name: "Punch-in", key: "p" },
  "wrong-note": { name: "Wrong note", key: "w" },
  dynamic: { name: "Dynamic", key: "d" },
  note: { name: "Sticky note", key: "n" },
  ink: { name: "Ink", key: "k" },
};

const unit = z.number().min(0).max(1);
const takeNumber = z.number().int().min(1).max(100_000);
const bar = z.number().int().min(0).max(100_000);

export const scoreMarkInput = z
  .object({
    kind: z.enum(scoreMarkKinds),
    page: z.number().int().min(1).max(10_000),
    /** Where on the page: its point, or the corner of the region an issue covers. */
    x: unit,
    y: unit,
    width: unit.nullable().optional(),
    height: unit.nullable().optional(),
    /** A freehand stroke, for ink. */
    points: z
      .array(z.tuple([unit, unit]))
      .min(2)
      .max(1024)
      .nullable()
      .optional(),
    barFrom: bar.nullable().optional(),
    barTo: bar.nullable().optional(),
    /** What it says: an issue's description, a dynamic ("mp"), a sticky note. */
    text: z.string().trim().max(500).nullable().optional(),
    /** An issue's category, of the project's. */
    categoryId: z.uuid().nullable().optional(),
    /** The takes an issue occurred in, and the take that fixed it, by number. */
    takes: z.array(takeNumber).max(50).optional(),
    fixedBy: takeNumber.nullable().optional(),
    resolved: z.boolean().optional(),
    /**
     * An edit point's hand-over: from one take into another. Without `from` it is the lead-in,
     * the take the track starts from. An overdub lays the take over, rather than cutting to it.
     * A take start, take end or punch-in names its take in `to`.
     */
    from: takeNumber.nullable().optional(),
    to: takeNumber.nullable().optional(),
    overdub: z.boolean().optional(),
  })
  .refine((m) => m.barFrom == null || m.barTo == null || m.barFrom <= m.barTo, {
    message: "The bars run forwards",
    path: ["barTo"],
  })
  .refine((m) => (m.width == null) === (m.height == null), {
    message: "A region has a width and a height",
    path: ["width"],
  })
  .refine((m) => (m.width ?? 0) + m.x <= 1 && (m.height ?? 0) + m.y <= 1, {
    message: "A region lies inside the page",
    path: ["width"],
  })
  .refine((m) => m.kind !== "ink" || (m.points?.length ?? 0) >= 2, {
    message: "Ink is a stroke",
    path: ["points"],
  })
  .refine((m) => m.kind !== "edit" || m.to != null, {
    message: "Say which take the edit goes into",
    path: ["to"],
  })
  .refine((m) => !["take-start", "take-end", "punch-in"].includes(m.kind) || m.to != null, {
    message: "Say which take",
    path: ["to"],
  })
  .refine((m) => !["dynamic", "note"].includes(m.kind) || Boolean(m.text), {
    message: "Write what it says",
    path: ["text"],
  });
export type ScoreMarkInput = z.input<typeof scoreMarkInput>;

/** What changes on a mark; its kind stays. */
export const scoreMarkChangeInput = z.object({
  page: z.number().int().min(1).max(10_000).optional(),
  x: unit.optional(),
  y: unit.optional(),
  barFrom: bar.nullable().optional(),
  barTo: bar.nullable().optional(),
  text: z.string().trim().max(500).nullable().optional(),
  categoryId: z.uuid().nullable().optional(),
  takes: z.array(takeNumber).max(50).optional(),
  fixedBy: takeNumber.nullable().optional(),
  resolved: z.boolean().optional(),
  from: takeNumber.nullable().optional(),
  to: takeNumber.nullable().optional(),
  overdub: z.boolean().optional(),
});
export type ScoreMarkChange = z.infer<typeof scoreMarkChangeInput>;

export interface ScoreMark {
  id: string;
  kind: ScoreMarkKind;
  page: number;
  x: number;
  y: number;
  width: number | null;
  height: number | null;
  points: [number, number][] | null;
  barFrom: number | null;
  barTo: number | null;
  text: string | null;
  categoryId: string | null;
  takes: number[];
  fixedBy: number | null;
  resolved: boolean;
  from: number | null;
  to: number | null;
  overdub: boolean;
  by: { id: string; name: string } | null;
  createdAt: string;
}

/** A project's categories of issue, each with its colour and the key that picks it. */
export const scoreMarkCategoryInput = z.object({
  name: z.string().trim().min(1, "Name the category").max(40),
  colour: z.enum(drawingColours),
  key: z
    .string()
    .regex(/^[1-9]$/, "A key from 1 to 9")
    .nullable(),
});
export interface ScoreMarkCategory {
  id: string;
  name: string;
  colour: (typeof drawingColours)[number];
  key: string | null;
  position: number;
}

/** Every project starts with these. */
export const defaultScoreMarkCategories: Omit<ScoreMarkCategory, "id" | "position">[] = [
  { name: "Intonation", colour: "signal", key: "1" },
  { name: "Ensemble", colour: "blue", key: "2" },
  { name: "Noise", colour: "green", key: "3" },
  { name: "Balance", colour: "paper", key: "4" },
];

/**
 * An edit point as the plot is written: "3T12 into T7" is bar 3 of take 12 handing over to
 * take 7; a lead-in is written "T3"; an overdub, "T9 over T7".
 */
export function editLabel(m: Pick<ScoreMark, "from" | "to" | "barFrom" | "overdub">): string {
  if (m.to == null) return "";
  if (m.from == null) return `T${m.to}`;
  const from = `${m.barFrom ?? ""}T${m.from}`;
  return m.overdub ? `T${m.to} over ${from}` : `${from} into T${m.to}`;
}

/** Marks in reading order: page by page, then down the page, then across it. */
export function readingOrder<T extends Pick<ScoreMark, "page" | "x" | "y">>(marks: T[]): T[] {
  // Within a few hundredths down the page, two marks are on one system: across decides.
  const line = (y: number) => Math.round(y * 40);
  return [...marks].sort((a, b) => a.page - b.page || line(a.y) - line(b.y) || a.x - b.x);
}

export interface EditPlot {
  /** The takes the track is made of, in the order it plays them: lead-in first. */
  chain: number[];
  problems: { markId: string | null; text: string }[];
}

/**
 * The edit plot check (#52): the track's T-edits in reading order make one chain, from the
 * lead-in to the final take. Every hand-over leaves the take the last one went into, and every
 * take it names was recorded for the track. Overdubs lay a take over and leave the chain as is.
 */
export function editPlot(
  marks: Pick<
    ScoreMark,
    "id" | "kind" | "page" | "x" | "y" | "from" | "to" | "overdub" | "barFrom"
  >[],
  recorded: ReadonlySet<number>,
): EditPlot {
  const edits = readingOrder(marks.filter((m) => m.kind === "edit" && m.to != null));
  const problems: EditPlot["problems"] = [];
  const chain: number[] = [];
  if (edits.length === 0) return { chain, problems };
  for (const edit of edits) {
    const where = edit.barFrom != null ? `bar ${edit.barFrom}` : `page ${edit.page}`;
    const named = [edit.from, edit.to].filter((n): n is number => n != null);
    for (const n of named)
      if (!recorded.has(n))
        problems.push({ markId: edit.id, text: `${where}: take ${n} was not recorded` });
    if (edit.overdub) continue;
    const current = chain.at(-1);
    if (edit.from == null) {
      if (current !== undefined)
        problems.push({
          markId: edit.id,
          text: `${where}: a second lead-in, T${edit.to}, after the chain began`,
        });
      else chain.push(edit.to as number);
      continue;
    }
    if (current === undefined) {
      problems.push({ markId: edit.id, text: `${where}: the plot has no lead-in before it` });
      chain.push(edit.from);
    } else if (edit.from !== current)
      problems.push({
        markId: edit.id,
        text: `${where}: hands over from T${edit.from}, but the plot is in T${current}`,
      });
    chain.push(edit.to as number);
  }
  return { chain, problems };
}

/** Takes typed as a list ("T3, 7 12"), as numbers in order without repeats; null if one is not a take. */
export function takeList(typed: string): number[] | null {
  const parts = typed.split(/[\s,;]+/).filter(Boolean);
  const numbers: number[] = [];
  for (const part of parts) {
    const n = /^t?(\d{1,6})$/i.exec(part)?.[1];
    if (n === undefined || Number(n) < 1) return null;
    if (!numbers.includes(Number(n))) numbers.push(Number(n));
  }
  return numbers;
}

const csvCell = (value: string | number | null) => {
  const text = value === null ? "" : String(value);
  // A cell a spreadsheet would run as a formula is written as text (CWE-1236).
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

/** A track's marks as CSV, in reading order: one row a mark. */
export function scoreMarksCsv(
  marks: ScoreMark[],
  categories: Pick<ScoreMarkCategory, "id" | "name">[],
): string {
  const header = ["Page", "Bars", "Kind", "Category", "Text", "Takes", "Fixed by", "Status"];
  const rows = readingOrder(marks).map((m) => [
    m.page,
    m.barFrom === null
      ? ""
      : m.barTo && m.barTo !== m.barFrom
        ? `${m.barFrom}–${m.barTo}`
        : m.barFrom,
    scoreMarkTools[m.kind].name,
    categories.find((c) => c.id === m.categoryId)?.name ?? "",
    m.kind === "edit"
      ? editLabel(m)
      : m.to != null && m.kind !== "issue"
        ? `T${m.to}`
        : (m.text ?? ""),
    m.takes.map((t) => `T${t}`).join(" "),
    m.fixedBy === null ? "" : `T${m.fixedBy}`,
    m.kind === "issue" ? (m.resolved ? "Resolved" : "Open") : "",
  ]);
  return `${[header, ...rows].map((r) => r.map((c) => csvCell(c)).join(",")).join("\r\n")}\r\n`;
}
