import { flowShape, outcomesOf, type WorkflowDefinition, workflowFromYaml } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import { workflowTemplates } from "./workflow-code";
import {
  CHIP_H,
  chipShown,
  chipWidth,
  connectorChip,
  depthBelow,
  fits,
  LABEL_CHARS,
  LANE_FIRST,
  LANE_STEP,
  leadOf,
  loopLanes,
  pathLabel,
  routing,
  tidied,
} from "./workflow-layout";
import { boundsOf, NODE_H, NODE_W, outPort, portTop } from "./workflow-nodes";

const step = (
  id: string,
  type: WorkflowDefinition["nodes"][number]["type"],
  name: string,
  x = 0,
  y = 0,
  groupId?: string,
) => ({ id, type, name, x, y, config: {}, ...(groupId ? { groupId } : {}) });

// The seeded album review, piled into one corner as a hand-made workflow might be.
const album: WorkflowDefinition = {
  groups: [{ id: "round", name: "First round" }],
  nodes: [
    step("start", "upload", "A version is uploaded"),
    step("notes", "feedback", "Soloists' notes", 10, 10, "round"),
    step("edit", "task", "Engineer edits", 20, 20, "round"),
    step("label", "approval", "Label approval", 30, 30),
    step("done", "finish", "Approved", 40, 40),
    step("tell", "notify", "Tell the producer", 50, 50),
  ],
  connectors: [
    { id: "c1", from: "start", outcome: "happened", to: "notes" },
    { id: "c2", from: "notes", outcome: "done", to: "edit" },
    { id: "c3", from: "notes", outcome: "overdue", to: "edit" },
    { id: "c4", from: "edit", outcome: "done", to: "label" },
    { id: "c5", from: "edit", outcome: "overdue", to: "label" },
    { id: "c6", from: "label", outcome: "approved", to: "done" },
    { id: "c7", from: "label", outcome: "changes", to: "notes", until: { times: 3 } },
    { id: "c8", from: "label", outcome: "mixed", to: "tell" },
    { id: "c9", from: "tell", outcome: "sent", to: "done" },
    { id: "c10", from: "edit", outcome: "overdue", to: "edit", until: { times: 2 } },
  ],
};

const overlap = (a: { x: number; y: number }, b: { x: number; y: number }, gap = 0) =>
  a.x < b.x + NODE_W + gap &&
  b.x < a.x + NODE_W + gap &&
  a.y < b.y + NODE_H + gap &&
  b.y < a.y + NODE_H + gap;

// The seeded delivery: checks, then the master filed, or a new export asked for.
const delivery: WorkflowDefinition = {
  groups: [],
  nodes: [
    step("start", "upload", "A version is uploaded"),
    step("qa", "checks", "Delivery checks"),
    step("file", "move", "File the master"),
    step("done", "finish", "Delivered"),
    step("tell", "notify", "Ask for a new export"),
  ],
  connectors: [
    { id: "c1", from: "start", outcome: "happened", to: "qa" },
    { id: "c2", from: "qa", outcome: "passed", to: "file" },
    { id: "c3", from: "file", outcome: "moved", to: "done" },
    { id: "c4", from: "qa", outcome: "failed", to: "tell" },
    { id: "c5", from: "tell", outcome: "sent", to: "done" },
  ],
};

const flows: [string, WorkflowDefinition][] = [
  ["the album review", album],
  ["the delivery", delivery],
  ...workflowTemplates.map((t): [string, WorkflowDefinition] => {
    const read = workflowFromYaml(t.text);
    if (!read.ok) throw new Error(t.name);
    return [t.name, read.definition];
  }),
];

describe("tidying a workflow up", () => {
  it.each(flows)("leaves no two steps of %s touching", (_, flow) => {
    const { nodes } = tidied(flow);
    for (const a of nodes)
      for (const b of nodes)
        if (a !== b) expect(overlap(a, b, 24), `${a.id} and ${b.id}`).toBe(false);
  });

  it.each(flows)("runs every forward connector of %s left to right, past its chips", (_, flow) => {
    const laid = tidied(flow);
    const { loops } = flowShape(laid);
    const at = new Map(laid.nodes.map((n) => [n.id, n]));
    for (const c of laid.connectors) {
      if (loops.has(c.id)) continue;
      const from = at.get(c.from);
      const to = at.get(c.to);
      if (!from || !to) throw new Error(c.id);
      expect(to.x, c.id).toBeGreaterThanOrEqual(from.x + NODE_W + leadOf(laid, from.id) + 40);
    }
  });

  it.each(flows)("passes no straight connector of %s through or beside another step", (_, flow) => {
    const laid = tidied(flow);
    const { loops } = flowShape(laid);
    const at = new Map(laid.nodes.map((n) => [n.id, n]));
    for (const c of laid.connectors) {
      const from = at.get(c.from);
      const to = at.get(c.to);
      if (!from || !to || loops.has(c.id) || from.y !== to.y) continue;
      const y = outPort(from, c.outcome).y;
      for (const n of laid.nodes) {
        if (n === from || n === to || n.x + NODE_W < from.x + NODE_W || n.x > to.x) continue;
        expect(y > n.y - 24 && y < n.y + NODE_H + 24, `${c.id} by ${n.id}`).toBe(false);
      }
    }
  });

  it.each(flows)("keeps the way most items go through %s on one row", (_, flow) => {
    const laid = tidied(flow);
    const { order, loops } = flowShape(laid);
    const ys: number[] = [];
    const seen = new Set<string>();
    for (let id = order[0]; id && !seen.has(id); ) {
      seen.add(id);
      ys.push(laid.nodes.find((n) => n.id === id)?.y ?? Number.NaN);
      const from = laid.nodes.find((n) => n.id === id);
      const first = from && outcomesOf(from.type)[0]?.id;
      id = laid.connectors.find(
        (c) => c.from === id && c.outcome === first && !loops.has(c.id),
      )?.to;
    }
    expect(new Set(ys).size).toBe(1);
  });

  it("keeps the main line straight, the workflow where it was, and everything but positions", () => {
    const laid = tidied(album);
    const y = (id: string) => laid.nodes.find((n) => n.id === id)?.y;
    expect(new Set([y("start"), y("notes"), y("edit"), y("label"), y("done")]).size).toBe(1);
    // A side branch hangs wholly below the main row, clear of the line through it.
    expect(y("tell")).toBeGreaterThanOrEqual((y("done") ?? 0) + NODE_H + 24);
    const before = boundsOf(album.nodes);
    const after = boundsOf(laid.nodes);
    expect([after.minX, after.minY]).toEqual([before.minX, before.minY]);
    expect(laid.connectors).toBe(album.connectors);
    expect(laid.nodes.map(({ x: _x, y: _y, ...rest }) => rest)).toEqual(
      album.nodes.map(({ x: _x, y: _y, ...rest }) => rest),
    );
  });

  it("keeps a stage's steps together, with nothing else among them", () => {
    const laid = tidied(album);
    const members = laid.nodes.filter((n) => n.groupId === "round");
    const box = boundsOf(members);
    for (const n of laid.nodes.filter((m) => m.groupId !== "round"))
      expect(
        n.x + NODE_W > box.minX && n.x < box.maxX && n.y + NODE_H > box.minY && n.y < box.maxY,
        n.id,
      ).toBe(false);
  });

  it("lays out the same again", () => {
    const once = tidied(album);
    expect(tidied(once).nodes).toEqual(once.nodes);
  });
});

describe("the chips on connectors", () => {
  it("say the outcome where there are several, and the connector's own condition", () => {
    const chip = (id: string) => {
      const c = album.connectors.find((x) => x.id === id);
      if (!c) throw new Error(id);
      return connectorChip(album, c);
    };
    expect(chip("c1")).toBeNull();
    expect(chip("c2")).toBe("submitted");
    expect(chip("c7")).toBe("changes requested · at most 3×");
    expect(chip("c9")).toBeNull();
  });

  it("never meet beside one node: ports are further apart than a chip is tall", () => {
    const label = album.nodes.find((n) => n.id === "label");
    if (!label) throw new Error("label");
    const ys = ["approved", "mixed", "changes"]
      .map((o) => outPort(label, o).y)
      .sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i += 1)
      expect((ys[i] ?? 0) - (ys[i - 1] ?? 0)).toBeGreaterThan(CHIP_H + 2);
  });
});

describe("chips where steps sit close", () => {
  it("are cut short, never running into the step a connector leads to", () => {
    // Steps 320 px apart, as a workflow placed by hand may have them.
    const close: WorkflowDefinition = {
      ...album,
      nodes: album.nodes.map((n, i) => ({ ...n, x: i * 320, y: 0 })),
    };
    const { loops } = flowShape(close);
    const fit = fits(close);
    for (const c of close.connectors) {
      if (loops.has(c.id)) continue;
      const from = close.nodes.find((n) => n.id === c.from);
      const to = close.nodes.find((n) => n.id === c.to);
      const f = fit.get(c.from);
      if (!from || !to || !f) throw new Error(c.id);
      // One leading back runs beneath the workflow instead.
      if (to.x < from.x + NODE_W) continue;
      expect(from.x + NODE_W + f.lead, c.id).toBeLessThanOrEqual(to.x - 40);
      expect(f.chip, c.id).toBeLessThanOrEqual(f.lead);
    }
  });

  it("are whole where there is room, as after tidying up", () => {
    const laid = tidied(album);
    const fit = fits(laid);
    expect(fit.get("label")?.lead).toBe(leadOf(laid, "label"));
  });
});

describe("steps so close a connector runs beneath", () => {
  it("still bound the chips, which give way to the port's own words", () => {
    // Engineer edits starts 40 px past the end of Soloists' notes: too close to curve into.
    const cramped: WorkflowDefinition = {
      ...album,
      nodes: album.nodes.map((n) => ({
        ...n,
        x: n.id === "notes" ? 0 : n.id === "edit" ? NODE_W + 40 : 2000,
        y: 0,
      })),
    };
    const route = routing(cramped);
    for (const c of cramped.connectors.filter((x) => x.from === "notes" && x.to === "edit")) {
      expect(route.below.has(c.id), c.id).toBe(true);
      expect(chipShown(cramped, route, c), c.id).toBe(0);
    }
  });
});

describe("the room beneath a workflow", () => {
  it("reaches past its deepest lane, and is none without lanes", () => {
    const route = routing(album);
    const deepest = Math.max(...route.lanes.lane.values());
    expect(depthBelow(route)).toBeGreaterThan(LANE_FIRST + deepest * LANE_STEP);
    expect(depthBelow(routing(tidied(delivery)))).toBe(0);
  });
});

describe("loops beneath a workflow", () => {
  it("put the shorter loop nearer, and set loops from one node side by side", () => {
    const laid = tidied(album);
    const lanes = loopLanes(laid, flowShape(laid).loops);
    expect(lanes.lane.get("c10")).toBe(0);
    expect(lanes.lane.get("c7")).toBe(1);
    expect(lanes.into.get("c10")).toBe(0);
  });
});

describe("a node's outputs and its paths' labels (#513)", () => {
  it("spaces outputs evenly about the node's middle", () => {
    for (const type of ["checks", "approval", "feedback", "notify"] as const) {
      const tops = outcomesOf(type).map((_, i) => portTop(type, i));
      const middle = tops.reduce((a, b) => a + b, 0) / tops.length;
      expect(middle).toBe(NODE_H / 2);
      const gaps = tops.slice(1).map((t, i) => t - (tops[i] ?? 0));
      expect(new Set(gaps).size).toBeLessThanOrEqual(1);
      // Each port, with its own room, inside the node.
      for (const t of tops) expect(t - 7 >= 0 && t + 7 <= NODE_H).toBe(true);
    }
  });

  it("shows a label whole up to about 32 characters, then cuts it with an ellipsis", () => {
    const thirty = "warnings · if tagged Reference";
    expect(thirty).toHaveLength(30);
    expect(pathLabel(thirty)).toBe(thirty);
    expect(pathLabel("x".repeat(LABEL_CHARS))).toHaveLength(LABEL_CHARS);
    const long = "changes requested · unless tagged Rough mix for the label";
    const cut = pathLabel(long);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(LABEL_CHARS);
    // At a word where one is near, never mid-word when it need not be.
    expect(cut).toBe("changes requested · unless…");
  });

  it("gives a label of 30 characters room enough to show whole, where the steps allow", () => {
    const flow: WorkflowDefinition = {
      groups: [],
      nodes: [step("qa", "checks", "QA check", 0), step("ok", "approval", "Sign-off", 600, 120)],
      connectors: [
        {
          id: "w",
          from: "qa",
          outcome: "warnings",
          to: "ok",
          condition: { test: "tag", is: "Reference" },
        },
      ],
    };
    const chip = connectorChip(
      flow,
      flow.connectors[0] as WorkflowDefinition["connectors"][number],
    );
    expect(chip).toBe("warnings · if tagged Reference");
    const width = chipShown(flow, routing(flow), flow.connectors[0] as never);
    expect(width).toBe(chipWidth(chip ?? ""));
    expect(width).toBeGreaterThanOrEqual(30 * 6.6);
  });
});
