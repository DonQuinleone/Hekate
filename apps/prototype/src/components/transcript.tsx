import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "~/components/icons";
import { Input } from "~/components/ui/input";
import { Dropdown, MenuList, usePopover } from "~/components/ui/menu";
import {
  activeCue,
  type CaptionTrack,
  captionFormatNames,
  captionKindNames,
  foldText,
} from "~/data";
import { cn } from "~/lib/cn";
import { formatClock, formatTimecode } from "~/lib/format";
import type { Playback } from "./player/playback.ts";

export type SidePanel = "comments" | "transcript";

/**
 * The panel beside the player names what it holds, and switches between them: its comments,
 * or the transcript read from a caption track (#201). Only offered where there is one.
 */
export function PanelTabs({
  panel,
  onPanel,
  count,
}: {
  panel: SidePanel;
  onPanel: (panel: SidePanel) => void;
  /** Open comments, beside their name. */
  count: number;
}) {
  return (
    <div role="tablist" aria-label="Beside the player" className="flex items-center gap-3">
      {(["comments", "transcript"] as const).map((p) => (
        <button
          key={p}
          type="button"
          role="tab"
          aria-selected={panel === p}
          onClick={() => onPanel(p)}
          className={cn(
            "flex h-11 items-center gap-1.5 text-[14px] transition-colors",
            panel === p ? "font-medium text-ink" : "text-ink-3 hover:text-ink",
          )}
        >
          {p === "comments" ? "Comments" : "Transcript"}
          {p === "comments" && (
            <span className="tabular text-[13px] font-normal text-ink-3">{count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

/**
 * The player's Captions menu (#201): off, or one track at a time, named as it was added with
 * what it is for beside it. Shown wherever a file has a track, a recording as well as a video.
 */
export function CaptionsMenu({
  tracks,
  current,
  onChange,
}: {
  tracks: CaptionTrack[];
  current: string | null;
  onChange: (id: string | null) => void;
}) {
  const on = tracks.find((t) => t.id === current);
  return (
    <Dropdown
      label="Captions"
      align="right"
      value={
        <span className="flex items-center gap-1.5">
          <Icon name="captions" size={14} className={on ? "text-ink" : undefined} />
          <span className={cn(on && "text-ink")}>{on ? on.label : "Captions"}</span>
        </span>
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

/** What is said now: low in the picture for a video, under the waveform for a recording. */
export function CaptionLine({
  cues,
  time,
  over,
}: {
  cues: CaptionTrack["cues"];
  time: number;
  /** Laid over a picture, rather than in a line of its own. */
  over: boolean;
}) {
  const at = activeCue(cues, time);
  const text = at >= 0 ? cues[at]?.text : null;
  if (over)
    return (
      <div
        className="pointer-events-none absolute inset-x-0 bottom-[8%] flex justify-center px-[6%]"
        aria-live="polite"
      >
        {text && (
          <span className="rounded-[3px] bg-black/75 px-2 py-0.5 text-center text-[13px] leading-snug whitespace-pre-line text-paper">
            {text}
          </span>
        )}
      </div>
    );
  return (
    <p
      aria-live="polite"
      className="m-0 flex min-h-[44px] items-center justify-center px-4 text-center text-[14px] leading-snug whitespace-pre-line text-ink"
    >
      {text ?? <span className="text-ink-3">&nbsp;</span>}
    </p>
  );
}

/** The words with what the search found marked. */
function Marked({ text, query }: { text: string; query: string }) {
  const q = foldText(query.trim());
  if (!q) return <>{text}</>;
  // Folding keeps one letter for one here (the sample data has no ligatures), so places match.
  const folded = text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  for (let i = folded.indexOf(q); i >= 0; i = folded.indexOf(q, i + q.length)) {
    parts.push(text.slice(from, i));
    parts.push(
      <mark key={i} className="rounded-[2px] bg-signal/25 text-ink">
        {text.slice(i, i + q.length)}
      </mark>,
    );
    from = i + q.length;
  }
  parts.push(text.slice(from));
  return <>{parts}</>;
}

/**
 * The transcript beside the player (#201): a caption track's cues in order, the one being
 * said marked and kept in view as it plays. A click goes to that moment; scrolling away stops
 * the following until it is asked back. Searched as a phrase, case and accents set aside;
 * exported as SubRip, WebVTT or TTML by whoever may download.
 */
export function TranscriptColumn({
  tracks,
  trackId,
  onTrack,
  playback,
  heading,
  tools,
  video,
  fps,
  canExport,
  className,
}: {
  tracks: CaptionTrack[];
  trackId: string | null;
  onTrack: (id: string) => void;
  playback: Playback;
  heading: ReactNode;
  tools?: ReactNode;
  video: boolean;
  fps?: number;
  canExport: boolean;
  className?: string;
}) {
  const track = tracks.find((t) => t.id === trackId) ?? tracks[0];
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [following, setFollowing] = useState(true);
  const [exportOpen, setExportOpen, exportBox] = usePopover();
  const list = useRef<HTMLOListElement>(null);
  const cues = track?.cues ?? [];
  const at = activeCue(cues, playback.time);
  const shown = useMemo(() => {
    const q = foldText(query.trim());
    return cues.map((c, i) => ({ c, i })).filter(({ c }) => !q || foldText(c.text).includes(q));
  }, [cues, query]);

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
  /** The reader scrolled: stop following while it plays, until asked back. */
  const away = () => {
    if (playback.playing) setFollowing(false);
  };

  if (!track) return null;
  const time = (s: number) => (video ? formatTimecode(s, fps) : formatClock(s, false));
  return (
    <aside aria-label="Transcript" className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex h-11 shrink-0 items-center gap-1 pr-2 pl-3">
        {heading}
        <span className="ml-auto flex items-center gap-0.5">
          {tracks.length > 1 && (
            <Dropdown
              size="sm"
              align="right"
              label="Caption track"
              value={<span className="max-w-[120px] truncate">{track.label}</span>}
              actions={tracks.map((t) => ({
                label: t.label,
                hint: captionKindNames[t.kind],
                checked: t.id === track.id,
                onSelect: () => onTrack(t.id),
              }))}
            />
          )}
          <button
            type="button"
            aria-label="Search the transcript"
            aria-pressed={searching}
            onClick={() => {
              setSearching((s) => !s);
              setQuery("");
            }}
            className={cn(
              "flex size-7 items-center justify-center rounded-control text-ink-3 transition-colors hover:bg-raised hover:text-ink",
              searching && "bg-raised text-ink",
            )}
          >
            <Icon name="search" size={14} />
          </button>
          {canExport && (
            <div ref={exportBox} className="relative">
              <button
                type="button"
                aria-label="Export the transcript"
                aria-haspopup="menu"
                aria-expanded={exportOpen}
                onClick={() => setExportOpen(!exportOpen)}
                className={cn(
                  "flex size-7 items-center justify-center rounded-control text-ink-3 transition-colors hover:bg-raised hover:text-ink",
                  exportOpen && "bg-raised text-ink",
                )}
              >
                <Icon name="download" size={14} />
              </button>
              {exportOpen && (
                <MenuList
                  anchor={exportBox}
                  align="right"
                  onClose={() => setExportOpen(false)}
                  actions={(["srt", "vtt", "ttml"] as const).map((f) => ({
                    label: `${captionFormatNames[f]} (.${f})`,
                    hint: f === track.format ? "as added" : undefined,
                    onSelect: () => setExportOpen(false),
                  }))}
                />
              )}
            </div>
          )}
          {tools}
        </span>
      </div>
      {searching && (
        <div className="rise-in relative px-3 pb-2">
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the transcript"
            aria-label="Search the transcript"
            className="h-8 pr-20 text-[13px]"
          />
          {query.trim() && (
            <span className="tabular pointer-events-none absolute top-0 right-5 flex h-8 items-center text-[12px] text-ink-3">
              {shown.length} {shown.length === 1 ? "match" : "matches"}
            </span>
          )}
        </div>
      )}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <ol
          ref={list}
          aria-label={`${track.label} transcript`}
          onWheel={away}
          onTouchMove={away}
          className="scroll-quiet relative m-0 flex min-h-0 flex-1 list-none flex-col gap-px overflow-auto px-1.5 pb-2"
        >
          {shown.length === 0 && (
            <li className="px-4 py-10 text-center text-[13px] text-ink-3">Nothing matches.</li>
          )}
          {shown.map(({ c, i }) => (
            <li key={`${c.start}-${i}`} data-cue={i}>
              <button
                type="button"
                aria-current={i === at ? "true" : undefined}
                onClick={() => {
                  playback.seek(c.start);
                  setFollowing(true);
                }}
                className={cn(
                  "relative flex w-full items-baseline gap-3 rounded-control py-1.5 pr-2 pl-3 text-left transition-colors hover:bg-raised/60",
                  i === at && "bg-raised",
                )}
              >
                {i === at && (
                  <span
                    aria-hidden="true"
                    className="absolute top-1.5 bottom-1.5 left-0 w-[2px] rounded-full bg-signal"
                  />
                )}
                <span className="tabular w-[72px] shrink-0 text-[12px] text-ink-3">
                  {time(c.start)}
                </span>
                <span
                  className={cn(
                    "min-w-0 text-[13px] leading-snug whitespace-pre-line",
                    i === at ? "text-ink" : "text-ink-2",
                  )}
                >
                  <Marked text={c.text} query={query} />
                </span>
              </button>
            </li>
          ))}
        </ol>
        {!following && (
          <button
            type="button"
            onClick={() => setFollowing(true)}
            className="rise-in absolute bottom-3 left-1/2 flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-raised px-3 text-[12px] text-ink shadow-2 hover:border-edge-strong"
          >
            <Icon name="arrowRight" size={12} className="rotate-90" />
            Follow playback
          </button>
        )}
      </div>
    </aside>
  );
}
