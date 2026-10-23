import { z } from "zod";
import { type ApiScope, apiScope, apiScopes } from "./api-tokens.ts";

/**
 * OAuth 2.1 (#447, decision 225): applications a workspace registers (its OAuth clients) ask
 * its members for access, and each member's connected apps act as them, within what they
 * granted. An application's access token is one more kind of API token: the same scopes,
 * asked of the same `scopeFor`, the same limits and the same API log.
 */

/** Confidential clients keep a secret on a server; public ones (desktop, mobile) cannot, and prove each exchange with PKCE alone. */
export const oauthClientKinds = ["confidential", "public"] as const;
export type OAuthClientKind = (typeof oauthClientKinds)[number];

export const oauthClientKindLabels: Record<OAuthClientKind, string> = {
  confidential: "Confidential",
  public: "Public (PKCE)",
};

/** How many clients one workspace may register. */
export const OAUTH_CLIENT_LIMIT = 50;
/** Redirect addresses one client may have. */
export const OAUTH_REDIRECT_LIMIT = 10;

/** How long each credential lasts, in seconds. */
export const OAUTH_CODE_SECONDS = 60;
export const OAUTH_ACCESS_SECONDS = 60 * 60;
export const OAUTH_REFRESH_SECONDS = 30 * 24 * 60 * 60;

/**
 * What each credential looks like. Each is 32 random bytes in base64url after a prefix a secret
 * scanner can find, except the client id, which is public and shorter.
 */
export const oauthPrefixes = {
  clientId: "hk_cli_",
  clientSecret: "hk_cls_",
  accessToken: "hk_oat_",
  refreshToken: "hk_ort_",
  code: "hk_oac_",
} as const;
export const OAUTH_CLIENT_ID_PATTERN = /^hk_cli_[A-Za-z0-9_-]{22}$/;
export const OAUTH_SECRET_PATTERN = /^hk_(cls|ort|oac)_[A-Za-z0-9_-]{43}$/;

/** The start of a client id or secret, which settings show to tell them apart: `hk_cli_7f3a`. */
export const oauthHint = (value: string) => value.slice(0, 11);

/** Schemes no redirect may use: they run, read or open something here rather than leave. */
const unsafeSchemes = new Set(["javascript", "data", "file", "vbscript", "blob", "about", "ftp"]);

/** Loopback addresses, where a desktop application listens on a port it picks (RFC 8252). */
const loopbackHosts = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * Why a redirect address cannot be registered, or null when it can: an absolute address with no
 * fragment, at https, at http on this computer only (a loopback address), or at an
 * application's own scheme (`hekate-logic://callback`).
 */
export function redirectUriProblem(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return "Give a whole address, such as https://app.example/oauth/callback";
  }
  if (url.hash || uri.includes("#")) return "A redirect address cannot have a fragment (#)";
  if (url.username || url.password) return "A redirect address cannot carry a name or password";
  const scheme = url.protocol.slice(0, -1);
  if (unsafeSchemes.has(scheme)) return `A redirect address cannot use ${scheme}:`;
  if (scheme === "http" && !loopbackHosts.has(url.hostname))
    return "Use https, or http on this computer only (127.0.0.1 or localhost)";
  if ((scheme === "https" || scheme === "http") && !url.hostname) return "Give the address's host";
  return null;
}

const isLoopbackIp = (url: URL) =>
  url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]");

/**
 * Whether a redirect address in a request is one the client registered: character for
 * character, as OAuth 2.1 asks, except that at a loopback IP address the port may differ, as a
 * desktop application listens on whichever is free (RFC 8252, section 7.3).
 */
export function redirectMatches(registered: readonly string[], given: string): boolean {
  if (registered.includes(given)) return true;
  let asked: URL;
  try {
    asked = new URL(given);
  } catch {
    return false;
  }
  if (!isLoopbackIp(asked)) return false;
  return registered.some((r) => {
    try {
      const url = new URL(r);
      return (
        isLoopbackIp(url) &&
        url.hostname === asked.hostname &&
        url.pathname === asked.pathname &&
        url.search === asked.search
      );
    } catch {
      return false;
    }
  });
}

/**
 * The scopes a request names, space-separated, in settings' order; null when one is not a
 * scope or there are none. A scope named twice counts once.
 */
export function parseScope(scope: string | undefined | null): ApiScope[] | null {
  if (!scope) return null;
  const given = scope.split(" ").filter((s) => s !== "");
  if (given.length === 0) return null;
  if (!given.every((s) => apiScope.safeParse(s).success)) return null;
  return apiScopes.filter((s) => given.includes(s));
}

/** The scopes as a request or a response names them. */
export const scopeString = (scopes: readonly ApiScope[]) => scopes.join(" ");

/** Whether every scope asked is among those held. */
export const scopesWithin = (asked: readonly ApiScope[], held: readonly ApiScope[]) =>
  asked.every((s) => held.includes(s));

/**
 * A PKCE code verifier as RFC 7636 has it: 43 to 128 unreserved characters. The challenge is its
 * SHA-256 in base64url, which is 43 characters; `plain` is never taken.
 */
export const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
export const PKCE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const clientName = z.string().trim().min(1, "Give it a name").max(80);
const redirectUris = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .superRefine((uri, ctx) => {
        const problem = redirectUriProblem(uri);
        if (problem) ctx.addIssue({ code: "custom", message: `${uri}: ${problem}` });
      }),
  )
  .min(1, "Give at least one redirect address")
  .max(OAUTH_REDIRECT_LIMIT, `At most ${OAUTH_REDIRECT_LIMIT} redirect addresses`)
  .transform((given) => [...new Set(given)]);
const clientScopes = z
  .array(apiScope)
  .min(1, "Choose at least one scope")
  .max(apiScopes.length)
  .transform((given) => apiScopes.filter((s) => given.includes(s)));

export const createOAuthClientInput = z
  .object({
    name: clientName,
    kind: z.enum(oauthClientKinds),
    redirectUris,
    scopes: clientScopes,
  })
  .strict();
export type CreateOAuthClientInput = z.infer<typeof createOAuthClientInput>;

/** A client's kind never changes: a public client given a secret would still be public. */
export const updateOAuthClientInput = z
  .object({
    name: clientName.optional(),
    redirectUris: redirectUris.optional(),
    scopes: clientScopes.optional(),
  })
  .strict()
  .refine(
    (v) => v.name !== undefined || v.redirectUris !== undefined || v.scopes !== undefined,
    "Nothing to change",
  );
export type UpdateOAuthClientInput = z.infer<typeof updateOAuthClientInput>;

/** A client as the workspace's settings show it; its secret is shown once, when made or rotated. */
export interface OAuthClientRow {
  id: string;
  name: string;
  kind: OAuthClientKind;
  /** Public: what an application sends to name itself. */
  clientId: string;
  /** The start of its secret (`hk_cls_7f3a`), for a confidential client. */
  secretHint: string | null;
  redirectUris: string[];
  /** What it may ask for; each person grants some or all of it. */
  scopes: ApiScope[];
  createdAt: string;
  createdBy: string | null;
  secretRotatedAt: string | null;
  /** How many people have it connected now. */
  connected: number;
}

/** What making a client, or rotating its secret, answers: the secret, which is not shown again. */
export interface CreatedOAuthClient {
  client: OAuthClientRow;
  /** Null for a public client, which has none. */
  secret: string | null;
}

/** Someone who has a client connected, for the workspace's admins. */
export interface OAuthConnectionRow {
  id: string;
  name: string;
  email: string;
  scopes: ApiScope[];
  connectedAt: string;
  lastUsedAt: string | null;
}

/** An application a member has connected, in Account. */
export interface ConnectedAppRow {
  id: string;
  name: string;
  kind: OAuthClientKind;
  scopes: ApiScope[];
  connectedAt: string;
  lastUsedAt: string | null;
}

/**
 * The parameters of an authorisation request (RFC 6749 section 4.1.1, with PKCE), as the
 * consent screen passes them on. Each is checked by `authorizeProblem` on the server, so a
 * problem is answered the way OAuth says (shown, or sent back to the application).
 */
export const authorizeParams = z.object({
  response_type: z.string().max(40).optional(),
  client_id: z.string().max(200).optional(),
  redirect_uri: z.string().max(2000).optional(),
  scope: z.string().max(500).optional(),
  state: z.string().max(1000).optional(),
  code_challenge: z.string().max(200).optional(),
  code_challenge_method: z.string().max(20).optional(),
  /** `consent` asks again even where the person already granted as much. */
  prompt: z.string().max(40).optional(),
});
export type AuthorizeParams = z.infer<typeof authorizeParams>;

/** The person's answer on the consent screen, with the request it answers. */
export const authorizeDecision = authorizeParams.extend({ approve: z.boolean() }).strict();
export type AuthorizeDecision = z.infer<typeof authorizeDecision>;

/** What the consent screen shows: who asks, for what, where it is sent back to. */
export interface AuthorizeRequestView {
  client: { name: string; kind: OAuthClientKind };
  workspace: { name: string };
  scopes: ApiScope[];
  /** Where the answer goes, by host (or the application's own scheme). */
  returnsTo: string;
  /** The person already granted at least this much, and was not asked to be asked again. */
  granted: boolean;
}

/**
 * A refused authorisation request: shown on the consent screen when the client or its redirect
 * address cannot be trusted (`redirect` null), otherwise sent back to the application.
 */
export interface AuthorizeRefusal {
  error: string;
  description: string;
  redirect: string | null;
}

/** A token request, form-encoded (RFC 6749 sections 4.1.3 and 6), with client credentials in the body or a Basic header. */
export const tokenRequest = z.discriminatedUnion("grant_type", [
  z.object({
    grant_type: z.literal("authorization_code"),
    code: z.string().max(200),
    redirect_uri: z.string().max(2000),
    code_verifier: z.string().max(200).optional(),
    client_id: z.string().max(200).optional(),
    client_secret: z.string().max(200).optional(),
  }),
  z.object({
    grant_type: z.literal("refresh_token"),
    refresh_token: z.string().max(200),
    scope: z.string().max(500).optional(),
    client_id: z.string().max(200).optional(),
    client_secret: z.string().max(200).optional(),
  }),
]);
export type TokenRequest = z.infer<typeof tokenRequest>;

/** A revocation request (RFC 7009). */
export const revokeRequest = z.object({
  token: z.string().max(200),
  token_type_hint: z.string().max(40).optional(),
  client_id: z.string().max(200).optional(),
  client_secret: z.string().max(200).optional(),
});
export type RevokeRequest = z.infer<typeof revokeRequest>;

/** What the token endpoint answers. */
export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}
