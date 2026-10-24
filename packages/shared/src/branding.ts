import { z } from "zod";

/**
 * A workspace's branding (#185, decision 226): a logo and an accent colour, shown on its
 * sign-in page (at its own address, #176), on guest pages and in its email. The product's own
 * lockup stays in the member's shell. The accent stands in for the signal colour, so it is
 * held to the rule every theme's signal is held to: 4.5:1 against every surface text is set
 * on, and under the label of a primary button.
 */

/** WCAG 2.2 AA for text, which the signal is used as. */
export const AA_CONTRAST = 4.5;

/** The largest logo kept, either side, in pixels: a larger one is scaled down to fit. */
export const LOGO_MAX_SIDE = 512;
/** The largest image taken to make a logo from. */
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;
/** The kinds of image a logo is made from. Never SVG: it can carry script. */
export const logoContentTypes = ["image/png", "image/jpeg", "image/webp"] as const;
export type LogoContentType = (typeof logoContentTypes)[number];

/**
 * The surfaces of Signal's two themes that text is set on, as tokens.css, depth.css and
 * themes.css have them, ground first (a primary button's label is the ground colour). Kept in
 * step with those files; the test beside this one checks the brand's own signal passes.
 */
export const brandSurfaces = {
  dark: {
    ground: "#0a0a0b",
    canvas: "#050506",
    pane: "#0e0e10",
    surface: "#111113",
    raised: "#18181b",
    overlay: "#1d1d21",
  },
  light: {
    ground: "#f4f4f2",
    canvas: "#e9e9e6",
    pane: "#fafaf9",
    surface: "#ffffff",
    raised: "#f0f0ed",
    overlay: "#ffffff",
  },
} as const;
export type BrandScheme = keyof typeof brandSurfaces;

/** Signal's own colour in each theme: what a workspace without an accent shows. */
export const signalColours: Record<BrandScheme, string> = { dark: "#f0762e", light: "#b53c0a" };

/** A colour as `#rrggbb`, kept in lower case. */
export const hexColour = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, "Give a colour as # and six hexadecimal digits, like #4fb3a9")
  .transform((s) => s.toLowerCase());

const channels = (hex: string): [number, number, number] => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
];

const toLinear = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

const fromLinear = (l: number) => {
  const s = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, s)) * 255);
};

/** Relative luminance, as WCAG defines it. */
export function luminance(hex: string): number {
  const [r, g, b] = channels(hex).map(toLinear) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The contrast ratio of two colours, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The lowest contrast a colour has against a theme's surfaces. */
export function leastContrast(colour: string, scheme: BrandScheme): number {
  return Math.min(...Object.values(brandSurfaces[scheme]).map((s) => contrast(colour, s)));
}

const hexOf = (rgb: number[]) => `#${rgb.map((c) => c.toString(16).padStart(2, "0")).join("")}`;

/**
 * Why an accent cannot be used, or null when it can. It is given for the dark theme, the
 * brand's default, and must read there; the light theme takes a darker cut of it.
 */
export function accentRefusal(accent: string): string | null {
  const least = leastContrast(accent, "dark");
  if (least >= AA_CONTRAST) return null;
  return `That accent is too dark to read on the dark ground: it has ${least.toFixed(1)}:1 where 4.5:1 is needed. Choose a lighter colour.`;
}

/**
 * The accent as the light theme shows it: the same hue and saturation at a lower luminance
 * (its linear light scaled down), the lightest that holds 4.5:1 on every light surface and
 * under the light ground as a label. An accent that already reads there is kept.
 */
export function lightAccent(accent: string): string {
  if (leastContrast(accent, "light") >= AA_CONTRAST) return accent;
  const linear = channels(accent).map(toLinear);
  const darkest = Math.min(...Object.values(brandSurfaces.light).map(luminance));
  const target = (darkest + 0.05) / AA_CONTRAST - 0.05;
  const scale = target / Math.max(luminance(accent), 1e-6);
  // Rounding to whole channels can land a hair short: step down until it holds.
  for (let k = scale; k > 0; k -= 0.005) {
    const shade = hexOf(linear.map((l) => fromLinear(l * k)));
    if (leastContrast(shade, "light") >= AA_CONTRAST) return shade;
  }
  return "#000000";
}

/** A workspace's branding as it is stored, beside its settings (`organisations.branding`). */
export const storedBranding = z.object({
  accent: hexColour.nullable(),
  logo: z
    .object({
      blobId: z.uuid(),
      width: z.number().int().min(1).max(LOGO_MAX_SIDE),
      height: z.number().int().min(1).max(LOGO_MAX_SIDE),
    })
    .nullable(),
});
export type StoredBranding = z.infer<typeof storedBranding>;
export const defaultBranding: StoredBranding = { accent: null, logo: null };

/** Stored branding read safely: a part missing or no longer valid is none, the rest kept. */
export function storedBrandingOf(stored: unknown): StoredBranding {
  const read = (key: string) =>
    stored && typeof stored === "object" ? (stored as Record<string, unknown>)[key] : undefined;
  const accent = storedBranding.shape.accent.safeParse(read("accent"));
  const logo = storedBranding.shape.logo.safeParse(read("logo"));
  return {
    accent: accent.success ? accent.data : null,
    logo: logo.success ? logo.data : null,
  };
}

/** Set the accent, or go back to the signal with null. */
export const brandingAccentInput = z.object({ accent: hexColour.nullable() }).strict();
export type BrandingAccentInput = z.infer<typeof brandingAccentInput>;

/** Where a workspace's logo is served: public, as it is shown before anyone signs in. */
export const logoPath = (organisationId: string, blobId: string) =>
  `/api/branding/${organisationId}/logo/${blobId}`;

/** A workspace's branding as its public pages and its mail use it. */
export interface PublicBranding {
  /** The logo, at an address relative to the instance's (or absolute, in mail). */
  logo: { url: string; width: number; height: number } | null;
  /** The accent for each of Signal's themes; null keeps the signal. */
  accent: Record<BrandScheme, string> | null;
}

/** What a workspace's stored branding shows; null when it has none. */
export function publicBranding(
  organisationId: string,
  stored: StoredBranding,
  base = "",
): PublicBranding | null {
  if (!stored.logo && !stored.accent) return null;
  return {
    logo: stored.logo
      ? {
          url: `${base}${logoPath(organisationId, stored.logo.blobId)}`,
          width: stored.logo.width,
          height: stored.logo.height,
        }
      : null,
    accent: stored.accent ? { dark: stored.accent, light: lightAccent(stored.accent) } : null,
  };
}

/** A logo's size when shown at `height` pixels tall, no wider than `maxWidth`. */
export function logoBox(
  logo: { width: number; height: number },
  height: number,
  maxWidth: number,
): { width: number; height: number } {
  const width = Math.round((logo.width / logo.height) * height);
  if (width <= maxWidth) return { width, height };
  return { width: maxWidth, height: Math.round((logo.height / logo.width) * maxWidth) };
}
