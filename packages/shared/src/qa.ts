import { z } from "zod";
import type { LoudnessSummary } from "./loudness.ts";
import type { MediaInfo } from "./media.ts";

/**
 * Quality checks (#41, docs/domain.md): what the media worker finds in a recording, as
 * findings with a check, a severity, a plain-English summary, and where they apply.
 *
 * Two kinds. Signal checks (clipping, dropouts, clicks, DC offset, phase) are measured from
 * the samples once, when the file is analysed, and do not depend on the project. Delivery
 * checks (loudness, true peak, format, dead channels and balance) are read from those
 * measurements against the project's delivery profile whenever they are shown, so choosing
 * another profile needs no new analysis.
 */

export const qaSeverities = ["pass", "info", "warn", "fail"] as const;
export type QaSeverity = (typeof qaSeverities)[number];

export const qaChecks = [
  "format",
  "loudness",
  "true-peak",
  "clipping",
  "flat-tops",
  "dropouts",
  "clicks",
  "dc-offset",
  "silence",
  "dead-channel",
  "imbalance",
  "phase",
] as const;
export type QaCheck = (typeof qaChecks)[number];

export const qaFinding = z.object({
  check: z.enum(qaChecks),
  severity: z.enum(qaSeverities),
  summary: z.string(),
  /** 0-based channel, in the file's order; null for the whole file. */
  channel: z.number().int().nonnegative().nullable(),
  /** Where in the file, in seconds; null for the whole file. */
  start: z.number().nonnegative().nullable(),
  end: z.number().nonnegative().nullable(),
  /** The technical numbers behind the summary. */
  details: z.record(z.string(), z.union([z.number(), z.string(), z.boolean(), z.null()])),
});
export type QaFinding = z.infer<typeof qaFinding>;

/** What a delivery asks of a recording. A null target is not checked. */
export interface DeliveryProfile {
  label: string;
  /** Integrated loudness, LUFS, and how far either side is acceptable. */
  loudness: { target: number; tolerance: number } | null;
  /** The highest true peak allowed, dBTP. */
  truePeakMax: number;
  /** Sample rates accepted: exactly these, or at least the first when `atLeast`. */
  sampleRates: { rates: readonly number[]; atLeast: boolean };
  /** Bits per sample, at least (or exactly, when `bitDepthExact`). */
  bitDepthMin: number | null;
  bitDepthExact?: boolean;
  channels: number;
}

export const deliveryProfileIds = [
  "streaming",
  "cd",
  "apple-digital-masters",
  "broadcast",
  "surround",
  "atmos",
] as const;
export type DeliveryProfileId = (typeof deliveryProfileIds)[number];
export const deliveryProfileId = z.enum(deliveryProfileIds);

export const deliveryProfiles: Record<DeliveryProfileId, DeliveryProfile> = {
  streaming: {
    label: "Streaming",
    loudness: { target: -14, tolerance: 1 },
    truePeakMax: -1,
    sampleRates: { rates: [44_100], atLeast: true },
    bitDepthMin: 16,
    channels: 2,
  },
  cd: {
    label: "CD",
    loudness: null,
    truePeakMax: -0.1,
    sampleRates: { rates: [44_100], atLeast: false },
    bitDepthMin: 16,
    bitDepthExact: true,
    channels: 2,
  },
  "apple-digital-masters": {
    label: "Apple Digital Masters",
    loudness: null,
    truePeakMax: -1,
    sampleRates: { rates: [44_100], atLeast: true },
    bitDepthMin: 24,
    channels: 2,
  },
  broadcast: {
    label: "Broadcast (EBU R128)",
    loudness: { target: -23, tolerance: 1 },
    truePeakMax: -1,
    sampleRates: { rates: [48_000], atLeast: false },
    bitDepthMin: 16,
    channels: 2,
  },
  surround: {
    label: "Surround 5.1",
    loudness: { target: -23, tolerance: 1 },
    truePeakMax: -1,
    sampleRates: { rates: [48_000], atLeast: false },
    bitDepthMin: 24,
    channels: 6,
  },
  atmos: {
    label: "Dolby Atmos (7.1.4 bed)",
    loudness: { target: -18, tolerance: 1 },
    truePeakMax: -1,
    sampleRates: { rates: [48_000], atLeast: false },
    bitDepthMin: 24,
    channels: 12,
  },
};

/** The profile a project without one is checked against, from the file's channels. */
export function suggestedProfile(channels: number): DeliveryProfileId {
  if (channels >= 12) return "atmos";
  if (channels >= 6) return "surround";
  return "streaming";
}

const fmt = (n: number, digits = 1) => n.toFixed(digits).replace("-", "−");

/** A channel's name for a summary: "channel 2", counted from 1 as engineers do. */
export const channelName = (channel: number) => `channel ${channel + 1}`;

/** Below this a channel carries nothing: −90 dBFS. */
export const DEAD_CHANNEL_DB = -90;
/** Front channels further apart than this in level are out of balance, dB. */
export const IMBALANCE_DB = 3;

/**
 * The delivery checks: the recording's measured facts against a profile. Each check gives
 * one finding, a pass included, so a report shows what was checked as well as what failed.
 */
export function deliveryFindings(
  profile: DeliveryProfile,
  info: MediaInfo | null,
  summary: LoudnessSummary | null,
): QaFinding[] {
  const out: QaFinding[] = [];
  const whole = { channel: null, start: null, end: null } as const;
  const audio = info?.audio;
  if (audio) {
    const problems: string[] = [];
    const { rates, atLeast } = profile.sampleRates;
    const rateOk = atLeast ? audio.sampleRate >= (rates[0] ?? 0) : rates.includes(audio.sampleRate);
    if (!rateOk) problems.push(`${audio.sampleRate / 1000} kHz`);
    if (
      profile.bitDepthMin &&
      audio.bitDepth &&
      (profile.bitDepthExact
        ? audio.bitDepth !== profile.bitDepthMin
        : audio.bitDepth < profile.bitDepthMin)
    ) {
      problems.push(`${audio.bitDepth}-bit`);
    }
    if (audio.channels !== profile.channels) {
      problems.push(`${audio.channels} ${audio.channels === 1 ? "channel" : "channels"}`);
    }
    out.push({
      check: "format",
      severity: problems.length ? "fail" : "pass",
      summary: problems.length
        ? `Not as ${profile.label} asks: ${problems.join(", ")}`
        : `${audio.sampleRate / 1000} kHz${audio.bitDepth ? `, ${audio.bitDepth}-bit` : ""}, ${audio.channels} channels`,
      ...whole,
      details: {
        sampleRate: audio.sampleRate,
        bitDepth: audio.bitDepth ?? null,
        channels: audio.channels,
        codec: audio.codec,
      },
    });
  }
  if (!summary) return out;

  if (profile.loudness && summary.integrated !== null) {
    const { target, tolerance } = profile.loudness;
    const off = summary.integrated - target;
    out.push({
      check: "loudness",
      severity:
        Math.abs(off) <= tolerance ? "pass" : Math.abs(off) <= 2 * tolerance ? "warn" : "fail",
      summary:
        Math.abs(off) <= tolerance
          ? `${fmt(summary.integrated)} LUFS, on target`
          : `${fmt(summary.integrated)} LUFS, ${fmt(Math.abs(off))} LU ${off > 0 ? "above" : "below"} the ${fmt(target, 0)} LUFS target`,
      ...whole,
      details: { integrated: summary.integrated, target, tolerance, range: summary.range },
    });
  }
  if (summary.truePeak !== null) {
    const over = summary.truePeak > profile.truePeakMax;
    out.push({
      check: "true-peak",
      severity: over ? "fail" : "pass",
      summary: over
        ? `True peak ${fmt(summary.truePeak)} dBTP, over the ${fmt(profile.truePeakMax)} dBTP ceiling`
        : `True peak ${fmt(summary.truePeak)} dBTP`,
      ...whole,
      details: { truePeak: summary.truePeak, ceiling: profile.truePeakMax },
    });
  }

  // Channels with nothing in them, while others carry the music.
  const peaks = summary.channels.map((c) => c.samplePeak);
  const anyAlive = peaks.some((p) => p !== null && p > DEAD_CHANNEL_DB);
  summary.channels.forEach((c, i) => {
    if (anyAlive && (c.samplePeak === null || c.samplePeak <= DEAD_CHANNEL_DB)) {
      out.push({
        check: "dead-channel",
        severity: "fail",
        summary: `Nothing on ${channelName(i)}`,
        channel: i,
        start: null,
        end: null,
        details: { samplePeak: c.samplePeak },
      });
    }
  });

  // Balance of the front pair.
  const [left, right] = summary.channels;
  if (left?.rms != null && right?.rms != null) {
    const diff = left.rms - right.rms;
    if (Math.abs(diff) > IMBALANCE_DB) {
      out.push({
        check: "imbalance",
        severity: "warn",
        summary: `${diff > 0 ? "Left" : "Right"} is ${fmt(Math.abs(diff))} dB louder than ${diff > 0 ? "right" : "left"}`,
        channel: null,
        start: null,
        end: null,
        details: { leftRms: left.rms, rightRms: right.rms },
      });
    }
  }
  return out;
}

const severityOrder: Record<QaSeverity, number> = { fail: 0, warn: 1, info: 2, pass: 3 };

/** Findings worst first, each check together, then in the order they occur. */
export const orderFindings = (findings: readonly QaFinding[]) =>
  [...findings].sort(
    (a, b) =>
      severityOrder[a.severity] - severityOrder[b.severity] ||
      qaChecks.indexOf(a.check) - qaChecks.indexOf(b.check) ||
      (a.start ?? -1) - (b.start ?? -1) ||
      (a.channel ?? -1) - (b.channel ?? -1),
  );
