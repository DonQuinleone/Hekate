import { z } from "zod";

/**
 * Instance flags (#159): switches an operator turns on in Debug tools, read by the server
 * at start-up and again as it runs, so turning one needs no restart. Each is something the
 * server does today; one that lasts goes off by itself after its time.
 */
export const instanceFlags = {
  "worker.verbose": {
    label: "Verbose logging for the worker",
    hint: "Every job's start, end and time in the log, for an hour, then off by itself",
    /** Minutes it stays on; null stays until turned off. */
    lasts: 60,
  },
} as const satisfies Record<string, { label: string; hint: string; lasts: number | null }>;

export type FlagKey = keyof typeof instanceFlags;
export const flagKeys = Object.keys(instanceFlags) as FlagKey[];

export const flagParam = z.object({ key: z.enum(flagKeys as [FlagKey, ...FlagKey[]]) });
export const flagInput = z.object({ on: z.boolean() });

/** A flag as Debug tools shows it. */
export interface InstanceFlag {
  key: FlagKey;
  label: string;
  hint: string;
  on: boolean;
  /** When it goes off by itself; null when it lasts, or is off. */
  until: string | null;
}

/** Whether a stored flag is on now: set on, and not yet past its time. */
export const flagOn = (row: { on: boolean; until: Date | null } | undefined, now: Date) =>
  !!row?.on && (!row.until || row.until > now);

/** When a flag turned on now goes off by itself, or null when it lasts. */
export function flagUntil(key: FlagKey, now: Date): Date | null {
  const lasts: number | null = instanceFlags[key].lasts;
  return lasts === null ? null : new Date(now.getTime() + lasts * 60_000);
}
