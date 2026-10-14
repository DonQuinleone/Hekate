import { formatChannels, formatDuration, type MediaInfo } from "@hekate/shared";
import type Hls from "hls.js";
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { cn } from "~/lib/cn";
import type { Playback, Rendition } from "~/lib/queries";
import { Icon } from "./icons";
import { Button } from "./ui/button";

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

/**
 * Browsers give audio-only streams a small buffer (Chrome about 12 MB), which a few segments
 * of high-resolution surround overflow. Read ahead only as far as about 6 MB of the heaviest
 * rendition allows, between 6 and 30 seconds, and let played audio go.
 */
export function audioBuffer(renditions: Rendition[]) {
  const peak = Math.max(1, ...renditions.map((r) => r.bandwidth));
  const seconds = Math.min(30, Math.max(6, Math.floor(48_000_000 / peak)));
  return { maxBufferLength: seconds, maxMaxBufferLength: seconds * 2, backBufferLength: 10 };
}

/**
 * Plays a protected stream: encrypted HLS, decrypted in the browser through Media Source
 * Extensions. Only this session can fetch the playlists, segments and keys.
 */
export function Player({
  kind,
  playback,
  info,
  onExpired,
}: {
  kind: "audio" | "video";
  playback: Playback;
  info: MediaInfo | null;
  onExpired: () => void;
}) {
  const media = useRef<HTMLVideoElement & HTMLAudioElement>(null);
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

  useEffect(() => {
    const element = media.current;
    if (!element) return;
    let cancelled = false;
    setFailure(null);
    setChoices([]);
    void import("hls.js").then(({ default: Hls }) => {
      if (cancelled) return;
      if (!Hls.isSupported()) {
        // Safari on iOS has no Media Source Extensions but plays AES-128 HLS natively.
        if (element.canPlayType("application/vnd.apple.mpegurl")) element.src = playback.url;
        else setFailure("unsupported");
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
    });
    return () => {
      cancelled = true;
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
    if (element.paused) void element.play();
    else element.pause();
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
          <div className="relative h-4">
            <div className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-hairline" />
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
            {choices.length === 1 && choices[0] && (
              <span className="tabular ml-auto text-xs text-ink-3">
                {renditionLabel(choices[0].rendition, info)}
              </span>
            )}
            {choices.length > 1 && (
              <fieldset className="m-0 ml-auto flex min-w-0 flex-wrap items-center gap-1 border-0 p-0">
                <legend className="sr-only">Rendition</legend>
                {kind === "video" && (
                  <RenditionButton selected={level === -1} onSelect={() => choose(-1)}>
                    Auto
                  </RenditionButton>
                )}
                {choices.map((c) => (
                  <RenditionButton
                    key={c.rendition.id}
                    selected={level === c.level}
                    onSelect={() => choose(c.level)}
                  >
                    {renditionLabel(c.rendition, info)}
                  </RenditionButton>
                ))}
              </fieldset>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function RenditionButton({
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
