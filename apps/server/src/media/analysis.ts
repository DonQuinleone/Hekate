import { createReadStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  formatClock,
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
  /** The length the file declares, in seconds, for the integrity check (#41). */
  declared?: number,
): Promise<AudioAnalysis> {
  const samplesPerFrame = samplesPerFrameAt(audio.sampleRate);
  const peaks = new PeakBuilder(audio.channels, audio.sampleRate);
  const phase = new PhaseMeter(audio.channels, samplesPerFrame);
  const checks = new SignalChecks(audio.channels, audio.sampleRate);
  const metadata = join(workspace, "loudness.txt");
  const { stderr } = await run(
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
    findings: [
      ...checks.finish(),
      integrityFinding(checks.seconds, declared, decodeErrors(stderr)),
    ],
  };
}

/** How many errors the decoder reported, from what it wrote with `-v error`. */
export const decodeErrors = (stderr: string) =>
  stderr.split("\n").filter((line) => line.trim() !== "").length;

/**
 * Whether the file decoded cleanly to its declared length (#41): a file cut short, or one the
 * decoder stumbled through, fails.
 */
export function integrityFinding(
  decoded: number,
  declared: number | undefined,
  errors: number,
): QaFinding {
  const short =
    declared !== undefined && Number.isFinite(declared)
      ? declared - decoded > Math.max(0.5, declared * 0.01)
      : false;
  const finding = (severity: QaFinding["severity"], summary: string): QaFinding => ({
    check: "integrity",
    severity,
    summary,
    channel: null,
    start: short ? Math.round(decoded * 1000) / 1000 : null,
    end: null,
    details: {
      decodedSeconds: Math.round(decoded * 1000) / 1000,
      declaredSeconds: declared ?? null,
      errors,
    },
  });
  if (short)
    return finding(
      "fail",
      `Decodes to ${formatClock(decoded)} of the ${formatClock(declared as number)} it declares: the file is likely cut short`,
    );
  if (errors > 0)
    return finding(
      "fail",
      `The decoder met ${errors === 1 ? "an error" : `${errors} errors`} on the way through: the file may be damaged`,
    );
  return finding("pass", "Decodes cleanly, to its full length");
}
