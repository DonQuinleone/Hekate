import { useMemo, useState } from "react";
import { Icon } from "~/components/icons";
import { type Comment, categories, type File, type Project } from "~/data";
import { cn } from "~/lib/cn";
import { type FileAccess, visibleComments } from "~/viewer/context";
import type { Playback } from "../player/playback.ts";
import { Composer } from "./composer.tsx";
import { Thread } from "./thread.tsx";

type Filter = "open" | "resolved" | "deferred";

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

/** The comments beside the player: one column, filtered, numbered as the markers are. */
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
}: {
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
}) {
  const [filter, setFilter] = useState<Filter>("open");
  const [category, setCategory] = useState<string | null>(null);
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
  const list = (filter === "open" ? open : filter === "resolved" ? resolved : deferred).filter(
    (c) => !category || c.categoryId === category,
  );
  const numberOf = new Map(open.map((c, i) => [c.id, i + 1]));
  const usedCategories = categories.filter((c) => shown.some((x) => x.categoryId === c.id));
  const composerNote = !access.comment
    ? isGuest
      ? "This share does not take comments."
      : "Your role here does not comment."
    : undefined;
  return (
    <aside
      aria-label="Comments"
      className="flex min-h-0 flex-col rounded-panel-lg border border-hairline bg-surface shadow-1"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-hairline-soft px-3">
        <h2 className="m-0 text-[15px] font-medium">Comments</h2>
        <span className="tabular rounded-full bg-raised px-1.5 text-[11px] leading-[18px] text-ink-2">
          {open.length}
        </span>
        <div
          role="radiogroup"
          className="ml-auto flex rounded-control border border-hairline bg-ground p-0.5"
        >
          {(
            [
              ["open", "Open", open.length],
              ["resolved", "Resolved", resolved.length],
              ["deferred", "Deferred", deferred.length],
            ] as const
          ).map(([id, label, n]) =>
            id === "deferred" && n === 0 ? null : (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={filter === id}
                onClick={() => setFilter(id)}
                className={cn(
                  "tabular h-6 rounded-[4px] px-2 text-xs",
                  filter === id ? "bg-overlay text-ink shadow-2" : "text-ink-3 hover:text-ink",
                )}
              >
                {label}
                {id !== "open" && n > 0 ? ` ${n}` : ""}
              </button>
            ),
          )}
        </div>
      </div>
      {usedCategories.length > 1 && access.comments === "all" && (
        <div className="flex shrink-0 flex-wrap gap-1 border-b border-hairline-soft px-3 py-2">
          <button
            type="button"
            aria-pressed={category === null}
            onClick={() => setCategory(null)}
            className={cn(
              "h-6 rounded-chip px-2 text-[11px]",
              category === null ? "bg-raised text-ink" : "text-ink-3 hover:text-ink",
            )}
          >
            All
          </button>
          {usedCategories.map((c) => (
            <button
              key={c.id}
              type="button"
              aria-pressed={category === c.id}
              onClick={() => setCategory(category === c.id ? null : c.id)}
              className={cn(
                "h-6 rounded-chip px-2 text-[11px]",
                category === c.id ? "bg-raised text-ink" : "text-ink-3 hover:text-ink",
              )}
            >
              {c.name}{" "}
              <span className="tabular text-ink-3">
                {shown.filter((x) => x.categoryId === c.id).length}
              </span>
            </button>
          ))}
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-auto p-2">
        {list.length === 0 && (
          <p className="m-0 px-2 py-8 text-center text-xs text-ink-3">
            {filter === "open"
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
          <p className="m-0 flex items-center gap-1.5 px-2 py-2 text-[11px] text-ink-3">
            <Icon name="eyeOff" size={12} /> {hiddenHere.length} carried{" "}
            {hiddenHere.length === 1 ? "thread is" : "threads are"} hidden on this version by
            triage.
          </p>
        )}
        {access.comments !== "all" && (
          <p className="m-0 px-2 py-2 text-[11px] text-ink-3">
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
        disabledReason={composerNote}
        onPost={onPost}
      />
    </aside>
  );
}
