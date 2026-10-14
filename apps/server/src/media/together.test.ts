import { describe, expect, it } from "vitest";
import { together } from "./together.ts";

/** A task that runs until cancelled, and records that it ended. */
const untilCancelled = (log: string[], name: string) => (signal: AbortSignal) =>
  new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => {
      setTimeout(() => {
        log.push(`${name} ended`);
        reject(new Error(`${name} cancelled`));
      }, 10);
    });
  });

describe("together", () => {
  it("returns every result in order", async () => {
    const out = await together(new AbortController().signal, [
      async () => 1,
      async () => "two",
    ] as const);
    expect(out).toEqual([1, "two"]);
  });

  it("cancels the others when one fails, and waits for them to end", async () => {
    const log: string[] = [];
    const run = together(new AbortController().signal, [
      untilCancelled(log, "spectrogram"),
      async () => {
        throw new Error("decode failed");
      },
    ] as const);
    await expect(run).rejects.toThrow("decode failed");
    expect(log).toEqual(["spectrogram ended"]);
  });

  it("passes the caller's cancellation on", async () => {
    const log: string[] = [];
    const controller = new AbortController();
    const run = together(controller.signal, [
      untilCancelled(log, "a"),
      untilCancelled(log, "b"),
    ] as const);
    controller.abort();
    await expect(run).rejects.toThrow(/cancelled/);
    expect(log.sort()).toEqual(["a ended", "b ended"]);
  });
});
