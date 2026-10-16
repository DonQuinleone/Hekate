import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

/** Every error leaves the API in the same shape. */
export interface ApiError {
  error: { code: string; message: string };
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

export function onError(err: Error, c: Context) {
  if (err instanceof HTTPException) {
    const code = err instanceof CodedException ? err.code : (codes[err.status] ?? "http_error");
    return c.json<ApiError>({ error: { code, message: err.message } }, err.status);
  }
  console.error(err);
  return c.json<ApiError>({ error: { code: "internal", message: "Something went wrong" } }, 500);
}
