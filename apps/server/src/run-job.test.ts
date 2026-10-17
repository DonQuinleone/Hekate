import { afterEach, describe, expect, it, vi } from "vitest";
import { runJob } from "./jobs.ts";
import { registry } from "./metrics/index.ts";

const job = { id: "j-1", data: {}, signal: new AbortController().signal, retryCount: 0 };

describe("a job's run", () => {
  afterEach(() => vi.restoreAllMocks());

  it("logs its start, end and time while verbose logging is on", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runJob(
      "workspaces-purge",
      job,
      async () => undefined,
      undefined,
      async () => true,
    );
    expect(log.mock.calls.map(([line]) => String(line))).toEqual([
      "Job workspaces-purge j-1 started (attempt 1)",
      expect.stringMatching(/^Job workspaces-purge j-1 finished in \d+ ms$/),
    ]);
  });

  it("says nothing while it is off, or cannot be read", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await runJob(
      "workspaces-purge",
      job,
      async () => undefined,
      undefined,
      async () => false,
    );
    await runJob(
      "workspaces-purge",
      job,
      async () => undefined,
      undefined,
      () => Promise.reject(new Error("no database")),
    );
    expect(log).not.toHaveBeenCalled();
  });

  it("logs a failure with its time, and still fails", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(
      runJob(
        "workspaces-purge",
        job,
        async () => {
          throw new Error("disk full");
        },
        undefined,
        async () => true,
      ),
    ).rejects.toThrow("disk full");
    expect(String(log.mock.calls.at(-1)?.[0])).toMatch(/failed after \d+ ms: Error: disk full$/);
  });

  it("is timed and counted for Prometheus, by queue and outcome (#70)", async () => {
    await runJob("storage-reconcile", job, async () => undefined);
    await expect(
      runJob("storage-reconcile", job, async () => {
        throw new Error("disk full");
      }),
    ).rejects.toThrow();
    const text = await registry.render();
    expect(text).toContain('hekate_jobs_failed_total{queue="storage-reconcile"} 1');
    expect(text).toContain(
      'hekate_job_duration_seconds_count{queue="storage-reconcile",outcome="completed"} 1',
    );
    expect(text).toContain(
      'hekate_job_duration_seconds_count{queue="storage-reconcile",outcome="failed"} 1',
    );
  });
});
