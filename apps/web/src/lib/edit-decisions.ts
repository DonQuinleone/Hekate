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
