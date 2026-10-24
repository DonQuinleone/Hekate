import type { OAuthClientRow } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import { clientHint, connectedHint } from "./oauth";

const client: OAuthClientRow = {
  id: "0190a6f0-0000-7000-8000-000000000001",
  name: "Hekate for Slack",
  kind: "confidential",
  clientId: "hk_cli_7f3aAAAAAAAAAAAAAAAAAA",
  secretHint: "hk_cls_2c91",
  redirectUris: ["https://slack.endlesshall.example/oauth/callback"],
  scopes: ["reviews:read", "comments"],
  createdAt: "2026-10-02T10:00:00Z",
  createdBy: "Mira Solberg",
  secretRotatedAt: null,
  connected: 1,
};

describe("an OAuth client's row (#447)", () => {
  it("says its kind, where it goes back to, what it may ask and who has it", () => {
    expect(clientHint(client)).toBe(
      "Confidential · https://slack.endlesshall.example/oauth/callback · reviews:read, comments · 1 person connected",
    );
    expect(
      clientHint({
        ...client,
        kind: "public",
        redirectUris: ["hekate-logic://callback", "http://127.0.0.1/callback"],
        connected: 0,
      }),
    ).toBe(
      "Public (PKCE) · hekate-logic://callback and 1 more · reviews:read, comments · 0 people connected",
    );
  });
});

describe("a connected app's row (#447)", () => {
  it("says what it may do in words, since when, and when it last called", () => {
    const hint = connectedHint({
      scopes: ["reviews:read", "comments"],
      connectedAt: "2026-08-19T10:00:00Z",
      lastUsedAt: null,
    });
    expect(hint).toMatch(
      /^Read reviews, read and write comments · connected .*2026 · not used yet$/,
    );
  });
});
