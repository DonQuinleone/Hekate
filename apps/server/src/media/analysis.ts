import { createReadStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  type LoudnessSeries,
  type LoudnessSummary,
  type PeakLevel,
  peakLevels,
  type QaFinding,
  samplesPerFrameAt,
} from "@hekate/shared";
import { run, safeInputArgs } from "./ffmpeg.ts";
import { finishLoudness, LoudnessParser, loudnessFilters, PhaseMeter } from "./loudness.ts";
import { PeakBuilder } from "./peaks.ts";
import { SignalChecks } from "./qa.ts";

export interface AudioAnalysis {
  levels: PeakLevel[];
  loudness: { series: LoudnessSeries; summary: LoudnessSummary };
  /** The QA's signal checks (#41), from the same samples. */
  findings: QaFinding[];
}

/**
 * Decode a file's first audio stream once, every channel as recorded, and measure it:
 * waveform peaks and phase from the PCM, loudness and levels from ffmpeg's own meters. The
 * decoded audio streams through and is never written anywhere (an hour of 96 kHz surround
 * would be gigabytes); only the meters' text goes to the job's workspace.
 */
export async function analyseAudio(
  path: string,
  audio: { channels: number; sampleRate: number },
  workspace: string,
  signal: AbortSignal,
): Promise<AudioAnalysis> {
  const samplesPerFrame = samplesPerFrameAt(audio.sampleRate);
  const peaks = new PeakBuilder(audio.channels, audio.sampleRate);
  const phase = new PhaseMeter(audio.channels, samplesPerFrame);
  const checks = new SignalChecks(audio.channels, audio.sampleRate);
  const metadata = join(workspace, "loudness.txt");
  await run(
    "ffmpeg",
    [
      ...safeInputArgs("ffmpeg"),
      "-v",
      "error",
      "-i",
      `file:${path}`,
      "-map",
      "0:a:0",
      "-vn",
      "-af",
      loudnessFilters(samplesPerFrame, metadata),
      "-f",
      "f32le",
      "-acodec",
      "pcm_f32le",
      // Keep the source's channels and rate exactly; a peak describes real samples.
      "-ac",
      String(audio.channels),
      "-ar",
      String(audio.sampleRate),
      "pipe:1",
    ],
    {
      signal,
      timeoutMs: 60 * 60_000,
      onStdout: (chunk) => {
        peaks.push(chunk);
        phase.push(chunk);
        checks.push(chunk);
      },
    },
  );
  const base = peaks.finish();
  if (base.count === 0) throw new Error("No audio was decoded");

  const parser = new LoudnessParser(audio.channels);
  const lines = createInterface({ input: createReadStream(metadata), crlfDelay: Infinity });
  for await (const line of lines) parser.line(line);
  return {
    levels: peakLevels(base),
    loudness: finishLoudness(parser, phase, audio.sampleRate),
    findings: checks.finish(),
  };
}
