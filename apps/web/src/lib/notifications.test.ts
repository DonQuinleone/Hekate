import { describe, expect, it } from "vitest";
import { byDay } from "./notifications";
import type { AppNotification } from "./queries";

const n = (id: string, createdAt: string): AppNotification => ({
  id,
  kind: "decision",
  actorName: "Mira Solberg",
  actorUserId: null,
  actorGuestId: null,
  text: "approved Album masters",
  link: "/reviews/r",
  readAt: null,
  createdAt,
});

describe("byDay", () => {
  it("groups by when they arrived, leaving out empty groups", () => {
    const now = new Date(2026, 9, 15, 14, 0).getTime();
    const local = (day: number, hour: number) => new Date(2026, 9, day, hour).toISOString();
    const groups = byDay(
      [n("a", local(15, 9)), n("b", local(14, 22)), n("c", local(10, 8)), n("d", local(1, 8))],
      now,
    );
    expect(groups.map(([label, items]) => [label, items.map((i) => i.id)])).toEqual([
      ["Today", ["a"]],
      ["Yesterday", ["b"]],
      ["Earlier this week", ["c"]],
      ["Older", ["d"]],
    ]);
    expect(byDay([n("a", local(15, 9))], now).map(([label]) => label)).toEqual(["Today"]);
  });
});
