import { describe, expect, it } from "vitest";
import { apiBase, apiErrorBody, apiErrorCodes, unversioned } from "./public-api.ts";

describe("the public API's versions (#197, decision 224)", () => {
  it("reads a versioned path as the unversioned one it reaches", () => {
    expect(apiBase()).toBe("/api/v1");
    expect(unversioned("/api/v1/projects")).toEqual({ version: 1, path: "/api/projects" });
    expect(unversioned("/api/v1/files/0192/comments")).toEqual({
      version: 1,
      path: "/api/files/0192/comments",
    });
    expect(unversioned("/api/v1")).toEqual({ version: 1, path: "/api" });
    // A version the server does not answer, and paths that only look like one.
    expect(unversioned("/api/v2/projects")).toBeNull();
    expect(unversioned("/api/v1projects")).toBeNull();
    expect(unversioned("/api/projects")).toBeNull();
    expect(unversioned("/v1/projects")).toBeNull();
  });

  it("names a status for every error code, and the shape they come in", () => {
    for (const { status } of Object.values(apiErrorCodes)) {
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
    expect(
      apiErrorBody.safeParse({ error: { code: "internal", message: "x", reference: "HK-7F3A-2C" } })
        .success,
    ).toBe(true);
    expect(apiErrorBody.safeParse({ success: false, error: { name: "ZodError" } }).success).toBe(
      false,
    );
  });
});
