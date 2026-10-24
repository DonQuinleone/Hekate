import {
  activeCue,
  type CaptionCue,
  type CaptionTrack,
  captionFormatNames,
  captionFormats,
  captionKindNames,
  cuesAt,
  formatDuration,
  matchRanges,
  searchCues,
  type VideoClock,
  videoTimecode,
} from "@hekate/shared";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "~/lib/cn";
import { exportCaptions } from "~/lib/queries";
import { Icon } from "./icons";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Dropdown, MenuList, usePopover } from "./ui/menu";

export type SidePanel = "comments" | "transcript";

/**
 * The panel beside the player names what it holds and switches between them: the comments,
 * or the transcript read from a caption track (#201). Offered only where there is a track.
 */
export function PanelTabs({
  panel,
  onPanel,
}: {
  panel: SidePanel;
  onPanel: (panel: SidePanel) => void;
}) {
  return (
    <div role="tablist" aria-label="Beside the player" className="flex items-center gap-4">
      {(["comments", "transcript"] as const).map((p) => (
        <button
          key={p}
          type="button"
          role="tab"
          aria-selected={panel === p}
          onClick={() => onPanel(p)}
          className={cn(
            "m-0 inline-flex min-h-6 cursor-pointer items-center border-0 bg-transparent p-0 text-[15px] transition-colors",
            panel === p ? "font-medium text-ink" : "text-ink-3 hover:text-ink",
          )}
        >
          {p === "comments" ? "Comments" : "Transcript"}
        </button>
      ))}
    </div>
  );
}

/**
 * The player's Captions menu (#201): off, or one track at a time, each named as it was added
 * with what it is for beside it. Wherever a file has a track, a recording as well as a video.
 */
export function CaptionsMenu({
  tracks,
  current,
  onChange,
}: {
  tracks: readonly CaptionTrack[];
  current: string | null;
  onChange: (id: string | null) => void;
}) {
  const on = tracks.find((t) => t.id === current);
  return (
    <Dropdown
      size="sm"
      above
      label="Captions"
      value={
        <>
          <Icon name="captions" size={14} className={on ? "text-ink" : undefined} />
          <span className={cn("max-w-[140px] truncate", on && "text-ink")}>
            {on ? on.label : "Captions"}
          </span>
        </>
      }
      actions={[
        { label: "Off", checked: !on, onSelect: () => onChange(null) },
        "divider",
        ...tracks.map((t) => ({
          label: t.label,
          hint: captionKindNames[t.kind],
          checked: t.id === current,
          onSelect: () => onChange(t.id),
        })),
      ]}
    />
  );
}

/** What is said now, under a recording's waveform: a line of its own, read out as it changes. */
export function CaptionLine({ cues, time }: { cues: readonly CaptionCue[]; time: number }) {
  const now = cuesAt(cues, time);
  return (
    <p
      aria-live="polite"
      className="m-0 flex min-h-11 flex-col items-center justify-center text-center text-[14px] leading-snug whitespace-pre-line text-ink"
    >
      {now.map((cue) => (
        <span key={`${cue.start}-${cue.text}`}>{cue.text}</span>
      ))}
    </p>
  );
}

/** The words, with what the search found marked. */
function Marked({ text, query }: { text: string; query: string }) {
  const ranges = matchRanges(text, query);
  if (ranges.length === 0) return <>{text}</>;
  const parts: ReactNode[] = [];
  let from = 0;
  for (const [start, end] of ranges) {
    parts.push(text.slice(from, start));
    parts.push(
      <mark key={start} className="rounded-[2px] bg-signal/25 text-ink">
        {text.slice(start, end)}
      </mark>,
    );
    from = end;
  }
  parts.push(text.slice(from));
  return <>{parts}</>;
}

/** The media's position as it plays and seeks. */
function useMediaTime(media: HTMLMediaElement | null) {
  const [time, setTime] = useState(media?.currentTime ?? 0);
  const [playing, setPlaying] = useState(media ? !media.paused : false);
  useEffect(() => {
    if (!media) return;
    const tick = () => setTime(media.currentTime);
    const play = () => setPlaying(!media.paused);
    tick();
    play();
    media.addEventListener("timeupdate", tick);
    media.addEventListener("seeked", tick);
    media.addEventListener("play", play);
    media.addEventListener("pause", play);
    return () => {
      media.removeEventListener("timeupdate", tick);
      media.removeEventListener("seeked", tick);
      media.removeEventListener("play", play);
      media.removeEventListener("pause", play);
    };
  }, [media]);
  return { time, playing };
}

/**
 * The transcript beside the player (#201): a caption track's cues in order, the one being
 * said marked and kept in view as it plays. A click goes to that moment; scrolling the list
 * stops the following until it is asked back. Searched as a phrase, case and accents set
 * aside; exported as SubRip, WebVTT or TTML by whoever may download from the file.
 */
export function Transcript({
  fileId,
  tracks,
  trackId,
  onTrack,
  media,
  clock,
  canExport,
  heading,
  tools,
}: {
  fileId: string;
  tracks: readonly CaptionTrack[];
  /** The track listed: the one the player shows, unless another is chosen here. */
  trackId: string | null;
  onTrack: (id: string) => void;
  media: HTMLMediaElement | null;
  /** A video's own timecode, for its times; a recording's read as minutes and seconds. */
  clock: VideoClock | null;
  canExport: boolean;
  /** The panel's name: the switch back to the comments. */
  heading: ReactNode;
  /** Controls for the panel itself: where it sits. */
  tools?: ReactNode;
}) {
  const track = tracks.find((t) => t.id === trackId) ?? tracks[0];
  const cues = track?.cues ?? [];
  const { time, playing } = useMediaTime(media);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [following, setFollowing] = useState(true);
  const [exportOpen, setExportOpen, exportBox] = usePopover();
  const list = useRef<HTMLOListElement>(null);
  const at = activeCue(cues, time);
  const found = useMemo(() => (query.trim() ? searchCues(cues, query) : null), [cues, query]);
  const shown = found ?? cues.map((_, i) => i);

  // The cue being said kept in view, scrolling the list alone and never the page.
  useEffect(() => {
    const box = list.current;
    if (!following || at < 0 || !box) return;
    const row = box.querySelector<HTMLElement>(`[data-cue="${at}"]`);
    if (!row) return;
    const top = row.offsetTop;
    if (top < box.scrollTop || top + row.offsetHeight > box.scrollTop + box.clientHeight)
      box.scrollTo({ top: Math.max(0, top - box.clientHeight / 3), behavior: "smooth" });
  }, [at, following]);

  if (!track) return null;
  const stamp = (s: number) => (clock ? videoTimecode(s, clock) : formatDuration(s));
  /** The reader scrolled: stop following while it plays, until asked back. */
  const away = () => {
    if (playing) setFollowing(false);
  };
  return (
    <section aria-label="Transcript" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        {heading}
        <div className="flex items-center gap-1">
          {tracks.length > 1 && (
            <Dropdown
              size="sm"
              align="right"
              label="Caption track"
              value={<span className="max-w-[140px] truncate">{track.label}</span>}
              actions={tracks.map((t) => ({
                label: t.label,
                hint: captionKindNames[t.kind],
                checked: t.id === track.id,
                onSelect: () => onTrack(t.id),
              }))}
            />
          )}
          <Button
            variant="ghost"
            size="iconSm"
            aria-label="Search the transcript"
            aria-pressed={searching}
            onClick={() => {
              setSearching((on) => !on);
              setQuery("");
            }}
            className={cn(searching && "bg-raised text-ink")}
          >
            <Icon name="search" size={14} />
          </Button>
          {canExport && (
            <div ref={exportBox} className="relative">
              <Button
                variant="ghost"
                size="iconSm"
                aria-label="Export the transcript"
                aria-haspopup="menu"
                aria-expanded={exportOpen}
                onClick={() => setExportOpen(!exportOpen)}
                className={cn(exportOpen && "bg-raised text-ink")}
              >
                <Icon name="download" size={14} />
              </Button>
              {exportOpen && (
                <MenuList
                  onClose={() => setExportOpen(false)}
                  actions={captionFormats.map((f) => ({
                    label: `${captionFormatNames[f]} (.${f})`,
                    hint: f === track.format ? "As added" : undefined,
                    onSelect: () => {
                      setExportOpen(false);
                      exportCaptions(fileId, track.id, f);
                    },
                  }))}
                />
              )}
            </div>
          )}
          {tools}
        </div>
      </div>
      {searching && (
        <div className="relative">
          <Input
            size="sm"
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setSearching(false);
                setQuery("");
              }
            }}
            placeholder="Search the transcript"
            aria-label="Search the transcript"
            className="pr-24"
          />
          {found && (
            <span
              aria-live="polite"
              className="tabular pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-[12px] text-ink-3"
            >
              {found.length} {found.length === 1 ? "match" : "matches"}
            </span>
          )}
        </div>
      )}
      <div className="relative">
        <ol
          ref={list}
          aria-label={`${track.label} transcript`}
          onWheel={away}
          onTouchMove={away}
          className="relative m-0 flex max-h-[min(70vh,640px)] list-none flex-col gap-px overflow-y-auto overscroll-contain p-0"
        >
          {shown.length === 0 && (
            <li className="py-8 text-center text-[13px] text-ink-3">Nothing matches.</li>
          )}
          {shown.map((i) => {
            const cue = cues[i];
            if (!cue) return null;
            const now = i === at;
            return (
              <li key={`${cue.start}-${i}`} data-cue={i}>
                <button
                  type="button"
                  aria-current={now ? "true" : undefined}
                  onClick={() => {
                    if (media) media.currentTime = cue.start;
                    setFollowing(true);
                  }}
                  className={cn(
                    "relative flex w-full cursor-pointer items-baseline gap-3 rounded-control border-0 bg-transparent py-1.5 pr-2 pl-3 text-left transition-colors hover:bg-raised/60",
                    now && "bg-raised",
                  )}
                >
                  {now && (
                    <span
                      aria-hidden="true"
                      className="absolute top-1.5 bottom-1.5 left-0 w-0.5 rounded-full bg-signal"
                    />
                  )}
                  <span className="tabular w-[76px] shrink-0 text-[12px] text-ink-3">
                    {stamp(cue.start)}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 text-[13px] leading-snug whitespace-pre-line",
                      now ? "text-ink" : "text-ink-2",
                    )}
                  >
                    <Marked text={cue.text} query={query} />
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        {!following && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setFollowing(true)}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-2"
          >
            <Icon name="arrowUp" size={12} className="rotate-180" />
            Follow playback
          </Button>
        )}
      </div>
    </section>
  );
}
