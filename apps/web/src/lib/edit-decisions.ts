import { barsLabel, clockOf, type EditDecisions, type EdlUse } from "@hekate/shared";

/** A list's timecode rate as editors say it: "25 fps", "29.97 fps drop frame". */
export const rateName = (fps: number, dropFrame: boolean) =>
  `${fps} fps${dropFrame ? " drop frame" : ""}`;

/** What the list says, in a line: whose list, how many edits, how many are no take of this track. */
export function decisionsSummary(d: EditDecisions): string {
  const unmatched = d.uses.filter((u) => u.takeId === null).length;
  const edits = `${d.uses.length} ${d.uses.length === 1 ? "edit" : "edits"}`;
  return `From V${d.version.number}'s list · ${edits}${
    unmatched ? `, ${unmatched} from no take of this track` : ""
  }`;
}

/** One edit as the list of edit decisions shows it. */
export interface EditLine {
  /** Where in the version: "0:12–0:25". */
  when: string;
  /** "T12", or null for a source that is no take of this track. */
  take: string | null;
  /** The source as the list names it: its clip name, else its reel. */
  source: string;
  /** Where in the take it starts, or why that is unknown. */
  place: string;
  bars: string | null;
}

export function editLine(use: EdlUse, numberOf: (takeId: string) => number | undefined): EditLine {
  const number = use.takeId ? numberOf(use.takeId) : undefined;
  return {
    when: `${clockOf(use.event.recordIn)}–${clockOf(use.event.recordOut)}`,
    take: number === undefined ? null : `T${number}`,
    source: use.event.clipName ?? use.event.reel,
    place:
      use.takeId === null
        ? "Not a take of this track"
        : use.from === null || use.to === null
          ? "Its place in the take is not known"
          : `${clockOf(use.from)}–${clockOf(use.to)} of the take`,
    bars: use.bars ? barsLabel({ barFrom: use.bars[0], barTo: use.bars[1] }) : null,
  };
}

/** The bars of a take the version uses, for its lane. */
export const barsUsedOf = (d: EditDecisions | null | undefined, takeId: string) =>
  (d?.uses ?? [])
    .filter((u) => u.takeId === takeId && u.bars)
    .map((u) => u.bars as [number, number]);

/**
 * The version whose list uses a take at a bar ("V2"), or null: "which take is used at bar
 * 72", answered beside the takes covering it.
 */
export function usedAtBar(
  d: EditDecisions | null | undefined,
  takeId: string,
  bar: number,
): string | null {
  const used = (d?.uses ?? []).some(
    (u) => u.takeId === takeId && u.bars !== null && u.bars[0] <= bar && u.bars[1] >= bar,
  );
  return used && d ? `V${d.version.number}` : null;
}

/** The takes a version's list uses at all. */
export const takesUsed = (d: EditDecisions | null | undefined) =>
  new Set((d?.uses ?? []).flatMap((u) => (u.takeId ? [u.takeId] : [])));

/** One stretch of a version's lane: where it plays, and what it comes from. */
export interface EditSegment {
  start: number;
  end: number;
  /** "T12", else the source as the list names it. */
  label: string;
  /** Whether it comes from a take of this track. */
  take: boolean;
  /** The bars of the take it uses, where they are known: "bars 9 to 16". */
  bars: string | null;
}

/**
 * A version's edits as stretches along its timeline (#56), in order. An edit filling two
 * tracks of the list (AA, or A and A2) is one stretch; where edits overlap, as a dissolve
 * does, each later one starts where the one before ends, so the lane reads as cuts.
 */
export function editSegments(
  d: EditDecisions | null | undefined,
  numberOf: (takeId: string) => number | undefined,
): EditSegment[] {
  const uses = [...(d?.uses ?? [])].sort(
    (a, b) => a.event.recordIn - b.event.recordIn || a.event.recordOut - b.event.recordOut,
  );
  const out: EditSegment[] = [];
  for (const use of uses) {
    const line = editLine(use, numberOf);
    const start = Math.max(use.event.recordIn, out.at(-1)?.end ?? 0);
    const end = use.event.recordOut;
    if (end <= start) continue;
    out.push({
      start,
      end,
      label: line.take ?? line.source,
      take: line.take !== null,
      bars: line.bars,
    });
  }
  return out;
}

/** The stretch playing at a moment, if any. */
export const segmentAt = (segments: readonly EditSegment[], at: number) =>
  segments.find((s) => s.start <= at && at < s.end) ?? null;
