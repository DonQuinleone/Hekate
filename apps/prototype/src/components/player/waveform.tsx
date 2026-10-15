import { useEffect, useMemo, useRef, useState } from "react";
import type { QaFinding } from "~/data/types";
import { cn } from "~/lib/cn";
import { formatClock } from "~/lib/format";
import { peaksFor } from "~/lib/seeded";
import type { Playback } from "./playback.ts";

export type MarkerState = "open" | "todo" | "deferred" | "resolved";

export interface Marker {
  id: string;
  at: number;
  end?: number;
  number: number;
  active?: boolean;
  /** Open threads are quiet, ones with work to do carry the signal colour, deferred ones fade. */
  state?: MarkerState;
}

export const waveColours = {
  ink: "var(--hk-ink)",
  signal: "var(--hk-signal)",
  cool: "oklch(0.78 0.09 235)",
  warm: "oklch(0.82 0.09 75)",
} as const;

export type WaveColourName = keyof typeof waveColours;

const channelNames = (channels: number): string[] => {
  if (channels === 1) return ["M"];
  if (channels === 2) return ["L", "R"];
  if (channels === 6) return ["L", "R", "C", "LFE", "Ls", "Rs"];
  if (channels === 8) return ["L", "R", "C", "LFE", "Lss", "Rss", "Lrs", "Rrs"];
  if (channels === 12)
    return ["L", "R", "C", "LFE", "Lss", "Rss", "Lrs", "Rrs", "Ltf", "Rtf", "Ltr", "Rtr"];
  return Array.from({ length: channels }, (_, i) => `${i + 1}`);
};

/** A closed outline of the envelope: the top edge left to right, the bottom edge back. */
function envelope(data: number[], mid: number, amp: number, step: number): string {
  if (data.length === 0) return "";
  const smooth = data;
  const top = smooth.map((v, i) => `${(i * step).toFixed(1)},${(mid - v * amp).toFixed(1)}`);
  const bottom = smooth
    .map((v, i) => `${(i * step).toFixed(1)},${(mid + v * amp).toFixed(1)}`)
    .reverse();
  return `M${top.join("L")}L${bottom.join("L")}Z`;
}

/**
 * The waveform, drawn from peaks the worker would have computed: one combined lane, or a
 * lane per channel, as a continuous envelope. Click seeks; drag selects a loop. Comment
 * markers sit above it, QA markers below, and the playhead crosses everything.
 */
export function Waveform({
  seed,
  duration,
  channels = 2,
  playback,
  split,
  markers,
  findings,
  onMarker,
  muted = new Set<number>(),
  solo = null,
  height = 220,
  overlay,
  className,
  colour = "ink",
  opacity = 0.5,
  amplitude = 0.32,
}: {
  seed: number;
  duration: number;
  channels?: number;
  layout?: string;
  playback: Playback;
  split: boolean;
  markers: Marker[];
  findings?: QaFinding[];
  onMarker?: (id: string) => void;
  muted?: Set<number>;
  solo?: number | null;
  height?: number;
  /** Something drawn behind the peaks, such as the spectrogram. */
  overlay?: React.ReactNode;
  className?: string;
  colour?: WaveColourName;
  opacity?: number;
  /** How much of the lane the loudest peak reaches: a third by default, the viewer's to change. */
  amplitude?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(Math.max(200, Math.floor(e.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const step = 1;
  const columns = Math.ceil(width / step) + 1;
  const lanes = split ? channels : 1;
  const peaks = useMemo(() => {
    const raw = peaksFor(seed, columns, split ? channels : 2);
    if (split) return raw;
    const a = raw[0] ?? [];
    const b = raw[1] ?? a;
    return [a.map((v, i) => Math.max(v, b[i] ?? 0))];
  }, [seed, columns, channels, split]);
  const names = channelNames(channels);
  const x = (t: number) => (t / duration) * width;
  const tAt = (clientX: number) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect) return 0;
    return Math.min(duration, Math.max(0, ((clientX - rect.left) / rect.width) * duration));
  };
  const played = x(playback.time);
  const laneH = height / lanes;
  const paths = useMemo(
    () =>
      Array.from({ length: lanes }, (_, lane) => {
        const mid = lane * laneH + laneH / 2;
        const lfe = names[lane] === "LFE";
        const amp = (laneH / 2 - 6) * amplitude * (lfe ? 0.45 : 1);
        return envelope(peaks[lane] ?? peaks[0] ?? [], mid, amp, step);
      }),
    [lanes, laneH, names, peaks, amplitude],
  );
  const loopOn = playback.loop && playback.looping;
  const region = drag
    ? { start: Math.min(drag.from, drag.to), end: Math.max(drag.from, drag.to) }
    : loopOn
      ? playback.loop
      : null;

  return (
    <div className={cn("relative select-none", className)} style={{ height }}>
      <div
        ref={box}
        className="absolute inset-0 cursor-crosshair overflow-hidden"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const t = tAt(e.clientX);
          setDrag({ from: t, to: t });
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (drag) setDrag({ from: drag.from, to: tAt(e.clientX) });
        }}
        onPointerUp={(e) => {
          if (!drag) return;
          const to = tAt(e.clientX);
          if (Math.abs(to - drag.from) < 0.15) {
            playback.seek(drag.from);
          } else {
            playback.setLoop({ start: Math.min(drag.from, to), end: Math.max(drag.from, to) });
            playback.setLooping(true);
            playback.seek(Math.min(drag.from, to));
          }
          setDrag(null);
        }}
      >
        {overlay}
        {/* a soft light that travels with the playhead */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-0 bottom-0 w-[260px] -translate-x-1/2 opacity-50"
          style={{
            left: played,
            background:
              "radial-gradient(closest-side, color-mix(in oklab, var(--hk-signal) 12%, transparent), transparent)",
          }}
        />
        <svg
          width={width}
          height={height}
          className="absolute inset-0"
          role="img"
          aria-label="Waveform"
        >
          {paths.map((d, lane) => {
            const off = (solo !== null && solo !== lane) || muted.has(lane);
            const lfe = names[lane] === "LFE";
            return (
              <g key={String(lane)} opacity={off ? 0.3 : 1}>
                {lane > 0 && (
                  <line
                    x1={0}
                    x2={width}
                    y1={lane * laneH}
                    y2={lane * laneH}
                    stroke="var(--hk-line)"
                  />
                )}
                <path d={d} fill={waveColours[colour]} opacity={opacity} />
                {split && (
                  <text
                    x={10}
                    y={lane * laneH + 15}
                    fill={lfe ? "var(--hk-signal)" : "var(--hk-ink-3)"}
                    fontFamily="var(--hk-font-sans)"
                    fontSize={11}
                    fontWeight={500}
                  >
                    {names[lane]}
                  </text>
                )}
              </g>
            );
          })}
          {findings
            ?.filter(
              (f) => f.start !== undefined && (f.severity === "fail" || f.severity === "warn"),
            )
            .map((f) => (
              <rect
                key={f.id}
                x={x(f.start ?? 0) - 1}
                y={height - 5}
                width={
                  f.end && f.end - (f.start ?? 0) > 0.2
                    ? Math.max(3, x(f.end) - x(f.start ?? 0))
                    : 3
                }
                height={5}
                rx={1}
                fill={f.severity === "fail" ? "var(--hk-signal)" : "transparent"}
                stroke="var(--hk-signal)"
                strokeWidth={1}
              />
            ))}
          {markers
            .filter((m) => m.end !== undefined && m.end > m.at)
            .map((m) => (
              <g key={`r-${m.id}`}>
                <rect
                  x={x(m.at)}
                  y={0}
                  width={x(m.end ?? m.at) - x(m.at)}
                  height={height}
                  fill="var(--hk-signal)"
                  opacity={m.active ? 0.1 : 0.05}
                />
                <rect
                  x={x(m.at)}
                  y={30}
                  width={x(m.end ?? m.at) - x(m.at)}
                  height={2}
                  rx={1}
                  fill="var(--hk-signal)"
                  opacity={m.active ? 1 : 0.6}
                />
              </g>
            ))}
        </svg>
        {region && (
          <>
            {/* Outside the loop the recording steps back; the loop itself stays as it was. */}
            <div
              className="pointer-events-none absolute top-0 bottom-0 left-0 bg-canvas/55"
              style={{ width: x(region.start) }}
            />
            <div
              className="pointer-events-none absolute top-0 right-0 bottom-0 bg-canvas/55"
              style={{ width: Math.max(0, width - x(region.end)) }}
            />
            <div
              className="pointer-events-none absolute top-0 bottom-0 border-x"
              style={{
                left: x(region.start),
                width: Math.max(1, x(region.end) - x(region.start)),
                borderColor: "var(--hk-signal-line)",
              }}
            />
          </>
        )}
        <div
          className="pointer-events-none absolute top-0 bottom-0 w-px bg-signal shadow-[0_0_8px_var(--hk-signal)]"
          style={{ left: played }}
        >
          <span className="tabular absolute bottom-2 left-2 rounded-chip bg-signal px-1.5 text-[11px] leading-[18px] font-medium text-ground">
            {formatClock(playback.time)}
          </span>
        </div>
      </div>
      {markers.map((m) => (
        <button
          key={m.id}
          type="button"
          aria-label={`Comment ${m.number} at ${formatClock(m.at)}`}
          onClick={() => {
            playback.seek(m.at);
            onMarker?.(m.id);
          }}
          className={cn(
            "tabular absolute top-2 z-10 flex size-[18px] -translate-x-1/2 items-center justify-center rounded-full border text-[10px] font-medium shadow-2 transition-transform duration-150 hover:scale-110",
            m.active
              ? "ring-out border-signal bg-signal text-ground"
              : m.state === "todo"
                ? "border-signal/60 bg-signal/90 text-ground"
                : m.state === "deferred"
                  ? "border-dashed border-ink-3 bg-raised text-ink-3"
                  : m.state === "resolved"
                    ? "border-line-strong bg-raised/60 text-ink-3 opacity-60"
                    : "border-ink-2/40 bg-raised text-ink",
          )}
          style={{ left: x(m.at) }}
        >
          {m.number}
        </button>
      ))}
    </div>
  );
}

/** The time ruler under the waveform. */
export function Ruler({
  duration,
  video = false,
  className,
}: {
  duration: number;
  video?: boolean;
  className?: string;
}) {
  const step = duration > 600 ? 120 : duration > 100 ? 30 : duration > 60 ? 10 : 5;
  const ticks: number[] = [];
  for (let t = 0; t <= duration; t += step) ticks.push(t);
  return (
    <div className={cn("tabular relative h-5 text-[11px] text-ink-3", className)}>
      {ticks.map((t) => (
        <span
          key={t}
          className="absolute top-0.5 -translate-x-1/2 first:translate-x-0 last:-translate-x-full"
          style={{ left: `${(t / duration) * 100}%` }}
        >
          {video
            ? `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}:00`
            : formatClock(t, false)}
        </span>
      ))}
    </div>
  );
}
