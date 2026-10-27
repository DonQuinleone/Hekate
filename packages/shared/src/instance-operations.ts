import { API_TOKEN_RATE } from "./api-tokens.ts";

/**
 * The instance's Operations (decision 251): backups and capacity, as far as Hekate can say
 * truthfully. Backups are taken outside it (docs/backup.md), so it shows how, not when; its
 * capacity is set in the environment, so it is shown, not changed.
 */

/** A limit on how often something may be asked, counted in PostgreSQL across replicas. */
export interface RateRule {
  max: number;
  windowMs: number;
}

/**
 * The rate limits that guard sign-in, keys and downloads, each used where it is enforced and
 * shown in Operations from here, so the two never differ.
 */
export const rateLimits = {
  /** Password sign-ins, per address (Better Auth's rule, kept in the database). */
  signIn: { max: 10, windowMs: 60_000 },
  /** Opening guest links and trying their codes, per address. */
  guestLinks: { max: 30, windowMs: 10 * 60_000 },
  /** Content keys for playback, per session (docs/security.md). */
  contentKeys: { max: 30, windowMs: 60_000 },
  /** Downloads, per person. */
  downloads: { max: 20, windowMs: 60 * 60_000 },
  /** Starting uploads, per member. */
  uploads: { max: 120, windowMs: 60_000 },
  /** Calls with one API token. */
  apiTokens: API_TOKEN_RATE,
} as const satisfies Record<string, RateRule>;
export type RateLimitName = keyof typeof rateLimits;

export const rateLimitCopy: Record<RateLimitName, { name: string; per: string }> = {
  signIn: { name: "Sign-in attempts", per: "per address" },
  guestLinks: { name: "Guest links and codes", per: "per address" },
  contentKeys: { name: "Content keys", per: "per session" },
  downloads: { name: "Downloads", per: "per person" },
  uploads: { name: "Uploads started", per: "per member" },
  apiTokens: { name: "API calls", per: "per token" },
};

/** A rule in words: 30 a minute, 20 an hour, 30 in ten minutes. */
export function rateInWords(rule: RateRule): string {
  const minutes = rule.windowMs / 60_000;
  const span =
    minutes === 1
      ? "a minute"
      : minutes === 60
        ? "an hour"
        : minutes % 60 === 0
          ? `in ${minutes / 60} hours`
          : `in ${minutes} minutes`;
  return `${rule.max} ${span}`;
}

export interface InstanceOperations {
  capacity: {
    /** Every replica's worker lanes now: those busy, of all there are, and how many replicas. */
    lanes: { used: number; total: number; replicas: number };
    /** This process, as its environment set it. */
    process: {
      role: "all" | "api" | "worker";
      /** WORKER_LANES as set; null takes every lane. */
      lanes: string | null;
      /** WORKER_CONCURRENCY. */
      concurrency: number;
    };
    /** The largest file one upload may carry: its chunks times the most a backend takes. */
    uploadLimitBytes: number;
    rateLimits: { name: RateLimitName; rule: RateRule }[];
  };
}
