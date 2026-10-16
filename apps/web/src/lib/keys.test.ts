import { describe, expect, it } from "vitest";
import { type KeyPress, keyCaps, matchBinding, strokeMatches } from "./keys";

const press = (key: string, mods: Partial<KeyPress> = {}): KeyPress => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("key bindings", () => {
  it("matches a letter whatever the case, but never with Shift unless written", () => {
    expect(strokeMatches("k", press("k"), false)).toBe(true);
    expect(strokeMatches("k", press("K"), false)).toBe(true);
    expect(strokeMatches("k", press("K", { shiftKey: true }), false)).toBe(false);
    expect(strokeMatches("Shift+L", press("L", { shiftKey: true }), false)).toBe(true);
    expect(strokeMatches("Shift+L", press("l"), false)).toBe(false);
  });

  it("reads Mod as Command on a Mac and Control elsewhere", () => {
    expect(strokeMatches("Mod+K", press("k", { metaKey: true }), true)).toBe(true);
    expect(strokeMatches("Mod+K", press("k", { ctrlKey: true }), true)).toBe(false);
    expect(strokeMatches("Mod+K", press("k", { ctrlKey: true }), false)).toBe(true);
    // A plain binding never fires with a command key held.
    expect(strokeMatches("k", press("k", { metaKey: true }), true)).toBe(false);
  });

  it("matches symbols by what the key produced, Shift or not", () => {
    expect(strokeMatches("?", press("?", { shiftKey: true }), false)).toBe(true);
    expect(strokeMatches("[", press("["), false)).toBe(true);
    expect(strokeMatches("Space", press(" "), false)).toBe(true);
    expect(strokeMatches(",", press("."), false)).toBe(false);
  });

  it("follows a sequence: the first stroke waits, the second completes it", () => {
    expect(matchBinding("g h", press("g"), null, false)).toBe("first");
    expect(matchBinding("g h", press("h"), "g", false)).toBe("match");
    expect(matchBinding("g h", press("h"), null, false)).toBe(null);
    expect(matchBinding("g h", press("i"), "g", false)).toBe(null);
  });

  it("shows bindings as key caps", () => {
    expect(keyCaps("Mod+K", true)).toEqual([["⌘", "K"]]);
    expect(keyCaps("Mod+K", false)).toEqual([["Ctrl", "K"]]);
    expect(keyCaps("g h", false)).toEqual([["G"], ["H"]]);
    expect(keyCaps("ArrowLeft", false)).toEqual([["←"]]);
  });
});
