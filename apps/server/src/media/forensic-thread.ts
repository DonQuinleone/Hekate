import { parentPort, workerData } from "node:worker_threads";
import { traceFile, writeMark } from "./forensic-audio.ts";

/**
 * Entry point of the thread that makes and reads forensic marks (`markInThread`,
 * `traceInThread`), so the signal processing never holds up the API on the main thread. It
 * works on paths in a private workspace; an `abort` message stops ffmpeg.
 */
const work = workerData as
  | {
      task: "mark";
      input: string;
      output: string;
      key: Uint8Array;
      markId: string;
      channels: number;
      timeoutMs: number;
    }
  | {
      task: "trace";
      input: string;
      groups: { key: Uint8Array; ids: string[] }[];
      seconds: number;
      timeoutMs: number;
    };
const controller = new AbortController();
parentPort?.on("message", (message) => {
  if (message === "abort") controller.abort();
});
try {
  const result =
    work.task === "mark"
      ? await writeMark(work.input, work.output, {
          key: Buffer.from(work.key),
          markId: work.markId,
          channels: work.channels,
          signal: controller.signal,
          timeoutMs: work.timeoutMs,
        })
      : await traceFile(
          work.input,
          work.groups.map((g) => ({ key: Buffer.from(g.key), ids: g.ids })),
          { seconds: work.seconds, signal: controller.signal, timeoutMs: work.timeoutMs },
        );
  parentPort?.postMessage({ ok: true, result });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
  });
}
