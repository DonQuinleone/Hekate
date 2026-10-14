import { useEffect, useState } from "react";
import { Icon } from "~/components/icons";
import { Kbd } from "~/components/label";
import { cn } from "~/lib/cn";
import { formatClock, formatTimecode } from "~/lib/format";
import type { Playback } from "./playback.ts";
import type { ColourMap } from "./spectrogram.tsx";

export interface View {
  split: boolean;
  spectrogram: "off" | "below" | "behind" | "instead";
  colourMap: ColourMap;
  scale: "linear" | "log" | "mel";
  downmix: boolean;
  normalised: boolean;
}

export const defaultView: View = {
  split: false,
  spectrogram: "off",
  colourMap: "cyan-orange",
  scale: "log",
  downmix: false,
  normalised: false,
};

function Seg<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex rounded-control border border-hairline bg-ground p-0.5"
    >
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          onClick={() => onChange(o.id)}
          className={cn(
            "h-6 rounded-[4px] px-2 text-xs",
            value === o.id ? "bg-overlay text-ink shadow-2" : "text-ink-3 hover:text-ink",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** The View menu: how the recording is drawn. Every setting is the viewer's and is remembered. */
export function ViewMenu({
  view,
  onView,
  channels,
  spectrogramAllowed,
  normaliseAllowed,
  open,
  onOpen,
}: {
  view: View;
  onView: (v: View) => void;
  channels: number;
  spectrogramAllowed: boolean;
  normaliseAllowed: boolean;
  open: boolean;
  onOpen: (o: boolean) => void;
}) {
  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onOpen(!open)}
        className={cn(
          "flex h-8 items-center gap-1.5 rounded-control border px-2.5 text-[13px]",
          open
            ? "border-edge bg-raised text-ink shadow-1"
            : "border-transparent text-ink-2 hover:bg-raised hover:text-ink",
        )}
      >
        <Icon name="eye" size={14} />
        View
        <Icon name="chevronDown" size={12} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-1 flex w-80 flex-col gap-3 rounded-panel border border-edge bg-overlay p-3 shadow-3"
        >
          <label className="flex items-center justify-between text-[13px] text-ink-2">
            Split channels
            <input
              type="checkbox"
              role="switch"
              checked={view.split}
              aria-checked={view.split}
              onChange={(e) => onView({ ...view, split: e.target.checked })}
            />
          </label>
          {channels > 2 && (
            <label className="flex items-center justify-between text-[13px] text-ink-2">
              Hear the stereo downmix
              <input
                type="checkbox"
                role="switch"
                checked={view.downmix}
                aria-checked={view.downmix}
                onChange={(e) => onView({ ...view, downmix: e.target.checked })}
              />
            </label>
          )}
          {spectrogramAllowed ? (
            <>
              <div className="flex items-center justify-between gap-3 text-[13px] text-ink-2">
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
                  <div className="flex items-center justify-between gap-3 text-[13px] text-ink-2">
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
                  <div className="flex items-center justify-between gap-3 text-[13px] text-ink-2">
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
                  <button type="button" className="self-start text-xs text-ink-3 hover:text-ink">
                    Window, FFT size, overlap, range and presets…
                  </button>
                </>
              )}
            </>
          ) : (
            <p className="m-0 text-xs text-ink-3">The spectrogram is not among your tools here.</p>
          )}
          {normaliseAllowed && (
            <label className="flex items-center justify-between text-[13px] text-ink-2">
              <span>
                Normalised playback
                <span className="block text-xs text-ink-3">
                  Level-matched to the project's target
                </span>
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={view.normalised}
                aria-checked={view.normalised}
                onChange={(e) => onView({ ...view, normalised: e.target.checked })}
              />
            </label>
          )}
          <p className="m-0 border-t border-hairline-soft pt-2 text-xs text-ink-3">
            Remembered for you, on every recording.
          </p>
        </div>
      )}
    </div>
  );
}

/** Play, seek, the readout, loop, rate, compare, volume. Keys: Space, J K L, arrows, I O, L. */
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
}) {
  const [muted, setMuted] = useState(false);
  const [rateOpen, setRateOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=true]")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case " ":
        case "k":
          e.preventDefault();
          playback.toggle();
          break;
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
  }, [playback, duration, video, fps, loopsAllowed]);
  const fmt = (t: number) => (video ? formatTimecode(t, fps) : formatClock(t));
  return (
    <div className="flex min-h-[56px] flex-wrap items-center gap-1 border-t border-hairline-soft px-3 py-2">
      <button
        type="button"
        aria-label="Back five seconds"
        title="Back (J, ←)"
        onClick={() => playback.seek(playback.time - 5)}
        className="flex size-8 items-center justify-center rounded-control text-ink-2 hover:bg-raised hover:text-ink"
      >
        <Icon name="back5" />
      </button>
      <button
        type="button"
        aria-label={playback.playing ? "Pause" : "Play"}
        title="Play or pause (Space)"
        onClick={playback.toggle}
        className="flex size-10 items-center justify-center rounded-full bg-ink text-ground shadow-2 hover:bg-ink/90"
      >
        <Icon
          name={playback.playing ? "pause" : "play"}
          size={14}
          fill="currentColor"
          strokeWidth={0}
        />
      </button>
      <button
        type="button"
        aria-label="Forward five seconds"
        title="Forward (L, →)"
        onClick={() => playback.seek(playback.time + 5)}
        className="flex size-8 items-center justify-center rounded-control text-ink-2 hover:bg-raised hover:text-ink"
      >
        <Icon name="forward5" />
      </button>
      <div className="tabular ml-2 text-[15px] text-ink">
        {fmt(playback.time)}
        <span className="text-[13px] text-ink-3"> / {fmt(duration)}</span>
      </div>
      {video && (
        <span className="tabular ml-2 text-xs text-ink-3">F {Math.floor(playback.time * fps)}</span>
      )}
      {reference && (
        <>
          <span className="mx-2 h-5 w-px bg-hairline" aria-hidden="true" />
          <span className="label text-ink-2">{reference}</span>
        </>
      )}
      {hearing && (
        <span className="ml-2 hidden rounded-chip border border-hairline px-1.5 text-[11px] leading-[18px] text-ink-3 @3xl/app:inline">
          {hearing}
        </span>
      )}
      <div className="ml-auto flex items-center gap-1">
        {loopsAllowed && (
          <button
            type="button"
            aria-pressed={playback.looping}
            title="Loop (L); I and O set the points"
            onClick={() => playback.setLooping(!playback.looping)}
            className={cn(
              "flex h-8 items-center gap-1.5 rounded-control px-2 text-xs",
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
        <div className="relative">
          <button
            type="button"
            onClick={() => setRateOpen((o) => !o)}
            aria-haspopup="menu"
            aria-expanded={rateOpen}
            className="tabular h-8 rounded-control px-2 text-xs text-ink-2 hover:bg-raised hover:text-ink"
          >
            {playback.rate.toFixed(playback.rate === 1 ? 1 : 2).replace(/0$/, "")}×
          </button>
          {rateOpen && (
            <div
              role="menu"
              className="absolute right-0 z-30 mt-1 flex flex-col rounded-control border border-edge bg-overlay p-1 shadow-3"
            >
              {[0.5, 0.75, 1, 1.25, 1.5].map((r) => (
                <button
                  key={r}
                  type="button"
                  role="menuitemradio"
                  aria-checked={playback.rate === r}
                  onClick={() => {
                    playback.setRate(r);
                    setRateOpen(false);
                  }}
                  className={cn(
                    "tabular rounded-[4px] px-3 py-1 text-left text-xs hover:bg-raised",
                    playback.rate === r ? "text-ink" : "text-ink-2",
                  )}
                >
                  {r}×
                </button>
              ))}
            </div>
          )}
        </div>
        {compareAllowed && (
          <button
            type="button"
            aria-pressed={compareOpen}
            onClick={onCompare}
            className={cn(
              "flex h-8 items-center gap-1.5 rounded-control border px-2.5 text-[13px]",
              compareOpen
                ? "border-edge bg-raised text-ink shadow-1"
                : "border-edge bg-raised text-ink shadow-1 hover:border-edge-strong",
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
          className="flex size-8 items-center justify-center rounded-control text-ink-2 hover:bg-raised hover:text-ink"
        >
          <Icon name={muted ? "mute" : "volume"} />
        </button>
        <button
          type="button"
          className="tabular h-8 rounded-control px-2 text-xs text-ink-2 hover:bg-raised hover:text-ink"
          title="Zoom: Fit, or scroll to zoom in to the sample"
        >
          Fit
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
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-hairline-soft px-3 py-2 text-xs text-ink-2">
      <span className="label text-signal">Loop</span>
      {(["start", "end"] as const).map((w) => (
        <span key={w} className="flex items-center gap-1">
          <span className="text-ink-3">{w === "start" ? "In" : "Out"}</span>
          <button
            type="button"
            aria-label={`${w} earlier`}
            onClick={() => nudge(w, -0.05)}
            className="flex size-6 items-center justify-center rounded-chip border border-hairline hover:bg-raised"
          >
            −
          </button>
          <span className="tabular text-ink">{formatClock(loop[w])}</span>
          <button
            type="button"
            aria-label={`${w} later`}
            onClick={() => nudge(w, 0.05)}
            className="flex size-6 items-center justify-center rounded-chip border border-hairline hover:bg-raised"
          >
            +
          </button>
        </span>
      ))}
      <span className="flex items-center gap-1 text-ink-3">
        step <Kbd>50 ms</Kbd>
      </span>
      <span className="flex items-center gap-2 text-ink-3">
        pre-roll{" "}
        <input
          type="number"
          defaultValue={1}
          min={0}
          max={10}
          step={0.5}
          className="h-6 w-14 rounded-chip border border-hairline bg-ground px-1.5 text-xs text-ink"
        />{" "}
        s
      </span>
      <span className="flex items-center gap-2 text-ink-3">
        post-roll{" "}
        <input
          type="number"
          defaultValue={1}
          min={0}
          max={10}
          step={0.5}
          className="h-6 w-14 rounded-chip border border-hairline bg-ground px-1.5 text-xs text-ink"
        />{" "}
        s
      </span>
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
