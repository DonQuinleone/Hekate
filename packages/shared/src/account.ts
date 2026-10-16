import { z } from "zod";

/** The languages Hekate's dates and numbers can be shown in; its words are English for now. */
export const locales = ["en-GB", "en-US", "de-DE", "fr-FR", "es-ES", "it-IT", "nl-NL", "sv-SE"] as const;
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
