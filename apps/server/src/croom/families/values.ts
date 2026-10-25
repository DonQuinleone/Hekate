import type { ReplayContext } from "../family.ts";

/**
 * Values as ControlRoom might write them, read into Hekate's forms. Tolerant on purpose: a date
 * or time in a form not foreseen is a problem in the report, never a failure.
 */

/** A calendar date, "2026-09-12", from a date, a timestamp or seconds since 1970. */
export function dateOf(value: string | number | null, ctx: ReplayContext): string | null {
  if (value === null) return null;
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const at = instantOf(value);
  if (at) return at.slice(0, 10);
  ctx.report.problem(`${ctx.type}: the date "${text.slice(0, 40)}" was not understood`);
  return null;
}

/** A time of day, "09:30", from "9:30", "09:30:00" or minutes past midnight. */
export function clockOf(value: string | number | null, ctx: ReplayContext): string | null {
  if (value === null) return null;
  if (typeof value === "number" && value >= 0 && value < 24 * 60) {
    const m = Math.round(value);
    return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  }
  const match = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(String(value).trim());
  if (match && Number(match[1]) < 24 && Number(match[2]) < 60)
    return `${match[1]?.padStart(2, "0")}:${match[2]}`;
  const at = instantOf(value);
  if (at && typeof value === "string" && value.includes("T")) return at.slice(11, 16);
  ctx.report.problem(`${ctx.type}: the time "${String(value).slice(0, 40)}" was not understood`);
  return null;
}

/** An instant as ISO 8601, from text or from seconds (or milliseconds) since 1970. */
export function instantOf(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" || /^\d+(\.\d+)?$/.test(String(value))) {
    const n = Number(value);
    const date = new Date(n > 1e11 ? n : n * 1000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** A word as a key: lower case, words joined by hyphens. */
export const keyOf = (word: string) =>
  word
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** A number within bounds, or null. */
export const within = (n: number | null | undefined, min: number, max: number) =>
  n == null || !Number.isFinite(n) ? null : Math.min(max, Math.max(min, n));
