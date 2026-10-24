import { describe, expect, it } from "vitest";
import {
  createOAuthClientInput,
  parseScope,
  redirectMatches,
  redirectUriProblem,
  scopesWithin,
  tokenRequest,
  updateOAuthClientInput,
} from "./oauth.ts";

describe("redirect addresses (#447)", () => {
  it("takes https, loopback http and an application's own scheme", () => {
    for (const ok of [
      "https://slack.endlesshall.example/oauth/callback",
      "https://app.example/cb?from=hekate",
      "http://127.0.0.1/callback",
      "http://[::1]:8080/callback",
      "http://localhost:3000/callback",
      "hekate-logic://callback",
      "com.endlesshall.review:/oauth",
    ])
      expect(redirectUriProblem(ok), ok).toBeNull();
  });

  it("refuses what could run, read or open something here, or carries a fragment", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,hi",
      "file:///etc/passwd",
      "http://app.example/callback",
      "https://app.example/callback#done",
      "https://user:pass@app.example/cb",
      "/oauth/callback",
      "callback",
    ])
      expect(redirectUriProblem(bad), bad).not.toBeNull();
  });

  it("matches character for character, but any port at a loopback IP address", () => {
    const registered = ["https://app.example/cb", "http://127.0.0.1/callback"];
    expect(redirectMatches(registered, "https://app.example/cb")).toBe(true);
    expect(redirectMatches(registered, "https://app.example/cb/")).toBe(false);
    expect(redirectMatches(registered, "https://APP.example/cb")).toBe(false);
    expect(redirectMatches(registered, "https://app.example/cb?x=1")).toBe(false);
    expect(redirectMatches(registered, "https://app.example:8443/cb")).toBe(false);
    expect(redirectMatches(registered, "http://127.0.0.1:51234/callback")).toBe(true);
    expect(redirectMatches(registered, "http://127.0.0.1:51234/other")).toBe(false);
    expect(redirectMatches(registered, "http://[::1]:51234/callback")).toBe(false);
    expect(redirectMatches(["http://localhost/cb"], "http://localhost:9999/cb")).toBe(false);
    expect(redirectMatches(registered, "not an address")).toBe(false);
  });
});

describe("scopes in a request (#447)", () => {
  it("reads space-separated scopes in settings' order, once each", () => {
    expect(parseScope("comments files:read comments")).toEqual(["files:read", "comments"]);
    expect(parseScope("  files:read  ")).toEqual(["files:read"]);
  });

  it("refuses an unknown scope, or none", () => {
    expect(parseScope("files:read admin")).toBeNull();
    expect(parseScope("")).toBeNull();
    expect(parseScope(" ")).toBeNull();
    expect(parseScope(undefined)).toBeNull();
  });

  it("tells whether what is asked is within what is held", () => {
    expect(scopesWithin(["files:read"], ["files:read", "comments"])).toBe(true);
    expect(scopesWithin(["files:read", "downloads"], ["files:read", "comments"])).toBe(false);
  });
});

describe("a client's settings (#447)", () => {
  const input = {
    name: "Hekate for Slack",
    kind: "confidential",
    redirectUris: ["https://slack.endlesshall.example/cb", "https://slack.endlesshall.example/cb"],
    scopes: ["comments", "reviews:read"],
  };

  it("keeps each address once and the scopes in order", () => {
    expect(createOAuthClientInput.parse(input)).toEqual({
      ...input,
      redirectUris: ["https://slack.endlesshall.example/cb"],
      scopes: ["reviews:read", "comments"],
    });
  });

  it("refuses a client with no address, no scope or a bad address, and a change of kind", () => {
    expect(createOAuthClientInput.safeParse({ ...input, redirectUris: [] }).success).toBe(false);
    expect(createOAuthClientInput.safeParse({ ...input, scopes: [] }).success).toBe(false);
    expect(
      createOAuthClientInput.safeParse({ ...input, redirectUris: ["javascript:x"] }).success,
    ).toBe(false);
    expect(updateOAuthClientInput.safeParse({ kind: "public" }).success).toBe(false);
    expect(updateOAuthClientInput.safeParse({}).success).toBe(false);
  });
});

describe("token requests (#447)", () => {
  it("takes the two grants and nothing else", () => {
    expect(
      tokenRequest.safeParse({ grant_type: "authorization_code", code: "c", redirect_uri: "r" })
        .success,
    ).toBe(true);
    expect(
      tokenRequest.safeParse({ grant_type: "refresh_token", refresh_token: "t" }).success,
    ).toBe(true);
    expect(tokenRequest.safeParse({ grant_type: "password", username: "u" }).success).toBe(false);
    expect(tokenRequest.safeParse({ grant_type: "authorization_code", code: "c" }).success).toBe(
      false,
    );
  });
});
