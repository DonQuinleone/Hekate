import { z } from "zod";

/**
 * API tokens (#198): a member's own, for scripts and tools of theirs, and a workspace's service
 * tokens, which act as the workspace rather than a person. Either reaches one workspace, and
 * only what its scopes allow; a member's can do no more than the member can.
 */

/**
 * What a token may be given, in the order settings show them. The public API (#197) and the MCP
 * endpoint (#199) ask the same scopes of a call, through `scopeFor`.
 */
export const apiScopes = [
  "files:read",
  "files:write",
  "reviews:read",
  "reviews:write",
  "comments",
  "downloads",
  "workflows",
  "org:read",
] as const;
export const apiScope = z.enum(apiScopes);
export type ApiScope = z.infer<typeof apiScope>;

/** What each scope lets a token do, as settings and the documentation say it. */
export const apiScopeLabels: Record<ApiScope, string> = {
  "files:read": "List and read projects, folders, files, tracks, versions and variations",
  "files:write": "Upload versions and variations, make folders, change files",
  "reviews:read": "Read reviews, reviewers and decisions",
  "reviews:write": "Request reviews and record decisions as the token's member",
  comments: "Read and write comments and their anchors",
  downloads: "Download originals and proxies, watermarked and logged",
  workflows: "Read and change workflows and their runs",
  "org:read": "Members, roles and settings, read-only",
};

/** Whose a token is: a member's own, or the workspace's (a service token). */
export const apiTokenKinds = ["personal", "service"] as const;
export type ApiTokenKind = (typeof apiTokenKinds)[number];

/** How long a new token lasts, in days; null never ends (until revoked). */
export const apiTokenLifetimes = [30, 90, 365] as const;
export type ApiTokenLifetime = (typeof apiTokenLifetimes)[number];

/**
 * Where a service token's own account has its address: `.invalid` is reserved (RFC 2606), so
 * nothing is ever delivered there and no one can be given it to sign in with.
 */
export const SERVICE_ACCOUNT_DOMAIN = "service-token.invalid";

/** Whether an account is a service token's, by its address. */
export const isServiceAccount = (email: string) => email.endsWith(`@${SERVICE_ACCOUNT_DOMAIN}`);

/** How many live tokens one member, or one workspace's service tokens, may hold at once. */
export const API_TOKEN_LIMIT = 50;

/** Calls one token may make in a minute (#172), past which it is answered 429. */
export const API_TOKEN_RATE = { max: 600, windowMs: 60_000 } as const;

/**
 * What a token looks like: `hk_pat_` for a member's, `hk_svc_` for a service token's, then 43
 * characters of base64url (32 random bytes). The prefix lets secret scanners find one that leaked.
 */
export const apiTokenPrefixes: Record<ApiTokenKind, string> = {
  personal: "hk_pat_",
  service: "hk_svc_",
};
export const API_TOKEN_PATTERN = /^hk_(pat|svc)_[A-Za-z0-9_-]{43}$/;

/** The start of a token, which settings show to tell tokens apart: `hk_pat_7f3a`. */
export const apiTokenHint = (token: string) => token.slice(0, 11);

const scopeList = z
  .array(apiScope)
  .min(1, "Choose at least one scope")
  .max(apiScopes.length)
  .transform((given) => apiScopes.filter((s) => given.includes(s)));

const tokenName = z.string().trim().min(1, "Give it a name").max(80);

export const createApiTokenInput = z
  .object({
    name: tokenName,
    scopes: scopeList,
    /** Days until it stops working; null for never. */
    expiresInDays: z.union([z.literal(30), z.literal(90), z.literal(365)]).nullable(),
  })
  .strict();
export type CreateApiTokenInput = z.infer<typeof createApiTokenInput>;

export const updateApiTokenInput = z
  .object({ name: tokenName.optional(), scopes: scopeList.optional() })
  .strict()
  .refine((v) => v.name !== undefined || v.scopes !== undefined, "Nothing to change");
export type UpdateApiTokenInput = z.infer<typeof updateApiTokenInput>;

/** A token as settings show it. The token itself is shown once, when it is made, and never again. */
export interface ApiTokenRow {
  id: string;
  kind: ApiTokenKind;
  name: string;
  /** Its first characters, `hk_pat_7f3a`, to tell it apart. */
  hint: string;
  scopes: ApiScope[];
  createdAt: string;
  /** Who made it: for a service token, the admin; for a member's own, themselves. */
  createdBy: string | null;
  lastUsedAt: string | null;
  /** Null for never. */
  expiresAt: string | null;
}

/** What making a token answers: the row, and the token, which is not shown again. */
export interface CreatedApiToken {
  token: ApiTokenRow;
  secret: string;
}

/** Whether a token with `held` scopes may do what `needed` asks: writing a kind includes reading it. */
export function scopeAllows(held: readonly ApiScope[], needed: ApiScope): boolean {
  if (held.includes(needed)) return true;
  if (needed === "files:read") return held.includes("files:write");
  if (needed === "reviews:read") return held.includes("reviews:write");
  return false;
}

/** A token that has stopped working because its time ran out. */
export const apiTokenExpired = (row: { expiresAt: string | null }, now = new Date()) =>
  row.expiresAt !== null && new Date(row.expiresAt) <= now;

type Access = "read" | "write";
type Rule = readonly [pattern: RegExp, scope: ApiScope | { read: ApiScope; write: ApiScope }];

const id = "[^/]+";
const files = { read: "files:read", write: "files:write" } as const;
const reviews = { read: "reviews:read", write: "reviews:write" } as const;

/**
 * Paths a token never reaches, whatever it holds: playback and pages (session-bound, and media
 * never leaves except as a logged download), deleting and moving projects, calendar feed links,
 * project roles and members, and archiving.
 */
const refused: readonly RegExp[] = [
  new RegExp(`^/files/${id}/(playback|view|spectrograms)(/|$)`),
  /^\/play(\/|$)/,
  new RegExp(
    `^/projects/${id}/(deletion|transfer|calendar/feed|roles|members|archive|unarchive)(/|$)`,
  ),
  /^\/transfers(\/|$)/,
];

/** Where each scope reaches, first match first. Paths are under `/api`. */
const rules: readonly Rule[] = [
  // Downloads: originals and proxies, a project's scores, a comment's attachment.
  [new RegExp(`^/files/${id}/downloads$`), "downloads"],
  [/^\/downloads\/[^/]+$/, "downloads"],
  [new RegExp(`^/projects/${id}/score-downloads$`), "downloads"],
  [new RegExp(`^/files/${id}/attachments/${id}/download$`), "downloads"],
  // Comments, wherever they are reached from.
  [new RegExp(`^/files/${id}/(comments|mentionable|attachments)(/|$)`), "comments"],
  [/^\/(comments|comment-carries)(\/|$)/, "comments"],
  [new RegExp(`^/tracks/${id}/carry$`), "comments"],
  // Workflows and their runs.
  [/^\/(workflows|workflow-runs)(\/|$)/, "workflows"],
  [new RegExp(`^/projects/${id}/(workflows|workflow-statuses)$`), "workflows"],
  [new RegExp(`^/tracks/${id}/(workflow-runs|workflow-standing)$`), "workflows"],
  // Reviews, their reviewers, groups and guests.
  [/^\/reviews(\/|$)/, reviews],
  [new RegExp(`^/projects/${id}/(reviews|groups|guests|reviewer-grants)(/|$)`), reviews],
  // Everything else in a project: files and what is made of them.
  [/^\/projects$/, files],
  [new RegExp(`^/projects/${id}(/|$)`), files],
  [
    /^\/(folders|files|tracks|versions|variations|takes|sessions|tags|uploads|upload-requests|score-categories|score-marks|stage-boxes|patch-rows|works|venues|schedule-days|schedule-rows|personnel|stage-plans|tasks|categories)(\/|$)/,
    files,
  ],
  [/^\/(search|home)(\/|$)/, files],
];

/** What the workspace's own settings a token with `org:read` may read. */
const organisationReads = /^\/organisation\/(settings|members|delivery-profiles|plan)$/;

/**
 * The scope a call needs, or null where no token may go (signing in, accounts, settings,
 * other tokens, the instance, playback). `path` is the request's, from `/api`. A pure function,
 * so the public API (#197) and the MCP endpoint (#199) ask the same of every call.
 */
export function scopeFor(method: string, path: string): ApiScope | null {
  const m = method.toUpperCase();
  const access: Access | null =
    m === "GET" || m === "HEAD"
      ? "read"
      : m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE"
        ? "write"
        : null;
  if (!access) return null;
  if (!path.startsWith("/api/")) return null;
  // Trailing slashes dropped by hand: a pattern for them is slow on a path of many slashes.
  let end = path.length;
  while (end > 4 && path[end - 1] === "/") end -= 1;
  const rest = path.slice(4, end) || "/";
  // Nothing that walks out of its segment, or that a router might read another way.
  if (/(^|\/)\.\.?(\/|$)|\/\/|%|\\/.test(rest)) return null;
  if (refused.some((r) => r.test(rest))) return null;
  if (organisationReads.test(rest)) return access === "read" ? "org:read" : null;
  for (const [pattern, scope] of rules) {
    if (!pattern.test(rest)) continue;
    return typeof scope === "string" ? scope : scope[access];
  }
  return null;
}
