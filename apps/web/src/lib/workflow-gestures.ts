import { type NodeType, outcomesOf } from "@hekate/shared";
import { NODE_H, NODE_W, outPort, type Pt } from "~/lib/workflow-nodes";

/**
 * The builder's canvas under a hand (#511, decision 289): zooming about the pointer, by a ctrl
 * or pinch on a trackpad and by two fingers on a screen, and a kind dragged from the picker or
 * the palette landing where it is dropped, wired from an output it is dropped on. Pure, so the
 * canvas does only the listening.
 */

/** Where the canvas is looked at: its offset in the window, and how far it is zoomed. */
export interface View {
  pan: Pt;
  zoom: number;
}

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 2;

/**
 * The view zoomed by a factor about a point of the canvas (in its own pixels, from its top
 * left), so what is under that point stays under it; held within the zoom's bounds.
 */
export function zoomAbout(view: View, factor: number, at: Pt): View {
  const zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, view.zoom * factor));
  const wx = (at.x - view.pan.x) / view.zoom;
  const wy = (at.y - view.pan.y) / view.zoom;
  return { zoom, pan: { x: at.x - wx * zoom, y: at.y - wy * zoom } };
}

/**
 * How far a wheel turned with ctrl (or a trackpad pinched, which browsers send as one) zooms:
 * smoothly for a trackpad's small steps, about a tenth for a mouse's notch, never more. Lines
 * and pages are read as pixels first.
 */
export function wheelFactor(deltaY: number, deltaMode = 0): number {
  const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  const step = Math.max(-10, Math.min(10, pixels));
  return Math.exp(-step / 100);
}

const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const apart = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Two fingers moved on the canvas: the view zoomed by how far they spread or closed, about
 * the point between them, and moved with that point, as a map follows the hand.
 */
export function pinched(view: View, before: [Pt, Pt], after: [Pt, Pt]): View {
  const was = apart(before[0], before[1]);
  const now = apart(after[0], after[1]);
  const factor = was > 0 && now > 0 ? now / was : 1;
  const from = mid(before[0], before[1]);
  const to = mid(after[0], after[1]);
  const zoomed = zoomAbout(view, factor, from);
  return {
    zoom: zoomed.zoom,
    pan: { x: zoomed.pan.x + to.x - from.x, y: zoomed.pan.y + to.y - from.y },
  };
}

type Placed = { id: string; type: NodeType; x: number; y: number };

/** How near an output a drop counts as on it, in the canvas's own pixels. */
const PORT_REACH = 28;

/**
 * The output a kind dropped at a point is wired from, if it was dropped on one: the nearest
 * output port within reach, else, dropped on a node itself, its first output nothing leaves by
 * yet (or its first). A finish has no output, so nothing is wired from it.
 */
export function dropTarget(
  nodes: readonly Placed[],
  at: Pt,
  wired: (nodeId: string, outcome: string) => boolean = () => false,
): { nodeId: string; outcome: string } | null {
  let best: { nodeId: string; outcome: string; d: number } | null = null;
  for (const n of nodes)
    for (const o of outcomesOf(n.type)) {
      const port = outPort(n, o.id);
      const d = apart(port, at);
      if (d <= PORT_REACH && (!best || d < best.d)) best = { nodeId: n.id, outcome: o.id, d };
    }
  if (best) return { nodeId: best.nodeId, outcome: best.outcome };
  // Topmost first: the node drawn last lies over the others.
  for (const n of [...nodes].reverse()) {
    if (at.x < n.x || at.x > n.x + NODE_W || at.y < n.y || at.y > n.y + NODE_H) continue;
    const outs = outcomesOf(n.type);
    const free = outs.find((o) => !wired(n.id, o.id)) ?? outs[0];
    return free ? { nodeId: n.id, outcome: free.id } : null;
  }
  return null;
}

/** Between a step and the one added after it, beyond the room its paths' labels take. */
export const ADD_GAP = 120;

/**
 * Where a kind lands: wired from an output, to the right of that output with its middle on
 * it; otherwise centred where it was let go.
 */
export function landing(at: Pt, from?: { node: Placed; outcome: string }): Pt {
  if (!from) return { x: at.x - NODE_W / 2, y: at.y - NODE_H / 2 };
  const port = outPort(from.node, from.outcome);
  return { x: from.node.x + NODE_W + ADD_GAP, y: port.y - NODE_H / 2 };
}
