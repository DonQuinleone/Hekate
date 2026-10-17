import { describe, expect, it } from "vitest";
import { flagOn, flagParam, flagUntil } from "./flags.ts";

describe("instance flags", () => {
  const now = new Date("2026-10-17T06:00:00Z");

  it("is on until its time is past", () => {
    expect(flagOn(undefined, now)).toBe(false);
    expect(flagOn({ on: false, until: null }, now)).toBe(false);
    expect(flagOn({ on: true, until: null }, now)).toBe(true);
    expect(flagOn({ on: true, until: new Date("2026-10-17T06:30:00Z") }, now)).toBe(true);
    expect(flagOn({ on: true, until: new Date("2026-10-17T05:59:59Z") }, now)).toBe(false);
  });

  it("turns verbose logging off by itself after an hour", () => {
    expect(flagUntil("worker.verbose", now)?.toISOString()).toBe("2026-10-17T07:00:00.000Z");
  });

  it("knows only its own flags", () => {
    expect(flagParam.safeParse({ key: "worker.verbose" }).success).toBe(true);
    expect(flagParam.safeParse({ key: "everything.on" }).success).toBe(false);
  });
});
