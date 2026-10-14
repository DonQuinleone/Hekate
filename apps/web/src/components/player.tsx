import { formatChannels, formatDuration, type MediaInfo } from "@hekate/shared";
import type Hls from "hls.js";
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { cn } from "~/lib/cn";
import type { Playback, Rendition } from "~/lib/queries";
import { Icon } from "./icons";
import { Spectrogram, type SpectrogramChannelChoice } from "./spectrogram";
import { SpectrogramSettings, useSpectrogramView } from "./spectrogram-settings";
import { Button } from "./ui/button";
import { WAVEFORM_HEIGHT, Waveform, type WaveformView } from "./waveform";

/** How the audio is drawn above the transport. */
type Display = "waveform" | "spectrogram" | "both" | "overlay";
const displayNames: Record<Display, string> = {
  waveform: "Waveform",
  spectrogram: "Spectrogram",
  both: "Both",
  overlay: "Overlay",
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
}) {
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
  const [view, setView] = useState<WaveformView>("channels");
  const channels = info?.audio?.channels ?? 0;
  const [display, setDisplay] = useState<Display>("waveform");
  const [spectrum, setSpectrum] = useSpectrogramView();
  const [spectrumChannel, setSpectrumChannel] = useState<SpectrogramChannelChoice>(
    channels > 1 ? "each" : "0",
  );
  const [settingsOpen, setSettingsOpen] = useState(false);

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

  const seekBy = (seconds: number) => {
    const element = media.current;
    if (element)
      element.currentTime = Math.max(0, Math.min(duration, element.currentTime + seconds));
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.target instanceof HTMLInputElement && event.key !== " ") return;
    if (event.key === " " || event.key === "k") {
      event.preventDefault();
      toggle();
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      seekBy(-5);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      seekBy(5);
    }
  };

  const events = {
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onEnded: () => setPlaying(false),
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
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the player takes keyboard shortcuts as a whole.
      tabIndex={0}
      onKeyDown={onKeyDown}
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
          {kind === "audio" && element && (display === "waveform" || display === "both") && (
            <Waveform
              fileId={fileId}
              media={element}
              duration={duration}
              layout={info?.audio?.channelLayout}
              view={view}
            />
          )}
          {kind === "audio" && element && (display === "spectrogram" || display === "both") && (
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
          {kind === "audio" && element && display === "overlay" && (
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
          <div className="relative h-4">
            <div className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-hairline" />
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
            <input
              type="range"
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
            <span className="tabular font-mono text-xs text-ink-2">
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
            {kind === "audio" && (
              <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-1 border-0 p-0">
                <legend className="sr-only">Display</legend>
                {(Object.keys(displayNames) as Display[]).map((d) => (
                  <ChoiceButton key={d} selected={display === d} onSelect={() => setDisplay(d)}>
                    {displayNames[d]}
                  </ChoiceButton>
                ))}
                {display !== "waveform" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-expanded={settingsOpen}
                    onClick={() => setSettingsOpen((open) => !open)}
                  >
                    Settings
                  </Button>
                )}
              </fieldset>
            )}
            {kind === "audio" && channels > 1 && display !== "spectrogram" && (
              <fieldset className="m-0 flex min-w-0 items-center gap-1 border-0 p-0">
                <legend className="sr-only">Waveform</legend>
                <ChoiceButton selected={view === "channels"} onSelect={() => setView("channels")}>
                  Channels
                </ChoiceButton>
                <ChoiceButton selected={view === "combined"} onSelect={() => setView("combined")}>
                  Combined
                </ChoiceButton>
              </fieldset>
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
          {kind === "audio" && display !== "waveform" && settingsOpen && (
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
