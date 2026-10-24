import type { ApiErrorBody, ApiRequestIssue } from "@hekate/shared";
import { zValidator as honoZodValidator } from "@hono/zod-validator";
import type { Context, MiddlewareHandler, ValidationTargets } from "hono";
import type { z } from "zod";

/**
 * What a route checks, kept for the API's description (#197): each validator made here is
 * remembered with its target and schema, so the OpenAPI document is read from the routes as
 * they are, not from a second description that could drift from them.
 */
export interface Validated {
  target: keyof ValidationTargets;
  schema: z.ZodType;
}

const validated = new WeakMap<MiddlewareHandler, Validated>();

/** What a middleware validates, if it is one of ours. */
export const validatedBy = (handler: unknown): Validated | undefined =>
  typeof handler === "function" ? validated.get(handler as MiddlewareHandler) : undefined;

/** A request that did not validate, in the API's error shape (decision 224). */
export function invalidRequest(issues: readonly z.core.$ZodIssue[]): ApiErrorBody {
  const listed: ApiRequestIssue[] = issues.map((i) => ({
    path: i.path.map(String).join("."),
    message: i.message,
  }));
  const first = listed[0];
  return {
    error: {
      code: "invalid_request",
      message: first
        ? first.path
          ? `${first.path}: ${first.message}`
          : first.message
        : "Check the request.",
      issues: listed,
    },
  };
}

type Result =
  | { success: true; data: unknown }
  | { success: false; error: { issues: z.core.$ZodIssue[] }; data: unknown };
type Hook = (result: Result, c: Context) => unknown;

/**
 * `@hono/zod-validator`'s validator, with the same types, that also records what it checks for
 * the OpenAPI document and answers a request that fails in the API's own error shape
 * (`invalid_request`, with each issue's path and message) rather than zod's.
 */
export const zValidator = ((
  target: keyof ValidationTargets,
  schema: z.ZodType,
  hook?: Hook,
  options?: unknown,
) => {
  const answer = async (result: Result, c: Context) => {
    const given = hook ? await hook(result, c) : undefined;
    if (given) return given;
    if (!result.success) return c.json(invalidRequest(result.error.issues), 400);
    return undefined;
  };
  // biome-ignore lint/suspicious/noExplicitAny: the library's overloads are restated by the cast below.
  const middleware = (honoZodValidator as any)(
    target,
    schema,
    answer,
    options,
  ) as MiddlewareHandler;
  validated.set(middleware, { target, schema });
  return middleware;
}) as unknown as typeof honoZodValidator;
