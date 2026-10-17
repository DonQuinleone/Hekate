import { describe, expect, it } from "vitest";
import { templateContent } from "./templates.ts";

describe("template content", () => {
  it("holds whatever a project may: no limits of its own on roles or categories", () => {
    const content = {
      settings: {
        carriedCommentsShown: true,
        deliveryProfile: null,
        checkTruePeak: false,
        requireEdl: true,
        qaSettings: null,
      },
      roles: Array.from({ length: 80 }, (_, i) => ({ name: `Role ${i}`, permissions: ["view"] })),
      categories: Array.from({ length: 150 }, (_, i) => ({
        name: `Kind ${i}`,
        handling: "normal",
        stage: null,
      })),
    };
    expect(templateContent.safeParse(content).success).toBe(true);
    expect(
      templateContent.safeParse({ ...content, roles: [{ name: "X", permissions: ["fly"] }] })
        .success,
    ).toBe(false);
  });
});
