import { describe, expect, it } from "vitest";
import { isShortcutHint } from "./shortcut-hint";

describe("a menu item's hint", () => {
  it("is a shortcut when it is keys", () => {
    expect(isShortcutHint("⌘X")).toBe(true);
    expect(isShortcutHint("Ctrl+V")).toBe(true);
    expect(isShortcutHint("⌘⇧Z")).toBe(true);
    expect(isShortcutHint("?")).toBe(true);
  });

  it("is words otherwise, kept on a touch screen", () => {
    expect(isShortcutHint("Finish: Approved")).toBe(false);
    expect(isShortcutHint("Producer")).toBe(false);
    expect(isShortcutHint("3")).toBe(false);
    expect(isShortcutHint("Active · 3 steps")).toBe(false);
    expect(isShortcutHint("A step sets it: change the step first")).toBe(false);
  });
});
