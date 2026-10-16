import { z } from "zod";
import type { LoudnessSummary } from "./loudness.ts";
import type { MediaInfo } from "./media.ts";
import type { QaCheck, QaFinding } from "./qa.ts";

/**
 * A project's QA rules (#144): which checks run, how hard each bites, and rules of its own.
 * Like the delivery checks, all of it is read against the stored measurements whenever a
 * report is shown, so changing a rule needs no new analysis.
 */

/** Where a rule sits in the settings. */
export const qaCategories = [
  "audio",
  "immersive",
  "video",
  "artwork",
  "naming",
  "metadata",
] as const;
export type QaCategory = (typeof qaCategories)[number];

/** Measured from the samples when a file is analysed: always on, only their severity moves. */
export const signalChecks = [
  "clipping",
  "flat-tops",
  "dropouts",
  "clicks",
  "dc-offset",
  "silence",
  "phase",
] as const satisfies readonly QaCheck[];

/** Read against the delivery profile: one switch for them all, and each can be turned off. */
export const deliveryChecks = [
  "format",
  "loudness",
  "true-peak",
  "dead-channel",
  "imbalance",
] as const satisfies readonly QaCheck[];

export type BuiltInCheck = (typeof signalChecks)[number] | (typeof deliveryChecks)[number];
export const builtInChecks: readonly BuiltInCheck[] = [...signalChecks, ...deliveryChecks];
export const isDeliveryCheck = (check: QaCheck) =>
  (deliveryChecks as readonly QaCheck[]).includes(check);

/** How hard a failed rule bites: an issue, a warning, or an advisory. */
export const ruleSeverities = ["fail", "warn", "info"] as const;
export type RuleSeverity = (typeof ruleSeverities)[number];

/** What a rule of your own can measure, in the units people read them in. */
export const ruleMeasures = {
  sampleRate: { label: "Sample rate", unit: "kHz", kind: "number" },
  bitDepth: { label: "Bit depth", unit: "bits", kind: "number" },
  channels: { label: "Channels", unit: "", kind: "number" },
  duration: { label: "Duration", unit: "s", kind: "number" },
  integrated: { label: "Integrated loudness", unit: "LUFS", kind: "number" },
  truePeak: { label: "True peak", unit: "dBTP", kind: "number" },
  range: { label: "Loudness range", unit: "LU", kind: "number" },
  codec: { label: "Codec", unit: "", kind: "text" },
  fileName: { label: "File name", unit: "", kind: "text" },
} as const;
export type RuleMeasure = keyof typeof ruleMeasures;
export const ruleMeasureIds = Object.keys(ruleMeasures) as RuleMeasure[];

export const ruleOperators = {
  is: "is",
  isNot: "is not",
  atLeast: "at least",
  atMost: "at most",
  between: "between",
  oneOf: "one of",
  matches: "matches",
} as const;
export type RuleOperator = keyof typeof ruleOperators;
export const ruleOperatorIds = Object.keys(ruleOperators) as RuleOperator[];

/** Which operators each kind of measure takes. */
export const operatorsFor = (measure: RuleMeasure): RuleOperator[] =>
  ruleMeasures[measure].kind === "number"
    ? ["is", "isNot", "atLeast", "atMost", "between", "oneOf"]
    : ["is", "isNot", "oneOf", "matches"];

/** What files a rule of your own looks at. Video and artwork follow with their checks. */
export const ruleScopes = { audio: "Audio", immersive: "Immersive audio", any: "Every recording" };
export type RuleScope = keyof typeof ruleScopes;

/** A number as people type it: a true minus sign, or a comma for a decimal point, read too. */
const numberOf = (text: string) => {
  const n = Number(text.trim().replace(/^−/, "-").replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
/** The words or marks that join the ends of a range: "−16 to −14", "44.1–48". */
const rangeJoins = [" to ", " and ", "–", " - "];

/**
 * "44.1, 48" or "44.1 to 48": the parts of a list or a range. Read by finding the joins, not
 * with a pattern, so a long value costs no more than its length.
 */
const partsOf = (value: string, operator: RuleOperator) => {
  if (operator === "oneOf") return value.split(/[,;]/).map((p) => p.trim());
  if (operator !== "between") return [value];
  const lower = value.toLowerCase();
  for (const join of rangeJoins) {
    const at = lower.indexOf(join);
    if (at > 0) return [value.slice(0, at).trim(), value.slice(at + join.length).trim()];
  }
  return [value.trim()];
};

/**
 * Whether a name fits a wildcard pattern (`*` any run, `?` one character), whole and ignoring
 * case. Matched by walking both once, going back only to the last `*`, never by a regular
 * expression: a pattern such as `*a*a*a*b` cannot make it slow.
 */
export function wildcardMatches(pattern: string, name: string): boolean {
  const p = pattern.toLowerCase();
  const t = name.toLowerCase();
  let i = 0;
  let j = 0;
  let star = -1;
  let resume = 0;
  while (j < t.length) {
    if (i < p.length && (p[i] === "?" || (p[i] !== "*" && p[i] === t[j]))) {
      i += 1;
      j += 1;
    } else if (i < p.length && p[i] === "*") {
      star = i;
      resume = j;
      i += 1;
    } else if (star >= 0) {
      i = star + 1;
      resume += 1;
      j = resume;
    } else return false;
  }
  while (i < p.length && p[i] === "*") i += 1;
  return i === p.length;
}

export const customRule = z
  .object({
    id: z.uuid(),
    name: z.string().trim().min(1, "Name the rule").max(80),
    appliesTo: z.enum(Object.keys(ruleScopes) as [RuleScope, ...RuleScope[]]),
    measure: z.enum(ruleMeasureIds as [RuleMeasure, ...RuleMeasure[]]),
    operator: z.enum(ruleOperatorIds as [RuleOperator, ...RuleOperator[]]),
    /** As typed, in the measure's unit: "96", "−14 to −16", "flac, wav", "*_master.wav". */
    value: z.string().trim().min(1, "Say what it should be").max(100),
    severity: z.enum(ruleSeverities),
    on: z.boolean(),
  })
  .superRefine((rule, ctx) => {
    if (!operatorsFor(rule.measure).includes(rule.operator)) {
      ctx.addIssue({
        code: "custom",
        path: ["operator"],
        message: `${ruleMeasures[rule.measure].label} cannot be compared that way`,
      });
      return;
    }
    if (ruleMeasures[rule.measure].kind !== "number") return;
    const parts = partsOf(rule.value, rule.operator);
    if (
      parts.some((p) => numberOf(p) === null) ||
      (rule.operator === "between" && parts.length !== 2)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message:
          rule.operator === "between" ? "Give two numbers, such as −16 to −14" : "Give a number",
      });
    }
  });
export type CustomRule = z.infer<typeof customRule>;

/** A project's rules: which checks run and how hard, and its own. */
export const qaSettings = z.object({
  /** The delivery checks, all together. */
  delivery: z.boolean(),
  /** Per built-in check: whether it runs (delivery checks only) and its severity when it fails. */
  checks: z.partialRecord(
    z.enum(builtInChecks as [BuiltInCheck, ...BuiltInCheck[]]),
    z.object({ on: z.boolean(), severity: z.enum(ruleSeverities).nullable() }),
  ),
  rules: z.array(customRule).max(100),
});
export type QaSettings = z.infer<typeof qaSettings>;
export const defaultQaSettings: QaSettings = { delivery: true, checks: {}, rules: [] };

/** Stored settings read safely: a project without any, or with some no longer valid, gets the defaults. */
export function qaSettingsOf(stored: unknown): QaSettings {
  const parsed = qaSettings.safeParse(stored);
  return parsed.success ? parsed.data : defaultQaSettings;
}

/**
 * The built-in findings as the project wants them: delivery checks gone when switched off,
 * and a failed check at the severity the project gave it. Signal checks always stay.
 */
export function applyQaSettings(findings: readonly QaFinding[], settings: QaSettings): QaFinding[] {
  return findings.flatMap((f) => {
    if (f.check === "custom") return [f];
    const own = settings.checks[f.check as BuiltInCheck];
    if (isDeliveryCheck(f.check) && (!settings.delivery || own?.on === false)) return [];
    // Anything but a pass takes the project's severity: silence, say, is reported as info.
    if (f.severity !== "pass" && own?.severity) {
      return [{ ...f, severity: own.severity }];
    }
    return [f];
  });
}

/** A measure's value for a file, in the unit people read it in; undefined when unknown. */
function measured(
  measure: RuleMeasure,
  file: { name: string },
  info: MediaInfo | null,
  summary: LoudnessSummary | null,
): number | string | undefined {
  switch (measure) {
    case "sampleRate":
      return info?.audio ? info.audio.sampleRate / 1000 : undefined;
    case "bitDepth":
      return info?.audio?.bitDepth;
    case "channels":
      return info?.audio?.channels;
    case "duration":
      return info?.duration;
    case "integrated":
      return summary?.integrated ?? undefined;
    case "truePeak":
      return summary?.truePeak ?? undefined;
    case "range":
      return summary?.range;
    case "codec":
      return info?.audio?.codec;
    case "fileName":
      return file.name;
  }
}

/** Whether a measured value meets a rule. */
export function meetsRule(rule: Pick<CustomRule, "operator" | "value">, actual: number | string) {
  const parts = partsOf(rule.value, rule.operator);
  if (typeof actual === "number") {
    const [a, b] = parts.map((p) => numberOf(p) ?? Number.NaN) as [number, number];
    const near = (x: number, y: number) => Math.abs(x - y) < 1e-6;
    switch (rule.operator) {
      case "is":
        return near(actual, a);
      case "isNot":
        return !near(actual, a);
      case "atLeast":
        return actual >= a - 1e-6;
      case "atMost":
        return actual <= a + 1e-6;
      case "between":
        return actual >= Math.min(a, b) - 1e-6 && actual <= Math.max(a, b) + 1e-6;
      case "oneOf":
        return parts.some((p) => near(actual, numberOf(p) ?? Number.NaN));
      default:
        return false;
    }
  }
  const same = (x: string) => x.trim().toLowerCase() === actual.toLowerCase();
  switch (rule.operator) {
    case "is":
      return same(rule.value);
    case "isNot":
      return !same(rule.value);
    case "oneOf":
      return parts.some(same);
    case "matches":
      return wildcardMatches(rule.value.trim(), actual);
    default:
      return false;
  }
}

const shown = (measure: RuleMeasure, value: number | string) => {
  if (typeof value === "string") return value;
  const { unit } = ruleMeasures[measure];
  const text = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return `${text.replace("-", "−")}${unit ? ` ${unit}` : ""}`;
};

/**
 * The project's own rules against one recording: a finding for each rule that applies and
 * whose measure is known, passed or at the rule's severity.
 */
export function ruleFindings(
  rules: readonly CustomRule[],
  file: { name: string },
  info: MediaInfo | null,
  summary: LoudnessSummary | null,
): QaFinding[] {
  const channels = info?.audio?.channels ?? 0;
  return rules.flatMap((rule): QaFinding[] => {
    if (!rule.on) return [];
    if (rule.appliesTo !== "any" && !info?.audio) return [];
    if (rule.appliesTo === "immersive" && channels <= 2) return [];
    if (rule.appliesTo === "audio" && channels > 2) return [];
    const actual = measured(rule.measure, file, info, summary);
    if (actual === undefined) return [];
    const ok = meetsRule(rule, actual);
    const asked = `${ruleOperators[rule.operator]} ${rule.value}`;
    return [
      {
        check: "custom",
        severity: ok ? "pass" : rule.severity,
        summary: ok
          ? `${rule.name}: ${shown(rule.measure, actual)}`
          : `${rule.name}: ${shown(rule.measure, actual)}, not ${asked}`,
        channel: null,
        start: null,
        end: null,
        details: { rule: rule.id, name: rule.name, measure: rule.measure, value: rule.value },
      },
    ];
  });
}

/** Where each built-in check sits; every check measured today is an audio one. */
export const categoryOf = (check: BuiltInCheck): QaCategory =>
  check === "dead-channel" ? "immersive" : "audio";

/** Where a rule of your own sits. */
export const ruleCategory = (rule: Pick<CustomRule, "appliesTo" | "measure">): QaCategory =>
  rule.measure === "fileName"
    ? "naming"
    : rule.measure === "codec"
      ? "metadata"
      : rule.appliesTo === "immersive"
        ? "immersive"
        : "audio";
