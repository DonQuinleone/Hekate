import { z } from "zod";

/**
 * The public API (#197, decision 224): the calls an API token may make, under a versioned base
 * (`/api/v1`) whose shape only grows. The unversioned `/api` is the web app's own and changes
 * with it; the versioned base answers the same routes, with the same handlers, and nothing else.
 */

/** The versions the server answers, oldest first; the last is the current one. */
export const apiVersions = [1] as const;
export type ApiVersion = (typeof apiVersions)[number];
export const API_VERSION: ApiVersion = 1;

/** Where a version's calls go, from the instance's address: `/api/v1`. */
export const apiBase = (version: ApiVersion = API_VERSION) => `/api/v${version}`;

/** Where the OpenAPI document is served, for the current version and for each one. */
export const OPENAPI_PATH = "/api/openapi.json";

/**
 * The unversioned path a versioned one reaches (`/api/v1/projects` is `/api/projects`), and the
 * version it named; null for a path outside every version, or naming one the server does not
 * answer.
 */
export function unversioned(path: string): { version: ApiVersion; path: string } | null {
  const match = /^\/api\/v(\d+)(\/.*)?$/.exec(path);
  if (!match) return null;
  const version = Number(match[1]);
  if (!apiVersions.includes(version as ApiVersion)) return null;
  return { version: version as ApiVersion, path: `/api${match[2] ?? ""}` };
}

/** One thing wrong with a request that did not validate: where (a dotted path), and what. */
export const apiRequestIssue = z.object({ path: z.string(), message: z.string() });
export type ApiRequestIssue = z.infer<typeof apiRequestIssue>;

/**
 * Every refusal and failure leaves the API in this shape. A failure (5xx) carries the reference
 * an operator looks it up by (#159); a request that did not validate lists what was wrong.
 */
export const apiErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    reference: z.string().optional(),
    issues: z.array(apiRequestIssue).optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof apiErrorBody>;

/** The codes a script may act on, the status each comes with, and what it means. */
export const apiErrorCodes = {
  invalid_request: {
    status: 400,
    meaning: "The body, query or path did not validate; `issues` says where and why.",
  },
  bad_request: { status: 400, meaning: "The request cannot be acted on as it stands." },
  token_invalid: {
    status: 401,
    meaning: "The token is wrong, revoked or expired, or for another workspace.",
  },
  unauthenticated: { status: 401, meaning: "No token, and no session." },
  insufficient_scope: {
    status: 403,
    meaning: "The token does not hold the scope the call needs; the message names it.",
  },
  token_not_allowed: {
    status: 403,
    meaning: "No token may make this call, whatever it holds.",
  },
  forbidden: {
    status: 403,
    meaning: "The token's member (or a service token's admin reach) may not do this.",
  },
  workspace_suspended: { status: 403, meaning: "The workspace is suspended." },
  not_found: {
    status: 404,
    meaning: "Nothing there, or nothing the token's member may see, or not part of this version.",
  },
  conflict: { status: 409, meaning: "The change clashes with the state it would change." },
  too_large: { status: 413, meaning: "The body is larger than the call takes." },
  rate_limited: {
    status: 429,
    meaning: "Too many calls; `Retry-After` gives the seconds to wait.",
  },
  internal: {
    status: 500,
    meaning: "Hekate failed; quote the `reference` to the instance's operator.",
  },
  maintenance: {
    status: 503,
    meaning: "The instance is under maintenance; uploads wait until it is over.",
  },
} as const satisfies Record<string, { status: number; meaning: string }>;
export type ApiErrorCode = keyof typeof apiErrorCodes;
