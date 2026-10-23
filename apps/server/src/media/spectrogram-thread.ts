import { parentPort, workerData } from "node:worker_threads";
import { encodeSpectrogram, type SpectrogramAnalysis } from "@hekate/shared";
import { computeSpectrograms } from "./spectrogram.ts";

/**
 * Entry point of the thread that builds spectrograms (`spectrogramsInThread`), so a long
 * analysis never holds up the API on the main thread. It receives a path in the job's
 * workspace and returns encoded spectrograms; an `abort` message stops ffmpeg.
 */
const { path, audio, duration, analysis } = workerData as {
  path: string;
  audio: { channels: number; sampleRate: number };
  duration: number | undefined;
  analysis: SpectrogramAnalysis;
};
const controller = new AbortController();
parentPort?.on("message", (message) => {
  if (message === "abort") controller.abort();
});
try {
  const out = await computeSpectrograms(path, audio, duration, controller.signal, analysis);
  const encoded = out.map(({ channel, spectrogram }) => ({
    channel,
    columns: spectrogram.columns,
    bands: spectrogram.bands,
    fftSize: spectrogram.fftSize,
    samplesPerColumn: spectrogram.samplesPerColumn,
    bytes: encodeSpectrogram(spectrogram),
  }));
  parentPort?.postMessage(
    { ok: true, encoded },
    encoded.map((e) => e.bytes.buffer as ArrayBuffer),
  );
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    message: error instanceof Error ? error.message : String(error),
  });
}
