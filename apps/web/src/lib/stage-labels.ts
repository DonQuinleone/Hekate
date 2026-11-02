/**
 * Where a microphone's label sits on the stage plan (#570): to the right of its mark, as the
 * prototype draws it, unless that would run into another mark; then to its left, else under it.
 * Worked out in pixels at the plan's scale, so it holds at every zoom.
 */

export type LabelSide = "right" | "left" | "below";

export interface MarkedLabel {
  id: string;
  /** The mark's centre, in metres. */
  x: number;
  y: number;
  label: string | null;
}

/** The mark's radius and the gap to its label, in pixels; a character's width at 10 px. */
export const MARK = 9;
const GAP = 3;
const CHAR = 5.6;
const HALF_LINE = 6;

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const overlaps = (a: Box, b: Box) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

function labelBox(m: MarkedLabel, side: LabelSide, scale: number): Box {
  const cx = m.x * scale;
  const cy = m.y * scale;
  const width = (m.label ?? "").length * CHAR;
  if (side === "right")
    return {
      left: cx + MARK + GAP,
      right: cx + MARK + GAP + width,
      top: cy - HALF_LINE,
      bottom: cy + HALF_LINE,
    };
  if (side === "left")
    return {
      left: cx - MARK - GAP - width,
      right: cx - MARK - GAP,
      top: cy - HALF_LINE,
      bottom: cy + HALF_LINE,
    };
  const top = cy + MARK + GAP;
  return { left: cx - width / 2, right: cx + width / 2, top, bottom: top + 2 * HALF_LINE };
}

const markBox = (m: MarkedLabel, scale: number): Box => ({
  left: m.x * scale - MARK,
  right: m.x * scale + MARK,
  top: m.y * scale - MARK,
  bottom: m.y * scale + MARK,
});

/** Each labelled mark's side: the first of right, left and below that clears every other mark. */
export function labelSides(marks: readonly MarkedLabel[], scale: number): Map<string, LabelSide> {
  const sides = new Map<string, LabelSide>();
  for (const m of marks) {
    if (!m.label) continue;
    const others = marks.filter((o) => o.id !== m.id).map((o) => markBox(o, scale));
    const side =
      (["right", "left", "below"] as const).find((s) => {
        const box = labelBox(m, s, scale);
        return !others.some((o) => overlaps(box, o));
      }) ?? "right";
    sides.set(m.id, side);
  }
  return sides;
}
