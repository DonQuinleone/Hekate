import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { normaliseSetupCode, setupCodeInput } from "@hekate/shared";
import type { MiddlewareHandler } from "hono";
import { CodedException } from "./errors.ts";

/** Twelve characters people can read back without mistaking one for another. */
const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

/** Wrong codes allowed in a window before every attempt is refused until it passes. */
export const SETUP_CODE_ATTEMPTS = 10;
export const SETUP_CODE_WINDOW_MS = 10 * 60_000;

/** The header the browser sends the code in. */
export const SETUP_CODE_HEADER = "x-hekate-setup-code";

export interface SetupGate {
  readonly code: string;
  check(given: string | undefined): "ok" | "wrong" | "locked";
}

/**
 * Guards installing and creating the first owner (decision 061): the code the server prints in
 * its log at start, `HEKATE_SETUP_CODE` when it is given one (for tests), or a new one each start.
 */
export function createSetupGate(options: { code?: string; now?: () => number } = {}): SetupGate {
  const fixed = options.code && setupCodeInput.safeParse({ code: options.code }).success;
  const code = fixed
    ? normaliseSetupCode(options.code ?? "")
    : Array.from({ length: 3 }, () =>
        Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join(""),
      ).join("-");
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const expected = digest(code);
  const now = options.now ?? Date.now;
  let failures: number[] = [];
  return {
    code,
    check(given) {
      failures = failures.filter((at) => now() - at < SETUP_CODE_WINDOW_MS);
      if (failures.length >= SETUP_CODE_ATTEMPTS) return "locked";
      const ok =
        !!given &&
        setupCodeInput.safeParse({ code: given }).success &&
        timingSafeEqual(digest(normaliseSetupCode(given)), expected);
      if (ok) return "ok";
      failures.push(now());
      return "wrong";
    },
  };
}

/** Refuses a request without the right code: 403, or 429 once too many were wrong. */
export const requireSetupCode =
  (gate: SetupGate): MiddlewareHandler =>
  async (c, next) => {
    const result = gate.check(c.req.header(SETUP_CODE_HEADER));
    if (result === "locked")
      throw new CodedException(
        429,
        "setup_code_locked",
        "Too many wrong codes. Wait ten minutes, then try again.",
      );
    if (result === "wrong")
      throw new CodedException(
        403,
        "setup_code_wrong",
        "That is not the setup code. Copy it from the server's log.",
      );
    await next();
  };

/** What the server prints so whoever runs it can open the installer. */
export const setupMessage = (gate: SetupGate, address: string) =>
  `Hekate is not set up yet. Open ${address}/setup and enter the setup code: ${gate.code}`;
