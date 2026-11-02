import { describe, expect, it } from "vitest";
import { traySummary } from "./upload-tray";

const at = (sent: number, total: number, more: { error?: string; done?: boolean } = {}) => ({
  progress: { sent, total },
  ...more,
});

describe("the upload tray's line", () => {
  it("counts what is still going, by bytes, apart from what failed or arrived", () => {
    expect(
      traySummary([at(50, 100), at(0, 300), at(10, 10, { done: true }), at(5, 20, { error: "x" })]),
    ).toEqual({ going: 2, failed: 1, done: 1, percent: 12 });
  });

  it("is whole once everything has arrived", () => {
    expect(traySummary([at(10, 10, { done: true })])).toMatchObject({ going: 0, percent: 100 });
  });
});
