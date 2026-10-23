import { describe, expect, it } from "vitest";
import {
  API_TOKEN_PATTERN,
  apiScopes,
  apiTokenExpired,
  apiTokenHint,
  createApiTokenInput,
  isServiceAccount,
  scopeAllows,
  scopeFor,
  updateApiTokenInput,
} from "./api-tokens.ts";

const id = "0190a6f0-0000-7000-8000-000000000001";

describe("API token scopes (#198)", () => {
  it("asks a read scope of reading and a write scope of changing files", () => {
    expect(scopeFor("GET", "/api/projects")).toBe("files:read");
    // Trailing slashes are dropped, quickly however many there are.
    expect(scopeFor("GET", "/api/projects///")).toBe("files:read");
    const started = performance.now();
    expect(scopeFor("GET", `/api/${"/".repeat(50_000)}x`)).toBeNull();
    expect(performance.now() - started).toBeLessThan(200);
    expect(scopeFor("GET", `/api/projects/${id}/files`)).toBe("files:read");
    expect(scopeFor("HEAD", `/api/files/${id}`)).toBe("files:read");
    expect(scopeFor("POST", `/api/projects/${id}/folders`)).toBe("files:write");
    expect(scopeFor("PUT", `/api/uploads/${id}/chunks/0`)).toBe("files:write");
    expect(scopeFor("POST", `/api/tracks/${id}/versions`)).toBe("files:write");
    expect(scopeFor("PATCH", `/api/files/${id}`)).toBe("files:write");
    expect(scopeFor("DELETE", `/api/folders/${id}`)).toBe("files:write");
    expect(scopeFor("GET", "/api/search")).toBe("files:read");
  });

  it("gives reviews, comments, downloads and workflows their own scopes", () => {
    expect(scopeFor("GET", `/api/projects/${id}/reviews`)).toBe("reviews:read");
    expect(scopeFor("POST", `/api/projects/${id}/reviews`)).toBe("reviews:write");
    expect(scopeFor("GET", `/api/reviews/${id}`)).toBe("reviews:read");
    expect(scopeFor("POST", `/api/reviews/${id}/decisions`)).toBe("reviews:write");
    expect(scopeFor("GET", `/api/files/${id}/comments`)).toBe("comments");
    expect(scopeFor("POST", `/api/files/${id}/comments`)).toBe("comments");
    expect(scopeFor("PATCH", `/api/comments/${id}`)).toBe("comments");
    expect(scopeFor("POST", `/api/files/${id}/downloads`)).toBe("downloads");
    expect(scopeFor("GET", "/api/downloads/abc_DEF-123")).toBe("downloads");
    expect(scopeFor("POST", `/api/files/${id}/attachments/${id}/download`)).toBe("downloads");
    expect(scopeFor("DELETE", `/api/files/${id}/attachments/${id}`)).toBe("comments");
    expect(scopeFor("GET", `/api/projects/${id}/workflows`)).toBe("workflows");
    expect(scopeFor("PATCH", `/api/workflows/${id}`)).toBe("workflows");
    expect(scopeFor("GET", "/api/organisation/members")).toBe("org:read");
    expect(scopeFor("GET", "/api/organisation/settings")).toBe("org:read");
  });

  it("lets no token sign in, reach accounts, settings, other tokens, the instance or playback", () => {
    for (const [method, path] of [
      ["POST", "/api/auth/sign-in/email"],
      ["GET", "/api/me"],
      ["GET", "/api/me/tokens"],
      ["POST", "/api/me/tokens"],
      ["GET", "/api/organisation/tokens"],
      ["PATCH", "/api/organisation"],
      ["PUT", "/api/organisation/settings"],
      ["GET", "/api/organisation/audit"],
      ["GET", "/api/organisation/sso"],
      ["POST", "/api/organisation/invitations"],
      ["GET", "/api/instance/workspaces"],
      ["POST", `/api/files/${id}/playback`],
      ["POST", `/api/files/${id}/view`],
      ["GET", "/api/play/token/master.m3u8"],
      ["POST", `/api/projects/${id}/deletion`],
      ["PUT", `/api/projects/${id}/members/user`],
      ["POST", `/api/projects/${id}/calendar/feed`],
      ["GET", "/api/transfers"],
      ["GET", "/api/notifications"],
      ["OPTIONS", "/api/projects"],
      ["GET", "/projects"],
    ] as const)
      expect(scopeFor(method, path), `${method} ${path}`).toBeNull();
  });

  it("refuses paths a router might read another way", () => {
    expect(scopeFor("GET", `/api/projects/${id}/../../me`)).toBeNull();
    expect(scopeFor("GET", "/api/projects//x")).toBeNull();
    expect(scopeFor("GET", "/api/%70lay/x")).toBeNull();
    expect(scopeFor("GET", "/api/projects\\x")).toBeNull();
  });

  it("lets writing a kind include reading it, and nothing more", () => {
    expect(scopeAllows(["files:write"], "files:read")).toBe(true);
    expect(scopeAllows(["reviews:write"], "reviews:read")).toBe(true);
    expect(scopeAllows(["files:read"], "files:write")).toBe(false);
    expect(scopeAllows(["reviews:read"], "reviews:write")).toBe(false);
    expect(scopeAllows(["files:write"], "downloads")).toBe(false);
    expect(scopeAllows([...apiScopes], "org:read")).toBe(true);
  });

  it("takes a name, at least one scope (in order, once each) and a lifetime", () => {
    expect(
      createApiTokenInput.parse({
        name: " Release pipeline ",
        scopes: ["reviews:read", "files:read", "files:read"],
        expiresInDays: 90,
      }),
    ).toEqual({
      name: "Release pipeline",
      scopes: ["files:read", "reviews:read"],
      expiresInDays: 90,
    });
    expect(
      createApiTokenInput.safeParse({ name: "x", scopes: [], expiresInDays: null }).success,
    ).toBe(false);
    expect(
      createApiTokenInput.safeParse({ name: "x", scopes: ["admin"], expiresInDays: null }).success,
    ).toBe(false);
    expect(
      createApiTokenInput.safeParse({ name: "x", scopes: ["comments"], expiresInDays: 7 }).success,
    ).toBe(false);
    expect(updateApiTokenInput.safeParse({}).success).toBe(false);
    expect(updateApiTokenInput.parse({ scopes: ["downloads"] })).toEqual({ scopes: ["downloads"] });
  });

  it("knows a token by its shape, and its hint by its start", () => {
    const token = `hk_pat_${"A".repeat(43)}`;
    expect(API_TOKEN_PATTERN.test(token)).toBe(true);
    expect(API_TOKEN_PATTERN.test(`hk_svc_${"b".repeat(43)}`)).toBe(true);
    expect(API_TOKEN_PATTERN.test(`hk_xyz_${"b".repeat(43)}`)).toBe(false);
    expect(API_TOKEN_PATTERN.test("hk_pat_short")).toBe(false);
    expect(apiTokenHint(token)).toBe("hk_pat_AAAA");
    expect(isServiceAccount("0190@service-token.invalid")).toBe(true);
    expect(isServiceAccount("mira@endlesshall.example")).toBe(false);
  });

  it("says when a token's time has run out", () => {
    const now = new Date("2026-10-23T10:00:00Z");
    expect(apiTokenExpired({ expiresAt: null }, now)).toBe(false);
    expect(apiTokenExpired({ expiresAt: "2026-10-23T09:59:59Z" }, now)).toBe(true);
    expect(apiTokenExpired({ expiresAt: "2026-10-24T10:00:00Z" }, now)).toBe(false);
  });
});
