import {
  channelNames,
  combineChannels,
  defaultWaveLook,
  levelFor,
  type PeakLevel,
  type WaveColour,
  type WaveLook,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import type WaveSurfer from "wavesurfer.js";
import { cn } from "~/lib/cn";
import { peakLevelQuery, peaksQuery } from "~/lib/queries";
import { useShownTheme } from "~/lib/theme";

export type WaveformView = "channels" | "combined";

/** Total height of the waveform, shared between channels; the least it takes when it fills. */
export const WAVEFORM_HEIGHT = 168;
const HEIGHT = WAVEFORM_HEIGHT;

/** Wavesurfer is drawn again only when the height moves this far, not at every pixel. */
const heightStep = (height: number) => Math.max(HEIGHT, Math.round(height / 8) * 8);

export const waveTokens: Record<WaveColour, string> = {
  ink: "--hk-ink",
  signal: "--hk-signal",
  cool: "--hk-wave-cool",
  warm: "--hk-wave-warm",
};
export const waveColourNames: Record<WaveColour, string> = {
  ink: "Ink",
  signal: "Signal",
  cool: "Cool",
  warm: "Warm",
};

/**
 * wavesurfer's colours and scale for a look: the played part at the chosen brightness, the
 * rest at a third of it (a little more over a spectrogram, where the ground is busy), and
 * the wave scaled so the default height draws full scale to the lane's edges.
 */
export function waveStyle(look: WaveLook, colour: string, overlay: boolean) {
  return {
    waveColor: translucent(colour, look.opacity * (overlay ? 0.56 : 0.3)),
    progressColor: translucent(colour, look.opacity),
    barHeight: look.height / defaultWaveLook.height,
  };
}

/** A token colour with transparency. */
const translucent = (hex: string, alpha: number) => {
  const value = Number.parseInt(hex.replace("#", "").slice(0, 6), 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
};

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
  overlay = false,
  look = defaultWaveLook,
  fill = false,
}: {
  fileId: string;
  media: HTMLMediaElement;
  duration: number;
  layout?: string;
  view: WaveformView;
  /** Drawn see-through, over a spectrogram. */
  overlay?: boolean;
  look?: WaveLook;
  /**
   * Grows with the player around it (#15), as the prototype's full-height frame draws it,
   * from the usual height up; the player decides how far.
   */
  fill?: boolean;
}) {
  const container = useRef<HTMLDivElement>(null);
  /** Where wavesurfer draws: laid over the box, so what it draws never sizes the box. */
  const mount = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [measured, setMeasured] = useState(HEIGHT);
  const height = fill ? heightStep(measured) : HEIGHT;
  const { data: index } = useQuery(peaksQuery(fileId));
  // The colours come from the tokens, so a new theme draws the waveform again.
  const theme = useShownTheme();

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(Math.round(entry?.contentRect.width ?? 0));
      setMeasured(Math.round(entry?.contentRect.height ?? HEIGHT));
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

  // Kept stable across renders, so playback updates do not rebuild the waveform.
  const shown = useMemo(
    () => (level && view === "combined" ? combineChannels(level) : level),
    [level, view],
  );
  const names = level ? channelNames(level.channels, layout) : [];

  // biome-ignore lint/correctness/useExhaustiveDependencies: the tokens it reads change with the theme.
  useEffect(() => {
    const element = mount.current;
    if (!element || !shown) return;
    let instance: WaveSurfer | undefined;
    let cancelled = false;
    void import("wavesurfer.js").then(({ default: WaveSurfer }) => {
      if (cancelled) return;
      const rowHeight = Math.floor(height / shown.channels);
      // Played audio reads brighter; the playhead is always the signal colour.
      const style = {
        ...waveStyle(look, token(waveTokens[look.colour]), overlay),
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
      // A waveform drawn while paused (a new view, or the overlay) starts at the playhead.
      instance.once("redrawcomplete", () => {
        if (media.currentTime > 0) instance?.setTime(media.currentTime);
      });
    });
    return () => {
      cancelled = true;
      instance?.destroy();
    };
  }, [shown, media, duration, overlay, theme, look.colour, look.opacity, look.height, height]);

  // Nothing to wait for: no peaks are coming for this file.
  if (index && index.status !== "pending" && index.status !== "ready") return null;
  const rows = shown?.channels ?? 1;
  return (
    <div className={cn("relative", fill && "flex min-h-0 flex-1 flex-col")}>
      <div
        ref={container}
        className={cn(
          "relative w-full",
          fill && "min-h-0 flex-1 overflow-hidden",
          !shown && !overlay && "animate-pulse rounded-control bg-raised",
        )}
        style={fill ? { minHeight: HEIGHT } : { height: HEIGHT }}
        aria-label="Waveform"
        role="img"
      >
        <div ref={mount} className="absolute inset-x-0 top-0" />
      </div>
      {shown && view === "channels" && names.length > 1 && (
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col" aria-hidden="true">
          {names.map((name, i) => (
            <span
              key={name}
              className={cn("flex items-center", i > 0 && "border-t border-hairline")}
              style={{ height: height / rows }}
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
