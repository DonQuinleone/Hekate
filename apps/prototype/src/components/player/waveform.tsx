import { useEffect, useMemo, useRef, useState } from "react";
import type { QaFinding } from "~/data/types";
import { cn } from "~/lib/cn";
import { formatClock } from "~/lib/format";
import { peaksFor } from "~/lib/seeded";
import type { Playback } from "./playback.ts";

export interface Marker {
  id: string;
  at: number;
  end?: number;
  number: number;
  active?: boolean;
}

const channelNames = (channels: number): string[] => {
  if (channels === 1) return ["M"];
  if (channels === 2) return ["L", "R"];
  if (channels === 6) return ["L", "R", "C", "LFE", "Ls", "Rs"];
  if (channels === 8) return ["L", "R", "C", "LFE", "Lss", "Rss", "Lrs", "Rrs"];
  if (channels === 12)
    return ["L", "R", "C", "LFE", "Lss", "Rss", "Lrs", "Rrs", "Ltf", "Rtf", "Ltr", "Rtr"];
  return Array.from({ length: channels }, (_, i) => `${i + 1}`);
};

/**
 * The waveform, drawn from peaks the worker would have computed: one combined lane, or a
 * lane per channel. Click seeks; drag selects a loop. Comment markers sit above it, QA
 * markers below, and the playhead crosses everything.
 */
export function Waveform({
  seed,
  duration,
  channels = 2,
  layout,
  playback,
  split,
  markers,
  findings,
  onMarker,
  muted = new Set<number>(),
  solo = null,
  height = 220,
  overlay,
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
  const columns = Math.floor(width / 3);
  const lanes = split ? channels : 1;
  const peaks = useMemo(
    () => peaksFor(seed, columns, split ? channels : 2),
    [seed, columns, channels, split],
  );
  const names = channelNames(channels);
  void layout;
  const x = (t: number) => (t / duration) * width;
  const tAt = (clientX: number) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect) return 0;
    return Math.min(duration, Math.max(0, ((clientX - rect.left) / rect.width) * duration));
  };
  const played = x(playback.time);
  const laneH = height / lanes;

  return (
    <div className="relative select-none" style={{ height }}>
      <div
        ref={box}
        className="absolute inset-0 cursor-crosshair overflow-hidden rounded-control border border-hairline-soft bg-sunken"
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
        <svg
          width={width}
          height={height}
          className="absolute inset-0"
          role="img"
          aria-label="Waveform"
        >
          {Array.from({ length: lanes }, (_, lane) => {
            const mid = lane * laneH + laneH / 2;
            const amp = laneH / 2 - 6;
            const data = peaks[lane] ?? peaks[0] ?? [];
            const off = (solo !== null && solo !== lane) || muted.has(lane);
            const lfe = names[lane] === "LFE";
            return (
              <g key={lane} opacity={off ? 0.3 : 1}>
                {lane > 0 && (
                  <line
                    x1={0}
                    x2={width}
                    y1={lane * laneH}
                    y2={lane * laneH}
                    stroke="var(--hk-hairline-soft)"
                  />
                )}
                {data.map((v, i) => {
                  const px = i * 3;
                  const h = Math.max(
                    1,
                    v * amp * (lfe ? 0.45 : 1) * (split ? 1 : lane === 0 ? 1 : 0),
                  );
                  const combined = !split ? Math.max(1, Math.max(v, peaks[1]?.[i] ?? 0) * amp) : h;
                  const hh = split ? h : combined;
                  const isPlayed = px <= played;
                  return (
                    <rect
                      key={String(i)}
                      x={px}
                      y={mid - hh}
                      width={2}
                      height={hh * 2}
                      fill={isPlayed ? "var(--hk-ink-2)" : "var(--hk-edge-strong)"}
                    />
                  );
                })}
                {split && (
                  <text
                    x={8}
                    y={lane * laneH + 14}
                    fill={lfe ? "var(--hk-signal)" : "var(--hk-ink-3)"}
                    fontFamily="var(--hk-font-mono)"
                    fontSize={10}
                    letterSpacing="0.08em"
                  >
                    {names[lane]}
                  </text>
                )}
              </g>
            );
          })}
          {/* QA markers along the foot */}
          {findings
            ?.filter(
              (f) => f.start !== undefined && (f.severity === "fail" || f.severity === "warn"),
            )
            .map((f) => (
              <g key={f.id}>
                <rect
                  x={x(f.start ?? 0) - 1}
                  y={height - 6}
                  width={
                    f.end && f.end - (f.start ?? 0) > 0.2
                      ? Math.max(3, x(f.end) - x(f.start ?? 0))
                      : 3
                  }
                  height={6}
                  fill={f.severity === "fail" ? "var(--hk-signal)" : "transparent"}
                  stroke="var(--hk-signal)"
                  strokeWidth={1}
                />
              </g>
            ))}
          {/* comment ranges */}
          {markers
            .filter((m) => m.end !== undefined && m.end > m.at)
            .map((m) => (
              <rect
                key={`r-${m.id}`}
                x={x(m.at)}
                y={0}
                width={x(m.end ?? m.at) - x(m.at)}
                height={height}
                fill="var(--hk-signal-wash)"
              />
            ))}
        </svg>
        {(drag || (playback.loop && playback.looping)) && (
          <div
            className="pointer-events-none absolute top-0 bottom-0 border-x bg-signal/15"
            style={{
              left: x(drag ? Math.min(drag.from, drag.to) : (playback.loop?.start ?? 0)),
              width: Math.max(
                1,
                x(
                  drag
                    ? Math.abs(drag.to - drag.from)
                    : (playback.loop?.end ?? 0) - (playback.loop?.start ?? 0),
                ),
              ),
              borderColor: "var(--hk-signal-line)",
            }}
          />
        )}
        <div
          className="pointer-events-none absolute top-0 bottom-0 w-[2px] bg-signal"
          style={{ left: played }}
        >
          <span className="tabular absolute bottom-1.5 left-2 rounded-chip bg-signal px-1.5 text-[10px] leading-[18px] font-medium text-ground">
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
            "tabular absolute top-1.5 z-10 flex size-[17px] -translate-x-1/2 items-center justify-center rounded-full bg-signal text-[10px] font-medium text-ground",
            m.active && "ring-2 ring-signal ring-offset-2 ring-offset-sunken",
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
export function Ruler({ duration, video = false }: { duration: number; video?: boolean }) {
  const step = duration > 600 ? 120 : duration > 100 ? 30 : duration > 60 ? 10 : 5;
  const ticks: number[] = [];
  for (let t = 0; t <= duration; t += step) ticks.push(t);
  return (
    <div className="tabular relative h-5 text-[10px] text-ink-3">
      {ticks.map((t) => (
        <span
          key={t}
          className="absolute top-1 -translate-x-1/2 first:translate-x-0 last:-translate-x-full"
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
