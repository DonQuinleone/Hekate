// Before the first paint: the theme chosen on this device last time, or the system's, and the
// browser's own chrome in its ground colour. Kept in step with src/lib/theme.ts.
(() => {
  const grounds = {
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
  let choice = "system";
  try {
    choice = localStorage.getItem("hekate.theme") || "system";
  } catch {}
  let theme =
    choice === "system"
      ? matchMedia("(prefers-color-scheme: light)").matches
        ? "signal-light"
        : "signal-dark"
      : choice;
  if (!(theme in grounds)) theme = "signal-dark";
  if (theme !== "signal-dark") document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", grounds[theme]);
})();
