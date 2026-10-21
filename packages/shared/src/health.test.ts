import { describe, expect, it } from "vitest";
import { combineReplicas, type HealthMinute, healthSeries, readiness } from "./health.ts";

describe("readiness", () => {
  const all = { database: "ok", storage: "ok", worker: "ok", mail: "ok" } as const;

  it("is ready while the database and storage are, whatever the worker and mail", () => {
    expect(readiness("0.2.0", all).status).toBe("ready");
    expect(readiness("0.2.0", { ...all, worker: "stale", mail: "failed" }).status).toBe("ready");
  });

  it("is not ready without the database or storage", () => {
    expect(readiness("0.2.0", { ...all, database: "failed" }).status).toBe("not_ready");
    expect(readiness("0.2.0", { ...all, storage: "failed" }).status).toBe("not_ready");
  });
});

describe("the System health charts", () => {
  const now = new Date("2026-10-20T12:00:30Z");
  const minute = (at: string, over: Partial<HealthMinute> = {}): HealthMinute => ({
    at,
    requests: 0,
    errors: 0,
    p95Seconds: null,
    jobsWaiting: 0,
    lanes: 4,
    lanesBusy: 0,
    uploadBytes: 0,
    ...over,
  });

  it("gives the hour a point a minute, a gap where nothing was measured", () => {
    const series = healthSeries(
      [
        minute("2026-10-20T11:58:00Z", { requests: 120, errors: 3, p95Seconds: 0.2 }),
        minute("2026-10-20T11:59:00Z", { requests: 0, uploadBytes: 1_000 }),
      ],
      "1h",
      now,
    );
    expect(series.step).toBe(1);
    expect(series.requestsPerMinute).toHaveLength(60);
    expect(series.requestsPerMinute.slice(-3)).toEqual([null, 120, 0]);
    expect(series.errorRate.slice(-2)).toEqual([2.5, 0]);
    expect(series.p95Ms.slice(-2)).toEqual([200, null]);
    expect(series.uploadBytesPerHour.at(-1)).toBe(60_000);
    expect(series.lanes).toBe(4);
  });

  it("gives the day a point a quarter of an hour, rates per minute measured", () => {
    const series = healthSeries(
      [
        minute("2026-10-20T11:45:00Z", { requests: 30, p95Seconds: 0.1, jobsWaiting: 2 }),
        minute("2026-10-20T11:50:00Z", { requests: 10, p95Seconds: 0.4, jobsWaiting: 4 }),
        // Older than the day: left out.
        minute("2026-10-19T11:00:00Z", { requests: 1_000 }),
      ],
      "24h",
      now,
    );
    expect(series.step).toBe(15);
    expect(series.requestsPerMinute).toHaveLength(96);
    expect(series.requestsPerMinute.at(-1)).toBe(20);
    // The slowest minute's, not an average that would hide it.
    expect(series.p95Ms.at(-1)).toBe(400);
    expect(series.jobsWaiting.at(-1)).toBe(3);
    expect(series.requestsPerMinute.filter((p) => p !== null)).toHaveLength(1);
  });
});

describe("every replica as one (#188)", () => {
  const reading = (share: number | null, cores: number, used: number, busy: number) => ({
    cpu: share === null ? null : { share, cores },
    memory: { used: used, total: 16 },
    lanes: { used: busy, total: 2 },
  });

  it("adds lanes and memory up, and weighs the processors by their cores", () => {
    expect(combineReplicas([reading(0.5, 2, 4, 1), reading(0.2, 8, 8, 0)])).toEqual({
      cpu: { share: (0.5 * 2 + 0.2 * 8) / 10, cores: 10 },
      memory: { used: 12, total: 32 },
      lanes: { used: 1, total: 4 },
    });
  });

  it("leaves a share as it was when one machine is counted twice", () => {
    const one = combineReplicas([reading(0.3, 4, 6, 1)]);
    const twice = combineReplicas([reading(0.3, 4, 6, 1), reading(0.3, 4, 6, 1)]);
    expect(twice.cpu?.share).toBeCloseTo(one.cpu?.share ?? 0);
    expect((twice.memory?.used ?? 0) / (twice.memory?.total ?? 1)).toBe(
      (one.memory?.used ?? 0) / (one.memory?.total ?? 1),
    );
  });

  it("knows no processors before anything was measured, and nothing with no replica", () => {
    expect(combineReplicas([reading(null, 4, 6, 0)]).cpu).toBeNull();
    expect(combineReplicas([])).toEqual({ cpu: null, memory: null, lanes: { used: 0, total: 0 } });
  });
});
