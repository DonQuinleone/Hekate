import { z } from "zod";

/** The languages Hekate's dates and numbers can be shown in; its words are English for now. */
export const locales = [
  "en-GB",
  "en-US",
  "de-DE",
  "fr-FR",
  "es-ES",
  "it-IT",
  "nl-NL",
  "sv-SE",
] as const;
export type Locale = (typeof locales)[number];

/** An IANA time zone the runtime knows, such as "Europe/London". */
export const timeZone = z
  .string()
  .max(64)
  .refine((zone) => {
    try {
      new Intl.DateTimeFormat("en-GB", { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }, "Not a time zone");

/** What someone may change about themselves; null clears a choice back to the browser's. */
export const profileInput = z
  .object({
    name: z.string().trim().min(1, "A name is needed").max(120).optional(),
    locale: z.enum(locales).nullable().optional(),
    timeZone: timeZone.nullable().optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, "Nothing to change");
export type ProfileInput = z.infer<typeof profileInput>;

export const skipSteps = [1, 5, 10] as const;
export const preRolls = [0, 1, 2] as const;

/**
 * What someone wants to see and how the player behaves for them, in every workspace. The
 * project still decides which tools they may have; these choose among those.
 */
export const preferencesSchema = z.object({
  /** The spectrogram in the player's View menu. */
  showSpectrogram: z.boolean(),
  /** The loudness meters and their history on the QA view. */
  showLoudness: z.boolean(),
  /** Each channel in its own lane when a recording first opens. */
  splitChannels: z.boolean(),
  /** How far the arrow keys move the playhead, in seconds. */
  skipSeconds: z.union(
    skipSteps.map((n) => z.literal(n)) as [z.ZodLiteral<1>, z.ZodLiteral<5>, z.ZodLiteral<10>],
  ),
  /** How much to play before a comment's moment when it is opened, in seconds. */
  preRoll: z.union(
    preRolls.map((n) => z.literal(n)) as [z.ZodLiteral<0>, z.ZodLiteral<1>, z.ZodLiteral<2>],
  ),
});
export type Preferences = z.infer<typeof preferencesSchema>;

export const defaultPreferences: Preferences = {
  showSpectrogram: true,
  showLoudness: true,
  splitChannels: false,
  skipSeconds: 5,
  preRoll: 1,
};

/** A change to some preferences; the rest stay. */
export const preferencesInput = preferencesSchema
  .partial()
  .strict()
  .refine((p) => Object.keys(p).length > 0, "Nothing to change");

/** Stored preferences read safely: anything missing or unknown falls back to the default. */
export function preferencesOf(stored: unknown): Preferences {
  const out = { ...defaultPreferences };
  if (stored && typeof stored === "object") {
    for (const key of Object.keys(defaultPreferences) as (keyof Preferences)[]) {
      const parsed = preferencesSchema.shape[key].safeParse(
        (stored as Record<string, unknown>)[key],
      );
      if (parsed.success) (out as Record<string, unknown>)[key] = parsed.data;
    }
  }
  return out;
}
