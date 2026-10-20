import { describe, expect, it } from "vitest";
import { type HealthMinute, healthSeries, readiness } from "./health.ts";

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
