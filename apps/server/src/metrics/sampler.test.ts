import { describe, expect, it } from "vitest";
import { between, quantileOf, type Reading } from "./sampler.ts";

describe("the minute measured (#156)", () => {
  it("finds a quantile in a histogram's buckets as Prometheus does", () => {
    const totals = (counts: number[], count: number) => ({ bounds: [0.1, 0.5, 1], counts, count });
    expect(quantileOf(totals([0, 0, 0], 0), 0.95)).toBeNull();
    // Every observation under 100 ms: 95% of the way through the first bucket.
    expect(quantileOf(totals([20, 20, 20], 20), 0.95)).toBeCloseTo(0.095);
    // Ten under 100 ms, ten between 100 and 500: the 19th of 20 is 90% into the second.
    expect(quantileOf(totals([10, 20, 20], 20), 0.95)).toBeCloseTo(0.46);
    // Past the last bound: the last bound.
    expect(quantileOf(totals([0, 0, 0], 4), 0.95)).toBe(1);
  });

  it("reads a minute as the difference between two readings", () => {
    const reading = (n: number, idle: number, total: number): Reading => ({
      requests: n,
      errors: n / 10,
      durations: { bounds: [0.1, 1], counts: [n, n], count: n },
      uploadBytes: n * 1_000,
      cpu: { idle, total },
      cores: 4,
    });
    const minute = between(reading(10, 1_000, 2_000), reading(30, 1_300, 3_000));
    expect(minute).toMatchObject({ requests: 20, errors: 2, uploadBytes: 20_000 });
    expect(minute.p95Seconds).toBeCloseTo(0.095);
    expect(minute.cpu).toBeCloseTo(0.7);
    expect(between(reading(10, 0, 0), reading(10, 0, 0))).toMatchObject({
      requests: 0,
      p95Seconds: null,
      cpu: 0,
    });
  });
});
