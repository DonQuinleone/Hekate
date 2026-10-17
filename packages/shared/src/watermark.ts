import { z } from "zod";

/**
 * The visible watermark (#31, docs/security.md): who is looking, drawn over what they see so a
 * screenshot says whose it was. Burned into pages and pictures on the server; laid over video
 * in the player. A project chooses whom it marks, where and how strongly.
 */
export const watermarkScopes = ["off", "guests", "everyone"] as const;
export const watermarkPositions = ["corner", "centre", "tiled"] as const;

export const watermarkSettings = z.object({
  scope: z.enum(watermarkScopes),
  position: z.enum(watermarkPositions),
  /** Per cent, from faint to plain. */
  opacity: z.number().int().min(10).max(80),
});
export type WatermarkSettings = z.infer<typeof watermarkSettings>;
export type WatermarkScope = WatermarkSettings["scope"];
export type WatermarkPosition = WatermarkSettings["position"];

/** As before projects chose: guests' pages, tiled, faint. */
export const defaultWatermark: WatermarkSettings = {
  scope: "guests",
  position: "tiled",
  opacity: 30,
};

export const watermarkScopeWords: Record<WatermarkScope, string> = {
  off: "Off",
  guests: "Guests only",
  everyone: "Everyone",
};

export const watermarkPositionWords: Record<WatermarkPosition, string> = {
  corner: "Bottom right",
  centre: "Centre",
  tiled: "Tiled",
};

/** A project's watermark as stored, or the default when it has chosen none. */
export function watermarkOf(stored: unknown): WatermarkSettings {
  const parsed = watermarkSettings.safeParse(stored);
  return parsed.success ? parsed.data : defaultWatermark;
}

/** Whether this viewer is marked: guests unless the project marks no one, members only when it marks everyone. */
export function marks(settings: WatermarkSettings, viewer: "guest" | "member"): boolean {
  if (settings.scope === "off") return false;
  return settings.scope === "everyone" || viewer === "guest";
}

/** The two lines of the mark: who, and where and when. */
export function watermarkText(
  viewer: { name: string; email: string },
  organisation: string,
  at: Date,
): string {
  const day = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(at);
  // One line each, whatever was typed into a name.
  const flat = (s: string) => s.replace(/\s+/g, " ").trim();
  return `${flat(viewer.name)} · ${flat(viewer.email)}\n${flat(organisation)} · ${day}`;
}
