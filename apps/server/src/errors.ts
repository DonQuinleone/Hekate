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

export function onError(err: Error, c: Context) {
  if (err instanceof HTTPException) {
    const code =
      err.status === 404 ? "not_found" : err.status === 400 ? "bad_request" : "http_error";
    return c.json<ApiError>({ error: { code, message: err.message } }, err.status);
  }
  console.error(err);
  return c.json<ApiError>({ error: { code: "internal", message: "Something went wrong" } }, 500);
}
