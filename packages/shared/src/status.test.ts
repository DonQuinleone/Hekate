import { describe, expect, it } from "vitest";
import {
  checkedState,
  daysSince,
  formatUptime,
  type IncidentSpan,
  incidentInput,
  incidentMomentProblem,
  incidentUpdateInput,
  serviceDays,
  serviceStateNow,
  weightedCover,
  worstState,
} from "./status.ts";

const now = new Date("2026-10-23T12:00:00Z");

describe("status page (#183)", () => {
  it("takes the worse of what was measured and what is posted", () => {
    expect(worstState([])).toBe("operational");
    expect(worstState(["degraded", "major", "partial"])).toBe("major");
    expect(checkedState("failed")).toBe("major");
    expect(checkedState("stale")).toBe("degraded");
    expect(checkedState("off")).toBe("operational");
    const open = [{ impact: "partial" as const, services: ["storage" as const] }];
    expect(serviceStateNow("storage", "ok", open)).toBe("partial");
    expect(serviceStateNow("api", "ok", open)).toBe("operational");
    expect(serviceStateNow("storage", "failed", open)).toBe("major");
  });

  it("draws none before the first measure, and counts uptime from there", () => {
    const { uptime, days } = serviceDays(
      "api",
      [{ day: "2026-10-22", service: "api", minutes: 1440, down: 0 }],
      [],
      now,
    );
    expect(days).toHaveLength(90);
    expect(days.at(-1)?.day).toBe("2026-10-23");
    expect(days.at(-3)?.state).toBe("none");
    expect(days.at(-2)?.state).toBe("operational");
    expect(uptime).toBe(1);
  });

  it("counts incidents over the same time once, at the worst impact", () => {
    expect(
      weightedCover([
        { from: 0, to: 60, weight: 1 },
        { from: 0, to: 60, weight: 1 },
        { from: 30, to: 90, weight: 0.3 },
      ]),
    ).toBeCloseTo(60 + 30 * 0.3, 6);
    const hour = (title: string): IncidentSpan => ({
      title,
      impact: "major",
      services: ["api"],
      startedAt: "2026-10-22T10:00:00Z",
      resolvedAt: "2026-10-22T11:00:00Z",
    });
    const { days } = serviceDays("api", [], [hour("Sign-in fails"), hour("Uploads fail")], now);
    expect(days.at(-2)?.downMinutes).toBe(60);
  });

  it("knows nothing without a measure or an incident", () => {
    const { uptime, days } = serviceDays("api", [], [], now);
    expect(uptime).toBeNull();
    expect(days.every((d) => d.state === "none")).toBe(true);
  });

  it("counts minutes measured down, and colours the day by how many", () => {
    const { uptime, days } = serviceDays(
      "storage",
      [
        { day: "2026-10-21", service: "storage", minutes: 1440, down: 0 },
        { day: "2026-10-22", service: "storage", minutes: 1440, down: 144 },
        { day: "2026-10-22", service: "api", minutes: 1440, down: 1440 },
      ],
      [],
      now,
    );
    expect(days.at(-2)).toMatchObject({ state: "major", downMinutes: 144 });
    // Two whole days and half of today, 144 minutes down.
    expect(uptime).toBeCloseTo(1 - 144 / (1440 * 2 + 720), 6);
  });

  it("counts an outage nothing inside could measure once it is posted", () => {
    const outage: IncidentSpan = {
      title: "The instance is down",
      impact: "major",
      services: ["api", "database"],
      startedAt: "2026-10-22T10:00:00Z",
      resolvedAt: "2026-10-22T12:00:00Z",
    };
    const { uptime, days } = serviceDays(
      "api",
      [{ day: "2026-10-22", service: "api", minutes: 1320, down: 0 }],
      [outage],
      now,
    );
    expect(days.at(-2)).toMatchObject({
      state: "major",
      downMinutes: 120,
      incidents: ["The instance is down"],
    });
    expect(uptime).toBeCloseTo(1 - 120 / (1440 + 720), 6);
    // Another service the incident does not name is untouched.
    expect(serviceDays("mail", [], [outage], now).uptime).toBeNull();
  });

  it("weighs a partial outage lightly and slowness not at all, and takes the more of the two", () => {
    const partial: IncidentSpan = {
      title: "Some uploads fail",
      impact: "partial",
      services: ["storage"],
      startedAt: "2026-10-22T00:00:00Z",
      resolvedAt: "2026-10-22T10:00:00Z",
    };
    const slow: IncidentSpan = { ...partial, title: "Slow", impact: "degraded" };
    const records = [{ day: "2026-10-22", service: "storage" as const, minutes: 1440, down: 30 }];
    expect(serviceDays("storage", records, [partial], now).days.at(-2)?.downMinutes).toBe(180);
    const quiet = serviceDays("storage", records, [slow], now).days.at(-2);
    expect(quiet).toMatchObject({ downMinutes: 30, state: "partial" });
  });

  it("runs an open incident up to now, across midnight", () => {
    const open: IncidentSpan = {
      title: "Mail is not going out",
      impact: "major",
      services: ["mail"],
      startedAt: "2026-10-22T23:00:00Z",
      resolvedAt: null,
    };
    const { days } = serviceDays("mail", [], [open], now);
    expect(days.at(-2)).toMatchObject({ downMinutes: 60, state: "major" });
    expect(days.at(-1)).toMatchObject({ downMinutes: 720, state: "major" });
  });

  it("never prints 100% with a minute down", () => {
    expect(formatUptime(null)).toBe("No data yet");
    expect(formatUptime(1)).toBe("100%");
    expect(formatUptime(0.999999)).toBe("99.99%");
    expect(formatUptime(0.98765)).toBe("98.76%");
  });

  it("counts whole days since the last incident", () => {
    expect(daysSince("2026-09-12T12:00:00Z", now)).toBe(41);
    expect(daysSince("2026-10-23T11:00:00Z", now)).toBe(0);
  });

  it("takes an incident with what it touches, in the page's order", () => {
    const parsed = incidentInput.parse({
      title: " Uploads fail ",
      impact: "partial",
      services: ["worker", "storage", "storage"],
      body: "We are looking into it.",
    });
    expect(parsed).toMatchObject({
      title: "Uploads fail",
      state: "investigating",
      services: ["storage", "worker"],
    });
    expect(incidentInput.safeParse({ ...parsed, services: [] }).success).toBe(false);
    expect(incidentInput.safeParse({ ...parsed, services: ["proxy"] }).success).toBe(false);
  });

  it("gives an end only to a resolved incident, after its start", () => {
    const base = { title: "Down", impact: "major", services: ["api"], body: "It was down." };
    expect(incidentInput.safeParse({ ...base, resolvedAt: "2026-10-22T12:00:00Z" }).success).toBe(
      false,
    );
    expect(
      incidentInput.safeParse({
        ...base,
        state: "resolved",
        startedAt: "2026-10-22T12:00:00Z",
        resolvedAt: "2026-10-22T11:00:00Z",
      }).success,
    ).toBe(false);
    expect(
      incidentInput.safeParse({
        ...base,
        state: "resolved",
        startedAt: "2026-10-22T10:00:00Z",
        resolvedAt: "2026-10-22T11:00:00Z",
      }).success,
    ).toBe(true);
  });

  it("refuses a moment ahead of now or before the page's 90 days", () => {
    expect(incidentMomentProblem("2026-10-23T11:00:00Z", now)).toBeNull();
    expect(incidentMomentProblem("2026-10-23T13:00:00Z", now)).toMatch(/future/);
    expect(incidentMomentProblem("2026-07-01T00:00:00Z", now)).toMatch(/90 days/);
  });

  it("takes an update with or without a change of what it touches", () => {
    expect(incidentUpdateInput.parse({ state: "monitoring", body: "A fix is out." })).toEqual({
      state: "monitoring",
      body: "A fix is out.",
    });
    expect(incidentUpdateInput.safeParse({ state: "resolved", body: " " }).success).toBe(false);
  });
});
