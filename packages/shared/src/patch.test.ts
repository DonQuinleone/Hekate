import { describe, expect, it } from "vitest";
import { nextChannel, patchRowChangeInput, patchRowInput } from "./patch.ts";

describe("the patch list", () => {
  it("numbers a new channel one past the highest", () => {
    expect(nextChannel([])).toBe(1);
    expect(nextChannel([{ channel: 1 }, { channel: 4 }, { channel: 2 }])).toBe(5);
  });

  it("takes a channel with blanks for what is not yet known", () => {
    expect(patchRowInput.parse({ direction: "input", source: " Main L " })).toEqual({
      direction: "input",
      source: "Main L",
      device: "",
      cable: "",
      notes: "",
    });
    expect(patchRowInput.safeParse({ direction: "sideways" }).success).toBe(false);
    expect(patchRowInput.safeParse({ direction: "input", channel: 0 }).success).toBe(false);
  });

  it("refuses a change that changes nothing", () => {
    expect(patchRowChangeInput.safeParse({}).success).toBe(false);
    expect(patchRowChangeInput.parse({ cable: "A3" })).toEqual({ cable: "A3" });
  });
});
