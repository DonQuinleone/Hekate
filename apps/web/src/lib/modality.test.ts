import { afterEach, describe, expect, it } from "vitest";
import { followInputModality } from "./modality";

describe("the input modality", () => {
  let stop: () => void = () => {};
  afterEach(() => stop());

  it("follows the pointer and the keyboard, ignoring a modifier alone", () => {
    const root = document.createElement("div");
    stop = followInputModality(root);
    expect(root.dataset.input).toBeUndefined();
    window.dispatchEvent(new Event("pointerdown"));
    expect(root.dataset.input).toBe("pointer");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift" }));
    expect(root.dataset.input).toBe("pointer");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" }));
    expect(root.dataset.input).toBe("keyboard");
  });
});
