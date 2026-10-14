import { useQueries, useQuery } from "@tanstack/react-query";
import type Hls from "hls.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "~/lib/cn";
import {
  blindLetter,
  blindOrder,
  type CompareSource,
  compareSources,
  gainLabel,
  levelGains,
  MAX_SOURCES,
  needsResync,
} from "~/lib/compare";
import {
  type FileDetail,
  loudnessQuery,
  type Playback,
  playbackQuery,
  trackQuery,
} from "~/lib/queries";
import { audioBuffer, preferredRendition } from "./player";
import { Button } from "./ui/button";

/**
 * One source playing silently in step with the master player, so switching to it is
 * instant: no new stream to start, no gap. It follows play, pause, seeks and loops.
 */
function Follower({
  playback,
  master,
  volume,
}: {
  playback: Playback;
  master: HTMLMediaElement;
  /** 0 while another source is heard. */
  volume: number;
}) {
  const element = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const audio = element.current;
    if (!audio) return;
    let hls: Hls | null = null;
    let cancelled = false;
    import("hls.js").then(({ default: Hls }) => {
      if (cancelled) return;
      if (!Hls.isSupported()) {
        audio.src = playback.url;
        return;
      }
      hls = new Hls({ enableWorker: true, ...audioBuffer(playback.renditions) });
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        // The same rendition the master would choose: lossless where the browser can.
        const preferred = preferredRendition(playback.renditions);
        const level = hls?.levels.findIndex(
          (l) => preferred && l.uri.includes(`/r/${preferred.id}/`),
        );
        if (hls && level !== undefined && level >= 0) hls.currentLevel = level;
      });
      hls.loadSource(playback.url);
      hls.attachMedia(audio);
    });
    return () => {
      cancelled = true;
      hls?.destroy();
      audio.removeAttribute("src");
    };
  }, [playback]);

  useEffect(() => {
    const audio = element.current;
    if (!audio) return;
    const sync = () => {
      if (needsResync(master.currentTime, audio.currentTime))
        audio.currentTime = master.currentTime;
    };
    const play = () => {
      sync();
      void audio.play().catch(() => undefined);
    };
    const pause = () => audio.pause();
    master.addEventListener("play", play);
    master.addEventListener("pause", pause);
    master.addEventListener("seeked", sync);
    // Loops and seeks move the master; drift is put right a few times a second.
    const timer = window.setInterval(() => {
      if (!master.paused) sync();
    }, 250);
    sync();
    if (!master.paused) play();
    return () => {
      master.removeEventListener("play", play);
      master.removeEventListener("pause", pause);
      master.removeEventListener("seeked", sync);
      window.clearInterval(timer);
      audio.pause();
    };
  }, [master]);

  useEffect(() => {
    if (element.current) element.current.volume = volume;
  }, [volume]);

  // biome-ignore lint/a11y/useMediaCaption: a silent follower of the main player, never shown.
  return <audio ref={element} preload="auto" />;
}

/** A follower needs its own protected stream, issued to this session like any other. */
function FollowerSource({
  fileId,
  master,
  volume,
}: {
  fileId: string;
  master: HTMLMediaElement;
  volume: number;
}) {
  const { data } = useQuery(playbackQuery(fileId));
  return data ? <Follower playback={data} master={master} volume={volume} /> : null;
}

const chip =
  "tabular h-7 cursor-pointer rounded-chip border px-2.5 text-xs disabled:cursor-default disabled:opacity-40";

/**
 * Quick comparison: up to four sources (this file, and others of its track) pinned to the
 * number keys. One key flips between them at the same position, level-matched, gapless and
 * inside any loop; blind mode hides which is which.
 */
export function Compare({ file, media }: { file: FileDetail; media: HTMLMediaElement | null }) {
  const variation = file.variation;
  const { data: track } = useQuery({
    ...trackQuery(variation?.trackId ?? ""),
    enabled: Boolean(variation),
  });
  const candidates = useMemo(() => (track ? compareSources(track, file.id) : []), [track, file.id]);
  const [pinned, setPinned] = useState<string[]>([]);
  const [heard, setHeard] = useState(0);
  const [blind, setBlind] = useState(false);
  /** Blind: the source behind each key; otherwise key k is source k. */
  const [order, setOrder] = useState<number[]>([]);

  const self: CompareSource = {
    fileId: file.id,
    label: variation ? `V${variation.versionNumber} · ${variation.name}` : file.name,
    versionNumber: variation?.versionNumber ?? 0,
  };
  const sources = [
    self,
    ...pinned.flatMap((id) => candidates.filter((c) => c.fileId === id)),
  ].slice(0, MAX_SOURCES);
  const loudness = useQueries({
    queries: sources.map((s) => loudnessQuery(s.fileId)),
  });
  const gains = levelGains(loudness.map((q) => q.data?.summary?.integrated));
  const comparing = sources.length > 1;
  const current = Math.min(heard, sources.length - 1);

  // The master is heard only when it is the chosen source; the others follow silently.
  useEffect(() => {
    if (!media) return;
    media.volume = comparing ? (current === 0 ? (gains[0] ?? 1) : 0) : 1;
  }, [media, comparing, current, gains]);
  // Leaving comparison gives the master back its full volume.
  useEffect(() => {
    return () => {
      if (media) media.volume = 1;
    };
  }, [media]);

  // Number keys switch, anywhere on the page but in a text field.
  useEffect(() => {
    if (!comparing) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=true]")) return;
      const n = Number(event.key);
      if (Number.isInteger(n) && n >= 1 && n <= sources.length) {
        event.preventDefault();
        setHeard(blind ? (order[n - 1] ?? n - 1) : n - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [comparing, sources.length, blind, order]);

  if (!variation || candidates.length === 0) return null;

  const toggle = (fileId: string) => {
    setPinned((list) =>
      list.includes(fileId)
        ? list.filter((id) => id !== fileId)
        : list.length < MAX_SOURCES - 1
          ? [...list, fileId]
          : list,
    );
  };
  const startBlind = () => {
    const shuffled = blindOrder(sources.length);
    setOrder(shuffled);
    // Keep hearing what was heard, now under whichever key it moved to.
    setBlind(true);
    setHeard(current);
  };
  /** The source behind a key. */
  const at = (key: number) => (blind ? (order[key] ?? key) : key);

  return (
    <section
      aria-label="Compare"
      className="flex flex-col gap-3 rounded-panel border border-hairline p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="m-0 text-[15px] font-medium">Compare</h2>
        <span className="text-xs text-ink-3">
          {comparing
            ? `Keys 1 ${sources.length === 2 ? "and" : "to"} ${sources.length} switch at the same position, level-matched.`
            : "Add up to three more to flip between at the same position."}
        </span>
      </div>
      <fieldset className="m-0 flex flex-wrap gap-1 border-0 p-0">
        <legend className="sr-only">Sources to compare</legend>
        {candidates.map((c) => {
          const on = pinned.includes(c.fileId);
          return (
            <button
              key={c.fileId}
              type="button"
              aria-pressed={on}
              disabled={!on && sources.length >= MAX_SOURCES}
              onClick={() => toggle(c.fileId)}
              className={cn(
                chip,
                on
                  ? "border-edge bg-raised text-ink"
                  : "border-transparent bg-transparent text-ink-3 hover:text-ink",
              )}
            >
              {on ? "✓ " : "+ "}
              {c.label}
            </button>
          );
        })}
      </fieldset>
      {comparing && media && (
        <>
          <ol className="m-0 grid list-none grid-cols-1 gap-2 p-0 sm:grid-cols-2">
            {sources.map((_, key) => {
              const i = at(key);
              const s = sources[i];
              return s ? (
                <li key={s.fileId}>
                  <button
                    type="button"
                    aria-pressed={current === i}
                    onClick={() => setHeard(i)}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-3 rounded-control border px-3 py-2 text-left",
                      current === i
                        ? "border-signal bg-raised text-ink"
                        : "border-hairline bg-transparent text-ink-2 hover:border-edge",
                    )}
                  >
                    <span className="tabular font-mono text-xs text-ink-3">{key + 1}</span>
                    <span className="min-w-0 flex-1 truncate text-[13px]">
                      {blind ? `Source ${blindLetter(key)}` : s.label}
                    </span>
                    {!blind && (
                      <span className="tabular shrink-0 font-mono text-[11px] text-ink-3">
                        {gainLabel(gains[i] ?? 1)}
                      </span>
                    )}
                  </button>
                </li>
              ) : null;
            })}
          </ol>
          <div className="flex flex-wrap items-center gap-2">
            {blind ? (
              <Button size="sm" variant="ghost" onClick={() => setBlind(false)}>
                Reveal
              </Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={startBlind}>
                Listen blind
              </Button>
            )}
            <span className="text-xs text-ink-3">
              Versions are compared at the same time from the start; alignment by musical position
              follows.
            </span>
          </div>
          {sources.slice(1).map((s, i) => (
            <FollowerSource
              key={s.fileId}
              fileId={s.fileId}
              master={media}
              volume={current === i + 1 ? (gains[i + 1] ?? 1) : 0}
            />
          ))}
        </>
      )}
    </section>
  );
}
