import { type ReactNode, useEffect, useState } from "react";
import { Icon } from "~/components/icons";
import { Kbd } from "~/components/label";
import { FollowDaw } from "~/components/recorder";
import { Dropdown, MenuList, usePopover } from "~/components/ui/menu";
import { Switch } from "~/components/ui/toggle";
import { cn } from "~/lib/cn";
import { inField } from "~/lib/dom";
import { formatClock, formatTimecode } from "~/lib/format";
import type { Playback } from "./playback.ts";
import type { ColourMap } from "./spectrogram.tsx";

export type WaveColour = "ink" | "signal" | "cool" | "warm";
export type SpectrumWindow = "hann" | "hamming" | "blackman-harris" | "kaiser";

export interface View {
  split: boolean;
  /** How the waveform is drawn: its colour, and how much it is allowed to glow. */
  wave: { colour: WaveColour; opacity: number; height: number };
  spectrogram: "off" | "below" | "behind" | "instead";
  colourMap: ColourMap;
  scale: "linear" | "log" | "mel";
  /** The spectrogram's own brightness (#495), in dB either way. */
  gain: number;
  /**
   * How the spectrogram is analysed (#34): the window, the FFT's size and how far windows
   * overlap. Anything but the default is drawn on the server when first asked for.
   */
  analysis: {
    window: SpectrumWindow;
    fftSize: "auto" | "1024" | "4096" | "16384";
    overlap: "50" | "75" | "87.5";
  };
  normalised: boolean;
  /** The line of loudness and issues under the player. */
  loudness: boolean;
}

export const defaultView: View = {
  split: false,
  // Full brightness and the Mel scale by default (#495).
  wave: { colour: "ink", opacity: 1, height: 0.32 },
  spectrogram: "off",
  colourMap: "cyan-orange",
  scale: "mel",
  gain: 0,
  analysis: { window: "hann", fftSize: "auto", overlap: "75" },
  normalised: false,
  loudness: true,
};

/**
 * A few choices of the same thing, one pressed at a time. An `action` adds one more to the
 * set (another variant beside the dry and the wet): a small button at its end, after a
 * hairline.
 */
export function Seg<T extends string>({
  value,
  options,
  onChange,
  label,
  size = "sm",
  action,
}: {
  value: T;
  options: { id: T; label: string; hint?: string }[];
  onChange: (v: T) => void;
  label: string;
  size?: "sm" | "md";
  /** A way to add to the choices, at the end: its name (read and shown on hover) and icon. */
  action?: { label: string; icon: ReactNode; onSelect: () => void };
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex shrink-0 items-center rounded-control border border-line bg-ground/60 p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            "flex items-center gap-1.5 rounded-[4px] transition-colors",
            size === "sm" ? "h-6 px-2 text-[12px]" : "h-7 px-2.5 text-[13px]",
            value === o.id ? "bg-overlay text-ink shadow-2" : "text-ink-3 hover:text-ink",
          )}
        >
          {o.label}
          {o.hint && <span className="text-ink-3">{o.hint}</span>}
        </button>
      ))}
      {action && (
        <>
          <span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-line" />
          <button
            type="button"
            aria-label={action.label}
            title={action.label}
            onClick={action.onSelect}
            className={cn(
              "flex items-center justify-center rounded-[4px] text-ink-3 transition-colors hover:bg-overlay/60 hover:text-ink",
              size === "sm" ? "size-6" : "size-7",
            )}
          >
            {action.icon}
          </button>
        </>
      )}
    </div>
  );
}

/** The View menu: how the recording is drawn. Every setting is the viewer's and is remembered. */
export function ViewMenu({
  view,
  onView,
  spectrogramAllowed,
  normaliseAllowed,
}: {
  view: View;
  onView: (v: View) => void;
  spectrogramAllowed: boolean;
  normaliseAllowed: boolean;
}) {
  const [open, setOpen, box] = usePopover();
  const [analysing, setAnalysing] = useState(false);
  const row = "flex items-center justify-between gap-4 text-[13px] text-ink";
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(
          "flex h-8 items-center gap-1.5 rounded-control px-2.5 text-[13px] text-ink-2 transition-colors hover:bg-raised hover:text-ink",
          open && "bg-raised text-ink",
        )}
      >
        <Icon name="waveform" size={14} />
        View
      </button>
      {open && (
        <div
          role="menu"
          className="rise-in absolute right-0 z-30 mt-1 flex w-80 flex-col gap-3.5 rounded-panel bg-overlay p-4 shadow-3"
        >
          {/* With the spectrogram in its place there is no waveform to choose about. */}
          {view.spectrogram !== "instead" && (
            <div className="flex flex-col gap-2">
              <div className={row}>
                Waveform
                <span className="flex items-center gap-1.5">
                  {(
                    [
                      ["ink", "var(--hk-ink)"],
                      ["signal", "var(--hk-signal)"],
                      ["cool", "oklch(0.78 0.09 235)"],
                      ["warm", "oklch(0.82 0.09 75)"],
                    ] as const
                  ).map(([id, colour]) => (
                    <button
                      key={id}
                      type="button"
                      aria-label={`${id} waveform`}
                      aria-pressed={view.wave.colour === id}
                      onClick={() => onView({ ...view, wave: { ...view.wave, colour: id } })}
                      className={cn(
                        "size-5 rounded-full border-2 transition-transform hover:scale-110",
                        view.wave.colour === id ? "border-ink" : "border-transparent",
                      )}
                      style={{ background: colour }}
                    />
                  ))}
                </span>
              </div>
              <label className="flex items-center gap-3 text-[12px] text-ink-3">
                Brightness
                <input
                  type="range"
                  // No fainter than 40% (#495): below that it vanishes over a spectrogram.
                  min={40}
                  max={100}
                  value={Math.round(view.wave.opacity * 100)}
                  onChange={(e) =>
                    onView({
                      ...view,
                      wave: { ...view.wave, opacity: Number(e.target.value) / 100 },
                    })
                  }
                  aria-label="Waveform brightness"
                  className="h-1 flex-1 accent-[var(--hk-signal)]"
                />
                <span className="tabular w-8 text-right">
                  {Math.round(view.wave.opacity * 100)}%
                </span>
              </label>
              <label className="flex items-center gap-3 text-[12px] text-ink-3">
                Height
                <input
                  type="range"
                  min={15}
                  max={100}
                  value={Math.round(view.wave.height * 100)}
                  onChange={(e) =>
                    onView({
                      ...view,
                      wave: { ...view.wave, height: Number(e.target.value) / 100 },
                    })
                  }
                  aria-label="Waveform height"
                  className="h-1 flex-1 accent-[var(--hk-signal)]"
                />
                <span className="tabular w-8 text-right">
                  {Math.round(view.wave.height * 100)}%
                </span>
              </label>
            </div>
          )}
          <div className={row}>
            Split channels
            <Switch
              label="Split channels"
              checked={view.split}
              onChange={(v) => onView({ ...view, split: v })}
            />
          </div>
          {spectrogramAllowed ? (
            <>
              <div className={row}>
                Spectrogram
                <Seg
                  value={view.spectrogram}
                  onChange={(v) => onView({ ...view, spectrogram: v })}
                  label="Spectrogram placement"
                  options={[
                    { id: "off", label: "Off" },
                    { id: "below", label: "Below" },
                    { id: "behind", label: "Behind" },
                    { id: "instead", label: "Instead" },
                  ]}
                />
              </div>
              {view.spectrogram !== "off" && (
                <>
                  <div className={row}>
                    Colours
                    <Seg
                      value={view.colourMap}
                      onChange={(v) => onView({ ...view, colourMap: v })}
                      label="Colour map"
                      options={[
                        { id: "cyan-orange", label: "Cyan–orange" },
                        { id: "inferno", label: "Inferno" },
                        { id: "greyscale", label: "Grey" },
                        { id: "signal", label: "Signal" },
                      ]}
                    />
                  </div>
                  <div className={row}>
                    Scale
                    <Seg
                      value={view.scale}
                      onChange={(v) => onView({ ...view, scale: v })}
                      label="Frequency scale"
                      options={[
                        { id: "linear", label: "Linear" },
                        { id: "log", label: "Log" },
                        { id: "mel", label: "Mel" },
                      ]}
                    />
                  </div>
                  <label className="flex items-center gap-3 text-[12px] text-ink-3">
                    Brightness
                    <input
                      type="range"
                      min={-24}
                      max={24}
                      value={view.gain}
                      onChange={(e) => onView({ ...view, gain: Number(e.target.value) })}
                      aria-label="Spectrogram brightness"
                      className="h-1 flex-1 accent-[var(--hk-signal)]"
                    />
                    <span className="tabular w-12 text-right">
                      {view.gain > 0 ? "+" : view.gain < 0 ? "−" : ""}
                      {Math.abs(view.gain)} dB
                    </span>
                  </label>
                  <button
                    type="button"
                    aria-expanded={analysing}
                    onClick={() => setAnalysing(!analysing)}
                    className="self-start text-[13px] text-ink-3 hover:text-ink"
                  >
                    Window, FFT size and overlap…
                  </button>
                  {analysing && (
                    <div className="flex flex-col gap-2.5 border-t border-line pt-2.5">
                      <div className={row}>
                        Window
                        <Seg
                          value={view.analysis.window}
                          onChange={(v) =>
                            onView({ ...view, analysis: { ...view.analysis, window: v } })
                          }
                          label="Window"
                          options={[
                            { id: "hann", label: "Hann" },
                            { id: "hamming", label: "Hamming" },
                            { id: "blackman-harris", label: "B–H" },
                            { id: "kaiser", label: "Kaiser" },
                          ]}
                        />
                      </div>
                      <div className={row}>
                        <span>
                          FFT size
                          <span className="block text-[12px] text-ink-3">
                            Smaller is sharper in time, larger in pitch
                          </span>
                        </span>
                        <Seg
                          value={view.analysis.fftSize}
                          onChange={(v) =>
                            onView({ ...view, analysis: { ...view.analysis, fftSize: v } })
                          }
                          label="FFT size"
                          options={[
                            { id: "auto", label: "Auto" },
                            { id: "1024", label: "1k" },
                            { id: "4096", label: "4k" },
                            { id: "16384", label: "16k" },
                          ]}
                        />
                      </div>
                      <div className={row}>
                        Overlap
                        <Seg
                          value={view.analysis.overlap}
                          onChange={(v) =>
                            onView({ ...view, analysis: { ...view.analysis, overlap: v } })
                          }
                          label="Overlap"
                          options={[
                            { id: "50", label: "50%" },
                            { id: "75", label: "75%" },
                            { id: "87.5", label: "87.5%" },
                          ]}
                        />
                      </div>
                      <p className="text-[12px] text-ink-3">
                        {view.analysis.window === "hann" &&
                        view.analysis.fftSize === "auto" &&
                        view.analysis.overlap === "75"
                          ? "As every file is analysed. Other settings are drawn on the server the first time, and kept with your view and its presets."
                          : "Drawn on the server the first time; the spectrogram says so while it is drawn."}
                      </p>
                    </div>
                  )}
                </>
              )}
            </>
          ) : (
            <p className="text-[13px] text-ink-3">The spectrogram is not among your tools here.</p>
          )}
          <div className={row}>
            Loudness and issues
            <Switch
              label="Loudness and issues"
              checked={view.loudness}
              onChange={(v) => onView({ ...view, loudness: v })}
            />
          </div>
          {normaliseAllowed && (
            <div className={row}>
              <span>
                Normalised playback
                <span className="block text-[12px] text-ink-3">
                  Level-matched to the project target
                </span>
              </span>
              <Switch
                label="Normalised playback"
                checked={view.normalised}
                onChange={(v) => onView({ ...view, normalised: v })}
              />
            </div>
          )}
          <FollowDaw />
          {/* Views kept with the account under a name; removed from Account, Appearance. */}
          <div className={cn(row, "border-t border-hairline pt-3")}>
            Presets
            <span className="flex items-center gap-1.5">
              <select
                aria-label="Apply a preset"
                defaultValue=""
                className="h-7 rounded-control border border-line bg-raised/40 px-2 text-[12px] text-ink-2"
              >
                <option value="" disabled>
                  Apply…
                </option>
                <option>Edit</option>
                <option>Noise hunt</option>
              </select>
              <button
                type="button"
                className="h-7 rounded-control px-2 text-[13px] text-ink-2 hover:bg-raised hover:text-ink"
              >
                Save as…
              </button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

/** The furthest the waveform zooms in: down to the finest peaks the worker keeps. */
const MAX_ZOOM = 16;
const nextZoom = (zoom: number, direction: 1 | -1) =>
  Math.max(1, Math.min(MAX_ZOOM, direction === 1 ? zoom * 2 : zoom / 2));

const iconButton =
  "flex size-9 items-center justify-center rounded-full text-ink-2 transition-colors hover:bg-raised hover:text-ink";

/**
 * Play, seek, the readout, loop, rate, compare, volume. Keys: Space, J K L, arrows, I O, L,
 * Home and End, and Shift+up and down for the previous and next marker.
 */
export function Transport({
  playback,
  duration,
  video = false,
  fps = 25,
  reference,
  loopsAllowed,
  compareAllowed,
  compareOpen,
  onCompare,
  hearing,
  zoom,
  onZoom,
  marks = [],
}: {
  playback: Playback;
  duration: number;
  video?: boolean;
  fps?: number;
  reference?: string;
  loopsAllowed: boolean;
  compareAllowed: boolean;
  compareOpen: boolean;
  onCompare: () => void;
  hearing?: string;
  /** How far the waveform is zoomed in (1 is the whole file), where it can be. */
  zoom?: number;
  onZoom?: (zoom: number) => void;
  /** Where markers are (comments, QA findings), in seconds, for Shift+up and down. */
  marks?: number[];
}) {
  const [muted, setMuted] = useState(false);
  const zoomBy = (direction: 1 | -1) => onZoom?.(nextZoom(zoom ?? 1, direction));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (inField(e)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case " ":
        case "k":
          e.preventDefault();
          playback.toggle();
          break;
        case "ArrowUp":
        case "ArrowDown": {
          if (!e.shiftKey) break;
          e.preventDefault();
          const near = 0.05;
          const sorted = [...marks].sort((a, b) => a - b);
          const to =
            e.key === "ArrowDown"
              ? sorted.find((t) => t > playback.time + near)
              : sorted.findLast((t) => t < playback.time - near);
          if (to !== undefined) playback.seek(to);
          break;
        }
        case "ArrowLeft":
          playback.seek(playback.time - (e.shiftKey ? 1 : video ? 1 / fps : 5));
          break;
        case "ArrowRight":
          playback.seek(playback.time + (e.shiftKey ? 1 : video ? 1 / fps : 5));
          break;
        case "j":
          playback.seek(playback.time - 5);
          break;
        case "l":
          playback.seek(playback.time + 5);
          break;
        case "L":
          if (loopsAllowed) playback.setLooping(!playback.looping);
          break;
        case "i":
          if (loopsAllowed)
            playback.setLoop({
              start: playback.time,
              end: Math.max(playback.time + 0.5, playback.loop?.end ?? playback.time + 4),
            });
          break;
        case "o":
          if (loopsAllowed)
            playback.setLoop({
              start: Math.min(
                playback.loop?.start ?? Math.max(0, playback.time - 4),
                playback.time - 0.5,
              ),
              end: playback.time,
            });
          break;
        case "=":
          onZoom?.(nextZoom(zoom ?? 1, 1));
          break;
        case "-":
          onZoom?.(nextZoom(zoom ?? 1, -1));
          break;
        case "0":
          onZoom?.(1);
          break;
        case "Home":
          playback.seek(0);
          break;
        case "End":
          playback.seek(duration);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playback, duration, video, fps, loopsAllowed, zoom, onZoom, marks]);
  const fmt = (t: number) => (video ? formatTimecode(t, fps) : formatClock(t));
  return (
    <div className="flex min-h-16 flex-wrap items-center gap-1 px-3 py-2 @3xl/app:px-4">
      <button
        type="button"
        aria-label="Back five seconds"
        title="Back (J, ←)"
        onClick={() => playback.seek(playback.time - 5)}
        className={iconButton}
      >
        <Icon name="back5" size={18} />
      </button>
      <button
        type="button"
        aria-label={playback.playing ? "Pause" : "Play"}
        title="Play or pause (Space)"
        onClick={playback.toggle}
        className={cn(
          "flex size-11 items-center justify-center rounded-full bg-ink text-ground shadow-2 transition-[transform,box-shadow] duration-150 hover:scale-105 active:scale-95",
          playback.playing &&
            "shadow-[0_0_0_1px_rgb(0_0_0/0.4),0_0_28px_-4px_var(--hk-signal-line)]",
        )}
      >
        <Icon
          name={playback.playing ? "pause" : "play"}
          size={16}
          fill="currentColor"
          strokeWidth={0}
          className={playback.playing ? "" : "ml-0.5"}
        />
      </button>
      <button
        type="button"
        aria-label="Forward five seconds"
        title="Forward (L, →)"
        onClick={() => playback.seek(playback.time + 5)}
        className={iconButton}
      >
        <Icon name="forward5" size={18} />
      </button>
      <div className="tabular ml-3 text-[16px] text-ink">
        {fmt(playback.time)}
        <span className="text-[13px] text-ink-3"> / {fmt(duration)}</span>
      </div>
      {video && (
        <span className="tabular ml-3 text-[13px] text-ink-3">
          frame {Math.floor(playback.time * fps)}
        </span>
      )}
      {reference && (
        <span className="ml-3 hidden text-[13px] text-ink-2 @3xl/app:inline">{reference}</span>
      )}
      {hearing && (
        <span className="ml-3 hidden text-[12px] text-ink-3 @5xl/app:inline">{hearing}</span>
      )}
      <div className="ml-auto flex items-center gap-0.5">
        {loopsAllowed && (
          <button
            type="button"
            aria-pressed={playback.looping}
            title="Loop (shift L); I and O set the points"
            onClick={() => playback.setLooping(!playback.looping)}
            className={cn(
              "flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] transition-colors",
              playback.looping
                ? "bg-signal/15 text-signal"
                : "text-ink-2 hover:bg-raised hover:text-ink",
            )}
          >
            <Icon name="loop" />
            {playback.loop && playback.looping && (
              <span className="tabular hidden @3xl/app:inline">
                {formatClock(playback.loop.start, false)}–{formatClock(playback.loop.end, false)}
              </span>
            )}
          </button>
        )}
        {onZoom && (
          <span className="flex items-center">
            <button
              type="button"
              aria-label="Zoom out"
              title="Zoom out (−)"
              disabled={(zoom ?? 1) <= 1}
              onClick={() => zoomBy(-1)}
              className={cn(iconButton, "disabled:opacity-40 disabled:hover:bg-transparent")}
            >
              <Icon name="zoomOut" size={16} />
            </button>
            <button
              type="button"
              title="Fit the whole file (0)"
              onClick={() => onZoom(1)}
              className="tabular h-9 min-w-10 rounded-full px-1.5 text-[13px] text-ink-2 hover:bg-raised hover:text-ink"
            >
              {(zoom ?? 1) <= 1 ? "Fit" : `${zoom}×`}
            </button>
            <button
              type="button"
              aria-label="Zoom in"
              title="Zoom in (=)"
              disabled={(zoom ?? 1) >= MAX_ZOOM}
              onClick={() => zoomBy(1)}
              className={cn(iconButton, "disabled:opacity-40 disabled:hover:bg-transparent")}
            >
              <Icon name="zoomIn" size={16} />
            </button>
          </span>
        )}
        <Dropdown
          value={
            <span className="tabular">
              {playback.rate.toFixed(playback.rate === 1 ? 1 : 2).replace(/0$/, "")}×
            </span>
          }
          align="right"
          actions={[0.5, 0.75, 1, 1.25, 1.5].map((r) => ({
            label: `${r}×`,
            checked: playback.rate === r,
            onSelect: () => playback.setRate(r),
          }))}
          className="h-9 rounded-full"
        />
        {compareAllowed && (
          <button
            type="button"
            aria-pressed={compareOpen}
            onClick={onCompare}
            className={cn(
              "flex h-9 items-center gap-1.5 rounded-full px-3 text-[13px] transition-colors",
              compareOpen
                ? "bg-raised text-ink shadow-1"
                : "text-ink-2 hover:bg-raised hover:text-ink",
            )}
          >
            <Icon name="compare" size={14} />
            Compare
          </button>
        )}
        <button
          type="button"
          aria-label={muted ? "Unmute" : "Mute"}
          onClick={() => setMuted((m) => !m)}
          className={iconButton}
        >
          <Icon name={muted ? "mute" : "volume"} />
        </button>
      </div>
    </div>
  );
}

/** The loop's edges, nudged, with pre-roll and post-roll. */
export function LoopBar({ playback }: { playback: Playback }) {
  const loop = playback.loop;
  if (!loop || !playback.looping) return null;
  const nudge = (which: "start" | "end", by: number) =>
    playback.setLoop({ ...loop, [which]: Math.max(0, loop[which] + by) });
  const small =
    "flex size-6 items-center justify-center rounded-chip border border-line text-ink-2 transition-colors hover:bg-raised hover:text-ink";
  return (
    <div className="rise-in flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-4 py-2 text-[13px] text-ink-2">
      <span className="font-medium text-signal">Loop</span>
      {(["start", "end"] as const).map((w) => (
        <span key={w} className="flex items-center gap-1.5">
          <span className="text-ink-3">{w === "start" ? "In" : "Out"}</span>
          <button
            type="button"
            aria-label={`${w} earlier`}
            onClick={() => nudge(w, -0.05)}
            className={small}
          >
            −
          </button>
          <span className="tabular text-ink">{formatClock(loop[w])}</span>
          <button
            type="button"
            aria-label={`${w} later`}
            onClick={() => nudge(w, 0.05)}
            className={small}
          >
            +
          </button>
        </span>
      ))}
      <span className="flex items-center gap-1.5 text-ink-3">
        step <Kbd>50 ms</Kbd>
      </span>
      {(["pre-roll", "post-roll"] as const).map((k) => (
        <span key={k} className="flex items-center gap-1.5 text-ink-3">
          {k}
          <input
            type="number"
            defaultValue={1}
            min={0}
            max={10}
            step={0.5}
            aria-label={k}
            className="tabular h-6 w-14 rounded-chip border border-line bg-ground/60 px-1.5 text-[13px] text-ink"
          />
          s
        </span>
      ))}
      <button
        type="button"
        onClick={() => {
          playback.setLooping(false);
          playback.setLoop(null);
        }}
        className="ml-auto text-ink-3 hover:text-ink"
      >
        Clear
      </button>
    </div>
  );
}

export { MenuList };
