import {
  channelNames,
  isDefaultAnalysis,
  type SpectrogramAnalysis,
  type Spectrogram as SpectrogramData,
  scalePosition,
} from "@hekate/shared";
import { useQueries, useQuery } from "@tanstack/react-query";
import { type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "~/lib/cn";
import { spectrogramQuery, spectrogramsQuery, useRetrySpectrogram } from "~/lib/queries";
import {
  colourTable,
  combineSpectrograms,
  renderSpectrogram,
  type SpectrogramView,
} from "~/lib/spectrogram";
import { useShownTheme } from "~/lib/theme";
import { Button } from "./ui/button";

/**
 * Which spectrogram to show: every channel stacked ("each"), every channel as one ("all",
 * under the combined waveform), one channel by index, or the mid or side.
 */
export type SpectrogramChannelChoice = "each" | "all" | string;

const token = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Frequencies worth a label, kept only where they fall inside the range shown. */
const TICKS = [50, 100, 200, 500, 1000, 2000, 5000, 10_000, 20_000, 40_000];
const tickLabel = (hz: number) => (hz >= 1000 ? `${hz / 1000}k` : `${hz}`);

/** Wider than this, browsers refuse to draw a canvas at all. */
const MAX_CANVAS_WIDTH = 16_384;

/** One spectrogram drawn to fill its box at the screen's resolution. */
function Plane({
  spectrogram,
  view,
  label,
  showTicks,
}: {
  spectrogram: SpectrogramData;
  view: SpectrogramView;
  label?: string;
  showTicks: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  // The colours come from the tokens, so a new theme redraws the plane.
  const theme = useShownTheme();

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({
        width: Math.round(entry?.contentRect.width ?? 0),
        height: Math.round(entry?.contentRect.height ?? 0),
      }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the tokens it reads change with the theme.
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context || size.width === 0 || size.height === 0) return;
    const ratio = window.devicePixelRatio || 1;
    // A zoomed plane can be wider than a canvas may be; the stored spectra are coarser anyway.
    const width = Math.min(Math.round(size.width * ratio), MAX_CANVAS_WIDTH);
    const height = Math.round(size.height * ratio);
    element.width = width;
    element.height = height;
    const table = colourTable(view.colourMap, [
      token("--hk-ground"),
      token("--hk-signal"),
      token("--hk-ink"),
    ]);
    const image = context.createImageData(width, height);
    renderSpectrogram(spectrogram, width, height, view, table, image.data);
    context.putImageData(image, 0, 0);
  }, [spectrogram, view, size, theme]);

  const high = Math.min(view.high, spectrogram.sampleRate / 2);
  const low = Math.min(view.low, high - 1);
  // Labels at least 16 px apart and clear of the edges, so short rows stay legible.
  const ticks: { hz: number; at: number }[] = [];
  if (showTicks && size.height > 0) {
    for (const hz of TICKS) {
      if (hz <= low || hz >= high) continue;
      const at = scalePosition(view.scale, hz, low, high);
      const y = (1 - at) * size.height;
      const previous = ticks.at(-1);
      const clear = !previous || (1 - previous.at) * size.height - y >= 16;
      if (y > 8 && y < size.height - 8 && clear) ticks.push({ hz, at });
    }
  }

  return (
    <div className="relative min-h-0 flex-1">
      <canvas ref={canvas} className="absolute inset-0 block h-full w-full" />
      {label && (
        <span className="label pointer-events-none absolute top-1 left-1 rounded-chip bg-surface/85 px-1 text-[10px] normal-case leading-4 text-ink-2">
          {label}
        </span>
      )}
      {/* Above the waveform drawn over the plane (#495), on a little ground, so they stay legible. */}
      {ticks.map((t) => (
        <span
          key={t.hz}
          className="tabular pointer-events-none absolute right-1 z-10 -translate-y-1/2 rounded-[2px] bg-ground/60 px-0.5 text-[9px] text-ink/70"
          style={{ top: `${(1 - t.at) * 100}%` }}
          aria-hidden="true"
        >
          {tickLabel(t.hz)}
        </span>
      ))}
    </div>
  );
}

/**
 * A file's spectrogram, drawn from what the media worker computed: every channel stacked,
 * one channel, or the mid or side of the front pair. It follows and seeks the player's
 * media element and analyses no audio itself.
 */
export function Spectrogram({
  fileId,
  media,
  duration,
  layout,
  channel,
  view,
  height,
  playhead = true,
  labels = true,
  fill = false,
}: {
  fileId: string;
  media: HTMLMediaElement;
  duration: number;
  layout?: string;
  channel: SpectrogramChannelChoice;
  view: SpectrogramView;
  height: number;
  /** Off when a waveform drawn on top already shows the playhead and handles seeking. */
  playhead?: boolean;
  /** Off when a waveform drawn on top already names the channels. */
  labels?: boolean;
  /** Grows with the player around it (#15), from `height` up. */
  fill?: boolean;
}) {
  const { data: index } = useQuery(spectrogramsQuery(fileId, view.analysis));
  const available = index?.status === "ready" ? index.spectrograms : [];
  const own = available
    .filter((s) => /^\d+$/.test(s.channel))
    .sort((a, b) => Number(a.channel) - Number(b.channel));
  const names = channelNames(own.length, layout);
  const shown = useMemo(
    () =>
      channel === "each" || channel === "all"
        ? own.map((s, i) => ({ info: s, label: own.length > 1 ? names[i] : undefined }))
        : available
            .filter((s) => s.channel === channel)
            .map((s) => ({
              info: s,
              label:
                s.channel === "mid"
                  ? "Mid"
                  : s.channel === "side"
                    ? "Side"
                    : names[Number(s.channel)],
            })),
    [available, own, names, channel],
  );
  const results = useQueries({
    queries: shown.map((s) => spectrogramQuery(fileId, s.info.id)),
  });
  const loaded = results.every((r) => r.data) && shown.length > 0;
  // Every plane drawn: one per channel, or all of them combined into one.
  const planes = useMemo(() => {
    if (!loaded) return [];
    const data = results.map((r) => r.data as SpectrogramData);
    if (channel !== "all")
      return data.map((d, i) => ({ data: d, label: shown[i]?.label, key: shown[i]?.info.id ?? i }));
    const combined = combineSpectrograms(data);
    return combined
      ? [{ data: combined, label: own.length > 1 ? "All" : undefined, key: "all" }]
      : [];
  }, [loaded, results, channel, shown, own.length]);
  const marker = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!playhead) return;
    let handle = 0;
    const tick = () => {
      if (marker.current && duration > 0) {
        marker.current.style.left = `${Math.min(1, media.currentTime / duration) * 100}%`;
      }
      handle = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(handle);
  }, [media, duration, playhead]);

  const seek = (event: MouseEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (duration > 0) media.currentTime = ((event.clientX - box.left) / box.width) * duration;
  };

  // A viewer's own settings that could not be drawn (#34): said so, with a way to try again.
  if (index?.status === "failed" && !isDefaultAnalysis(view.analysis))
    return <DrawingFailed fileId={fileId} analysis={view.analysis} height={height} />;
  if (index && index.status !== "pending" && index.status !== "ready") return null;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the position slider is the keyboard route to seeking; this is a pointer shortcut.
    <div
      className={cn(
        "relative flex w-full flex-col overflow-hidden rounded-control",
        playhead && "cursor-pointer",
        fill && "min-h-0 flex-1",
        !loaded && "animate-pulse bg-raised",
      )}
      style={fill ? { minHeight: height } : { height }}
      onClick={playhead ? seek : undefined}
      role="img"
      aria-label={`Spectrogram${channel === "each" || channel === "all" ? "" : `, ${shown[0]?.label ?? channel}`}`}
    >
      {planes.map((plane, i) => (
        <div
          key={plane.key}
          className={cn("flex min-h-0 flex-1", i > 0 && "border-t border-ground")}
        >
          <Plane
            spectrogram={plane.data}
            view={view}
            label={labels ? plane.label : undefined}
            showTicks={i === 0 || planes.length <= 2}
          />
        </div>
      ))}
      {index?.status === "pending" && !isDefaultAnalysis(view.analysis) && (
        <span role="status" className="m-auto px-3 text-center text-[12px] text-ink-3">
          Drawing the spectrogram with these settings
        </span>
      )}
      {playhead && loaded && (
        <span
          ref={marker}
          className="pointer-events-none absolute inset-y-0 w-px bg-signal"
          aria-hidden="true"
        />
      )}
    </div>
  );
}

function DrawingFailed({
  fileId,
  analysis,
  height,
}: {
  fileId: string;
  analysis: SpectrogramAnalysis;
  height: number;
}) {
  const retry = useRetrySpectrogram(fileId, analysis);
  return (
    <div
      className="flex w-full flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-control border border-hairline px-3 text-center text-[12px] text-ink-3"
      style={{ minHeight: Math.min(height, 72) }}
    >
      <span role="status">The spectrogram could not be drawn with these settings.</span>
      <Button size="sm" variant="ghost" disabled={retry.isPending} onClick={() => retry.mutate()}>
        Try again
      </Button>
    </div>
  );
}
