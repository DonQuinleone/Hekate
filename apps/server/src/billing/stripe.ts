import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stripe's API, as far as Hekate uses it (#178): form-encoded requests with the secret key, and
 * the signature on each webhook checked against the endpoint's secret. Its own few calls are
 * written out rather than taken from Stripe's library, so the version is pinned here and a test
 * can stand in for the network.
 */

/** The API version every request asks for, so a change on Stripe's side never surprises it. */
export const STRIPE_API_VERSION = "2025-09-30.clover";

/** A webhook signed longer ago than this, or this far ahead, is refused. */
const TOLERANCE_SECONDS = 5 * 60;

export class StripeError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, message: string, code: string | null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** A webhook whose signature does not hold. */
export class Unsigned extends Error {}

/** An event as Stripe sends it. */
export interface StripeEvent {
  id: string;
  type: string;
  /** Seconds since the epoch. */
  created: number;
  livemode: boolean;
  data: { object: Record<string, unknown> };
}

type Param = string | number | boolean | null | undefined | Param[] | { [key: string]: Param };

/** Stripe's form encoding: `line_items[0][price_data][currency]=gbp`. Empty values are left out. */
export function formEncode(params: Record<string, Param>): URLSearchParams {
  const form = new URLSearchParams();
  const add = (key: string, value: Param) => {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) for (const [i, v] of value.entries()) add(`${key}[${i}]`, v);
    else if (typeof value === "object")
      for (const [k, v] of Object.entries(value)) add(`${key}[${k}]`, v);
    else form.append(key, String(value));
  };
  for (const [key, value] of Object.entries(params)) add(key, value);
  return form;
}

export interface Stripe {
  request<T = Record<string, unknown>>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    params?: Record<string, Param>,
    options?: { idempotencyKey?: string },
  ): Promise<T>;
}

export function stripeClient(options: {
  secretKey: string;
  fetch?: typeof fetch;
  base?: string;
}): Stripe {
  const fetcher = options.fetch ?? fetch;
  const base = options.base ?? "https://api.stripe.com";
  return {
    async request(method, path, params = {}, { idempotencyKey } = {}) {
      const form = formEncode(params);
      const query = method === "POST" ? "" : `?${form}`;
      const res = await fetcher(`${base}${path}${query === "?" ? "" : query}`, {
        method,
        headers: {
          authorization: `Bearer ${options.secretKey}`,
          "stripe-version": STRIPE_API_VERSION,
          ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        },
        ...(method === "POST" ? { body: form.toString() } : {}),
        signal: AbortSignal.timeout(30_000),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: { message?: string; code?: string };
      };
      if (!res.ok)
        throw new StripeError(
          res.status,
          body.error?.message ?? `Stripe answered ${res.status}`,
          body.error?.code ?? null,
        );
      return body as never;
    },
  };
}

/**
 * Check a webhook's `Stripe-Signature` (`t=…,v1=…`) against the endpoint's secret and read the
 * event. Any of its `v1` signatures may match, as Stripe signs with old and new secrets while a
 * secret is rolled.
 */
export function verifyStripeEvent(
  body: string,
  header: string | undefined,
  secret: string,
  now = Date.now(),
): StripeEvent {
  const parts = (header ?? "").split(",").map((p) => p.trim().split("="));
  const at = Number(parts.find(([k]) => k === "t")?.[1]);
  const signatures = parts.filter(([k, v]) => k === "v1" && v).map(([, v]) => v ?? "");
  if (!Number.isFinite(at) || signatures.length === 0) throw new Unsigned("No signature");
  if (Math.abs(now / 1000 - at) > TOLERANCE_SECONDS) throw new Unsigned("Signed too long ago");
  const expected = createHmac("sha256", secret).update(`${at}.${body}`).digest();
  const holds = signatures.some((s) => {
    const given = Buffer.from(s, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!holds) throw new Unsigned("The signature does not hold");
  const event = JSON.parse(body) as StripeEvent;
  if (typeof event?.id !== "string" || typeof event.type !== "string")
    throw new Unsigned("Not an event");
  return event;
}

/** A signature for a body, as Stripe makes one: for tests, and the fake gateway. */
export function signStripeEvent(body: string, secret: string, at = Date.now()): string {
  const t = Math.floor(at / 1000);
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
}
