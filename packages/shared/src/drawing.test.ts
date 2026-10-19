import { describe, expect, it } from "vitest";
import { remapAnchor } from "./alignment.ts";
import { anchor, drawing, drawingBounds, regionShowsAt } from "./anchor.ts";
import { anchorProblem, anchorTime } from "./comments.ts";
import { formatAnchor } from "./format.ts";

describe("drawings on a frame or page (#146)", () => {
  it("takes two points for a shape, any number for a stroke, one with text", () => {
    expect(
      drawing.safeParse({
        tool: "box",
        colour: "signal",
        points: [
          [0.1, 0.1],
          [0.4, 0.3],
        ],
      }).success,
    ).toBe(true);
    expect(
      drawing.safeParse({ tool: "arrow", colour: "paper", points: [[0.1, 0.1]] }).success,
    ).toBe(false);
    expect(
      drawing.safeParse({
        tool: "free",
        colour: "blue",
        points: [
          [0.1, 0.1],
          [0.2, 0.15],
          [0.3, 0.3],
        ],
      }).success,
    ).toBe(true);
    expect(
      drawing.safeParse({
        tool: "text",
        colour: "green",
        points: [[0.5, 0.5]],
        text: "Boom in shot",
      }).success,
    ).toBe(true);
    expect(drawing.safeParse({ tool: "text", colour: "green", points: [[0.5, 0.5]] }).success).toBe(
      false,
    );
    expect(
      drawing.safeParse({
        tool: "box",
        colour: "signal",
        points: [
          [0.1, 0.1],
          [1.2, 0.3],
        ],
      }).success,
    ).toBe(false);
    expect(
      drawing.safeParse({
        tool: "box",
        colour: "purple",
        points: [
          [0.1, 0.1],
          [0.2, 0.3],
        ],
      }).success,
    ).toBe(false);
  });

  it("is kept on a region anchor, with its box as the region, on a frame or a range", () => {
    const d = {
      tool: "circle" as const,
      colour: "signal" as const,
      points: [
        [0.6, 0.2],
        [0.4, 0.5],
      ] as [number, number][],
    };
    expect(drawingBounds(d)).toEqual({ x: 0.4, y: 0.2, width: 0.2, height: 0.3 });
    expect(
      drawingBounds({
        points: [
          [0.2, 0.5],
          [0.8, 0.5],
        ],
      }),
    ).toEqual({
      x: 0.2,
      y: 0.5,
      width: 0.6,
      height: 0,
    });
    const parsed = anchor.parse({
      kind: "region",
      at: 12.5,
      end: 14,
      ...drawingBounds(d),
      drawing: d,
    });
    expect(parsed).toMatchObject({ kind: "region", drawing: { tool: "circle" } });
    expect(
      anchor.safeParse({ kind: "region", at: 12, end: 11, x: 0, y: 0, width: 1, height: 1 })
        .success,
    ).toBe(false);
    expect(
      anchor.safeParse({ kind: "region", end: 11, x: 0, y: 0, width: 1, height: 1 }).success,
    ).toBe(false);
  });

  it("shows on its own frame, or through its range", () => {
    const frame = 1 / 25;
    expect(regionShowsAt({ at: 10 }, 10, frame)).toBe(true);
    expect(regionShowsAt({ at: 10 }, 10.01, frame)).toBe(true);
    expect(regionShowsAt({ at: 10 }, 10.04, frame)).toBe(false);
    expect(regionShowsAt({ at: 10 }, 9.9, frame)).toBe(false);
    expect(regionShowsAt({ at: 10, end: 12 }, 11, frame)).toBe(true);
    expect(regionShowsAt({ at: 10, end: 12 }, 12.1, frame)).toBe(false);
    expect(regionShowsAt({}, 10, frame)).toBe(false);
  });

  it("plays from the frame it was drawn on, and moves with it to the next version", () => {
    const region = {
      kind: "region" as const,
      at: 10,
      end: 12,
      x: 0.1,
      y: 0.1,
      width: 0.2,
      height: 0.2,
    };
    expect(anchorTime(region)).toBe(10);
    expect(formatAnchor(region)).toBe("00:10.000 – 00:12.000 · REGION");
    expect(
      formatAnchor({
        ...region,
        end: undefined,
        drawing: {
          tool: "arrow",
          colour: "signal",
          points: [
            [0.1, 0.1],
            [0.3, 0.3],
          ],
        },
      }),
    ).toBe("00:10.000 · DRAWING");
    expect(anchorTime({ kind: "region", page: 2, x: 0, y: 0, width: 1, height: 1 })).toBeNull();
    // Two seconds were added at the start of the next version.
    const later = [
      [0, 2],
      [60, 62],
    ] as [number, number][];
    expect(remapAnchor(later, region)).toEqual({ ...region, at: 12, end: 14 });
    expect(remapAnchor(later, { ...region, end: undefined })).toMatchObject({ at: 12 });
  });

  it("is refused past the end of the video, or on audio", () => {
    const video = { kind: "video" as const, duration: 60 };
    const drawn = {
      kind: "region" as const,
      at: 50,
      x: 0.1,
      y: 0.1,
      width: 0.2,
      height: 0.2,
      drawing: {
        tool: "box" as const,
        colour: "signal" as const,
        points: [
          [0.1, 0.1],
          [0.3, 0.3],
        ] as [number, number][],
      },
    };
    expect(anchorProblem(drawn, video)).toBeNull();
    expect(anchorProblem({ ...drawn, end: 75 }, video)).toMatch(/past the end/);
    expect(anchorProblem({ ...drawn, at: 70 }, video)).toMatch(/past the end/);
    expect(anchorProblem(drawn, { kind: "audio", duration: 60 })).toMatch(/page or a frame/);
  });
});
