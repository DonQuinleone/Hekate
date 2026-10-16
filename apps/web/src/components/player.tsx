import { formatChannels, formatDuration, type MediaInfo, type ReviewerTool } from "@hekate/shared";
import type Hls from "hls.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "~/lib/cn";
import { type Loop, loopEntry, loopFrom, type Rolls, roll, wrapTarget } from "~/lib/loop";
import { type Playback, type Rendition, usePreferences } from "~/lib/queries";
import { useAnnounce, useShortcuts } from "~/lib/shortcuts";
import { Icon } from "./icons";
import { LoopControls, LoopSurface } from "./loop";
import { Spectrogram, type SpectrogramChannelChoice } from "./spectrogram";
import { SpectrogramSettings, useSpectrogramView } from "./spectrogram-settings";
import { Button } from "./ui/button";
import { Slider } from "./ui/slider";
import { Toggle } from "./ui/toggle";
import { WAVEFORM_HEIGHT, Waveform, type WaveformView } from "./waveform";

const ROLLS_KEY = "hekate.loop.rolls";

/** Pre-roll and post-roll, remembered per browser; storage can be missing or refuse. */
function useRolls(): [Rolls, (rolls: Rolls) => void] {
  const [rolls, setRolls] = useState<Rolls>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(ROLLS_KEY) ?? "null") as Partial<Rolls> | null;
      return { pre: roll(saved?.pre ?? 0), post: roll(saved?.post ?? 0) };
    } catch {
      return { pre: 0, post: 0 };
    }
  });
  const save = (next: Rolls) => {
    setRolls(next);
    try {
      localStorage.setItem(ROLLS_KEY, JSON.stringify(next));
    } catch {
      // Not remembered; the setting still holds for this visit.
    }
  };
  return [rolls, save];
}

/** How the audio is drawn above the transport. */
type Display = "waveform" | "spectrogram" | "both" | "overlay";

/**
 * What the player shows beyond the plain waveform, all off by default: one waveform with
 * the channels combined. Remembered per browser.
 */
interface PlayerView {
  /** Each channel in its own lane, rather than combined. */
  split: boolean;
  spectrogram: boolean;
  /** Where the spectrogram goes: under the waveform, behind it, or instead of it. */
  placement: "below" | "behind" | "instead";
}
const defaultPlayerView: PlayerView = { split: false, spectrogram: false, placement: "below" };
const VIEW_KEY = "hekate.player.view";

/** `splitByDefault`: the member's choice, used until this browser remembers its own. */
function usePlayerView(splitByDefault: boolean): [PlayerView, (next: PlayerView) => void] {
  const [view, setView] = useState<PlayerView>(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem(VIEW_KEY) ?? "null",
      ) as Partial<PlayerView> | null;
      return {
        split: saved ? saved.split === true : splitByDefault,
        spectrogram: saved?.spectrogram === true,
        placement:
          saved?.placement === "behind" || saved?.placement === "instead"
            ? saved.placement
            : "below",
      };
    } catch {
      return defaultPlayerView;
    }
  });
  const save = useCallback((next: PlayerView) => {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(next));
    } catch {
      // Not remembered; the choice still holds for this visit.
    }
  }, []);
  return [view, save];
}

const placementNames: Record<PlayerView["placement"], string> = {
  below: "Below",
  behind: "Behind",
  instead: "Instead",
};

/** What a reviewer chooses between, in plain words. */
export function renditionLabel(rendition: Rendition, info: MediaInfo | null): string {
  const audio = info?.audio;
  const layout = audio ? formatChannels(audio.channels, audio.channelLayout) : "";
  switch (rendition.name) {
    case "aac-256":
      return "AAC · stereo";
    case "flac":
      return audio
        ? `Lossless · ${audio.sampleRate / 1000} kHz${audio.bitDepth ? ` · ${audio.bitDepth}-bit` : ""} · ${layout}`
        : "Lossless";
    case "eac3":
      return audio ? `Dolby Digital Plus · ${layout}` : "Dolby Digital Plus";
    case "ac3":
      return audio ? `Dolby Digital · ${layout}` : "Dolby Digital";
    default:
      return rendition.height ? `${rendition.height}p` : rendition.name;
  }
}

/**
 * The rendition to start with: the original Dolby stream when the browser can decode it,
 * then lossless, then whatever is left. Video starts on automatic selection.
 */
export function preferredRendition(available: Rendition[]): Rendition | undefined {
  const order = ["eac3", "ac3", "flac", "aac-256"];
  return [...available]
    .filter((r) => order.includes(r.name))
    .sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name))[0];
}

interface Choice {
  rendition: Rendition;
  level: number;
}

type Failure = "unsupported" | "codecs" | "expired" | "failed";

const failureCopy: Record<Failure, string> = {
  unsupported: "This browser cannot play protected streams.",
  codecs: "This browser cannot decode any of this file's renditions.",
  expired: "This playback link has expired.",
  failed: "Playback stopped because the stream could not be loaded.",
};

/** About half of the smallest audio buffer a browser gives (Chrome's is about 12 MB). */
const AUDIO_BUFFER_BYTES = 6_000_000;

/**
 * Browsers give audio-only streams a small buffer, which a few segments of high-resolution
 * surround overflow. hls.js reads ahead by bytes and by seconds, so bound both: about 6 MB
 * of the heaviest rendition, between 6 and 30 seconds. Streams too heavy for 30 seconds
 * also let played audio go at once, so nothing behind the playhead takes the space.
 */
export function audioBuffer(renditions: Rendition[]) {
  const peak = Math.max(1, ...renditions.map((r) => r.bandwidth));
  const seconds = Math.min(30, Math.max(6, Math.floor((AUDIO_BUFFER_BYTES * 8) / peak)));
  return {
    maxBufferSize: AUDIO_BUFFER_BYTES,
    maxBufferLength: seconds,
    maxMaxBufferLength: seconds,
    backBufferLength: seconds < 30 ? 0 : 10,
  };
}

/**
 * Plays a protected stream: encrypted HLS, decrypted in the browser through Media Source
 * Extensions. Only this session can fetch the playlists, segments and keys.
 */
export function Player({
  fileId,
  kind,
  playback,
  info,
  onExpired,
  onMedia,
  markers = [],
  loop = null,
  onLoop = () => {},
  cue,
  tools = null,
}: {
  fileId: string;
  kind: "audio" | "video";
  playback: Playback;
  info: MediaInfo | null;
  onExpired: () => void;
  /** The media element, once mounted, so other panels can read and move the playhead. */
  onMedia?: (element: HTMLMediaElement | null) => void;
  /** Positions in seconds to mark on the timeline, such as anchored comments. */
  markers?: number[];
  /** The passage being looped; kept by the page so it holds across files. */
  loop?: Loop | null;
  onLoop?: (loop: Loop | null) => void;
  /** Changes each time the page asks to hear the loop, which switches it back on. */
  cue?: number;
  /** The tools a guest's review allows; null for members, who have them all. */
  tools?: readonly ReviewerTool[] | null;
}) {
  const preferences = usePreferences();
  const canLoop = !tools || tools.includes("loops");
  // The project grants the spectrogram; the member chooses whether to see it offered.
  const canSpectrogram = (!tools || tools.includes("spectrogram")) && preferences.showSpectrogram;
  const media = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  // Kept in a ref so a new callback from the parent does not restart playback.
  const announce = useRef(onMedia);
  announce.current = onMedia;
  const hls = useRef<Hls | null>(null);
  const [choices, setChoices] = useState<Choice[]>([]);
  /** A level index, or -1 for automatic selection. */
  const [level, setLevel] = useState(-1);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(info?.duration ?? 0);
  const [buffered, setBuffered] = useState(0);
  const [muted, setMuted] = useState(false);
  /** A source is attached, so play can start. */
  const [ready, setReady] = useState(false);
  /** Safari on iOS plays the stream itself, so its errors come from the element, not hls.js. */
  const native = useRef(false);
  /** The media element once mounted, for the waveform to follow. */
  const [element, setElement] = useState<HTMLMediaElement | null>(null);
  const [playerView, setPlayerView] = usePlayerView(preferences.splitChannels);
  const channels = info?.audio?.channels ?? 0;
  const view: WaveformView = playerView.split && channels > 1 ? "channels" : "combined";
  const display: Display = !(playerView.spectrogram && canSpectrogram)
    ? "waveform"
    : playerView.placement === "behind"
      ? "overlay"
      : playerView.placement === "instead"
        ? "spectrogram"
        : "both";
  const [spectrum, setSpectrum] = useSpectrogramView();
  const [spectrumChannel, setSpectrumChannel] = useState<SpectrogramChannelChoice>(
    channels > 1 ? (playerView.split ? "each" : "all") : "0",
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** The spectrogram's own settings, a level below the view menu. */
  const [tuning, setTuning] = useState(false);
  /** A loop can be kept but switched off, to hear on past it. */
  const [looping, setLooping] = useState(true);
  const [rolls, setRolls] = useRolls();
  const active = Boolean(loop) && looping;

  useEffect(() => {
    const element = media.current;
    if (!element) return;
    setElement(element);
    announce.current?.(element);
    let cancelled = false;
    setFailure(null);
    setChoices([]);
    setReady(false);
    native.current = false;
    import("hls.js")
      .then(({ default: Hls }) => {
        if (cancelled) return;
        if (!Hls.isSupported()) {
          // Safari on iOS has no Media Source Extensions but plays AES-128 HLS natively.
          if (element.canPlayType("application/vnd.apple.mpegurl")) {
            native.current = true;
            element.src = playback.url;
            setReady(true);
          } else setFailure("unsupported");
          return;
        }
        const instance = new Hls({
          enableWorker: true,
          startFragPrefetch: true,
          ...(kind === "audio" ? audioBuffer(playback.renditions) : {}),
        });
        hls.current = instance;
        instance.on(Hls.Events.MANIFEST_PARSED, () => {
          // The browser drops renditions it cannot decode; offer what is left.
          const found: Choice[] = [];
          instance.levels.forEach((l, index) => {
            const rendition = playback.renditions.find((r) => l.uri.includes(`/r/${r.id}/`));
            if (rendition) found.push({ rendition, level: index });
          });
          setChoices(found);
          setReady(true);
          if (kind === "audio") {
            const preferred = preferredRendition(found.map((c) => c.rendition));
            const choice = found.find((c) => c.rendition === preferred);
            if (choice) {
              instance.currentLevel = choice.level;
              setLevel(choice.level);
            }
          }
        });
        instance.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          if (data.details === Hls.ErrorDetails.MANIFEST_INCOMPATIBLE_CODECS_ERROR)
            setFailure("codecs");
          else if (data.response?.code === 403) setFailure("expired");
          else setFailure("failed");
          instance.destroy();
        });
        instance.loadSource(playback.url);
        instance.attachMedia(element);
      })
      // The player's code could not be fetched (a dropped connection, or a new release).
      .catch(() => {
        if (!cancelled) setFailure("failed");
      });
    return () => {
      cancelled = true;
      announce.current?.(null);
      hls.current?.destroy();
      hls.current = null;
      element.removeAttribute("src");
    };
  }, [kind, playback]);

  const choose = (index: number) => {
    if (!hls.current) return;
    // Keep the position: switch at the next segment rather than starting again.
    hls.current.nextLevel = index;
    setLevel(index);
  };

  const toggle = useCallback(() => {
    const element = media.current;
    if (!element) return;
    if (!element.paused) {
      element.pause();
      return;
    }
    element.play().catch((error: unknown) => {
      // A pause or a new source interrupting play is not a failure.
      if (error instanceof DOMException && error.name === "AbortError") return;
      setFailure("failed");
    });
  }, []);

  const seek = (seconds: number) => {
    const element = media.current;
    if (element) element.currentTime = Math.max(0, Math.min(duration, seconds));
  };

  /** A new loop starts playing from its entry, so it can be heard at once. */
  const setLoop = (next: Loop | null) => {
    onLoop(next);
    if (next) {
      setLooping(true);
      seek(loopEntry(next, rolls));
    }
  };

  // A loop set from outside (a comment's Loop, a new address) is switched on.
  // By value: the page makes a new loop object on every render.
  const loopStart = loop?.start;
  const loopEnd = loop?.end;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the cue is the trigger; asked again for the same passage, it comes back on.
  useEffect(() => {
    if (loopStart !== undefined && loopEnd !== undefined) setLooping(true);
  }, [loopStart, loopEnd, cue]);

  // A loop that does not fit this file (an address, or one carried from a longer version)
  // is cut to it, or dropped if nothing of it is left.
  useEffect(() => {
    if (!loop || !(duration > 0) || loop.end <= duration) return;
    onLoop(loopFrom(loop.start, Math.min(loop.end, duration), duration));
  }, [loop, duration, onLoop]);

  // A page opened with a loop (from its address, or a switch of version) starts at it.
  const placed = useRef(false);
  useEffect(() => {
    const element = media.current;
    if (!ready || !element || placed.current) return;
    placed.current = true;
    if (loop && looping) element.currentTime = loopEntry(loop, rolls);
  }, [ready, loop, looping, rolls]);

  // Go round the loop. Checked every frame while playing: the media's own time updates
  // come only a few times a second, too coarse for a tight passage.
  useEffect(() => {
    const element = media.current;
    if (!element || !playing || !loop || !looping) return;
    let frame = 0;
    const check = () => {
      const target = wrapTarget(element.currentTime, loop, rolls, duration);
      if (target !== null) element.currentTime = target;
      frame = requestAnimationFrame(check);
    };
    frame = requestAnimationFrame(check);
    return () => cancelAnimationFrame(frame);
  }, [playing, loop, looping, rolls, duration]);

  const seekBy = (seconds: number) => {
    const element = media.current;
    if (element)
      element.currentTime = Math.max(0, Math.min(duration, element.currentTime + seconds));
  };

  const say = useAnnounce();
  /** One frame of video, or a hundredth of a second of audio. */
  const step = info?.video?.fps ? 1 / info.video.fps : 0.01;
  const stepBy = (direction: -1 | 1) => {
    const element = media.current;
    if (!element) return;
    element.pause();
    seekBy(direction * step);
  };
  /** Loop in or out at the playhead; the other edge stays, or the loop runs to the end. */
  const edge = (which: "in" | "out") => {
    const element = media.current;
    if (!element || !(duration > 0)) return;
    const at = element.currentTime;
    const next =
      which === "in"
        ? loopFrom(at, loop && loop.end > at ? loop.end : duration, duration)
        : loopFrom(loop && loop.start < at ? loop.start : 0, at, duration);
    if (next) {
      onLoop(next);
      setLooping(true);
      say(`Loop ${which} point set`);
    }
  };
  // The player's keys work anywhere on the page it is on, as in Frame.io; never in a field.
  useShortcuts("player", "Player", [
    {
      keys: ["Space", "k"],
      label: "Play or pause",
      run: () => {
        const element = media.current;
        toggle();
        if (element) say(element.paused ? "Paused" : "Playing");
      },
    },
    {
      keys: ["j", "ArrowLeft"],
      label: `Back ${preferences.skipSeconds} seconds`,
      run: () => seekBy(-preferences.skipSeconds),
    },
    {
      keys: ["l", "ArrowRight"],
      label: `Forward ${preferences.skipSeconds} seconds`,
      run: () => seekBy(preferences.skipSeconds),
    },
    {
      keys: [","],
      label: info?.video?.fps ? "One frame back" : "A hundredth of a second back",
      run: () => stepBy(-1),
    },
    {
      keys: ["."],
      label: info?.video?.fps ? "One frame forward" : "A hundredth of a second forward",
      run: () => stepBy(1),
    },
    ...(canLoop
      ? [
          { keys: ["i"], label: "Loop from the playhead", run: () => edge("in") },
          { keys: ["o"], label: "Loop to the playhead", run: () => edge("out") },
          {
            keys: ["Shift+L"],
            label: "Loop on or off",
            run: () => {
              if (!loop) return;
              setLooping((on) => {
                say(on ? "Loop off" : "Loop on");
                return !on;
              });
            },
          },
        ]
      : []),
  ]);

  const events = {
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onEnded: () => {
      // A loop that runs to the very end goes round when the media stops.
      const element = media.current;
      // Only a loop that itself runs to the end; one earlier was left behind on purpose.
      if (element && loop && looping && loop.end + rolls.post >= duration - 0.05) {
        element.currentTime = loopEntry(loop, rolls);
        element.play().catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          setPlaying(false);
          setFailure("failed");
        });
        return;
      }
      setPlaying(false);
    },
    onTimeUpdate: () => setTime(media.current?.currentTime ?? 0),
    onDurationChange: () => {
      const d = media.current?.duration;
      if (d && Number.isFinite(d)) setDuration(d);
    },
    onProgress: () => {
      const element = media.current;
      if (element && element.buffered.length > 0)
        setBuffered(element.buffered.end(element.buffered.length - 1));
    },
    onVolumeChange: () => setMuted(media.current?.muted ?? false),
    onError: () => {
      // hls.js reports and recovers its own errors; only the native player needs this.
      if (native.current) setFailure("failed");
    },
  };

  const share = (value: number) => (duration > 0 ? Math.min(100, (value / duration) * 100) : 0);

  return (
    <section
      aria-label="Player"
      className="flex flex-col overflow-hidden rounded-panel border border-hairline bg-surface outline-none focus-visible:border-edge"
    >
      {kind === "video" ? (
        <video
          ref={media}
          playsInline
          onClick={toggle}
          className={cn("aspect-video w-full cursor-pointer bg-ground", failure && "hidden")}
          {...events}
        />
      ) : (
        <audio ref={media} {...events} />
      )}
      {failure ? (
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4">
          <p className="m-0 text-sm text-ink-2">{failureCopy[failure]}</p>
          {(failure === "expired" || failure === "failed") && (
            <Button size="sm" onClick={onExpired}>
              Load again
            </Button>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3 px-4 py-4">
          {kind === "audio" && element && (
            <LoopSurface
              duration={duration}
              loop={loop}
              active={active}
              onSeek={seek}
              onLoop={canLoop ? setLoop : undefined}
              label={
                canLoop
                  ? "Waveform: click to move the playhead, drag to loop a passage"
                  : "Waveform: click to move the playhead"
              }
              className="flex flex-col gap-3"
            >
              {element && (display === "waveform" || display === "both") && (
                <Waveform
                  fileId={fileId}
                  media={element}
                  duration={duration}
                  layout={info?.audio?.channelLayout}
                  view={view}
                />
              )}
              {element && (display === "spectrogram" || display === "both") && (
                <Spectrogram
                  fileId={fileId}
                  media={element}
                  duration={duration}
                  layout={info?.audio?.channelLayout}
                  channel={spectrumChannel}
                  view={spectrum}
                  height={WAVEFORM_HEIGHT}
                />
              )}
              {element && display === "overlay" && (
                // The waveform, drawn see-through, sits on the spectrogram and keeps the playhead.
                <div className="relative">
                  <div className="absolute inset-0">
                    <Spectrogram
                      fileId={fileId}
                      media={element}
                      duration={duration}
                      layout={info?.audio?.channelLayout}
                      // Row for row under the waveform: each channel, or all of them combined.
                      channel={view === "combined" ? "all" : "each"}
                      view={spectrum}
                      height={WAVEFORM_HEIGHT}
                      playhead={false}
                      labels={false}
                    />
                  </div>
                  <Waveform
                    fileId={fileId}
                    media={element}
                    duration={duration}
                    layout={info?.audio?.channelLayout}
                    view={view}
                    overlay
                  />
                </div>
              )}
            </LoopSurface>
          )}
          {/* Video has no waveform to drag on: the loop lane stands in for it. */}
          {kind === "video" && canLoop && (
            <LoopSurface
              duration={duration}
              loop={loop}
              active={active}
              onSeek={seek}
              onLoop={setLoop}
              label="Loop lane: drag to loop a passage"
              className="h-7"
            >
              <div
                aria-hidden="true"
                className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-hairline/60"
              />
            </LoopSurface>
          )}
          <div className="relative h-4">
            <div className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-hairline" />
            {loop && duration > 0 && (
              <div
                aria-hidden="true"
                className={cn(
                  "absolute top-1/2 h-1.5 -translate-y-1/2 bg-signal/30",
                  !active && "opacity-40",
                )}
                style={{
                  left: `${share(loop.start)}%`,
                  width: `${share(loop.end) - share(loop.start)}%`,
                }}
              />
            )}
            {markers.map((at) => (
              <div
                key={at}
                aria-hidden="true"
                className="absolute top-0 h-1.5 w-px -translate-x-1/2 bg-signal"
                style={{ left: `${share(at)}%` }}
              />
            ))}
            <div
              className="absolute top-1/2 left-0 h-0.5 -translate-y-1/2 rounded-full bg-edge"
              style={{ width: `${share(buffered)}%` }}
            />
            <div
              className="absolute top-1/2 left-0 h-0.5 -translate-y-1/2 rounded-full bg-signal"
              style={{ width: `${share(time)}%` }}
            />
            <div
              className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink"
              style={{ left: `${share(time)}%` }}
            />
            <Slider
              aria-label="Position"
              min={0}
              max={duration || 0}
              step={0.01}
              value={Math.min(time, duration || 0)}
              onChange={(event) => {
                const element = media.current;
                if (element) element.currentTime = Number(event.target.value);
              }}
              className="absolute inset-0 m-0 w-full cursor-pointer opacity-0"
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              size="icon"
              className="h-8 w-8"
              aria-label={playing ? "Pause" : "Play"}
              disabled={!ready}
              onClick={toggle}
            >
              <Icon name={playing ? "pause" : "play"} size={14} />
            </Button>
            <span className="tabular text-xs text-ink-2">
              {formatDuration(time)}{" "}
              <span className="text-ink-3">/ {formatDuration(duration)}</span>
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label={muted ? "Unmute" : "Mute"}
              onClick={() => {
                if (media.current) media.current.muted = !media.current.muted;
              }}
            >
              <Icon name={muted ? "mute" : "volume"} size={14} />
            </Button>
            {kind === "audio" && (channels > 1 || canSpectrogram) && (
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={settingsOpen}
                aria-controls="player-view"
                onClick={() => setSettingsOpen((open) => !open)}
                className={cn(settingsOpen && "bg-raised text-ink")}
              >
                <Icon name="settings" size={14} />
                View
              </Button>
            )}
            {choices.length === 1 && choices[0] && (
              <span className="tabular ml-auto text-xs text-ink-3">
                {renditionLabel(choices[0].rendition, info)}
              </span>
            )}
            {choices.length > 1 && (
              <fieldset className="m-0 ml-auto flex min-w-0 flex-wrap items-center gap-1 border-0 p-0">
                <legend className="sr-only">Rendition</legend>
                {kind === "video" && (
                  <ChoiceButton selected={level === -1} onSelect={() => choose(-1)}>
                    Auto
                  </ChoiceButton>
                )}
                {choices.map((c) => (
                  <ChoiceButton
                    key={c.rendition.id}
                    selected={level === c.level}
                    onSelect={() => choose(c.level)}
                  >
                    {renditionLabel(c.rendition, info)}
                  </ChoiceButton>
                ))}
              </fieldset>
            )}
          </div>
          {loop && (
            <LoopControls
              loop={loop}
              duration={duration}
              fps={info?.video?.fps}
              active={looping}
              rolls={rolls}
              onLoop={(next) => onLoop(next)}
              onActive={setLooping}
              onRolls={setRolls}
            />
          )}
          {kind === "audio" && settingsOpen && (
            <section
              id="player-view"
              aria-label="View"
              className="flex flex-col gap-3 border-t border-hairline pt-3"
            >
              <div className="flex max-w-80 flex-col gap-2.5">
                {channels > 1 && (
                  <Toggle
                    label="Split channels"
                    checked={playerView.split}
                    onChange={(split) => {
                      setPlayerView({ ...playerView, split });
                      // The spectrogram follows: a lane per channel, or all of them together.
                      setSpectrumChannel(split ? "each" : "all");
                    }}
                  />
                )}
                {canSpectrogram && (
                  <Toggle
                    label="Spectrogram"
                    checked={playerView.spectrogram}
                    onChange={(spectrogram) => setPlayerView({ ...playerView, spectrogram })}
                  />
                )}
                {canSpectrogram && playerView.spectrogram && (
                  <fieldset className="m-0 flex items-center justify-between gap-4 border-0 p-0">
                    <legend className="sr-only">Spectrogram placement</legend>
                    <span aria-hidden="true" className="text-[13px] text-ink-3">
                      Placement
                    </span>
                    <span className="flex gap-1">
                      {(Object.keys(placementNames) as PlayerView["placement"][]).map((p) => (
                        <ChoiceButton
                          key={p}
                          selected={playerView.placement === p}
                          onSelect={() => setPlayerView({ ...playerView, placement: p })}
                        >
                          {placementNames[p]}
                        </ChoiceButton>
                      ))}
                    </span>
                  </fieldset>
                )}
                {canSpectrogram && playerView.spectrogram && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-expanded={tuning}
                    onClick={() => setTuning((t) => !t)}
                    className="self-start px-0 text-ink-3 hover:text-ink"
                  >
                    {tuning ? "Hide spectrogram settings" : "Adjust spectrogram…"}
                  </Button>
                )}
              </div>
            </section>
          )}
          {kind === "audio" && display !== "waveform" && settingsOpen && tuning && (
            <SpectrogramSettings
              view={spectrum}
              onView={setSpectrum}
              channel={spectrumChannel}
              onChannel={setSpectrumChannel}
              channels={channels}
              layout={info?.audio?.channelLayout}
              sampleRate={info?.audio?.sampleRate ?? 48_000}
            />
          )}
        </div>
      )}
    </section>
  );
}

function ChoiceButton({
  selected,
  onSelect,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "tabular h-7 cursor-pointer rounded-chip border px-2.5 text-xs transition-colors",
        selected
          ? "border-edge bg-raised text-ink"
          : "border-transparent bg-transparent text-ink-3 hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}
