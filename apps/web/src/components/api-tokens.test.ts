import type { ApiTokenRow } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import { tokenHint } from "./api-tokens";

const token: ApiTokenRow = {
  id: "0190a6f0-0000-7000-8000-000000000001",
  kind: "personal",
  name: "Release pipeline",
  hint: "hk_pat_7f3a",
  scopes: ["files:read", "reviews:read"],
  createdAt: "2026-10-02T10:00:00Z",
  createdBy: "Mira Solberg",
  lastUsedAt: null,
  expiresAt: "2027-01-02T10:00:00Z",
};

describe("a token's row (#198)", () => {
  const now = new Date("2026-10-14T10:00:00Z");

  it("says what it may do, when it was made and used, and when it ends", () => {
    const hint = tokenHint(token, now);
    // Dates in ISO 8601 (#481) unless the workspace chose otherwise.
    expect(hint).toMatch(
      /^files:read, reviews:read · made 2026-10-0\d.* · never used · expires 2027-01-0\d.*$/,
    );
    // A member's own does not name its maker; a service token does.
    expect(hint).not.toContain("Mira Solberg");
    expect(tokenHint({ ...token, kind: "service" }, now)).toContain("by Mira Solberg");
  });

  it("says when it ran out, or that it never will", () => {
    expect(tokenHint({ ...token, expiresAt: "2026-10-01T10:00:00Z" }, now)).toMatch(/expired /);
    expect(tokenHint({ ...token, expiresAt: null }, now)).toMatch(/never expires$/);
  });
});
