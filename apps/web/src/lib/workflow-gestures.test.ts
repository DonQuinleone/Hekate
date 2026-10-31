import { describe, expect, it } from "vitest";
import {
  ADD_GAP,
  dropTarget,
  landing,
  pinched,
  type View,
  wheelFactor,
  ZOOM_MAX,
  ZOOM_MIN,
  zoomAbout,
} from "./workflow-gestures";
import { NODE_H, NODE_W, outPort } from "./workflow-nodes";

const view: View = { pan: { x: 100, y: 50 }, zoom: 1 };
/** Where a point of the canvas lies in the workflow's own pixels. */
const world = (v: View, p: { x: number; y: number }) => ({
  x: (p.x - v.pan.x) / v.zoom,
  y: (p.y - v.pan.y) / v.zoom,
});

describe("zooming the canvas (#511)", () => {
  it("keeps what is under the pointer under it", () => {
    const at = { x: 400, y: 300 };
    const zoomed = zoomAbout(view, 1.5, at);
    expect(zoomed.zoom).toBe(1.5);
    expect(world(zoomed, at)).toEqual(world(view, at));
  });

  it("stays within its bounds", () => {
    expect(zoomAbout(view, 100, { x: 0, y: 0 }).zoom).toBe(ZOOM_MAX);
    expect(zoomAbout(view, 0.001, { x: 0, y: 0 }).zoom).toBe(ZOOM_MIN);
  });

  it("reads a trackpad's small steps smoothly and a mouse's notch as a tenth", () => {
    expect(wheelFactor(-100)).toBeCloseTo(1.105, 3);
    expect(wheelFactor(100)).toBeCloseTo(0.905, 3);
    expect(wheelFactor(2)).toBeGreaterThan(0.97);
    expect(wheelFactor(3, 1)).toBeCloseTo(wheelFactor(48), 6);
    expect(wheelFactor(0)).toBe(1);
  });

  it("zooms by a pinch about the point between the fingers, and follows it", () => {
    const before: [{ x: number; y: number }, { x: number; y: number }] = [
      { x: 300, y: 300 },
      { x: 500, y: 300 },
    ];
    // Spread to twice as far apart, about the same middle.
    const spread = pinched(view, before, [
      { x: 200, y: 300 },
      { x: 600, y: 300 },
    ]);
    expect(spread.zoom).toBe(2);
    expect(world(spread, { x: 400, y: 300 })).toEqual(world(view, { x: 400, y: 300 }));
    // Moved together without spreading: the canvas pans with them, no zoom.
    const moved = pinched(view, before, [
      { x: 330, y: 340 },
      { x: 530, y: 340 },
    ]);
    expect(moved).toEqual({ zoom: 1, pan: { x: 130, y: 90 } });
  });
});

describe("dropping a kind on the canvas (#511)", () => {
  const nodes = [
    { id: "qa", type: "checks" as const, x: 0, y: 0 },
    { id: "end", type: "finish" as const, x: 600, y: 0 },
  ];

  it("wires it from the output it is dropped on", () => {
    const warn = outPort(nodes[0] as (typeof nodes)[number], "warnings");
    expect(dropTarget(nodes, { x: warn.x + 10, y: warn.y + 4 })).toEqual({
      nodeId: "qa",
      outcome: "warnings",
    });
    const failed = outPort(nodes[0] as (typeof nodes)[number], "failed");
    expect(dropTarget(nodes, { x: failed.x - 6, y: failed.y + 3 })?.outcome).toBe("failed");
  });

  it("wires it from a node's first free output when dropped on the node", () => {
    expect(dropTarget(nodes, { x: 40, y: NODE_H / 2 })).toEqual({
      nodeId: "qa",
      outcome: "passed",
    });
    const wired = (id: string, o: string) => id === "qa" && o === "passed";
    expect(dropTarget(nodes, { x: 40, y: NODE_H / 2 }, wired)?.outcome).toBe("warnings");
  });

  it("wires nothing from a finish, nor where nothing is", () => {
    expect(dropTarget(nodes, { x: 640, y: NODE_H / 2 })).toBeNull();
    expect(dropTarget(nodes, { x: 300, y: 400 })).toBeNull();
  });

  it("lands centred where it is let go, or beside the output it is wired from", () => {
    expect(landing({ x: 500, y: 300 })).toEqual({ x: 500 - NODE_W / 2, y: 300 - NODE_H / 2 });
    const from = { node: nodes[0] as (typeof nodes)[number], outcome: "failed" };
    const port = outPort(from.node, "failed");
    expect(landing({ x: 0, y: 0 }, from)).toEqual({
      x: NODE_W + ADD_GAP,
      y: port.y - NODE_H / 2,
    });
  });
});
