import { describe, expect, it } from "vitest";
import { inLanes, type Jobs, jobDefinitions, laneOf } from "./jobs.ts";
import { concurrencyIn, lanes, parseLanes, roleOf, servesPath } from "./lanes.ts";

describe("lanes and roles (#189)", () => {
  it("puts every kind of job in a lane", () => {
    for (const name of Object.keys(jobDefinitions) as (keyof typeof jobDefinitions)[])
      expect(lanes).toContain(laneOf(name));
    expect(laneOf("media-proxy")).toBe("transcode");
    expect(laneOf("document-render")).toBe("pages");
    expect(laneOf("notifications-mail")).toBe("mail");
  });

  it("reads WORKER_LANES, with or without how many at once", () => {
    const read = parseLanes("transcode:4, analyse ,pages:1");
    expect("plan" in read && [...(read.plan ?? [])]).toEqual([
      ["transcode", 4],
      ["analyse", null],
      ["pages", 1],
    ]);
    expect(parseLanes("render")).toEqual({ error: expect.stringContaining("not a lane") });
    expect(parseLanes("mail,mail")).toEqual({ error: "mail is named twice" });
    expect(parseLanes("mail:0")).toEqual({ error: expect.stringContaining("1 to 64") });
    expect(parseLanes("mail:2:3")).toEqual({ error: expect.stringContaining("not a lane") });
  });

  it("runs a lane as the plan says, as the job asks where it does not, and not at all if left out", () => {
    const plan = new Map([
      ["transcode", 4],
      ["analyse", null],
    ] as const);
    expect(concurrencyIn(null, "mail", 1)).toBe(1);
    expect(concurrencyIn(plan, "transcode", 1)).toBe(4);
    expect(concurrencyIn(plan, "analyse", 2)).toBe(2);
    expect(concurrencyIn(plan, "mail", 1)).toBeNull();
  });

  it("registers only the jobs in the lanes taken", async () => {
    const worked: [string, number | undefined][] = [];
    const jobs = {
      work: async (name: string, _handler: unknown, options?: { concurrency?: number }) => {
        worked.push([name, options?.concurrency]);
      },
    } as unknown as Jobs;
    const taking = inLanes(jobs, new Map([["transcode", 3]]));
    await taking.work("media-proxy", async () => {}, { concurrency: 1 });
    await taking.work("media-probe", async () => {}, { concurrency: 2 });
    await taking.work("notifications-mail", async () => {});
    expect(worked).toEqual([["media-proxy", 3]]);
  });

  it("takes WORKER's older switch when ROLE is not set", () => {
    expect(roleOf(undefined, true)).toBe("all");
    expect(roleOf(undefined, false)).toBe("api");
    expect(roleOf("worker", true)).toBe("worker");
  });

  it("lets a worker answer only its health and metrics", () => {
    expect(servesPath("worker", "/api/health/ready")).toBe(true);
    expect(servesPath("worker", "/metrics")).toBe(true);
    expect(servesPath("worker", "/api/projects")).toBe(false);
    expect(servesPath("worker", "/")).toBe(false);
    expect(servesPath("api", "/api/projects")).toBe(true);
    expect(servesPath("all", "/")).toBe(true);
  });
});
