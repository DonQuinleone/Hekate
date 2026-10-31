import { ACTION_TYPES, EVENT_TYPES, type NodeType, nodeTypes } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import {
  GROUP_ORDER,
  groupOf,
  groups,
  kindLine,
  kindsByGroup,
  paletteKinds,
  pickerTypes,
} from "./workflow-kinds";
import { nodeLooks } from "./workflow-nodes";

const every: NodeType[] = [...EVENT_TYPES, ...ACTION_TYPES];

describe("the kinds of node", () => {
  it("puts every kind in exactly one family", () => {
    const listed = GROUP_ORDER.flatMap((g) => kindsByGroup[g]);
    expect([...listed].sort()).toEqual([...every].sort());
    expect(groupOf("checks")).toBe("qa");
    expect(groupOf("approval")).toBe("review");
    expect(groupOf("status")).toBe("status");
    expect(groupOf("upload")).toBe("start");
    expect(groupOf("comment")).toBe("wait");
  });

  it("never draws two kinds alike: no two share an icon and a colour", () => {
    const looks = every.map((t) => `${nodeLooks[t].icon} in ${groups[groupOf(t)].colour}`);
    expect(new Set(looks).size).toBe(every.length);
  });

  it("gives no two families one colour", () => {
    const colours = GROUP_ORDER.map((g) => groups[g].colour);
    expect(new Set(colours).size).toBe(colours.length);
  });

  it("names every kind differently, each with a line on what it does", () => {
    const names = every.map((t) => nodeTypes[t].label.toLowerCase());
    expect(new Set(names).size).toBe(every.length);
    for (const t of every) expect(nodeLooks[t].hint.length).toBeGreaterThan(8);
    expect(nodeTypes.checks.label).toBe("QA check");
  });

  it("tells an approval review from a status that says Approved", () => {
    const review = kindLine({ type: "approval", config: { who: "Label" } });
    const approve = kindLine({ type: "status", config: { status: "Approved" } });
    expect(review).toBe("Approval review");
    expect(approve).toBe("Set status: Approved");
    expect(kindLine({ type: "status", config: {} })).toBe("Set status");
  });
});

describe("what the Add button offers (#511)", () => {
  it("offers families first, in the order a workflow reads, Start only on an empty canvas", () => {
    expect(pickerTypes({ hasStart: false }).map((t) => t.key)).toEqual([
      "start",
      "qa",
      "review",
      "task",
      "wait",
      "status",
      "notify",
      "finish",
    ]);
    const started = pickerTypes({ hasStart: true });
    expect(started.map((t) => t.key)).toEqual([
      "qa",
      "review",
      "task",
      "wait",
      "status",
      "notify",
      "finish",
      "new",
    ]);
    expect(started.at(-1)?.kinds).toEqual(kindsByGroup.start);
  });

  it("orders kinds within a family as they are met, and lets a wait be for a version", () => {
    const by = (key: string) => pickerTypes({ hasStart: true }).find((t) => t.key === key)?.kinds;
    expect(by("review")).toEqual(["feedback", "approval"]);
    expect(by("status")).toEqual(["status", "move"]);
    expect(by("wait")?.[0]).toBe("wait");
    expect(by("wait")).toContain("upload");
    expect(by("wait")).not.toContain("manual");
    expect(by("qa")).toEqual(["checks"]);
  });

  it("puts every action, and nothing else, on the palette", () => {
    const listed = paletteKinds.flat();
    expect([...listed].sort()).toEqual([...ACTION_TYPES].sort());
    expect(paletteKinds[0]).toEqual(["checks"]);
  });
});
