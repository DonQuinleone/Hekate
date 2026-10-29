import { type ReactNode, useMemo, useState } from "react";
import { Icon } from "~/components/icons";
import { Dropdown } from "~/components/ui/menu";
import { type Comment, categories, type File, type Project } from "~/data";
import { cn } from "~/lib/cn";
import { type FileAccess, visibleComments } from "~/viewer/context";
import type { Playback } from "../player/playback.ts";
import { channelNames } from "../player/waveform.tsx";
import { Composer } from "./composer.tsx";
import { Thread } from "./thread.tsx";

type Filter = "open" | "resolved" | "deferred" | "all";
type Sort = "position" | "newest";

/** Threads in the order the list reads: by time, then by page, then the whole file. */
export function orderThreads(threads: Comment[]): Comment[] {
  const key = (c: Comment) => {
    if (c.anchor.kind === "time") return [0, c.anchor.start] as const;
    if (c.anchor.kind === "region")
      return [
        c.anchor.at !== undefined ? 0 : 1,
        c.anchor.at ?? (c.anchor.page ?? 0) * 10 + c.anchor.y,
      ] as const;
    return [2, 0] as const;
  };
  return [...threads].sort((a, b) => {
    const [ka, va] = key(a);
    const [kb, vb] = key(b);
    return ka - kb || va - vb || a.createdAt.localeCompare(b.createdAt);
  });
}

/** The comments beside the player: filtered, sorted, searched, numbered as the markers are. */
export function CommentsColumn({
  file,
  all,
  access,
  playback,
  project,
  trackId,
  versionNumber,
  selected,
  onSelect,
  personId,
  isGuest,
  video,
  fps,
  page,
  kind,
  onPost,
  tools,
  banner,
  heading,
  className,
}: {
  /** In place of the panel's name, given how many threads are open: the transcript switch. */
  heading?: (open: number) => ReactNode;
  file: File;
  all: Comment[];
  access: FileAccess;
  playback: Playback | null;
  project: Project;
  trackId: string | null;
  versionNumber: number | null;
  selected: string | null;
  onSelect: (id: string | null) => void;
  personId: string;
  isGuest: boolean;
  video?: boolean;
  fps?: number;
  page?: number;
  kind: "media" | "document";
  onPost: (body: string) => void;
  /** Controls that belong to the panel itself, such as where it sits. */
  tools?: ReactNode;
  /** Something that needs the reviewer before the comments: their decision. */
  banner?: ReactNode;
  className?: string;
}) {
  const [filter, setFilter] = useState<Filter>("open");
  const [sort, setSort] = useState<Sort>("position");
  const [category, setCategory] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const visible = useMemo(() => visibleComments(all, access, personId), [all, access, personId]);
  const threads = visible.filter((c) => !c.parentId);
  const hiddenHere = threads.filter(
    (c) =>
      c.carries?.some((x) => x.versionNumber === versionNumber && !x.visible) && !access.triage,
  );
  const shown = threads.filter((c) => !hiddenHere.includes(c));
  const open = orderThreads(shown.filter((c) => !c.resolved && !c.deferredToStage));
  const resolved = orderThreads(shown.filter((c) => c.resolved));
  const deferred = orderThreads(shown.filter((c) => c.deferredToStage && !c.resolved));
  const pool =
    filter === "open"
      ? open
      : filter === "resolved"
        ? resolved
        : filter === "deferred"
          ? deferred
          : orderThreads(shown);
  const list = pool
    .filter((c) => !category || c.categoryId === category)
    .filter((c) => !query || c.body.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => (sort === "newest" ? b.createdAt.localeCompare(a.createdAt) : 0));
  const numberOf = new Map(open.map((c, i) => [c.id, i + 1]));
  const usedCategories = categories.filter((c) => shown.some((x) => x.categoryId === c.id));
  const composerNote = !access.comment
    ? isGuest
      ? "This share does not take comments."
      : "Your role here does not comment."
    : undefined;
  const filterLabel = { open: "Open", resolved: "Resolved", deferred: "Deferred", all: "All" };
  const iconButton = (label: string, name: "search" | "sort", on: boolean, onClick: () => void) => (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "flex size-7 items-center justify-center rounded-control text-ink-3 transition-colors hover:bg-raised hover:text-ink",
        on && "bg-raised text-ink",
      )}
    >
      <Icon name={name} size={14} />
    </button>
  );
  return (
    <aside aria-label="Comments" className={cn("flex min-h-0 flex-col", className)}>
      {banner}
      <div className="flex h-11 shrink-0 items-center gap-1 pr-2 pl-3">
        {heading ? (
          heading(open.length)
        ) : (
          <>
            <h2 className="text-[14px] font-medium text-ink">Comments</h2>
            <span className="tabular text-[13px] text-ink-3">{open.length}</span>
          </>
        )}
        <span className="ml-auto flex items-center gap-0.5">
          <Dropdown
            size="sm"
            align="right"
            value={<span>{filterLabel[filter]}</span>}
            actions={(["open", "resolved", "deferred", "all"] as const).map((f) => ({
              label: filterLabel[f],
              hint: String({ open, resolved, deferred, all: shown }[f].length),
              checked: filter === f,
              onSelect: () => setFilter(f),
            }))}
          />
          {iconButton("Sort", "sort", sort === "newest", () =>
            setSort(sort === "newest" ? "position" : "newest"),
          )}
          {iconButton("Search comments", "search", searching, () => {
            setSearching((s) => !s);
            setQuery("");
          })}
          {tools}
        </span>
      </div>
      {searching && (
        <div className="rise-in px-3 pb-2">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search comments"
            aria-label="Search comments"
            className="h-8 w-full rounded-control border border-line bg-ground/60 px-2.5 text-[13px] text-ink placeholder:text-ink-3 focus:border-edge-strong focus:outline-none"
          />
        </div>
      )}
      {usedCategories.length > 1 && access.comments === "all" && (
        <div className="flex shrink-0 flex-wrap gap-1 px-3 pb-2">
          {[{ id: null, name: "All" }, ...usedCategories].map((c) => (
            <button
              key={c.id ?? "all"}
              type="button"
              aria-pressed={category === c.id}
              onClick={() => setCategory(c.id)}
              className={cn(
                "h-6 rounded-full px-2.5 text-[12px] transition-colors",
                category === c.id ? "bg-raised text-ink shadow-1" : "text-ink-3 hover:text-ink",
              )}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}
      <div className="scroll-quiet flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto px-1.5 pb-2">
        {list.length === 0 && (
          <p className="px-4 py-10 text-center text-[13px] text-ink-3">
            {query
              ? "Nothing matches."
              : filter === "open"
                ? access.comment
                  ? "No comments yet. Play, then write one at the playhead, over a range, or on the whole file."
                  : "No comments yet."
                : filter === "resolved"
                  ? "Nothing resolved yet."
                  : "Nothing deferred."}
          </p>
        )}
        {list.map((c) => (
          <Thread
            key={c.id}
            comment={c}
            replies={visible.filter((r) => r.parentId === c.id)}
            number={numberOf.get(c.id) ?? null}
            active={selected === c.id}
            access={access}
            playback={playback}
            project={project}
            trackId={trackId}
            versionNumber={versionNumber}
            video={video}
            fps={fps}
            isGuest={isGuest}
            personId={personId}
            onSelect={() => onSelect(c.id)}
          />
        ))}
        {hiddenHere.length > 0 && filter === "open" && (
          <p className="flex items-center gap-1.5 px-3 py-2 text-[12px] text-ink-3">
            <Icon name="eyeOff" size={12} /> {hiddenHere.length} carried{" "}
            {hiddenHere.length === 1 ? "thread is" : "threads are"} hidden on this version.
          </p>
        )}
        {access.comments !== "all" && (
          <p className="px-3 py-2 text-[12px] text-ink-3">
            {access.comments === "own_and_replies"
              ? "You see your own comments and the replies to them."
              : "You see only your own comments."}
          </p>
        )}
      </div>
      <Composer
        playback={playback}
        kind={kind}
        video={video}
        fps={fps}
        page={page}
        references={
          kind === "media" && file.kind === "audio"
            ? project.references
            : { page: kind === "document", bar: false, beat: false }
        }
        canCategorise={access.triage}
        // Takes go on a comment from the track's own (#497), by those who triage and see takes.
        takesFrom={access.triage && access.tools.has("takes") ? trackId : null}
        channels={
          kind === "media" && file.kind === "audio" && (file.media.channels ?? 0) >= 2
            ? channelNames(file.media.channels ?? 0)
            : []
        }
        disabledReason={composerNote}
        onPost={onPost}
      />
    </aside>
  );
}
