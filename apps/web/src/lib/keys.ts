/**
 * Keyboard bindings, written as people read them: "k", "Space", "Shift+L", "Mod+K" (⌘ on a
 * Mac, Ctrl elsewhere), "?", and a sequence such as "g h" (g, then h within a second).
 */

export interface KeyPress {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** The second key of a sequence must follow the first within this long. */
export const SEQUENCE_MS = 1000;

const named: Record<string, string> = { " ": "Space", Esc: "Escape" };

/** Whether one written stroke ("Shift+L", "Mod+K", "?") is this key press. */
export function strokeMatches(stroke: string, press: KeyPress, mac: boolean): boolean {
  const parts = stroke.split("+");
  const key = parts.pop() ?? "";
  const mods = new Set(parts);
  const mod = mac ? press.metaKey : press.ctrlKey;
  if (mods.has("Mod") !== mod) return false;
  // The other platform's command key is never part of a plain binding.
  if (!mods.has("Mod") && (press.metaKey || press.ctrlKey)) return false;
  if (mods.has("Alt") !== press.altKey) return false;
  const pressed = named[press.key] ?? press.key;
  if (key.length === 1 && /[a-z]/i.test(key)) {
    // A letter: Shift is part of the binding, written as such, never implied by the case.
    if (mods.has("Shift") !== press.shiftKey) return false;
    return pressed.toLowerCase() === key.toLowerCase();
  }
  // Anything else ("?", "[", "ArrowLeft") is matched by what the key produced.
  if (mods.has("Shift") && !press.shiftKey) return false;
  return pressed === key;
}

export type Match = "match" | "first" | null;

/**
 * How a press relates to a binding, given the first stroke of a sequence still waiting (or
 * null): the whole binding, the first stroke of a sequence, or nothing.
 */
export function matchBinding(
  binding: string,
  press: KeyPress,
  waiting: string | null,
  mac: boolean,
): Match {
  const strokes = binding.split(" ");
  if (strokes.length === 1) return strokeMatches(binding, press, mac) ? "match" : null;
  const [first, second] = strokes;
  if (!first || !second) return null;
  if (waiting === first && strokeMatches(second, press, mac)) return "match";
  return strokeMatches(first, press, mac) ? "first" : null;
}

const glyphs: Record<string, string> = {
  Space: "Space",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Escape: "Esc",
  Enter: "↵",
};

/** A binding as key caps: each stroke's keys, in order ("Mod+K" on a Mac is ⌘ K). */
export function keyCaps(binding: string, mac: boolean): string[][] {
  return binding.split(" ").map((stroke) =>
    stroke.split("+").map((k) => {
      if (k === "Mod") return mac ? "⌘" : "Ctrl";
      if (k === "Shift") return "⇧";
      if (k === "Alt") return mac ? "⌥" : "Alt";
      return glyphs[k] ?? (k.length === 1 ? k.toUpperCase() : k);
    }),
  );
}

export const isMac = () =>
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
