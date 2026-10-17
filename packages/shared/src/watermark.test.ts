import { describe, expect, it } from "vitest";
import { defaultWatermark, marks, watermarkOf, watermarkText } from "./watermark.ts";

describe("visible watermark", () => {
  it("marks guests by default, everyone when chosen, and no one when off", () => {
    expect(marks(defaultWatermark, "guest")).toBe(true);
    expect(marks(defaultWatermark, "member")).toBe(false);
    const everyone = { ...defaultWatermark, scope: "everyone" } as const;
    expect(marks(everyone, "member")).toBe(true);
    expect(marks({ ...defaultWatermark, scope: "off" }, "guest")).toBe(false);
  });

  it("reads a project's choice, or the default", () => {
    expect(watermarkOf(null)).toEqual(defaultWatermark);
    expect(watermarkOf({ scope: "everyone", position: "corner", opacity: 50 })).toEqual({
      scope: "everyone",
      position: "corner",
      opacity: 50,
    });
    expect(watermarkOf({ scope: "everyone", position: "corner", opacity: 5 })).toEqual(
      defaultWatermark,
    );
  });

  it("writes who, where and when on two lines, whatever was typed", () => {
    expect(
      watermarkText(
        { name: "Mira\n  Solberg", email: "mira@example.test" },
        "Endless Hall Records",
        new Date("2026-10-17T12:00:00Z"),
      ),
    ).toBe("Mira Solberg · mira@example.test\nEndless Hall Records · 17 October 2026");
  });
});
