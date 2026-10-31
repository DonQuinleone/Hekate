import { formatClock } from "./format.ts";
import { layoutLabel } from "./layouts.ts";
import type { LoudnessSummary } from "./loudness.ts";
import type { MediaInfo } from "./media.ts";
import { admHeading, admLine, metadataRows } from "./metadata.ts";
import { combineChannels, type PeakLevel } from "./peaks.ts";
import {
  channelName,
  type DeliveryProfile,
  formatMeets,
  frameRateName,
  type QaCheck,
  type QaFinding,
  type QaSeverity,
  qaCheckNames,
  qaSeverityNames,
  videoCodecs,
  videoPrimaries,
} from "./qa.ts";
import { type CustomRule, ruleMeasures, ruleOperators, signalChecks } from "./qa-rules.ts";

/**
 * The QA report as a document worth sending (#515, decision 293): a cover with the verdict, a
 * summary of the measures against the delivery profile, the findings grouped by severity then
 * time, each with a crop of the waveform around it and what to do, and appendices (the
 * loudness over the whole file, the format and metadata in full, the rules it was checked
 * against, and the way back to the file). One structure, built here from the facts: the
 * server sets it as a PDF and the app shows it as a page, so the two say the same.
 */

/** The verdict's tone: as the severities, with the checks not yet run as their own. */
export type QaVerdictTone = "pass" | "warn" | "fail" | "pending";

export interface QaVerdict {
  tone: QaVerdictTone;
  /** One line, as the cover says it. */
  words: string;
}

/** A shaded stretch of the loudness gauge: on target, or near enough to look at. */
export interface GaugeZone {
  from: number;
  to: number;
  tone: "pass" | "warn";
}

/** Integrated loudness on a scale, with the profile's target and tolerance marked. */
export interface LoudnessGauge {
  /** The scale's ends, in LUFS. */
  min: number;
  max: number;
  /** Where the scale is numbered. */
  ticks: number[];
  /** The measured loudness, null where nothing was measured. */
  value: number | null;
  target: number | null;
  tolerance: number | null;
  zones: GaugeZone[];
}

/** The passage a finding's crop shows, and the part of it the finding covers. */
export interface CropWindow {
  from: number;
  to: number;
  markFrom: number;
  markTo: number;
}

/** A crop of the waveform: the window, and each column's lowest and highest level, -1 to 1. */
export interface FindingCrop extends CropWindow {
  envelope: [number, number][] | null;
}

export interface ReportFinding {
  check: QaCheck;
  /** The check's name, or a project rule's own. */
  name: string;
  severity: QaSeverity;
  /** `00:12.005–00:12.500`, `00:31.000`, or "Whole file". */
  at: string;
  start: number | null;
  end: number | null;
  /** "Channel 2", where it is about one channel. */
  channel: string | null;
  /** What was heard (or seen): the finding's own summary. */
  heard: string;
  /** What to do about it. */
  advice: string;
  crop: FindingCrop | null;
  /**
   * Set out in full, with its crop and what to do; false for the fifth and later of the same
   * check in a group, which follow as a line each, so forty clicks do not run to ten pages.
   */
  illustrated: boolean;
}

export interface ReportGroup {
  severity: Exclude<QaSeverity, "pass">;
  /** "Fails", "Worth a look", "Notes". */
  label: string;
  findings: ReportFinding[];
}

/** One rule the file was checked against, with how it came out. */
export interface RuleLine {
  /** The delivery profile's, a signal check, or one of the project's own. */
  source: "profile" | "signal" | "project";
  label: string;
  /** What was asked, in words. */
  asked: string;
  /** The worst any finding of it came to; null where it was not measured. */
  result: QaSeverity | null;
}

/** Short-term loudness over the whole file, in LUFS, null where nothing was there. */
export interface LoudnessCurve {
  duration: number;
  points: (number | null)[];
  min: number;
  max: number;
  /** Where the scale is numbered. */
  ticks: number[];
  target: number | null;
  tolerance: number | null;
}

/** The report, as both the PDF and the page set it. */
export interface QaDocument {
  file: {
    id: string;
    name: string;
    track: string | null;
    version: number | null;
    variant: string | null;
  };
  workspace: string;
  project: string;
  /** Who asked for the report, and their part in the project. */
  preparedBy: { name: string; role: string | null };
  /** ISO 8601, and as the workspace writes dates. */
  preparedAt: string;
  preparedOn: string;
  /** When the file was measured, as the workspace writes dates; null before it is. */
  measuredOn: string | null;
  profile: string;
  status: string;
  verdict: QaVerdict;
  summary: {
    gauge: LoudnessGauge | null;
    integrated: number | null;
    range: number | null;
    truePeak: number | null;
    ceiling: number;
    shortTermMax: number | null;
    counts: Record<QaSeverity, number>;
    format: [string, string][];
    metadata: [string, string][];
  };
  groups: ReportGroup[];
  passed: { name: string; summary: string }[];
  appendix: {
    curve: LoudnessCurve | null;
    format: [string, string][];
    rules: RuleLine[];
    /** The file in Hekate, for the QR code and the link. */
    link: string;
  };
}

/** The facts a report is made from. */
export interface QaDocumentFacts {
  file: QaDocument["file"];
  workspace: string;
  project: string;
  preparedBy: QaDocument["preparedBy"];
  preparedAt: Date;
  preparedOn: string;
  measuredOn: string | null;
  profile: DeliveryProfile;
  /** The project's own rules (#144). */
  rules: readonly CustomRule[];
  status: string;
  loudness: LoudnessSummary | null;
  format: MediaInfo | null;
  /** As the QA view has them: the project's settings applied. */
  findings: readonly QaFinding[];
  /** The waveform's peaks, at a level fine enough for the crops; null where there are none. */
  peaks: PeakLevel | null;
  /** Short-term loudness, a frame each `secondsPerFrame`, in LUFS (null for silence). */
  shortTerm: { values: readonly (number | null)[]; secondsPerFrame: number } | null;
  link: string;
}

/** A level as a page writes it: one decimal, a true minus sign. */
export const decibels = (n: number, digits = 1) => n.toFixed(digits).replace("-", "−");

const severityRank: Record<QaSeverity, number> = { fail: 0, warn: 1, info: 2, pass: 3 };
const worst = (a: QaSeverity | null, b: QaSeverity): QaSeverity =>
  a === null || severityRank[b] < severityRank[a] ? b : a;

/** How many findings there are of each severity. */
export function severityCounts(findings: readonly QaFinding[]): Record<QaSeverity, number> {
  const counts: Record<QaSeverity, number> = { fail: 0, warn: 0, info: 0, pass: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}

/** A finding's name: its check's, or the project rule's own. */
export const findingName = (f: Pick<QaFinding, "check" | "details">) =>
  f.check === "custom" && typeof f.details.name === "string"
    ? f.details.name
    : qaCheckNames[f.check];

/** Names in a sentence: "clipping", "clipping and true peak", "a, b and 2 more". */
function listed(names: string[]): string {
  const lower = names.map((n) => (/^[A-Z][a-z]/.test(n) ? n[0]?.toLowerCase() + n.slice(1) : n));
  if (lower.length <= 1) return lower.join("");
  if (lower.length <= 3) return `${lower.slice(0, -1).join(", ")} and ${lower.at(-1)}`;
  return `${lower.slice(0, 2).join(", ")} and ${lower.length - 2} more`;
}

/** The checks with findings at a severity, each named once, in the order they first come. */
const checksAt = (findings: readonly QaFinding[], severity: QaSeverity) => [
  ...new Set(findings.filter((f) => f.severity === severity).map(findingName)),
];

/**
 * The verdict in one line: not ready while any check fails (naming them), ready with what is
 * worth a look, or ready outright; and, before the checks have run, that they have not.
 */
export function qaVerdict(
  findings: readonly QaFinding[],
  status: string,
  profile: string,
): QaVerdict {
  if (status === "pending") return { tone: "pending", words: "Still being measured." };
  if (status === "failed")
    return { tone: "pending", words: "The checks could not run on this file." };
  if (status !== "ready") return { tone: "pending", words: "Not measured." };
  const fails = checksAt(findings, "fail");
  if (fails.length > 0) {
    const verb = fails.length === 1 ? "fails" : "fail";
    return {
      tone: "fail",
      words: `Not ready for ${profile}: ${listed(fails)} ${verb}.`,
    };
  }
  const warns = checksAt(findings, "warn");
  if (warns.length > 0)
    return {
      tone: "warn",
      words: `Ready for ${profile}, with ${warns.length === 1 ? "one thing" : `${warns.length} things`} worth a look.`,
    };
  return { tone: "pass", words: `Ready for ${profile}: every check passes.` };
}

/**
 * Integrated loudness on a scale wide enough to read at a glance: centred on the profile's
 * target, at least 8 LU either side and numbered every 2 LU, widened in steps of 2 (and
 * numbered every 5 beyond 10) to take the measured value with room to spare. Without a target
 * (CD, Apple Digital Masters), −30 to 0 LUFS, widened in fives. The value is kept on the scale
 * as measured; one beyond −60 LUFS is drawn at the end.
 */
export function loudnessGauge(
  integrated: number | null,
  loudness: DeliveryProfile["loudness"],
): LoudnessGauge {
  if (!loudness) {
    const low = integrated !== null ? Math.min(-30, Math.floor((integrated - 3) / 5) * 5) : -30;
    const min = Math.max(-60, low);
    const ticks: number[] = [];
    for (let t = min; t <= 0; t += 5) ticks.push(t);
    return { min, max: 0, ticks, value: integrated, target: null, tolerance: null, zones: [] };
  }
  const { target, tolerance } = loudness;
  const off = integrated === null ? 0 : Math.abs(integrated - target);
  const half = Math.max(8, Math.ceil((off + 2) / 2) * 2, Math.ceil((tolerance * 2 + 2) / 2) * 2);
  const step = half > 10 ? 5 : 2;
  const min = Math.max(-60, target - half);
  const max = Math.min(0, target + half);
  const ticks: number[] = [];
  for (let t = Math.ceil(min / step) * step; t <= max; t += step) ticks.push(t);
  const clip = (n: number) => Math.min(max, Math.max(min, n));
  return {
    min,
    max,
    ticks,
    value: integrated,
    target,
    tolerance,
    zones: [
      { from: clip(target - 2 * tolerance), to: clip(target - tolerance), tone: "warn" },
      { from: clip(target - tolerance), to: clip(target + tolerance), tone: "pass" },
      { from: clip(target + tolerance), to: clip(target + 2 * tolerance), tone: "warn" },
    ],
  };
}

/** Where a level falls on a gauge or a curve's scale, 0 at its foot to 1 at its top. */
export const scaleAt = (scale: { min: number; max: number }, value: number) =>
  Math.min(1, Math.max(0, (value - scale.min) / (scale.max - scale.min)));

/** The least a crop shows either side of what it is about, in seconds. */
const CROP_PAD = 0.75;
/** The most a crop shows, unless the finding itself is longer. */
const CROP_LONGEST = 60;

/**
 * The passage a finding's crop shows: the finding with half as much again either side (at
 * least three quarters of a second, so a click has room around it), at most a minute unless
 * the finding is longer, moved rather than cut where it meets either end of the file. Null
 * for a finding about the whole file.
 */
export function cropWindow(
  f: Pick<QaFinding, "start" | "end">,
  duration: number | null,
): CropWindow | null {
  if (f.start === null) return null;
  const markFrom = f.start;
  const markTo = Math.max(f.end ?? f.start, f.start);
  const length = markTo - markFrom;
  let pad = Math.max(CROP_PAD, length * 0.5);
  if (length + 2 * pad > CROP_LONGEST) pad = Math.max(CROP_PAD, (CROP_LONGEST - length) / 2);
  let from = markFrom - pad;
  let to = markTo + pad;
  const end = duration && duration > 0 ? duration : null;
  if (from < 0) {
    to -= from;
    from = 0;
  }
  if (end !== null && to > end) {
    from = Math.max(0, from - (to - end));
    to = end;
  }
  return { from, to, markFrom, markTo: end !== null ? Math.min(markTo, end) : markTo };
}

/** Columns a crop's envelope is drawn in. */
export const CROP_COLUMNS = 160;

/**
 * The waveform over a window, in columns: each column's lowest and highest level across every
 * channel, from −1 to 1, to two decimals. Null where the peaks do not reach the window.
 */
export function cropEnvelope(
  level: PeakLevel,
  window: Pick<CropWindow, "from" | "to">,
  columns = CROP_COLUMNS,
): [number, number][] | null {
  const combined = combineChannels(level);
  const perSecond = level.sampleRate / level.samplesPerPeak;
  const first = Math.floor(window.from * perSecond);
  const last = Math.ceil(window.to * perSecond);
  if (first >= combined.count || last <= first) return null;
  const round = (n: number) => Math.round((n / 128) * 100) / 100;
  const out: [number, number][] = [];
  for (let c = 0; c < columns; c++) {
    const a = first + Math.floor(((last - first) * c) / columns);
    const b = Math.max(a + 1, first + Math.floor(((last - first) * (c + 1)) / columns));
    let min = 127;
    let max = -128;
    for (let p = a; p < b && p < combined.count; p++) {
      min = Math.min(min, combined.data[p * 2] as number);
      max = Math.max(max, combined.data[p * 2 + 1] as number);
    }
    out.push(min > max ? [0, 0] : [round(min), round(max)]);
  }
  return out;
}

/** Points the loudness curve is drawn with. */
export const CURVE_POINTS = 240;

/**
 * Short-term loudness over the whole file in at most `points` steps, each the loudest frame
 * of its stretch (so a peak in loudness is never averaged away), null where all of a stretch
 * is silence; on a scale from the quietest stretch heard (at most −40 LUFS, rounded down to 5)
 * to 0 LUFS, numbered every 5 or 10 LU.
 */
export function loudnessCurve(
  values: readonly (number | null)[],
  secondsPerFrame: number,
  loudness: DeliveryProfile["loudness"],
  points = CURVE_POINTS,
): LoudnessCurve | null {
  if (values.length === 0) return null;
  const n = Math.min(points, values.length);
  const out: (number | null)[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor((values.length * i) / n);
    const b = Math.floor((values.length * (i + 1)) / n);
    let high: number | null = null;
    for (let j = a; j < b; j++) {
      const v = values[j];
      if (v !== null && v !== undefined && (high === null || v > high)) high = v;
    }
    out.push(high === null ? null : Math.round(high * 10) / 10);
  }
  const heard = out.filter((v): v is number => v !== null);
  const quietest = heard.length > 0 ? Math.min(...heard) : -40;
  const min = Math.max(-70, Math.min(-40, Math.floor(quietest / 5) * 5));
  const step = min < -40 ? 10 : 5;
  const ticks: number[] = [];
  for (let t = 0; t >= min; t -= step) ticks.unshift(t);
  return {
    duration: values.length * secondsPerFrame,
    points: out,
    min,
    max: 0,
    ticks,
    target: loudness?.target ?? null,
    tolerance: loudness?.tolerance ?? null,
  };
}

/** Where a finding is: a moment, a stretch, or the whole file. */
export function findingAt(f: Pick<QaFinding, "start" | "end">): string {
  if (f.start === null) return "Whole file";
  return f.end !== null && f.end - f.start >= 0.01
    ? `${formatClock(f.start)}–${formatClock(f.end)}`
    : formatClock(f.start);
}

const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

/** What to do about a finding, in a sentence or two, as an engineer would say it. */
export function findingAdvice(f: QaFinding, profile: DeliveryProfile): string {
  switch (f.check) {
    case "format":
      return `Export again from the session as ${profile.label} asks, rather than converting this file: a file brought up to a higher rate or bit depth is not a higher-resolution master.`;
    case "picture-format":
      return `Export the picture again with the settings ${profile.label} asks for, from the edit rather than from this file.`;
    case "layout":
      return "Set the channel layout on export (or in the file's header), and check the channel order against it.";
    case "atmos":
      return "Export ADM BWF from the Dolby Atmos Renderer, so the bed, the objects and Dolby's metadata travel with the file.";
    case "integrity":
      return "The file does not decode cleanly to its end: export it again and upload the new file.";
    case "loudness": {
      const integrated = num(f.details.integrated);
      const target = num(f.details.target) ?? profile.loudness?.target ?? null;
      if (integrated === null || target === null)
        return "Measure the integrated loudness again against the profile's target.";
      const off = integrated - target;
      return off > 0
        ? `Bring the master down by ${decibels(off)} LU, to ${decibels(target, 0)} LUFS, with gain before the limiter rather than more limiting.`
        : `Raise the master by ${decibels(-off)} LU, to ${decibels(target, 0)} LUFS, keeping the true peak under ${decibels(profile.truePeakMax)} dBTP.`;
    }
    case "true-peak":
      return `Set the limiter's ceiling to ${decibels(num(f.details.ceiling) ?? profile.truePeakMax)} dBTP or below, with true-peak (oversampled) detection on, and export again.`;
    case "clipping":
      return "Go back before the clip: lower the gain into whatever clips (the converter, a plug-in, the bounce), or repair it with a declipper if the source is gone.";
    case "flat-tops":
      return "The peaks were flattened before this file was made: check the limiters and the gain staging in the chain, and export again.";
    case "dropouts":
      return "Listen here. If the gap is not in the music, patch it from another take or the session's backup.";
    case "clicks":
      return "Listen here, and repair it with a declicker or a short crossfade, or patch it from another take.";
    case "dc-offset":
      return "Remove the offset with a high-pass filter at a few hertz, or a DC offset removal, before the master.";
    case "silence":
      return "Check the silence is meant: trim it, or find the audio that is missing.";
    case "dead-channel":
      return "Check the routing to this channel and export again: a channel carrying nothing is usually a patching mistake.";
    case "imbalance":
      return "Check the balance and panning of the front pair, and correct it if it is not meant.";
    case "phase":
      return "Check the polarity and time alignment of the microphones, and listen in mono.";
    case "lfe":
      return "Low-pass the LFE at its crossover (120 Hz) before the export.";
    case "bandwidth":
      return "The top end stops short: check the source was not lossy or upsampled, and deliver from the original.";
    case "black-frames":
      return "Check the black is meant; otherwise relink or replace the missing shots.";
    case "frozen-frames":
      return "Check the hold is meant; otherwise render the passage again.";
    case "dropped-frames":
      return "Export the picture again at a constant frame rate.";
    case "interlacing":
      return "Deinterlace, or export progressive from the source.";
    case "broadcast-levels":
      return "Bring the levels within broadcast range with a legaliser before export.";
    case "letterbox":
      return "Check the framing is meant for this delivery.";
    case "flashing":
      return "Reduce the flashing to three a second or fewer, or have the passage tested for photosensitive risk.";
    case "timecode":
      return "Check the timecode runs on without a break and its sources agree; stripe it again if not.";
    case "custom":
      return "Bring the file in line with the project's rule, or ask whoever set it whether this one is an exception.";
  }
}

/** How many of one check a group sets out in full before the rest follow as a line each. */
export const ILLUSTRATED_PER_CHECK = 4;

/**
 * Findings grouped by severity (failures first, passes left out), each group in time: the
 * findings about the whole file first, then by where they start, then by check and channel.
 * The first few of each check are set out in full; the rest of that check follow briefly.
 */
export function reportGroups(
  findings: readonly QaFinding[],
  profile: DeliveryProfile,
  duration: number | null,
  peaks: PeakLevel | null,
): ReportGroup[] {
  return (["fail", "warn", "info"] as const).flatMap((severity) => {
    const these = findings
      .filter((f) => f.severity === severity)
      .sort(
        (a, b) =>
          (a.start ?? -1) - (b.start ?? -1) ||
          (a.end ?? -1) - (b.end ?? -1) ||
          a.check.localeCompare(b.check) ||
          (a.channel ?? -1) - (b.channel ?? -1),
      );
    if (these.length === 0) return [];
    const seen = new Map<QaCheck, number>();
    return [
      {
        severity,
        label: qaSeverityNames[severity],
        findings: these.map((f): ReportFinding => {
          const nth = (seen.get(f.check) ?? 0) + 1;
          seen.set(f.check, nth);
          const illustrated = nth <= ILLUSTRATED_PER_CHECK;
          const window = illustrated ? cropWindow(f, duration) : null;
          return {
            check: f.check,
            name: findingName(f),
            severity: f.severity,
            at: findingAt(f),
            start: f.start,
            end: f.end,
            channel:
              f.channel === null
                ? null
                : `${channelName(f.channel)[0]?.toUpperCase()}${channelName(f.channel).slice(1)}`,
            heard: f.summary,
            advice: findingAdvice(f, profile),
            crop: window
              ? { ...window, envelope: peaks ? cropEnvelope(peaks, window) : null }
              : null,
            illustrated,
          };
        }),
      },
    ];
  });
}

const kHz = (rate: number) => `${rate / 1000} kHz`;

/** The checks a file of its kind is put through, in the order the QA view lists them. */
function signalChecksFor(info: MediaInfo | null): QaCheck[] {
  const picture = new Set<QaCheck>([
    "black-frames",
    "frozen-frames",
    "dropped-frames",
    "interlacing",
    "broadcast-levels",
    "letterbox",
    "flashing",
    "timecode",
  ]);
  const channels = info?.audio?.channels ?? 0;
  return signalChecks.filter((c) => {
    if (picture.has(c)) return Boolean(info?.video);
    if (c === "lfe") return channels > 2;
    if (c === "phase") return channels >= 2;
    return Boolean(info?.audio) || c === "integrity";
  });
}

/**
 * The rules the file was checked against, and how each came out: the delivery profile's
 * asks, the signal checks run on a file of its kind, and the project's own rules.
 */
export function rulesChecked(
  profile: DeliveryProfile,
  rules: readonly CustomRule[],
  findings: readonly QaFinding[],
  info: MediaInfo | null,
  status: string,
): RuleLine[] {
  const resultOf = (match: (f: QaFinding) => boolean, measured: boolean): QaSeverity | null => {
    let out: QaSeverity | null = null;
    for (const f of findings) if (match(f)) out = worst(out, f.severity);
    // A check run on a measured file and finding nothing passed.
    return out ?? (measured && status === "ready" ? "pass" : null);
  };
  const of = (check: QaCheck, measured = true) => resultOf((f) => f.check === check, measured);
  const lines: RuleLine[] = [];
  const add = (
    source: RuleLine["source"],
    label: string,
    asked: string,
    result: QaSeverity | null,
  ) => lines.push({ source, label, asked, result });
  const audio = info?.audio;
  if (profile.loudness)
    add(
      "profile",
      "Integrated loudness",
      `${decibels(profile.loudness.target, 0)} LUFS ± ${profile.loudness.tolerance} LU`,
      of("loudness", false),
    );
  add(
    "profile",
    "True peak",
    `at most ${decibels(profile.truePeakMax)} dBTP`,
    of("true-peak", false),
  );
  if (audio) {
    const { rates, atLeast } = profile.sampleRates;
    // One format check covers all three asks; each row is judged on its own measure, so a
    // row passes when its ask is met whatever the others do (an unrun check stays unknown).
    const format = of("format", false);
    const meets = formatMeets(profile, audio);
    const formatRow = (met: boolean) => (format === null ? null : met ? "pass" : format);
    add(
      "profile",
      "Sample rate",
      atLeast ? `${kHz(rates[0] ?? 0)} or higher` : rates.map(kHz).join(" or "),
      formatRow(meets.sampleRate),
    );
    if (profile.bitDepthMin)
      add(
        "profile",
        "Bit depth",
        profile.bitDepthExact ? `${profile.bitDepthMin}-bit` : `${profile.bitDepthMin}-bit or more`,
        formatRow(meets.bitDepth),
      );
    if (profile.channels !== null)
      add("profile", "Channels", String(profile.channels), formatRow(meets.channels));
    if (profile.layout) add("profile", "Layout", layoutLabel(profile.layout), of("layout", false));
    if (profile.atmos) add("profile", "ADM BWF", "bed and objects described", of("atmos", false));
  }
  const video = profile.video;
  if (info?.video && video) {
    const asks = [
      video.codec ? videoCodecs[video.codec] : null,
      video.resolution ? `${video.resolution.width} × ${video.resolution.height}` : null,
      video.frameRate ? `${frameRateName(video.frameRate)} fps` : null,
      video.scan,
      video.primaries ? videoPrimaries[video.primaries] : null,
      video.range ? `${video.range} range` : null,
    ].filter(Boolean);
    if (asks.length > 0) add("profile", "Picture", asks.join(", "), of("picture-format", false));
  }
  for (const check of signalChecksFor(info))
    add("signal", qaCheckNames[check], "none in the file", of(check));
  for (const rule of rules.filter((r) => r.on)) {
    const measure = ruleMeasures[rule.measure];
    add(
      "project",
      rule.name,
      `${measure.label} ${ruleOperators[rule.operator]} ${rule.value}${measure.unit ? ` ${measure.unit}` : ""}`,
      resultOf((f) => f.check === "custom" && f.details.rule === rule.id, false),
    );
  }
  return lines;
}

/** The format, as the summary's table gives it: what a delivery is judged on. */
export function formatRows(info: MediaInfo | null): [string, string][] {
  if (!info) return [];
  const rows: [string, string][] = [];
  const { audio, video } = info;
  if (video) {
    const codec = videoCodecs[video.codec as keyof typeof videoCodecs] ?? video.codec;
    rows.push(["Picture", video.profile ? `${codec} ${video.profile}` : codec]);
    rows.push(["Frame size", `${video.width} × ${video.height}`]);
    if (video.fps) rows.push(["Frame rate", `${frameRateName(video.fps)} fps`]);
  }
  if (audio) {
    rows.push(["Codec", audio.codec]);
    rows.push(["Sample rate", kHz(audio.sampleRate)]);
    if (audio.bitDepth) rows.push(["Bit depth", `${audio.bitDepth}-bit`]);
    rows.push([
      "Channels",
      `${audio.channels}${audio.channelLayout ? ` (${audio.channelLayout})` : ""}`,
    ]);
  }
  if (info.duration !== undefined) rows.push(["Duration", formatClock(info.duration)]);
  return rows;
}

/** Everything known of the format and what the file says about itself, for the appendix. */
export function formatDump(info: MediaInfo | null): [string, string][] {
  if (!info) return [];
  const rows: [string, string][] = [];
  if (info.format) rows.push(["Container", info.format]);
  rows.push(...formatRows(info));
  if (info.bitRate) rows.push(["Bit rate", `${Math.round(info.bitRate / 1000)} kb/s`]);
  const { video, audio } = info;
  if (video) {
    if (video.frameRate) rows.push(["Exact frame rate", video.frameRate]);
    if (video.pixelFormat) rows.push(["Pixel format", video.pixelFormat]);
    if (video.scan) rows.push(["Scan", video.scan]);
    if (video.range) rows.push(["Range", video.range]);
    if (video.primaries)
      rows.push([
        "Primaries",
        videoPrimaries[video.primaries as keyof typeof videoPrimaries] ?? video.primaries,
      ]);
    if (video.pixelAspect) rows.push(["Pixel aspect", video.pixelAspect]);
    if (video.timecode) rows.push(["Timecode", video.timecode]);
  }
  if (audio?.duration !== undefined && info.duration !== undefined)
    if (Math.abs(audio.duration - info.duration) > 0.001)
      rows.push(["Sound's duration", formatClock(audio.duration)]);
  if (info.metadata) {
    rows.push(...metadataRows(info.metadata, audio?.sampleRate));
    if (info.metadata.adm) rows.push([admHeading(info.metadata.adm), admLine(info.metadata.adm)]);
  }
  return rows;
}

/** The report from its facts. */
export function qaDocument(facts: QaDocumentFacts): QaDocument {
  const { findings, profile, loudness } = facts;
  const duration = facts.format?.duration ?? null;
  return {
    file: facts.file,
    workspace: facts.workspace,
    project: facts.project,
    preparedBy: facts.preparedBy,
    preparedAt: facts.preparedAt.toISOString(),
    preparedOn: facts.preparedOn,
    measuredOn: facts.measuredOn,
    profile: profile.label,
    status: facts.status,
    verdict: qaVerdict(findings, facts.status, profile.label),
    summary: {
      gauge:
        loudness && (facts.format?.audio || loudness.integrated !== null)
          ? loudnessGauge(loudness.integrated, profile.loudness)
          : null,
      integrated: loudness?.integrated ?? null,
      range: loudness?.range ?? null,
      truePeak: loudness?.truePeak ?? null,
      ceiling: profile.truePeakMax,
      shortTermMax: loudness?.shortTermMax ?? null,
      counts: severityCounts(findings),
      format: formatRows(facts.format),
      metadata: facts.format?.metadata
        ? metadataRows(facts.format.metadata, facts.format.audio?.sampleRate)
        : [],
    },
    groups: reportGroups(findings, profile, duration, facts.peaks),
    passed: findings
      .filter((f) => f.severity === "pass")
      .map((f) => ({ name: findingName(f), summary: f.summary })),
    appendix: {
      curve: facts.shortTerm
        ? loudnessCurve(facts.shortTerm.values, facts.shortTerm.secondsPerFrame, profile.loudness)
        : null,
      format: formatDump(facts.format),
      rules: rulesChecked(profile, facts.rules, findings, facts.format, facts.status),
      link: facts.link,
    },
  };
}

/** What each severity's mark is called where a page needs words for it. */
export const verdictToneNames: Record<QaVerdictTone, string> = {
  pass: "Passes",
  warn: "Worth a look",
  fail: "Fails",
  pending: "Not measured",
};
