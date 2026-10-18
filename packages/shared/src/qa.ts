import { z } from "zod";
import { fileLayout, type LayoutName, layoutLabel, layoutNames } from "./layouts.ts";
import type { LoudnessSummary } from "./loudness.ts";
import type { MediaInfo } from "./media.ts";
import { admShape } from "./metadata.ts";

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
  /** How the channels are laid out, against the profile's layout (#74). */
  "layout",
  /** Whether an ADM master's description of its bed and objects is there when asked for (#74). */
  "atmos",
  /** Whether the file decodes cleanly to the length it declares (#41). */
  "integrity",
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
  /** Content on the LFE channel above its crossover (#74). */
  "lfe",
  /** How high the content reaches: a wall where lossy encoding cut it, or an upsampled file. */
  "bandwidth",
  /** One of the project's own rules (#144); its name is in the finding's details. */
  "custom",
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
  /** How many channels; null takes any number. */
  channels: number | null;
  /** How they are laid out (#74); for an ADM master, its bed. Null or absent takes any. */
  layout?: LayoutName | null;
  /** Whether it is delivered as ADM BWF, its bed and objects described in the file (#74). */
  atmos?: boolean;
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
    layout: "5.1",
  },
  atmos: {
    label: "Dolby Atmos (ADM BWF)",
    loudness: { target: -18, tolerance: 1 },
    truePeakMax: -1,
    sampleRates: { rates: [48_000], atLeast: false },
    bitDepthMin: 24,
    // As many channels as its bed and objects need.
    channels: null,
    atmos: true,
  },
};

/**
 * A workspace's own delivery profile (#144): what its projects can measure against beside the
 * built-in ones, shared by all of them.
 */
export const customProfileInput = z.object({
  label: z.string().trim().min(1, "Name the profile").max(60),
  loudness: z
    .object({ target: z.number().min(-40).max(0), tolerance: z.number().min(0.1).max(6) })
    .nullable(),
  truePeakMax: z.number().min(-12).max(0),
  sampleRates: z.object({
    rates: z.array(z.number().int().min(8000).max(768_000)).min(1).max(6),
    atLeast: z.boolean(),
  }),
  bitDepthMin: z.union([z.literal(16), z.literal(24), z.literal(32)]).nullable(),
  bitDepthExact: z.boolean().optional(),
  channels: z.number().int().min(1).max(64).nullable(),
  layout: z.enum(layoutNames).nullable().optional(),
  atmos: z.boolean().optional(),
});
export type CustomProfileInput = z.infer<typeof customProfileInput>;

/** A workspace's own profile, as stored. */
export interface CustomProfile extends DeliveryProfile {
  id: string;
}

/**
 * What a project, track, file or workspace measures against: a built-in profile by its id,
 * or one of the workspace's own as `custom:` and its id.
 */
export type ProfileRef = DeliveryProfileId | `custom:${string}`;
export const profileRef = z.union([
  deliveryProfileId,
  z
    .string()
    .regex(/^custom:/)
    .transform((s) => s.slice("custom:".length).toLowerCase())
    .pipe(z.uuid())
    .transform((id) => `custom:${id}` as const),
]);
export const customRef = (id: string): ProfileRef => `custom:${id}`;
/** Choosing a profile for a track or a file; null takes the choice away. */
export const deliveryProfileChoice = z.object({ deliveryProfile: profileRef.nullable() });
/** The custom profile's id a reference names, or null for a built-in one. */
export const customIdOf = (ref: ProfileRef): string | null =>
  ref.startsWith("custom:") ? ref.slice("custom:".length) : null;

/** The profile a reference names, or null when it names none (a custom one since deleted). */
export function profileFor(
  ref: ProfileRef | null | undefined,
  customs: readonly CustomProfile[],
): DeliveryProfile | null {
  if (!ref) return null;
  const custom = customIdOf(ref);
  if (custom === null) return deliveryProfiles[ref as DeliveryProfileId] ?? null;
  return customs.find((c) => c.id === custom) ?? null;
}

/** Where the profile a file is measured against comes from, nearest first. */
export const profileSources = ["file", "track", "project", "workspace", "suggested"] as const;
export type ProfileSource = (typeof profileSources)[number];

/**
 * The profile a file is measured against (#144): its own, else its track's, else its
 * project's, else the workspace's, else the one its channels suggest. A reference to a
 * profile that no longer exists is passed over.
 */
export function effectiveProfile(
  refs: Partial<Record<Exclude<ProfileSource, "suggested">, ProfileRef | null>>,
  channels: number,
  customs: readonly CustomProfile[],
  /** Whether the file is an ADM master (#74); asked of every caller, so none forgets it. */
  adm: boolean,
): { ref: ProfileRef; profile: DeliveryProfile; source: ProfileSource } {
  for (const source of ["file", "track", "project", "workspace"] as const) {
    const ref = refs[source];
    const profile = profileFor(ref, customs);
    if (ref && profile) return { ref, profile, source };
  }
  const id = suggestedProfile(channels, adm);
  return { ref: id, profile: deliveryProfiles[id], source: "suggested" };
}

/**
 * The profile a project without one is checked against, from the file's channels: an ADM
 * master, or anything as wide as a 7.1.4 bed, is most likely meant for Atmos.
 */
export function suggestedProfile(channels: number, adm = false): DeliveryProfileId {
  if (adm || channels >= 12) return "atmos";
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
    if (profile.bitDepthMin && !audio.bitDepth) {
      // A lossy or unreported format cannot show it meets a master's bit depth.
      problems.push(`${audio.codec}, no bit depth`);
    } else if (
      profile.bitDepthMin &&
      audio.bitDepth &&
      (profile.bitDepthExact
        ? audio.bitDepth !== profile.bitDepthMin
        : audio.bitDepth < profile.bitDepthMin)
    ) {
      problems.push(`${audio.bitDepth}-bit`);
    }
    if (profile.channels !== null && audio.channels !== profile.channels) {
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
  out.push(...layoutFindings(profile, info));
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

/**
 * The layout and Atmos checks (#74): how the channels are laid out against the profile's
 * layout, and whether an ADM master's description is there when the profile asks for one.
 */
function layoutFindings(profile: DeliveryProfile, info: MediaInfo | null): QaFinding[] {
  const audio = info?.audio;
  if (!audio) return [];
  const out: QaFinding[] = [];
  const whole = { channel: null, start: null, end: null } as const;
  const adm = info.metadata?.adm;
  // A count the format check already fails is not reported again as a layout.
  if (profile.layout && (profile.channels === null || profile.channels === audio.channels)) {
    const actual = fileLayout(info);
    const asked = layoutLabel(profile.layout);
    const details = {
      layout: actual,
      asked: profile.layout,
      reported: audio.channelLayout ?? null,
    };
    out.push(
      actual === profile.layout
        ? {
            check: "layout",
            severity: "pass",
            summary: `${asked}, as ${profile.label} asks`,
            ...whole,
            details,
          }
        : actual === null
          ? {
              check: "layout",
              severity: "warn",
              summary: `The file does not say how its ${audio.channels} channels are laid out; ${profile.label} asks for ${asked}`,
              ...whole,
              details,
            }
          : {
              check: "layout",
              severity: "fail",
              summary: `Laid out as ${layoutLabel(actual)}; ${profile.label} asks for ${asked}`,
              ...whole,
              details,
            },
    );
  }
  // Files read before ADM was (adm absent) are not judged: nothing is known either way.
  if (adm === undefined) return out;
  const details = {
    bed: adm?.bed ?? null,
    layout: adm?.layout ?? null,
    objects: adm?.objects ?? null,
    dolby: adm?.dolby ?? null,
  };
  if (profile.atmos && adm === null) {
    out.push({
      check: "atmos",
      severity: "fail",
      summary: `No ADM metadata: ${profile.label} is delivered as ADM BWF, its bed and objects described in the file`,
      ...whole,
      details,
    });
  } else if (profile.atmos && adm) {
    out.push({
      check: "atmos",
      severity: adm.dolby ? "pass" : "warn",
      summary: adm.dolby
        ? `ADM BWF: ${admShape(adm)}, with Dolby metadata`
        : `ADM BWF: ${admShape(adm)}, but no Dolby metadata (the dbmd chunk Dolby's renderer writes, with its downmix and headphone settings)`,
      ...whole,
      details,
    });
  } else if (adm) {
    out.push({
      check: "atmos",
      severity: "info",
      summary: `An ADM master (${admShape(adm)}), which ${profile.label} does not ask for`,
      ...whole,
      details,
    });
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

/** What each check is called in the list, in reports, and in the project's QA rules. */
export const qaCheckNames: Record<QaCheck, string> = {
  format: "Format",
  layout: "Layout",
  atmos: "Atmos",
  integrity: "Integrity",
  loudness: "Loudness",
  "true-peak": "True peak",
  clipping: "Clipping",
  "flat-tops": "Flattened peaks",
  dropouts: "Dropouts",
  clicks: "Clicks",
  "dc-offset": "DC offset",
  silence: "Silence",
  "dead-channel": "Dead channel",
  imbalance: "Balance",
  phase: "Phase",
  lfe: "LFE",
  bandwidth: "Bandwidth",
  // The project's own rules: the finding's summary starts with the rule's name.
  custom: "Project rule",
};

/** How each severity is said, in the list and in reports. */
export const qaSeverityNames: Record<QaSeverity, string> = {
  fail: "Fails",
  warn: "Worth a look",
  info: "Note",
  pass: "Passes",
};
