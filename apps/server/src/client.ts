import { type ClientRequestOptions, hc } from "hono/client";
import type { Api } from "./app.ts";

/**
 * Typed client for the web app; `baseUrl` points at the API root (for example `/api`).
 * Only types flow from the server, so no server code reaches the browser bundle.
 */
export const createClient = (baseUrl: string, options?: ClientRequestOptions) =>
  hc<Api>(baseUrl, options);
export type { Api };
