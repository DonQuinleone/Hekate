import { ACTION_TYPES, EVENT_TYPES, type NodeType, nodeTypes } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import { GROUP_ORDER, groupOf, groups, kindLine, kindsByGroup } from "./workflow-kinds";
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
