import { describe, expect, it } from "vitest";
import { parseBars } from "./anchor.ts";
import { anchorProblem } from "./comments.ts";
import { formatAnchor } from "./format.ts";
import { defaultReferences, parseBeat, referencesOf } from "./references.ts";

describe("comment references", () => {
  it("defaults by profile, and reads a project's own choice", () => {
    expect(defaultReferences("music")).toEqual({ page: true, bar: true, beat: true });
    expect(defaultReferences("video")).toEqual({ page: false, bar: false, beat: false });
    expect(referencesOf(null, "music")).toEqual({ page: true, bar: true, beat: true });
    expect(referencesOf({ page: false, bar: true, beat: false }, "general")).toEqual({
      page: false,
      bar: true,
      beat: false,
    });
    expect(referencesOf({ page: "yes" }, "general").bar).toBe(false);
  });

  it("reads a beat typed in its own field", () => {
    expect(parseBeat("3")).toBe(3);
    expect(parseBeat(" 2.5 ")).toBe(2.5);
    expect(parseBeat("0")).toBeNull();
    expect(parseBeat("33")).toBeNull();
    expect(parseBeat("three")).toBeNull();
  });

  it("reads a beat only where beats are taken", () => {
    expect(parseBars("25.3")).toBeNull();
    expect(parseBars("25.3", { beats: true })).toEqual({ from: { bar: 25, beat: 3 } });
    expect(parseBars("bar 9:2.5", { beats: true })).toEqual({ from: { bar: 9, beat: 2.5 } });
    expect(parseBars("9.40", { beats: true })).toBeNull();
    expect(parseBars("9-12", { beats: true })).toEqual({
      from: { bar: 9, beat: 1 },
      to: { bar: 12 },
    });
  });

  it("refuses what a project does not take, and shows the page", () => {
    const anchor = { kind: "bar" as const, from: { bar: 9, beat: 2 }, page: 3 };
    const audio = { kind: "audio" as const, profile: "music" as const };
    expect(
      anchorProblem(anchor, { ...audio, references: { page: true, bar: true, beat: true } }),
    ).toBeNull();
    expect(
      anchorProblem(anchor, { ...audio, references: { page: false, bar: true, beat: true } }),
    ).toMatch(/page/);
    expect(
      anchorProblem(anchor, { ...audio, references: { page: true, bar: true, beat: false } }),
    ).toMatch(/beats/);
    expect(
      anchorProblem(anchor, { ...audio, references: { page: true, bar: false, beat: true } }),
    ).toMatch(/bar/);
    // A general project that chose bars takes them, whatever its profile.
    expect(
      anchorProblem(
        { kind: "bar", from: { bar: 4, beat: 1 } },
        {
          kind: "document",
          profile: "general",
          references: { page: false, bar: true, beat: false },
        },
      ),
    ).toBeNull();
    expect(formatAnchor(anchor)).toBe("P. 3 · BAR 9.2");
  });
});
