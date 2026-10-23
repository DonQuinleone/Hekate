import type { PublicBranding } from "@hekate/shared";
import { useEffect } from "react";

const colour = /^#[0-9a-f]{6}$/i;

/**
 * Shows a workspace's accent (#185) in place of the signal while the page that asks is open,
 * in Signal's dark and light themes (themes.css). The server checked both cuts for contrast;
 * anything that is not a colour is ignored.
 */
export function useBrandAccent(accent: PublicBranding["accent"] | undefined) {
  const dark = accent?.dark;
  const light = accent?.light;
  useEffect(() => {
    if (!dark || !light || !colour.test(dark) || !colour.test(light)) return;
    const root = document.documentElement;
    root.style.setProperty("--hk-brand-dark", dark);
    root.style.setProperty("--hk-brand-light", light);
    root.dataset.brand = "";
    return () => {
      delete root.dataset.brand;
      root.style.removeProperty("--hk-brand-dark");
      root.style.removeProperty("--hk-brand-light");
    };
  }, [dark, light]);
}
