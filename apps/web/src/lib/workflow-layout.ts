import { Graph, layout } from "@dagrejs/dagre";
import {
  flowShape,
  outcomesOf,
  type WorkflowConnector,
  type WorkflowDefinition,
} from "@hekate/shared";
import { boundsOf, conditionText, NODE_H, NODE_W } from "~/lib/workflow-nodes";

/**
 * Keeping a workflow legible on the canvas (#26): each connector says what it is in a chip at
 * its start, where chips beside one node never meet, and Tidy up lays a workflow out again so
 * nothing overlaps, as n8n's does: in columns from left to right by the order a run reaches each
 * step (a layered layout, by dagre), loops left out so they run underneath.
 */

export const CHIP_H = 16;
const CHIP_MAX = 200;
/** About the width of a character of the chip's 11 px type, to size a chip before drawing it. */
const CHAR_W = 6.6;

/** What a connector's chip says: the outcome it leaves by, where there are several, and its own condition. */
export function connectorChip(flow: WorkflowDefinition, c: WorkflowConnector): string | null {
  const from = flow.nodes.find((n) => n.id === c.from);
  const outs = from ? outcomesOf(from.type) : [];
  const outcome = outs.length > 1 ? outs.find((o) => o.id === c.outcome)?.label : undefined;
  const words = [outcome, conditionText(c)].filter(Boolean).join(" · ");
  return words || null;
}

export const chipWidth = (text: string) => Math.min(CHIP_MAX, Math.ceil(text.length * CHAR_W) + 16);

/** Where a chip starts, past its port. */
export const CHIP_GAP = 10;

/**
 * How far a node's connectors run straight before they turn: past the widest of their chips,
 * so every line leaving a node turns at the same place and none cuts across another's chip.
 */
export function leadOf(flow: WorkflowDefinition, nodeId: string): number {
  const widths = flow.connectors
    .filter((c) => c.from === nodeId)
    .map((c) => connectorChip(flow, c))
    .map((t) => (t ? chipWidth(t) : 0));
  return Math.max(0, ...widths) > 0 ? CHIP_GAP + Math.max(...widths) + 12 : 28;
}

/** What a node's connectors have to work with: how far they run straight, and how wide a chip may be. */
export interface Fit {
  lead: number;
  chip: number;
}

/**
 * Each node's lead and the widest its chips may be, within the room its forward connectors have
 * before the nearest step they lead to (less the curve's room): where steps sit close, as a
 * hand-made layout may have them, chips are cut short rather than run into the next step.
 */
export function fits(flow: WorkflowDefinition): Map<string, Fit> {
  const at = new Map(flow.nodes.map((n) => [n.id, n]));
  const out = new Map<string, Fit>();
  for (const n of flow.nodes) {
    // Every step a connector leads to further right bounds the chips, even one so close that
    // its connector runs beneath: the chips would run into it all the same.
    const rooms = flow.connectors
      .filter((c) => c.from === n.id && (at.get(c.to)?.x ?? Number.NEGATIVE_INFINITY) > n.x)
      .map((c) => (at.get(c.to)?.x ?? Number.POSITIVE_INFINITY) - n.x - NODE_W - 48);
    const room = Math.min(Number.POSITIVE_INFINITY, ...rooms);
    const lead = Math.max(28, Math.min(leadOf(flow, n.id), room));
    out.set(n.id, { lead, chip: Math.max(0, Math.min(CHIP_MAX, lead - CHIP_GAP - 8)) });
  }
  return out;
}

export interface LoopLanes {
  /** Each loop's lane below the workflow, from 0, the nearest. */
  lane: Map<string, number>;
  /** How far over each loop drops from its node, and rises into its target, beside others. */
  out: Map<string, number>;
  into: Map<string, number>;
}

/**
 * Loops run beneath the workflow, one lane each: the shortest nearest, so a loop inside another
 * never crosses it, and loops leaving or entering one node set side by side.
 */
export function loopLanes(flow: WorkflowDefinition, loops: ReadonlySet<string>): LoopLanes {
  const at = new Map(flow.nodes.map((n) => [n.id, n]));
  const back = flow.connectors.filter((c) => loops.has(c.id));
  const span = (c: WorkflowConnector) => (at.get(c.from)?.x ?? 0) - (at.get(c.to)?.x ?? 0);
  const ordered = [...back].sort((a, b) => span(a) - span(b) || a.id.localeCompare(b.id));
  const lane = new Map(ordered.map((c, i) => [c.id, i]));
  const out = new Map<string, number>();
  const into = new Map<string, number>();
  const seenFrom = new Map<string, number>();
  const seenTo = new Map<string, number>();
  for (const c of ordered) {
    const f = seenFrom.get(c.from) ?? 0;
    const t = seenTo.get(c.to) ?? 0;
    // The outer loop (a lower lane) turns further out, so its line goes round the inner one's.
    out.set(c.id, f * 10);
    into.set(c.id, t * 10);
    seenFrom.set(c.from, f + 1);
    seenTo.set(c.to, t + 1);
  }
  return { lane, out, into };
}

/** How far a straight line passes from a step beside it, at the least. */
const CLEARANCE = 28;

/**
 * dagre bends a line that skips a column round the steps in it; the canvas draws a line between
 * two steps on one row straight. Where a step sits in that row between them, it and those below
 * it in its column move down until the row is clear.
 */
function cleared<N extends WorkflowDefinition["nodes"][number]>(
  nodes: N[],
  forward: WorkflowConnector[],
): N[] {
  let laid = nodes;
  for (let pass = 0; pass <= nodes.length; pass += 1) {
    const at = new Map(laid.map((n) => [n.id, n]));
    let clash: { node: N; by: number } | null = null;
    for (const c of forward) {
      const from = at.get(c.from);
      const to = at.get(c.to);
      if (!from || !to || from.y !== to.y) continue;
      // The row the two share is kept clear between them, not only the line.
      const hit = laid.find(
        (n) =>
          n.x > from.x &&
          n.x < to.x &&
          n.y < from.y + NODE_H + CLEARANCE &&
          n.y + NODE_H > from.y - CLEARANCE,
      );
      if (hit) {
        clash = { node: hit, by: from.y + NODE_H + CLEARANCE - hit.y };
        break;
      }
    }
    if (!clash) return laid;
    const { node, by } = clash;
    laid = laid.map((n) => (n.x === node.x && n.y >= node.y ? { ...n, y: n.y + by } : n));
  }
  return laid;
}

/** Between one column of steps and the next, beyond the room their chips take. */
const COLUMN_GAP = 56;
/** Between steps in one column. */
const ROW_GAP = 56;

/**
 * The workflow laid out again: steps in columns by the order a run reaches them, the first
 * outcome of each kept straight ahead where it can be, the others below; a stage's steps kept
 * together; and the whole where it was, its top left corner unmoved. Only positions change.
 */
export function tidied(flow: WorkflowDefinition): WorkflowDefinition {
  if (flow.nodes.length === 0) return flow;
  const { order, loops } = flowShape(flow);
  const g = new Graph({ compound: true, multigraph: true });
  g.setGraph({
    rankdir: "LR",
    ranksep: COLUMN_GAP,
    nodesep: ROW_GAP,
    edgesep: 24,
    marginx: 0,
    marginy: 0,
  });
  g.setDefaultEdgeLabel(() => ({}));
  // In the order a run reaches them, which dagre keeps where it can: the main line on top.
  const rank = new Map(order.map((id, i) => [id, i]));
  const nodes = [...flow.nodes].sort(
    (a, b) => (rank.get(a.id) ?? order.length) - (rank.get(b.id) ?? order.length),
  );
  const groups = new Set(nodes.flatMap((n) => (n.groupId ? [n.groupId] : [])));
  for (const id of groups) g.setNode(`group:${id}`, {});
  for (const n of nodes) {
    // Each step takes the room its chips need after it, so each column is as wide as its own.
    g.setNode(n.id, { width: NODE_W + leadOf(flow, n.id), height: NODE_H });
    if (n.groupId && groups.has(n.groupId)) g.setParent(n.id, `group:${n.groupId}`);
  }
  const index = (c: WorkflowConnector) => {
    const from = flow.nodes.find((n) => n.id === c.from);
    return from ? outcomesOf(from.type).findIndex((o) => o.id === c.outcome) : 0;
  };
  const forward = flow.connectors
    .filter((c) => !loops.has(c.id) && c.from !== c.to)
    .sort((a, b) => (rank.get(a.from) ?? 0) - (rank.get(b.from) ?? 0) || index(a) - index(b));
  // The first outcome pulls hardest, so the way most items go stays a straight line.
  for (const c of forward)
    g.setEdge(c.from, c.to, { weight: index(c) === 0 ? 4 : 1, minlen: 1 }, c.id);
  layout(g);

  const before = boundsOf(flow.nodes);
  // dagre centres a column; its steps share a left edge here, as a column of text would.
  const width = (id: string) => NODE_W + leadOf(flow, id);
  const columns = new Map<number, number>();
  for (const n of flow.nodes) {
    const cx = Math.round(g.node(n.id).x);
    columns.set(cx, Math.max(columns.get(cx) ?? 0, width(n.id)));
  }
  let laid = flow.nodes.map((n) => {
    const p = g.node(n.id);
    const cx = Math.round(p.x);
    return {
      ...n,
      x: Math.round(cx - (columns.get(cx) ?? width(n.id)) / 2),
      y: Math.round(p.y - NODE_H / 2),
    };
  });
  // The way most items go (each step's first outcome, from the first trigger) runs along one
  // row: dagre centres a step between its branches, so each column is moved to keep it there.
  const line = laid.find((n) => n.id === order[0])?.y ?? 0;
  const main: string[] = [];
  for (let id = order[0]; id && !main.includes(id); ) {
    main.push(id);
    const next = forward.filter((c) => c.from === id).sort((a, b) => index(a) - index(b))[0];
    id = next?.to;
  }
  for (const id of main) {
    const n = laid.find((m) => m.id === id);
    if (!n || n.y === line) continue;
    const by = line - n.y;
    const column = n.x;
    laid = laid.map((m) => (m.x === column ? { ...m, y: m.y + by } : m));
  }
  // Side branches hang below that row, as one reads down a page: dagre may set them above it,
  // and then the whole is turned over.
  const above = laid.filter((n) => n.y < line).length;
  const below = laid.filter((n) => n.y > line).length;
  if (above > below) laid = laid.map((n) => ({ ...n, y: 2 * line - n.y }));
  laid = cleared(laid, forward);
  const after = boundsOf(laid);
  const dx = before.minX - after.minX;
  const dy = before.minY - after.minY;
  return { ...flow, nodes: laid.map((n) => ({ ...n, x: n.x + dx, y: n.y + dy })) };
}

/** Everything the canvas needs to draw a workflow's connectors clear of one another. */
export interface Routing {
  /** Loops, and connectors whose target is too far back for a curve: run beneath. */
  below: Set<string>;
  lanes: LoopLanes;
  fit: Map<string, Fit>;
}

/** Narrower than this, a chip says nothing, and its port names the outcome instead. */
const CHIP_MIN = 32;

export function routing(flow: WorkflowDefinition): Routing {
  const { loops } = flowShape(flow);
  const at = new Map(flow.nodes.map((n) => [n.id, n]));
  const below = new Set(
    flow.connectors
      .filter((c) => {
        const from = at.get(c.from);
        const to = at.get(c.to);
        return (
          loops.has(c.id) ||
          // Chips shrink to the room there is: only a target behind the shortest lead is out of
          // a curve's reach.
          (from !== undefined && to !== undefined && to.x < from.x + NODE_W + 28 + 48)
        );
      })
      .map((c) => c.id),
  );
  return { below, lanes: loopLanes(flow, below), fit: fits(flow) };
}

/** How wide a connector's chip is drawn, or 0 when it is not: no words, or no room for them. */
export function chipShown(flow: WorkflowDefinition, route: Routing, c: WorkflowConnector): number {
  const words = connectorChip(flow, c);
  if (!words) return 0;
  const width = Math.min(chipWidth(words), route.fit.get(c.from)?.chip ?? 0);
  return width >= CHIP_MIN ? width : 0;
}

/** Where the first lane beneath a workflow runs, below its lowest step, and the step between lanes. */
export const LANE_FIRST = 36;
export const LANE_STEP = 18;

/** How far beneath its lowest step a workflow's lanes reach: room kept before the next. */
export function depthBelow(route: Routing): number {
  const lanes = [...route.lanes.lane.values()];
  return lanes.length === 0 ? 0 : LANE_FIRST + Math.max(...lanes) * LANE_STEP + 12;
}
