import {
  channelNames,
  FIELD_BINS,
  frameAt,
  type LoudnessSeries,
  type LoudnessSummary,
  SILENCE,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { type MouseEvent, useEffect, useRef, useState } from "react";
import { cn } from "~/lib/cn";
import { loudnessQuery, loudnessSeriesQuery } from "~/lib/queries";
import { describeField, fieldOutline, mostlyBeyond, readField } from "~/lib/stereo-field";

/** Meters and the history read from this level up to 0 dB. */
export const METER_FLOOR = -60;
const HISTORY_HEIGHT = 72;

/** Where a level sits on a meter, from 0 (the floor or below) to 1 (0 dB or above). */
export function meterFraction(db: number | null, floor = METER_FLOOR): number {
  if (db === null || !Number.isFinite(db) || db <= floor) return 0;
  return Math.min(1, (db - floor) / -floor);
}

/** A level with one decimal and a true minus sign; silence reads as minus infinity. */
export function formatLevel(db: number | null): string {
  if (db === null || db <= SILENCE) return "−∞";
  const text = Math.abs(db).toFixed(1);
  return db < 0 && text !== "0.0" ? `−${text}` : text;
}

/**
 * The history as points for one series: x across the width for the whole file, y from 0 dB
 * at the top to the floor at the bottom. Silent frames are breaks in the line.
 */
export function historyPoints(
  values: Float32Array,
  width: number,
  height: number,
  floor = METER_FLOOR,
): ({ x: number; y: number } | null)[] {
  const count = values.length;
  // At most one point per pixel: the loudest frame each pixel covers.
  const columns = Math.max(1, Math.min(count, Math.round(width)));
  return Array.from({ length: columns }, (_, column) => {
    const start = Math.floor((column * count) / columns);
    const end = Math.max(start + 1, Math.floor(((column + 1) * count) / columns));
    let top = Number.NEGATIVE_INFINITY;
    for (let f = start; f < end; f++) top = Math.max(top, values[f] as number);
    if (top <= floor) return null;
    return {
      x: columns === 1 ? 0 : (column / (columns - 1)) * width,
      y: (1 - meterFraction(top, floor)) * height,
    };
  });
}

const token = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** The frame under the playhead, updated as the media element plays. */
export function usePlayheadFrame(
  series: LoudnessSeries | undefined,
  media: HTMLMediaElement | null,
) {
  const [frame, setFrame] = useState<number | null>(null);
  useEffect(() => {
    if (!series || !media) return;
    let handle = 0;
    const tick = () => {
      setFrame(frameAt(series, media.currentTime));
      handle = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(handle);
  }, [series, media]);
  return frame;
}

function Reading({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="label">{label}</span>
      <span className="tabular text-[20px] font-medium leading-none tracking-[-0.01em] text-ink">
        {value}
        <span className="ml-1 text-[11px] font-normal text-ink-3">{unit}</span>
      </span>
    </div>
  );
}

/** Momentary and short-term loudness across the whole file, with the playhead; click to seek. */
function History({
  series,
  media,
  frame,
}: {
  series: LoudnessSeries;
  media: HTMLMediaElement | null;
  frame: number | null;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.round(entry?.contentRect.width ?? 0)),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context || width === 0) return;
    const ratio = window.devicePixelRatio || 1;
    element.width = width * ratio;
    element.height = HISTORY_HEIGHT * ratio;
    context.scale(ratio, ratio);
    context.clearRect(0, 0, width, HISTORY_HEIGHT);
    // Gridlines every 10 dB.
    context.strokeStyle = token("--hk-hairline");
    context.lineWidth = 1;
    for (let db = -10; db > METER_FLOOR; db -= 10) {
      const y = Math.round((1 - meterFraction(db)) * HISTORY_HEIGHT) + 0.5;
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(width, y);
      context.stroke();
    }
    const draw = (values: Float32Array, colour: string) => {
      context.strokeStyle = colour;
      context.beginPath();
      let drawing = false;
      for (const point of historyPoints(values, width, HISTORY_HEIGHT)) {
        if (!point) {
          drawing = false;
          continue;
        }
        if (drawing) context.lineTo(point.x, point.y);
        else context.moveTo(point.x, point.y);
        drawing = true;
      }
      context.stroke();
    };
    draw(series.momentary, token("--hk-edge"));
    draw(series.shortTerm, token("--hk-ink-2"));
  }, [series, width]);

  const seek = (event: MouseEvent<HTMLDivElement>) => {
    if (!media) return;
    const box = event.currentTarget.getBoundingClientRect();
    const seconds = (series.count * series.samplesPerFrame) / series.sampleRate;
    media.currentTime = ((event.clientX - box.left) / box.width) * seconds;
  };
  const at = frame === null ? null : (frame / Math.max(1, series.count - 1)) * 100;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between text-[10px] text-ink-3">
        <span className="label">History</span>
        <span className="flex gap-3">
          <span className="flex items-center gap-1">
            <span className="inline-block h-px w-3 bg-ink-2" />
            Short-term
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block h-px w-3 bg-edge" />
            Momentary
          </span>
        </span>
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the waveform and transport are the keyboard route to seeking; this is a pointer shortcut. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: as above. */}
      <div className="relative cursor-pointer" onClick={seek}>
        <canvas
          ref={canvas}
          className="block w-full"
          style={{ height: HISTORY_HEIGHT }}
          aria-label="Loudness over time: short-term and momentary"
          role="img"
        />
        {at !== null && (
          <span
            className="pointer-events-none absolute inset-y-0 w-px bg-signal"
            style={{ left: `${at}%` }}
            aria-hidden="true"
          />
        )}
      </div>
    </div>
  );
}

/** One channel: RMS as the bar, sample peak as the line above it. Over full scale shows. */
function ChannelMeter({ name, peak, rms }: { name: string; peak: number; rms: number }) {
  const over = peak >= -0.1;
  return (
    <li className="flex w-6 flex-col items-center gap-1.5">
      <meter
        className="sr-only"
        min={METER_FLOOR}
        max={0}
        value={Math.max(METER_FLOOR, peak)}
        aria-label={`${name}: peak ${formatLevel(peak)} dBFS, RMS ${formatLevel(rms)} dBFS`}
      />
      <div className="relative h-28 w-2 overflow-hidden rounded-[1px] bg-raised" aria-hidden="true">
        <span
          className="absolute inset-x-0 bottom-0 bg-ink-3"
          style={{ height: `${meterFraction(rms) * 100}%` }}
        />
        <span
          className={cn("absolute inset-x-0 h-px", over ? "bg-signal" : "bg-ink")}
          style={{ bottom: `${meterFraction(peak) * 100}%` }}
        />
      </div>
      <span className="label text-[10px] normal-case" aria-hidden="true">
        {name}
      </span>
    </li>
  );
}

/** Phase correlation of the front pair: -1 (out of phase) to +1 (mono). */
function PhaseMeter({ value }: { value: number }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="label">Phase</span>
      <meter
        className="sr-only"
        min={-1}
        max={1}
        value={value}
        aria-label={`Phase correlation ${value.toFixed(2)}`}
      />
      <div className="relative h-2 w-full rounded-[1px] bg-raised" aria-hidden="true">
        <span className="absolute inset-y-0 left-1/2 w-px bg-edge" />
        <span
          className={cn("absolute inset-y-0 w-0.5", value < 0 ? "bg-signal" : "bg-ink")}
          style={{ left: `calc(${((value + 1) / 2) * 100}% - 1px)` }}
        />
      </div>
      <div className="tabular flex justify-between text-[10px] text-ink-3">
        <span>−1</span>
        <span>0</span>
        <span>+1</span>
      </div>
    </div>
  );
}

/**
 * The front pair's mid (what the two sides share) and side (where they differ), as RMS: a
 * side close to the mid is wide or out of phase, a side far below it narrow.
 */
function MidSideMeter({ mid, side }: { mid: number; side: number }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="label">Mid and side</span>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {(
          [
            ["M", "Mid", mid],
            ["S", "Side", side],
          ] as const
        ).map(([short, name, level]) => (
          <li key={short} className="flex items-center gap-2">
            <meter
              className="sr-only"
              min={METER_FLOOR}
              max={0}
              value={Math.max(METER_FLOOR, level)}
              aria-label={`${name}: RMS ${formatLevel(level)} dBFS`}
            />
            <span className="label w-3 text-[10px]" aria-hidden="true">
              {short}
            </span>
            <span className="relative h-2 flex-1 rounded-[1px] bg-raised" aria-hidden="true">
              <span
                className="absolute inset-y-0 left-0 bg-ink-3"
                style={{ width: `${meterFraction(level) * 100}%` }}
              />
            </span>
            <span className="tabular w-10 text-right text-[11px] text-ink-2" aria-hidden="true">
              {formatLevel(level)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The half disc's radius and the room below and beside it, in the scope's own units. */
const SCOPE = { radius: 44, x: 50, y: 48 };

/**
 * The stereo field of the front pair (#34), as a goniometer draws it: mono straight up, the
 * left and right speakers 45° either side, out of phase flat across; the shape is where the
 * energy is at the playhead.
 */
function StereoField({ shares }: { shares: Float32Array | null }) {
  const reading = shares ? readField(shares) : { lean: null, beyond: 0 };
  const words = describeField(reading);
  const at = (angle: number, r = 1) => ({
    x: SCOPE.x + SCOPE.radius * r * Math.sin((angle * Math.PI) / 180),
    y: SCOPE.y - SCOPE.radius * r * Math.cos((angle * Math.PI) / 180),
  });
  const outline = shares ? fieldOutline(shares) : [];
  const trace =
    outline.length > 0
      ? `M${SCOPE.x},${SCOPE.y} ${outline
          .map(
            (p) =>
              `L${(SCOPE.x + p.x * SCOPE.radius).toFixed(2)},${(SCOPE.y - p.y * SCOPE.radius).toFixed(2)}`,
          )
          .join(" ")} Z`
      : null;
  return (
    <figure className="m-0 flex w-36 flex-col gap-1.5">
      <figcaption className="label">Stereo field</figcaption>
      <svg
        viewBox="0 0 100 52"
        className="w-full overflow-visible"
        role="img"
        aria-label={`Stereo field: ${words}`}
      >
        <path
          d={`M${SCOPE.x - SCOPE.radius},${SCOPE.y} A${SCOPE.radius},${SCOPE.radius} 0 0 1 ${SCOPE.x + SCOPE.radius},${SCOPE.y} Z`}
          className="fill-raised stroke-hairline"
          strokeWidth={0.75}
        />
        {[-45, 0, 45].map((angle) => {
          const end = at(angle);
          return (
            <line
              key={angle}
              x1={SCOPE.x}
              y1={SCOPE.y}
              x2={end.x}
              y2={end.y}
              className="stroke-edge"
              strokeWidth={0.75}
            />
          );
        })}
        {trace && (
          <path
            d={trace}
            className={cn(
              "stroke-ink-2",
              mostlyBeyond(reading) ? "fill-signal/40" : "fill-ink-3/50",
            )}
            strokeWidth={0.75}
            strokeLinejoin="round"
          />
        )}
        {(
          [
            ["L", -45],
            ["R", 45],
          ] as const
        ).map(([name, angle]) => {
          const place = at(angle, 1.12);
          return (
            <text
              key={name}
              x={place.x}
              y={place.y}
              textAnchor="middle"
              dominantBaseline="middle"
              className="fill-ink-3 text-[7px]"
            >
              {name}
            </text>
          );
        })}
      </svg>
      <span className="text-[11px] text-ink-2" aria-hidden="true">
        {words}
      </span>
    </figure>
  );
}

/** The whole file in four numbers. */
function Readings({ summary }: { summary: LoudnessSummary }) {
  return (
    <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
      <Reading
        label="Integrated"
        value={summary.integrated === null ? "−∞" : formatLevel(summary.integrated)}
        unit="LUFS"
      />
      <Reading label="Range" value={summary.range.toFixed(1)} unit="LU" />
      <Reading label="True peak" value={formatLevel(summary.truePeak)} unit="dBTP" />
      <Reading label="Max short-term" value={formatLevel(summary.shortTermMax)} unit="LUFS" />
    </div>
  );
}

/** Each channel over the whole file. */
function ChannelTable({ summary, names }: { summary: LoudnessSummary; names: string[] }) {
  return (
    <table className="tabular w-full border-collapse text-[12px]">
      <thead>
        <tr className="text-left">
          <th className="label border-b border-hairline py-1.5 font-normal">Channel</th>
          <th className="label border-b border-hairline py-1.5 text-right font-normal">
            True peak
          </th>
          <th className="label border-b border-hairline py-1.5 text-right font-normal">
            Sample peak
          </th>
          <th className="label border-b border-hairline py-1.5 text-right font-normal">RMS</th>
        </tr>
      </thead>
      <tbody>
        {summary.channels.map((channel, i) => (
          <tr key={names[i] ?? i} className="text-ink-2">
            <td className="border-b border-hairline py-1.5 text-ink">{names[i]}</td>
            <td className="border-b border-hairline py-1.5 text-right">
              {formatLevel(channel.truePeak)}
            </td>
            <td className="border-b border-hairline py-1.5 text-right">
              {formatLevel(channel.samplePeak)}
            </td>
            <td className="border-b border-hairline py-1.5 text-right">
              {formatLevel(channel.rms)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Loudness to EBU R 128 and levels per channel, measured once by the media worker: the
 * whole-file summary, the history with the playhead, and meters that follow playback. No
 * audio is analysed in the browser.
 */
export function Loudness({
  fileId,
  media,
  layout,
}: {
  fileId: string;
  media: HTMLMediaElement | null;
  layout?: string;
}) {
  const { data } = useQuery(loudnessQuery(fileId));
  const { data: series } = useQuery({
    ...loudnessSeriesQuery(fileId),
    enabled: Boolean(data?.series),
  });
  const frame = usePlayheadFrame(series, media);
  if (!data || data.status === "none" || data.status === "failed") return null;
  if (!data.summary || !data.series) {
    return <p className="m-0 text-[13px] text-ink-3">Measuring loudness.</p>;
  }
  const names = channelNames(data.series.channels, layout);
  const at = frame ?? 0;
  const live = (values: Float32Array) =>
    series && frame !== null ? (values[at] as number) : SILENCE;

  return (
    <section aria-label="Loudness" className="flex flex-col gap-5 border-t border-hairline pt-5">
      <h2 className="m-0 text-[15px] font-medium">Loudness</h2>
      <Readings summary={data.summary} />
      {series && <History series={series} media={media} frame={frame} />}
      {series && (
        <div className="flex flex-wrap items-end gap-x-8 gap-y-5">
          <ul className="m-0 flex list-none gap-1 p-0" aria-label="Channel levels at the playhead">
            {names.map((name, c) => (
              <ChannelMeter
                key={name}
                name={name}
                peak={frame === null ? SILENCE : (series.peak[at * series.channels + c] as number)}
                rms={frame === null ? SILENCE : (series.rms[at * series.channels + c] as number)}
              />
            ))}
          </ul>
          {series.hasField && (
            <StereoField
              shares={
                frame === null
                  ? null
                  : series.field.subarray(at * FIELD_BINS, (at + 1) * FIELD_BINS)
              }
            />
          )}
          <div className="flex min-w-48 flex-1 flex-col gap-4">
            <div className="grid grid-cols-2 gap-6">
              <Reading label="Momentary" value={formatLevel(live(series.momentary))} unit="LUFS" />
              <Reading label="Short-term" value={formatLevel(live(series.shortTerm))} unit="LUFS" />
            </div>
            {series.hasPhase && (
              <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
                <PhaseMeter value={frame === null ? 0 : live(series.phase)} />
                {series.hasMidSide && (
                  <MidSideMeter mid={live(series.mid)} side={live(series.side)} />
                )}
              </div>
            )}
          </div>
        </div>
      )}
      <ChannelTable summary={data.summary} names={names} />
    </section>
  );
}
