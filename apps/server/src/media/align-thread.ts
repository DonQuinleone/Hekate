import { parentPort, workerData } from "node:worker_threads";
import { alignAudio, decodeForAlignment } from "./align.ts";

/**
 * Entry point of the thread that aligns two files (`alignInThread`), so the fingerprints
 * and the warp never hold up the API on the main thread. It receives two paths in the
 * job's workspace and returns the alignment; an `abort` message stops ffmpeg.
 */
const { a, b } = workerData as { a: string; b: string };
const controller = new AbortController();
parentPort?.on("message", (message) => {
  if (message === "abort") controller.abort();
});
try {
  const [pa, pb] = await Promise.all([
    decodeForAlignment(a, controller.signal),
    decodeForAlignment(b, controller.signal),
  ]);
  parentPort?.postMessage({ ok: true, alignment: alignAudio(pa, pb) });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
  });
}
