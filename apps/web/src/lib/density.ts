import type { Density } from "@hekate/shared";
import { useEffect } from "react";

const KEY = "hekate.density";

/**
 * Show a density: compact sets `data-density` on the page, which tightens every row token
 * (tokens.css). Remembered on this device for the next first paint (public/theme-boot.js).
 */
export function applyDensity(density: Density) {
  if (density === "compact") document.documentElement.dataset.density = "compact";
  else delete document.documentElement.dataset.density;
  try {
    localStorage.setItem(KEY, density);
  } catch {
    // Not remembered; the server keeps the choice anyway.
  }
}

/** Keep the page in the member's density once it is known. */
export function useDensitySync(density: Density | undefined) {
  useEffect(() => {
    if (density) applyDensity(density);
  }, [density]);
}
