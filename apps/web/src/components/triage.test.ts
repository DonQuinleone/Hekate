import { describe, expect, it } from "vitest";
import { triageLoop } from "./triage";

describe("triageLoop", () => {
  it("loops a passage with a second either side, within the file", () => {
    expect(triageLoop({ kind: "time", start: 21.4, end: 23 }, 60)).toEqual({
      start: 20.4,
      end: 24,
    });
    expect(triageLoop({ kind: "time", start: 0.5, end: 5 }, 5.5)).toEqual({ start: 0, end: 5.5 });
  });

  it("gives a moment a few seconds to be heard", () => {
    expect(triageLoop({ kind: "time", start: 6.2, end: 6.2 })).toEqual({ start: 5.2, end: 10.2 });
  });

  it("plays bars from the moment they were named, and nothing for the whole file", () => {
    expect(
      triageLoop({ kind: "bar", from: { bar: 9, beat: 1 }, to: { bar: 12 }, at: 14.2 }),
    ).toEqual({
      start: 13.2,
      end: 18.2,
    });
    expect(triageLoop({ kind: "bar", from: { bar: 9, beat: 1 } })).toBeNull();
    expect(triageLoop(null)).toBeNull();
  });
});
