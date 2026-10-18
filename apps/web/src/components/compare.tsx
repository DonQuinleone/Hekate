import { mapTime } from "@hekate/shared";
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
  levelMatchable,
  MAX_SOURCES,
  needsResync,
  shiftLabel,
  sourceFor,
} from "~/lib/compare";
import {
  alignmentsQuery,
  compareFamilyQuery,
  type FileDetail,
  loudnessQuery,
  type Playback,
  playbackQuery,
} from "~/lib/queries";
import { useAnnounce, useShortcuts } from "~/lib/shortcuts";
import { followRate } from "~/lib/speed";
import { audioBuffer, preferredRendition } from "./player";
import { Button } from "./ui/button";

/**
 * One source playing silently in step with the master player, so switching to it is
 * instant: no new stream to start, no gap. It follows play, pause, seeks and loops.
 */
/**
 * A protected stream attached to an audio element with hls.js, on the rendition the main
 * player would choose: lossless where the browser can. `onFail` hears a stream that cannot load.
 */
function useStream(
  element: React.RefObject<HTMLAudioElement | null>,
  playback: Playback,
  onFail: () => void,
) {
  const fail = useRef(onFail);
  fail.current = onFail;
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
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) fail.current();
      });
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
  }, [element, playback]);
}

export function Follower({
  playback,
  master,
  volume,
  follow,
  onFail,
  onElement,
}: {
  playback: Playback;
  master: HTMLMediaElement;
  /** 0 while another source is heard. */
  volume: number;
  /** Where this source should be for a time in the master: the same music, or the same time. */
  follow: (masterTime: number) => number;
  /** The stream could not be loaded, so this source cannot be heard. */
  onFail: () => void;
  /** Its element, for a waveform to follow. */
  onElement?: (element: HTMLAudioElement | null) => void;
}) {
  const fail = useRef(onFail);
  fail.current = onFail;
  const position = useRef(follow);
  position.current = follow;

  const element = useRef<HTMLAudioElement>(null);
  useStream(element, playback, onFail);
  const report = useRef(onElement);
  report.current = onElement;
  useEffect(() => {
    report.current?.(element.current);
    return () => report.current?.(null);
  }, []);

  useEffect(() => {
    const audio = element.current;
    if (!audio) return;
    const sync = () => {
      // Past this source's end (the master runs on through music it lacks), it waits there.
      const end = Number.isFinite(audio.duration) ? audio.duration : Number.POSITIVE_INFINITY;
      const target = Math.min(end, Math.max(0, position.current(master.currentTime)));
      if (needsResync(target, audio.currentTime)) audio.currentTime = target;
    };
    const play = () => {
      sync();
      // A rejection before the stream is attached is retried once it can play.
      void audio.play().catch(() => undefined);
    };
    const pause = () => audio.pause();
    // Pinned while the master plays: start as soon as there is something to play.
    const ready = () => {
      if (!master.paused && audio.paused) play();
    };
    // The player's mute button acts on the master; whichever source is heard obeys it.
    const mute = () => {
      audio.muted = master.muted;
    };
    const failed = () => fail.current();
    master.addEventListener("play", play);
    master.addEventListener("pause", pause);
    master.addEventListener("seeked", sync);
    master.addEventListener("volumechange", mute);
    audio.addEventListener("canplay", ready);
    audio.addEventListener("error", failed);
    mute();
    // At the player's speed (#15), pitch kept, so the passage compared is heard alike.
    const unfollow = followRate(master, audio);
    // Loops and seeks move the master; drift is put right a few times a second.
    const timer = window.setInterval(() => {
      if (master.paused) return;
      sync();
      // Back within this source after waiting at its end: play on.
      if (audio.paused && audio.currentTime < audio.duration) play();
    }, 250);
    sync();
    if (!master.paused) play();
    return () => {
      master.removeEventListener("play", play);
      master.removeEventListener("pause", pause);
      master.removeEventListener("seeked", sync);
      master.removeEventListener("volumechange", mute);
      unfollow();
      audio.removeEventListener("canplay", ready);
      audio.removeEventListener("error", failed);
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
export function FollowerSource({
  fileId,
  master,
  volume,
  follow,
  onFail,
  onElement,
}: {
  fileId: string;
  master: HTMLMediaElement;
  volume: number;
  follow: (masterTime: number) => number;
  onFail: () => void;
  onElement?: (element: HTMLAudioElement | null) => void;
}) {
  const { data, error } = useQuery(playbackQuery(fileId));
  const fail = useRef(onFail);
  fail.current = onFail;
  useEffect(() => {
    if (error) fail.current();
  }, [error]);
  return data ? (
    <Follower
      playback={data}
      master={master}
      volume={volume}
      follow={follow}
      onFail={onFail}
      onElement={onElement}
    />
  ) : null;
}

/**
 * A file's protected stream on an element of its own, never shown: the master another source
 * follows, played with keys and waveforms rather than the full player.
 */
export function StreamSource({
  fileId,
  volume,
  onElement,
  onFail,
}: {
  fileId: string;
  volume: number;
  onElement: (element: HTMLAudioElement | null) => void;
  onFail: () => void;
}) {
  const { data, error } = useQuery(playbackQuery(fileId));
  const fail = useRef(onFail);
  fail.current = onFail;
  useEffect(() => {
    if (error) fail.current();
  }, [error]);
  return data ? (
    <StreamElement playback={data} volume={volume} onElement={onElement} onFail={onFail} />
  ) : null;
}

function StreamElement({
  playback,
  volume,
  onElement,
  onFail,
}: {
  playback: Playback;
  volume: number;
  onElement: (element: HTMLAudioElement | null) => void;
  onFail: () => void;
}) {
  const element = useRef<HTMLAudioElement>(null);
  useStream(element, playback, onFail);
  const report = useRef(onElement);
  report.current = onElement;
  useEffect(() => {
    report.current(element.current);
    return () => report.current(null);
  }, []);
  useEffect(() => {
    if (element.current) element.current.volume = volume;
  }, [volume]);
  // biome-ignore lint/a11y/useMediaCaption: played with keys and waveforms, never shown.
  return <audio ref={element} preload="auto" />;
}

const chip =
  "tabular h-7 cursor-pointer rounded-chip border px-2.5 text-xs disabled:cursor-default disabled:opacity-40";

/**
 * Quick comparison: up to four sources (this file, and others of its track) pinned to the
 * number keys. One key flips between them at the same position, level-matched, gapless and
 * inside any loop; blind mode hides which is which.
 */
/** A source to bring in and hear first, such as the version a carried comment began on. */
export interface CompareFocus {
  fileId: string;
  /** Where the same passage sits in it, relative to this file, in seconds. */
  shift: number;
  /** Changes each time it is asked for, so asking again brings it back. */
  nonce: number;
}

export function Compare({
  file,
  media,
  focus = null,
  gain = 1,
}: {
  file: FileDetail;
  media: HTMLMediaElement | null;
  focus?: CompareFocus | null;
  /** The volume the page plays at outside comparison: normalised playback's (#240), or full. */
  gain?: number;
}) {
  const variation = file.variation;
  // Only what this person may open: a guest, the files their reviews give them.
  const { data: track } = useQuery({
    ...compareFamilyQuery(file.id),
    enabled: Boolean(variation),
  });
  const candidates = useMemo(() => {
    if (!track) return [];
    const offered = compareSources(track, file.id);
    // A focused source joins the offer even when it is not one of the usual ones.
    const extra =
      focus && !offered.some((c) => c.fileId === focus.fileId)
        ? sourceFor(track, focus.fileId)
        : undefined;
    return extra ? [extra, ...offered] : offered;
  }, [track, file.id, focus]);
  const [pinned, setPinned] = useState<string[]>([]);
  /** The source being heard, by file, so pinning or unpinning others never changes it. */
  const [heard, setHeard] = useState<string | null>(null);
  /** Sources whose stream could not be loaded. */
  const [failed, setFailed] = useState<string[]>([]);
  const [blind, setBlind] = useState(false);
  /** Blind: the source behind each key; otherwise key k is source k. */
  const [order, setOrder] = useState<number[]>([]);
  /** Per source, how far ahead of the master it plays; none for most. */
  const [shifts, setShifts] = useState<Record<string, number>>({});
  // Where the same music sits in each other version, once the worker has aligned them.
  const { data: aligned = [] } = useQuery({
    ...alignmentsQuery(file.id),
    enabled: Boolean(variation),
  });
  const pointsOf = (fileId: string) => aligned.find((a) => a.fileId === fileId)?.points;
  /** Alignment when there is one; otherwise the same time, or a comment's offset. */
  const followFor = (fileId: string) => {
    const points = pointsOf(fileId);
    const shift = shifts[fileId] ?? 0;
    return points ? (t: number) => mapTime(points, t) : (t: number) => t + shift;
  };

  // Asked to bring a source in: pin it (making room if need be) and hear it first.
  const focused = useRef<number | null>(null);
  useEffect(() => {
    if (!focus || focused.current === focus.nonce) return;
    if (!candidates.some((c) => c.fileId === focus.fileId)) return;
    focused.current = focus.nonce;
    setBlind(false);
    setPinned((list) =>
      list.includes(focus.fileId) ? list : [focus.fileId, ...list].slice(0, MAX_SOURCES - 1),
    );
    setShifts((map) => ({ ...map, [focus.fileId]: focus.shift }));
    setHeard(focus.fileId);
  }, [focus, candidates]);

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
  const levels = loudness.map((q) => q.data?.summary?.integrated);
  const gains = levelGains(levels);
  const matched = levelMatchable(levels);
  const comparing = sources.length > 1;
  const current = Math.max(
    0,
    sources.findIndex((s) => s.fileId === heard),
  );
  const hear = (i: number | undefined) => {
    const s = i === undefined ? undefined : sources[i];
    if (s && !failed.includes(s.fileId)) setHeard(s.fileId);
  };
  // Sources are fixed while blind; should one vanish anyway (no longer ready), the
  // assignment no longer holds, so reveal rather than mislabel.
  if (blind && order.length !== sources.length) {
    setBlind(false);
  }

  // The master is heard only when it is the chosen source; the others follow silently.
  useEffect(() => {
    if (!media) return;
    // Comparing, the sources are level-matched with one another; alone, the page's volume.
    media.volume = comparing ? (current === 0 ? (gains[0] ?? 1) : 0) : gain;
  }, [media, comparing, current, gains, gain]);
  // Leaving comparison gives the master back its full volume; the page sets its own after.
  useEffect(() => {
    return () => {
      if (media) media.volume = 1;
    };
  }, [media]);

  const say = useAnnounce();
  // Number keys switch, anywhere on the page but in a text field.
  useShortcuts(
    "compare",
    "Comparison",
    [
      {
        keys: sources.map((_, i) => String(i + 1)),
        label: "Hear a source by its number",
        run: (event) => {
          const n = Number(event.key);
          if (n < 1 || n > sources.length) return;
          hear(blind ? order[n - 1] : n - 1);
          say(`Hearing source ${n}`);
        },
      },
    ],
    comparing,
  );

  if (!variation || candidates.length === 0) return null;

  const toggle = (fileId: string) => {
    // Unpinned, a source loses any offset a comment gave it; pinned again, it lines up as usual.
    if (pinned.includes(fileId)) {
      setShifts(({ [fileId]: _, ...rest }) => rest);
    }
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
            ? `Keys 1 ${sources.length === 2 ? "and" : "to"} ${sources.length} switch at the same position${matched ? ", level-matched" : ""}.`
            : "Add up to three more to flip between at the same position."}
        </span>
      </div>
      {/* The sources stay put while listening blind, so each key keeps its source. */}
      <fieldset disabled={blind} className="m-0 flex flex-wrap gap-1 border-0 p-0">
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
              const unavailable = s ? failed.includes(s.fileId) : false;
              return s ? (
                <li key={s.fileId}>
                  <button
                    type="button"
                    aria-pressed={current === i}
                    disabled={unavailable}
                    onClick={() => hear(i)}
                    className={cn(
                      "flex w-full cursor-pointer items-center gap-3 rounded-control border px-3 py-2 text-left disabled:cursor-default disabled:opacity-40",
                      current === i
                        ? "border-signal bg-raised text-ink"
                        : "border-hairline bg-transparent text-ink-2 hover:border-edge",
                    )}
                  >
                    <span className="tabular text-xs text-ink-3">{key + 1}</span>
                    <span className="min-w-0 flex-1 truncate text-[13px]">
                      {blind ? `Source ${blindLetter(key)}` : s.label}
                    </span>
                    {!blind && i > 0 && pointsOf(s.fileId) ? (
                      <span className="shrink-0 text-[11px] text-ink-3">aligned</span>
                    ) : !blind && shifts[s.fileId] ? (
                      <span className="tabular shrink-0 text-[11px] text-ink-3">
                        {shiftLabel(shifts[s.fileId] ?? 0)}
                      </span>
                    ) : null}
                    {unavailable ? (
                      <span className="shrink-0 text-[11px] text-signal">Could not load</span>
                    ) : (
                      !blind &&
                      matched && (
                        <span className="tabular shrink-0 text-[11px] text-ink-3">
                          {gainLabel(gains[i] ?? 1)}
                        </span>
                      )
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
              {matched ? "" : "Not level-matched until every source is measured. "}
              {sources.slice(1).some((s) => pointsOf(s.fileId))
                ? "Aligned sources follow the music, wherever an edit moved it."
                : Object.values(shifts).some(Boolean)
                  ? "Offsets follow where a comment's passage was moved to on this version."
                  : "Until versions are aligned, they play at the same time from the start."}
            </span>
          </div>
          {sources.slice(1).map((s, i) => (
            <FollowerSource
              key={s.fileId}
              fileId={s.fileId}
              master={media}
              volume={current === i + 1 ? (gains[i + 1] ?? 1) : 0}
              follow={followFor(s.fileId)}
              onFail={() =>
                setFailed((list) => (list.includes(s.fileId) ? list : [...list, s.fileId]))
              }
            />
          ))}
        </>
      )}
    </section>
  );
}
