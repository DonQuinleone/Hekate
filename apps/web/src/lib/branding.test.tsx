import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useBrandAccent } from "./branding";

const root = () => document.documentElement;

describe("a workspace's accent", () => {
  afterEach(() => {
    delete root().dataset.brand;
    root().removeAttribute("style");
  });

  it("stands in for the signal while its page is open, and goes with it", () => {
    const shown = renderHook(() => useBrandAccent({ dark: "#4fb3a9", light: "#1f6d66" }));
    expect(root().dataset.brand).toBe("");
    expect(root().style.getPropertyValue("--hk-brand-dark")).toBe("#4fb3a9");
    expect(root().style.getPropertyValue("--hk-brand-light")).toBe("#1f6d66");
    shown.unmount();
    expect(root().dataset.brand).toBeUndefined();
    expect(root().style.getPropertyValue("--hk-brand-dark")).toBe("");
  });

  it("leaves the signal alone without one, or with anything that is not a colour", () => {
    renderHook(() => useBrandAccent(null));
    expect(root().dataset.brand).toBeUndefined();
    renderHook(() => useBrandAccent({ dark: "red; --x: 1", light: "#1f6d66" }));
    expect(root().dataset.brand).toBeUndefined();
    expect(root().style.getPropertyValue("--hk-brand-light")).toBe("");
  });
});
