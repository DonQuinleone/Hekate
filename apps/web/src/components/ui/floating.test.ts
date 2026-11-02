import { describe, expect, it } from "vitest";
import { besidePlace } from "./floating";

// A window 1000 by 800, its layer from the origin.
const H = { left: 0, top: 0, width: 1000, height: 800 };
const box = { w: 256, h: 300, gap: 4 } as const;

describe("besidePlace", () => {
  it("opens to the right of a rail, its top on the anchor's top", () => {
    const A = { left: 10, right: 50, top: 100, bottom: 140 };
    expect(besidePlace(A, H, { ...box, side: "right", align: "start" })).toMatchObject({
      left: 54,
      top: 100,
    });
  });

  it("lines its foot up with the anchor's for a menu at the foot of the rail", () => {
    const A = { left: 10, right: 50, top: 740, bottom: 784 };
    expect(besidePlace(A, H, { ...box, side: "right", align: "end" })).toMatchObject({
      left: 54,
      top: 484,
    });
  });

  it("flips to the left when there is no room on the right", () => {
    const A = { left: 900, right: 990, top: 100, bottom: 140 };
    expect(besidePlace(A, H, { ...box, side: "right", align: "start" }).left).toBe(640);
  });

  it("stays inside the window, and scrolls when taller than it", () => {
    const A = { left: 10, right: 50, top: 700, bottom: 740 };
    expect(besidePlace(A, H, { ...box, side: "right", align: "start" }).top).toBe(492);
    const tall = besidePlace(A, H, { ...box, h: 900, side: "right", align: "start" });
    expect(tall).toMatchObject({ top: 8, maxHeight: 784 });
  });
});
