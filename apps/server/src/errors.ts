import { type Database, uuidv7 } from "@hekate/db";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { recordFailure } from "./error-reports.ts";

/** Every error leaves the API in the same shape; a failure also carries its reference (#159). */
export interface ApiError {
  error: { code: string; message: string; reference?: string };
}

export class NotFound extends HTTPException {
  constructor(what: string) {
    super(404, { message: `${what} not found` });
  }
}

/** A refusal the web app acts on by its code, not only its status. */
export class CodedException extends HTTPException {
  readonly code: string;
  constructor(status: 400 | 403 | 409 | 410 | 422 | 429, code: string, message: string) {
    super(status, { message });
    this.code = code;
  }
}

const codes: Record<number, string> = {
  400: "bad_request",
  401: "unauthenticated",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  429: "rate_limited",
};

/**
 * Names each request, for the log and for an error report. Made here, never taken from the
 * request, so a reference always leads to this server's own record.
 */
export const requestId = createMiddleware<{ Variables: { requestId: string } }>(async (c, next) => {
  const id = `req_${uuidv7()}`;
  c.set("requestId", id);
  c.header("X-Request-Id", id);
  await next();
});

/** What the session middleware set, where it ran. */
const known = (c: Context, key: string) => {
  const value = (c.var as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
};

/**
 * Turns an error into the API's shape. A refusal says what was refused; a failure (any 5xx) is
 * recorded under a reference that the person can quote and an operator can look up.
 */
export const errorHandler = (db?: Database) => async (err: Error, c: Context) => {
  if (err instanceof HTTPException && err.status < 500) {
    const code = err instanceof CodedException ? err.code : (codes[err.status] ?? "http_error");
    return c.json<ApiError>({ error: { code, message: err.message } }, err.status);
  }
  const status = err instanceof HTTPException ? err.status : 500;
  if (!db) console.error(err);
  const reference = db
    ? await recordFailure(db, {
        source: "api",
        location: `${c.req.method} ${c.req.routePath}`,
        error: err,
        status,
        requestId: known(c, "requestId"),
        organisationId: known(c, "organisationId"),
        userId: known(c, "userId"),
      })
    : null;
  const message =
    err instanceof HTTPException && err.message ? err.message : "Something went wrong";
  return c.json<ApiError>(
    { error: { code: "internal", message, ...(reference ? { reference } : {}) } },
    status as 500,
  );
};

/** For apps with no database to record into. */
export const onError = errorHandler();
