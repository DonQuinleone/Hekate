import type { Theme } from "@hekate/shared";
import { useEffect, useSyncExternalStore } from "react";

const KEY = "hekate.theme";

/** How each theme is named in Appearance, and its swatch: ground, signal, ink. */
export const themeChoices: { id: Exclude<Theme, "system">; name: string; colours: string[] }[] = [
  { id: "signal-dark", name: "Signal, dark", colours: ["#0a0a0b", "#f0762e", "#f4f4f5"] },
  { id: "signal-light", name: "Signal, light", colours: ["#f4f4f2", "#b53c0a", "#111113"] },
  { id: "catppuccin", name: "Catppuccin", colours: ["#1e1e2e", "#f5c2e7", "#cdd6f4"] },
  { id: "dracula", name: "Dracula", colours: ["#282a36", "#bd93f9", "#f8f8f2"] },
  { id: "gruvbox", name: "Gruvbox", colours: ["#282828", "#fe8019", "#ebdbb2"] },
  { id: "rose-pine", name: "Rosé Pine", colours: ["#1f1d2e", "#ebbcba", "#e0def4"] },
  { id: "osaka-jade", name: "Osaka Jade", colours: ["#111c18", "#5fb39b", "#d6e8e0"] },
  { id: "kanagawa", name: "Kanagawa", colours: ["#1f1f28", "#7e9cd8", "#dcd7ba"] },
  { id: "solarized", name: "Solarized", colours: ["#002b36", "#d4a20b", "#eee8d5"] },
];

/**
 * Each theme's ground (`--hk-ground` in themes.css), for the browser's own chrome: the status
 * and address bars on a phone. Kept in step with themes.css and public/theme-boot.js.
 */
export const themeGrounds: Record<Exclude<Theme, "system">, string> = {
  "signal-dark": "#0a0a0b",
  "signal-light": "#f4f4f2",
  catppuccin: "#181825",
  dracula: "#21222c",
  gruvbox: "#1d2021",
  "rose-pine": "#191724",
  "osaka-jade": "#111c18",
  kanagawa: "#16161d",
  solarized: "#002731",
};

/** Fired on the window whenever the theme shown changes. */
const CHANGED = "hekate:theme";

const prefersLight = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches;

/** The theme a choice shows now: "system" is dark or light as the device is. */
export const resolveTheme = (choice: Theme, light = prefersLight()): Exclude<Theme, "system"> =>
  choice === "system" ? (light ? "signal-light" : "signal-dark") : choice;

/** Show a theme, and remember the choice on this device for the next first paint. */
export function applyTheme(choice: Theme) {
  const theme = resolveTheme(choice);
  const shown = document.documentElement.dataset.theme ?? "signal-dark";
  if (theme === "signal-dark") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", themeGrounds[theme] ?? themeGrounds["signal-dark"]);
  if (theme !== shown) window.dispatchEvent(new Event(CHANGED));
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    // Not remembered; the server keeps the choice for signed-in members anyway.
  }
}

/** The choice remembered on this device, for pages before anyone signs in. */
export function storedTheme(): Theme {
  try {
    return (localStorage.getItem(KEY) as Theme | null) ?? "system";
  } catch {
    return "system";
  }
}

/**
 * Keep the page in the member's theme once it is known (never the default while loading,
 * which would undo a choice remembered on this device).
 */
export function useThemeSync(choice: Theme | undefined) {
  useEffect(() => {
    if (choice) applyTheme(choice);
  }, [choice]);
}

/**
 * Follow the device between dark and light while the choice on this device is "system", on
 * every page: signed in or not, and a guest's.
 */
export function useFollowSystemTheme() {
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const media = matchMedia("(prefers-color-scheme: light)");
    const follow = () => {
      if (storedTheme() === "system") applyTheme("system");
    };
    media.addEventListener("change", follow);
    return () => media.removeEventListener("change", follow);
  }, []);
}

const subscribe = (onChange: () => void) => {
  window.addEventListener(CHANGED, onChange);
  return () => window.removeEventListener(CHANGED, onChange);
};

/**
 * The theme shown now. What paints with the tokens itself (a canvas, a waveform) redraws
 * when it changes, as CSS does on its own.
 */
export function useShownTheme(): string {
  return useSyncExternalStore(
    subscribe,
    () => document.documentElement.dataset.theme ?? "signal-dark",
    () => "signal-dark",
  );
}
