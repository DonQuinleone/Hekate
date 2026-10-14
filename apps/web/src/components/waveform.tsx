import { channelNames, combineChannels, levelFor, type PeakLevel } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type WaveSurfer from "wavesurfer.js";
import { cn } from "~/lib/cn";
import { peakLevelQuery, peaksQuery } from "~/lib/queries";

export type WaveformView = "channels" | "combined";

/** Total height of the waveform, shared between channels. */
const HEIGHT = 168;

/** Per channel, the peaks as wavesurfer draws them: min and max alternating, from −1 to 1. */
export function toChannelArrays(level: PeakLevel): Float32Array[] {
  return Array.from({ length: level.channels }, (_, channel) => {
    const out = new Float32Array(level.count * 2);
    for (let peak = 0; peak < level.count; peak++) {
      const at = (peak * level.channels + channel) * 2;
      out[peak * 2] = (level.data[at] as number) / 127;
      out[peak * 2 + 1] = (level.data[at + 1] as number) / 127;
    }
    return out;
  });
}

/** Colours come from the design tokens, read at runtime so the waveform follows them. */
const token = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/**
 * The waveform of a file's audio, drawn from precomputed peaks: every channel on its own
 * row, or all channels as one envelope. It follows and seeks the player's media element
 * and never loads audio of its own.
 */
export function Waveform({
  fileId,
  media,
  duration,
  layout,
  view,
}: {
  fileId: string;
  media: HTMLMediaElement;
  duration: number;
  layout?: string;
  view: WaveformView;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const { data: index } = useQuery(peaksQuery(fileId));

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.round(entry?.contentRect.width ?? 0));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Enough peaks for every device pixel across the width, from the coarsest level that has them.
  const wanted = Math.max(1, width * (window.devicePixelRatio || 1));
  const chosen = index?.status === "ready" ? levelFor(index.levels, wanted) : undefined;
  const { data: level } = useQuery({
    ...peakLevelQuery(fileId, chosen?.id ?? ""),
    enabled: Boolean(chosen),
  });

  const shown = level && view === "combined" ? combineChannels(level) : level;
  const names = level ? channelNames(level.channels, layout) : [];

  useEffect(() => {
    const element = container.current;
    if (!element || !shown) return;
    let instance: WaveSurfer | undefined;
    let cancelled = false;
    void import("wavesurfer.js").then(({ default: WaveSurfer }) => {
      if (cancelled) return;
      const rowHeight = Math.floor(HEIGHT / shown.channels);
      // Played audio reads brighter; the signal colour is kept for the playhead alone.
      const style = {
        waveColor: token("--hk-edge"),
        progressColor: token("--hk-ink-3"),
        height: rowHeight,
      };
      instance = WaveSurfer.create({
        container: element,
        media,
        peaks: toChannelArrays(shown),
        duration,
        ...style,
        cursorColor: token("--hk-signal"),
        cursorWidth: 1,
        normalize: false,
        dragToSeek: true,
        splitChannels: Array.from({ length: shown.channels }, () => style),
      });
    });
    return () => {
      cancelled = true;
      instance?.destroy();
    };
  }, [shown, media, duration]);

  if (index?.status === "failed") return null;
  const rows = shown?.channels ?? 1;
  return (
    <div className="relative">
      <div
        ref={container}
        className={cn("w-full", !shown && "animate-pulse rounded-control bg-raised")}
        style={{ height: HEIGHT }}
        aria-label="Waveform"
        role="img"
      />
      {shown && view === "channels" && names.length > 1 && (
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col" aria-hidden="true">
          {names.map((name, i) => (
            <span
              key={name}
              className={cn("flex items-center", i > 0 && "border-t border-hairline")}
              style={{ height: HEIGHT / rows }}
            >
              <span className="label rounded-chip bg-surface/85 px-1 text-[10px] normal-case leading-4 text-ink-2">
                {name}
              </span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
