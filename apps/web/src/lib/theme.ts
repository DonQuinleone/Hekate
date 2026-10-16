import type { Theme } from "@hekate/shared";
import { useEffect } from "react";

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

const prefersLight = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches;

/** The theme a choice shows now: "system" is dark or light as the device is. */
export const resolveTheme = (choice: Theme, light = prefersLight()): Exclude<Theme, "system"> =>
  choice === "system" ? (light ? "signal-light" : "signal-dark") : choice;

/** Show a theme, and remember the choice on this device for the next first paint. */
export function applyTheme(choice: Theme) {
  const theme = resolveTheme(choice);
  if (theme === "signal-dark") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
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
 * Keep the page in the member's theme: theirs once known (never the default while loading,
 * which would undo a choice remembered on this device), and following the device while it
 * is "system".
 */
export function useThemeSync(choice: Theme | undefined) {
  useEffect(() => {
    if (!choice) return;
    applyTheme(choice);
    if (choice !== "system" || typeof matchMedia !== "function") return;
    const media = matchMedia("(prefers-color-scheme: light)");
    const follow = () => applyTheme("system");
    media.addEventListener("change", follow);
    return () => media.removeEventListener("change", follow);
  }, [choice]);
}
