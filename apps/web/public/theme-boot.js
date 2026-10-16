// Before the first paint: the theme chosen on this device last time, or the system's.
// Kept in step with src/lib/theme.ts.
(() => {
  let choice = "system";
  try {
    choice = localStorage.getItem("hekate.theme") || "system";
  } catch {}
  const theme =
    choice === "system"
      ? matchMedia("(prefers-color-scheme: light)").matches
        ? "signal-light"
        : "signal-dark"
      : choice;
  if (theme !== "signal-dark") document.documentElement.dataset.theme = theme;
})();
