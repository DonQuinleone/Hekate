import { describe, expect, it } from "vitest";
import {
  AA_CONTRAST,
  accentRefusal,
  brandingAccentInput,
  contrast,
  leastContrast,
  lightAccent,
  logoBox,
  publicBranding,
  signalColours,
  storedBrandingOf,
} from "./branding.ts";

describe("contrast", () => {
  it("is WCAG's ratio", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#ffffff", "#ffffff")).toBe(1);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });

  it("holds the brand's own signal to the rule an accent is held to", () => {
    expect(leastContrast(signalColours.dark, "dark")).toBeGreaterThanOrEqual(AA_CONTRAST);
    expect(leastContrast(signalColours.light, "light")).toBeGreaterThanOrEqual(AA_CONTRAST);
    expect(accentRefusal(signalColours.dark)).toBeNull();
  });
});

describe("an accent", () => {
  it("is refused when it cannot be read on the dark ground", () => {
    expect(accentRefusal("#1f2a44")).toMatch(/too dark to read on the dark ground/);
    expect(accentRefusal("#3a3a3a")).toMatch(/4\.5:1/);
  });

  it("is taken when it reads on every dark surface", () => {
    expect(accentRefusal("#4fb3a9")).toBeNull();
    expect(accentRefusal("#ffffff")).toBeNull();
  });

  it("takes a darker cut of itself in the light theme, legible there", () => {
    for (const accent of ["#4fb3a9", "#f0762e", "#d4a20b", "#bd93f9", "#ffffff"]) {
      const light = lightAccent(accent);
      expect(leastContrast(light, "light")).toBeGreaterThanOrEqual(AA_CONTRAST);
      // As light as it can be and still pass: within a few steps of the line.
      expect(leastContrast(light, "light")).toBeLessThan(5);
    }
  });

  it("keeps an accent that already reads in the light theme", () => {
    expect(lightAccent("#1a1a1a")).toBe("#1a1a1a");
  });

  it("is given as six hexadecimal digits, kept in lower case", () => {
    expect(brandingAccentInput.parse({ accent: "#4FB3A9" })).toEqual({ accent: "#4fb3a9" });
    expect(brandingAccentInput.parse({ accent: null })).toEqual({ accent: null });
    expect(brandingAccentInput.safeParse({ accent: "teal" }).success).toBe(false);
    expect(brandingAccentInput.safeParse({ accent: "#fff" }).success).toBe(false);
    expect(brandingAccentInput.safeParse({ accent: "#4fb3a9", logo: null }).success).toBe(false);
  });
});

describe("public branding", () => {
  const organisationId = "0199e3a0-0000-7000-8000-000000000185";
  const blobId = "0199e3a0-0000-7000-8000-000000000186";

  it("is nothing without a logo or an accent", () => {
    expect(publicBranding(organisationId, { accent: null, logo: null })).toBeNull();
  });

  it("names the logo's public address and both themes' accents", () => {
    const shown = publicBranding(
      organisationId,
      { accent: "#4fb3a9", logo: { blobId, width: 400, height: 100 } },
      "https://review.example",
    );
    expect(shown?.logo).toEqual({
      url: `https://review.example/api/branding/${organisationId}/logo/${blobId}`,
      width: 400,
      height: 100,
    });
    expect(shown?.accent?.dark).toBe("#4fb3a9");
    expect(shown?.accent?.light).toBe(lightAccent("#4fb3a9"));
  });
});

describe("a logo's box", () => {
  it("keeps its shape at the height asked, within the width allowed", () => {
    expect(logoBox({ width: 400, height: 100 }, 28, 200)).toEqual({ width: 112, height: 28 });
    expect(logoBox({ width: 512, height: 64 }, 28, 160)).toEqual({ width: 160, height: 20 });
  });
});

describe("stored branding", () => {
  it("is read part by part, what is no longer valid falling back to none", () => {
    expect(
      storedBrandingOf({
        accent: "#4FB3A9",
        logo: { blobId: "not-an-id", width: 1, height: 1 },
      }),
    ).toEqual({ accent: "#4fb3a9", logo: null });
    expect(storedBrandingOf(null)).toEqual({ accent: null, logo: null });
    expect(storedBrandingOf({ accent: "#123" })).toEqual({ accent: null, logo: null });
  });
});
