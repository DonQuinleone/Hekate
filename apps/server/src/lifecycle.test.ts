import { describe, expect, it } from "vitest";
import { isStopping, shutDown } from "./lifecycle.ts";

describe("stopping without dropping anyone (#193)", () => {
  it("is unready first, drains, then stops serving and then working, within the time", async () => {
    let clock = 0;
    const seen: string[] = [];
    expect(isStopping()).toBe(false);
    await shutDown(
      {
        drain: async (ms) => {
          seen.push(`drain ${ms} ready=${!isStopping()}`);
          clock += ms;
        },
        stopServing: async (ms) => {
          seen.push(`serving ${ms}`);
          clock += 4_000;
        },
        stopWork: async (ms) => {
          seen.push(`work ${ms}`);
        },
      },
      { drainMs: 5_000, timeoutMs: 30_000 },
      () => clock,
    );
    // Unready before the drain begins; requests get half of what is left, jobs the rest.
    expect(seen).toEqual(["drain 5000 ready=false", "serving 12500", "work 21000"]);
  });

  it("never drains past the whole time, and leaves each later step a moment", async () => {
    let clock = 0;
    const given: number[] = [];
    await shutDown(
      {
        drain: async (ms) => {
          given.push(ms);
          clock += ms;
        },
        stopServing: async (ms) => {
          given.push(ms);
          clock += ms;
        },
        stopWork: async (ms) => {
          given.push(ms);
        },
      },
      { drainMs: 60_000, timeoutMs: 10_000 },
      () => clock,
    );
    expect(given).toEqual([10_000, 1_000, 1_000]);
  });
});
