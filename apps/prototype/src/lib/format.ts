import { NOW } from "~/data";
import type { Anchor, Reference } from "~/data/types";

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** A media position as the brand writes it: 0:14.300, or 1:04:31.250 past an hour. */
export function formatClock(seconds: number, ms = true): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const milli = Math.round((s - Math.floor(s)) * 1000);
  const base = h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  return ms ? `${base}.${pad(milli, 3)}` : base;
}

/** SMPTE timecode, 00:01:12:08. */
export function formatTimecode(seconds: number, fps = 25): string {
  const total = Math.max(0, seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = Math.floor(total % 60);
  const f = Math.floor((total - Math.floor(total)) * fps);
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(f)}`;
}

export const frameOf = (seconds: number, fps = 25) => Math.floor(seconds * fps);

/** The typed reference: p. 2 · bar 112.1 · bars 118–124. */
export function formatReference(
  ref: Reference | undefined,
  enabled = { page: true, bar: true, beat: true },
): string {
  if (!ref) return "";
  const parts: string[] = [];
  if (enabled.page && ref.page !== undefined) parts.push(`p. ${ref.page}`);
  if (enabled.bar && ref.bar !== undefined) {
    if (ref.barTo !== undefined && ref.barTo !== ref.bar)
      parts.push(`bars ${ref.bar}–${ref.barTo}`);
    else if (enabled.beat && ref.beat !== undefined && ref.beat !== 1)
      parts.push(`bar ${ref.bar}.${ref.beat}`);
    else parts.push(`bar ${ref.bar}`);
  }
  return parts.join(" · ");
}

export function formatAnchor(anchor: Anchor, opts: { fps?: number; video?: boolean } = {}): string {
  switch (anchor.kind) {
    case "time": {
      const f = (t: number) => (opts.video ? formatTimecode(t, opts.fps) : formatClock(t));
      return anchor.end !== undefined && anchor.end > anchor.start
        ? `${f(anchor.start)}–${f(anchor.end)}`
        : f(anchor.start);
    }
    case "region":
      if (anchor.at !== undefined)
        return `${formatTimecode(anchor.at, opts.fps)} · frame ${frameOf(anchor.at, opts.fps)}`;
      return anchor.page !== undefined ? `p. ${anchor.page}` : "region";
    case "whole":
      return "Whole file";
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${pad(s)}`;
}

const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
const dateYearFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
});
const timeFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

/** 2h, yesterday, 12 Oct: how long ago, as a list reads it. */
export function ago(iso: string, now: Date = NOW): string {
  const then = new Date(iso);
  const diff = (now.getTime() - then.getTime()) / 1000;
  if (diff < 60) return "now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86_400 && then.getDate() === now.getDate()) return `${Math.floor(diff / 3600)}h`;
  if (diff < 2 * 86_400) return "yesterday";
  return dateFmt.format(then);
}

export const formatDate = (iso: string) => dateFmt.format(new Date(iso));
export const formatLongDate = (iso: string) => dateYearFmt.format(new Date(iso));
export const formatTime = (iso: string) => timeFmt.format(new Date(iso));
export const formatDateTime = (iso: string) =>
  `${dateFmt.format(new Date(iso))}, ${timeFmt.format(new Date(iso))}`;

/** Days until a due date, or how long past. */
export function dueIn(iso: string, now: Date = NOW): { days: number; label: string } {
  const days = Math.ceil((new Date(iso).getTime() - now.getTime()) / 86_400_000);
  if (days < 0) return { days, label: `${-days} day${days === -1 ? "" : "s"} overdue` };
  if (days === 0) return { days, label: "due today" };
  return { days, label: `${days} day${days === 1 ? "" : "s"}` };
}

export function formatChannels(layout: string | undefined, channels: number | undefined): string {
  if (!channels) return "";
  if (layout === "stereo" || channels === 2) return "stereo";
  if (channels === 1) return "mono";
  return layout ?? `${channels} channels`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
