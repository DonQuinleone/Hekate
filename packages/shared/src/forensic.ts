import { z } from "zod";
import { downloadKinds } from "./downloads.ts";

/**
 * Forensic marking (#32, decision 236): an inaudible mark in every recording a person
 * downloads, made for them, so a leaked copy can be traced to whose download it was. Owners
 * turn it on or off for the workspace (it is on unless they turn it off, where the plan
 * includes it) and trace suspected leaks. Streams, video, pictures and pages carry only the
 * visible mark for now.
 */

/** An owner's change to forensic marking. */
export const forensicSettingsInput = z.object({ audio: z.boolean() }).strict();
export type ForensicSettingsInput = z.infer<typeof forensicSettingsInput>;

/** Forensic marking as the workspace has it. */
export interface ForensicStatus {
  /** Whether the workspace's plan includes it (always, without the billing module). */
  included: boolean;
  /** Whether recordings' downloads are marked: on by default. */
  audio: boolean;
  /** How many marks have been made, every one of them traceable. */
  marks: number;
}

/** The largest suspected leak that may be traced. */
export const TRACE_MAX_BYTES = 300 * 1024 * 1024;
/** Only the first ten minutes of a suspected leak are examined. */
export const TRACE_SECONDS = 600;

/** The download a mark was made for, as a trace names it. */
export const tracedMark = z.object({
  id: z.uuid(),
  /** Who it was made for, as shown at the time, and who they are now, where they still exist. */
  recipient: z.string(),
  userId: z.string().nullable(),
  guestId: z.uuid().nullable(),
  fileId: z.uuid(),
  fileName: z.string(),
  projectId: z.uuid(),
  kind: z.enum(downloadKinds),
  /** For a guest, the review whose grant allowed it. */
  reviewId: z.uuid().nullable(),
  reviewName: z.string().nullable(),
  /** The download's entry in the access log. */
  accessEventId: z.uuid().nullable(),
  at: z.iso.datetime({ offset: true }),
});
export type TracedMark = z.infer<typeof tracedMark>;

/** What a trace found. */
export interface TraceResult {
  /** How much of the file was examined, in seconds. */
  seconds: number;
  /** How many marks it was compared with. */
  compared: number;
  /** The mark it carries, when the chance of a mistake is below one in a million. */
  match: (TracedMark & { chance: number }) | null;
  /**
   * Without a match: whether the workspace's pattern was found anyway, as in a copy carrying
   * a mark too damaged to name anyone.
   */
  patternFound: boolean;
}

/**
 * The chance of a mistaken match, in words: "less than one in a billion". Rounded down to a
 * power of ten, so it never claims more certainty than the bound gives.
 */
export function chanceWords(chance: number): string {
  const exponent = chance > 0 ? Math.min(30, Math.floor(-Math.log10(chance))) : 30;
  if (exponent < 1) return "more than one in ten";
  const names: Record<number, string> = {
    1: "ten",
    2: "a hundred",
    3: "a thousand",
    4: "ten thousand",
    5: "a hundred thousand",
    6: "a million",
    7: "ten million",
    8: "a hundred million",
    9: "a billion",
    12: "a trillion",
  };
  return `less than one in ${names[exponent] ?? `10^${exponent}`}`;
}
