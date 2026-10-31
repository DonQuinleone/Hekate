import { useState } from "react";
import { Avatar } from "~/components/avatar";
import { Icon } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/input";
import { ActionMenu, type MenuAction } from "~/components/ui/menu";
import { type Comment, categories, type Project, personById } from "~/data";
import { cn } from "~/lib/cn";
import { ago, formatAnchor, formatClock, formatReference } from "~/lib/format";
import type { FileAccess } from "~/viewer/context";
import type { Playback } from "../player/playback.ts";
import { DeferDialog } from "./defer-dialog.tsx";
import { LinkedFiles } from "./file-picker.tsx";
import { OtherTakes, SharedTakes } from "./takes.tsx";

const carryCopy = { open: "Open", fixed: "Fixed", not_fixed: "Not fixed", wont_fix: "Won't fix" };

/**
 * A category's colour, by its place among the project's categories (#496): the bar at the
 * thread's left edge. Six tones, then round again.
 */
const tones = [
  "bg-category-1",
  "bg-category-2",
  "bg-category-3",
  "bg-category-4",
  "bg-category-5",
  "bg-category-6",
] as const;
export const categoryTone = (id: string) => {
  const at = categories.findIndex((c) => c.id === id);
  return at < 0 ? null : tones[at % tones.length];
};

export interface ThreadProps {
  comment: Comment;
  replies: Comment[];
  number: number | null;
  active: boolean;
  access: FileAccess;
  playback: Playback | null;
  project: Project;
  trackId: string | null;
  versionNumber: number | null;
  video?: boolean;
  fps?: number;
  isGuest: boolean;
  personId: string;
  onSelect: () => void;
}

/** A quiet word in the action row: a state the thread is in, not something to press. */
const quiet = "text-[12px] text-ink-3";

/**
 * One thread, laid out as Frame.io and Figma lay theirs (#496): who and when, with where
 * (the anchor) as a chip at the line's end; the words; what is attached; then one row of
 * actions, always there and quiet. Its category is the bar at its left edge, never a pill.
 */
export function Thread({
  comment,
  replies,
  number,
  active,
  access,
  playback,
  project,
  trackId,
  versionNumber,
  video,
  fps,
  isGuest,
  personId,
  onSelect,
}: ThreadProps) {
  const [replying, setReplying] = useState(false);
  const [takesOpen, setTakesOpen] = useState(false);
  const [beforeAfter, setBeforeAfter] = useState<"before" | "after" | null>(null);
  const [resolved, setResolved] = useState(Boolean(comment.resolved));
  const [deferring, setDeferring] = useState(false);
  const author = personById(comment.authorId);
  const category = categories.find((c) => c.id === comment.categoryId);
  const tone = category ? categoryTone(category.id) : null;
  const carry = comment.carries?.find((c) => c.versionNumber === versionNumber);
  const carriedFrom = comment.carries?.[0]?.versionNumber;
  const reference = formatReference(comment.reference, project.references);
  const anchorText =
    comment.anchor.kind === "whole" ? "" : formatAnchor(comment.anchor, { video, fps });
  // Where it points, in one chip: the bar or page, then the moment it was heard at (#496),
  // then the channel it is about.
  const where = [reference, anchorText, comment.channel].filter(Boolean).join(" · ");
  const canTriage = access.triage;
  const mine = comment.authorId === personId;
  const seekTo = () => {
    if (comment.anchor.kind === "time" && playback)
      playback.seek(carry?.at ?? comment.anchor.start);
    if (comment.anchor.kind === "region" && comment.anchor.at !== undefined && playback)
      playback.seek(comment.anchor.at);
    onSelect();
  };
  const loopIt = () => {
    if (!playback) return;
    const start =
      comment.anchor.kind === "time"
        ? comment.anchor.start
        : comment.anchor.kind === "region"
          ? (comment.anchor.at ?? 0)
          : 0;
    const end =
      comment.anchor.kind === "time" && comment.anchor.end ? comment.anchor.end : start + 4;
    playback.setLoop({ start: Math.max(0, start - 1), end: end + 1 });
    playback.setLooping(true);
    playback.seek(Math.max(0, start - 1));
  };
  const bar = comment.reference?.bar;
  const action = "rounded-chip px-1 text-[12px] text-ink-3 transition-colors hover:text-ink";
  const canLoop = Boolean(playback && access.tools.has("loops") && comment.anchor.kind !== "whole");
  const hasTakes = Boolean(
    trackId && bar !== undefined && (access.tools.has("takes") || canTriage),
  );
  // Everything but Reply and Resolve: the passage, the takes, triage, and the words themselves.
  const actions: (MenuAction | "divider")[] = [
    ...(canLoop ? [{ label: "Loop the passage", onSelect: loopIt }] : []),
    ...(hasTakes
      ? [
          {
            label: takesOpen ? "Hide other takes" : `Other takes for bar ${bar}`,
            onSelect: () => setTakesOpen((o) => !o),
          },
        ]
      : []),
    ...(mine ? [{ label: "Edit", onSelect: () => {} }] : []),
    ...(canTriage
      ? [
          "divider" as const,
          ...categories.map((c) => ({
            label: `Mark as ${c.name}`,
            checked: c.id === comment.categoryId,
            onSelect: () => {},
          })),
          "divider" as const,
          {
            label: comment.deferredToStage ? "Undefer" : "Defer to a stage…",
            onSelect: () => !comment.deferredToStage && setDeferring(true),
          },
          { label: "Assign to…", onSelect: () => {} },
          { label: "Make a task", onSelect: () => {} },
          { label: "Move the anchor to the loop", onSelect: () => {} },
          { label: "Copy link", onSelect: () => {} },
        ]
      : []),
    ...(mine ? ["divider" as const, { label: "Delete", danger: true, onSelect: () => {} }] : []),
  ];
  while (actions[0] === "divider") actions.shift();
  return (
    <article
      aria-current={active ? "true" : undefined}
      onClick={onSelect}
      className={cn(
        "group/thread relative flex flex-col gap-1.5 rounded-panel px-3 py-2.5 transition-colors duration-150",
        active ? "bg-raised shadow-1" : "hover:bg-raised/50",
        resolved && !active && "opacity-60",
      )}
    >
      {tone && category && (
        <span
          aria-hidden="true"
          title={category.name}
          className={cn("absolute top-3 bottom-3 left-0 w-[3px] rounded-full", tone)}
        />
      )}
      <div className="flex min-w-0 items-center gap-2">
        <Avatar personId={comment.authorId} size={22} />
        <span className="truncate text-[13px] font-medium text-ink">
          {isGuest && !mine ? author.name.split(" ")[0] : author.name}
        </span>
        <span className="tabular shrink-0 text-[12px] text-ink-3">{ago(comment.createdAt)}</span>
        {comment.importedFrom && (
          <span className="min-w-0 truncate text-[12px] text-ink-3">
            from {comment.importedFrom}
          </span>
        )}
        {where && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              seekTo();
            }}
            className="tabular ml-auto flex h-6 shrink-0 items-center gap-1 rounded-chip bg-signal/15 px-1.5 text-[12px] font-medium text-signal transition-colors hover:bg-signal/25"
          >
            {number !== null && <span>#{number}</span>}
            {where}
          </button>
        )}
      </div>
      <p className="text-[14px] leading-[21px] text-ink">{comment.body}</p>
      {comment.linkedFileIds && <LinkedFiles ids={comment.linkedFileIds} />}
      {comment.sharedTakeIds && <SharedTakes ids={comment.sharedTakeIds} bar={bar} />}
      {carry && canTriage && versionNumber !== null && (
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
          <span>On V{versionNumber}</span>
          <select
            defaultValue={carry.status}
            onClick={(e) => e.stopPropagation()}
            className="h-6 rounded-chip border border-line bg-ground/60 px-1.5 text-[12px] text-ink-2"
          >
            <option value="open">Open</option>
            <option value="fixed">Fixed in V{versionNumber}</option>
            <option value="not_fixed">Not fixed</option>
            <option value="wont_fix">Won't fix</option>
          </select>
          <label className="flex items-center gap-1">
            <input type="checkbox" defaultChecked={carry.visible} /> shown here
          </label>
          {carry.movedByHand === undefined && comment.anchor.kind === "time" && (
            <span>anchor followed the audio to {formatClock(carry.at)}</span>
          )}
        </div>
      )}
      {carry && !canTriage && carry.status !== "open" && (
        <p className="text-[12px] text-ink-3">
          {carryCopy[carry.status]} in V{carry.versionNumber}
        </p>
      )}
      {comment.carries &&
        comment.carries.length > 1 &&
        comment.carries.some((c) => c.status === "fixed") &&
        playback && (
          <div className="flex items-center gap-1 rounded-control border border-line bg-ground/50 p-1">
            {(["before", "after"] as const).map((side) => {
              const c =
                side === "before"
                  ? comment.carries?.[0]
                  : comment.carries?.find((x) => x.status === "fixed");
              return (
                <button
                  key={side}
                  type="button"
                  aria-pressed={beforeAfter === side}
                  onClick={(e) => {
                    e.stopPropagation();
                    setBeforeAfter(beforeAfter === side ? null : side);
                    if (c) {
                      playback.setLoop({ start: Math.max(0, c.at - 1.5), end: c.at + 2.5 });
                      playback.setLooping(true);
                      playback.seek(Math.max(0, c.at - 1.5));
                    }
                  }}
                  className={cn(
                    "tabular flex h-7 flex-1 items-center justify-center gap-1.5 rounded-[4px] text-[12px] transition-colors",
                    beforeAfter === side
                      ? "bg-overlay text-ink shadow-2"
                      : "text-ink-2 hover:text-ink",
                  )}
                >
                  <Icon
                    name={beforeAfter === side ? "pause" : "play"}
                    size={10}
                    fill="currentColor"
                    strokeWidth={0}
                  />
                  {side === "before" ? "Before" : "After"} · V{c?.versionNumber}
                </button>
              );
            })}
            <span className="px-2 text-[11px] text-ink-3">level-matched</span>
          </div>
        )}
      {replies.map((r) => (
        <div key={r.id} className="mt-1 flex gap-2">
          <Avatar personId={r.authorId} size={18} className="mt-0.5" />
          <div className="min-w-0 flex-1">
            <span className="text-[13px] font-medium text-ink">{personById(r.authorId).name}</span>
            <span className="tabular ml-1.5 text-[12px] text-ink-3">{ago(r.createdAt)}</span>
            <p className="text-[14px] leading-[21px] text-ink">{r.body}</p>
            {r.linkedFileIds && <LinkedFiles ids={r.linkedFileIds} />}
          </div>
        </div>
      ))}
      {takesOpen && trackId && bar !== undefined && (
        <OtherTakes
          trackId={trackId}
          bar={bar}
          versionNumber={versionNumber ?? 0}
          canShare={canTriage}
          onClose={() => setTakesOpen(false)}
        />
      )}
      {/* One row of actions, always there and quiet, as Frame.io and Figma have it. */}
      <div className="-mb-1 flex flex-wrap items-center gap-x-2.5 gap-y-1">
        {access.comment && !resolved && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setReplying((r) => !r);
            }}
            className={action}
          >
            Reply
          </button>
        )}
        {(canTriage || mine) && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setResolved((r) => !r);
            }}
            className={action}
          >
            {resolved ? "Reopen" : "Resolve"}
          </button>
        )}
        {resolved && (
          <span className={cn(quiet, "flex items-center gap-1")}>
            <Icon name="check" size={12} /> Resolved
          </span>
        )}
        {comment.deferredToStage && (
          <span className={quiet}>deferred to {comment.deferredToStage}</span>
        )}
        {carriedFrom !== undefined && versionNumber !== null && carriedFrom !== versionNumber && (
          <span className={quiet}>from V{carriedFrom}</span>
        )}
        {comment.assigneeId && (
          <span className={cn(quiet, "flex items-center gap-1")}>
            <Avatar personId={comment.assigneeId} size={12} />
            {personById(comment.assigneeId).name.split(" ")[0]}
          </span>
        )}
        {comment.todo && (
          <span
            className={cn(
              "rounded-chip px-1.5 text-[11px] leading-5",
              comment.todo.done
                ? "bg-raised text-ink-3 line-through"
                : "border border-signal/50 text-signal",
            )}
          >
            to do
          </span>
        )}
        {actions.length > 0 && (
          <span className="ml-auto" onClick={(e) => e.stopPropagation()}>
            <ActionMenu always label="comment" actions={actions} />
          </span>
        )}
      </div>
      {deferring && (
        <span onClick={(e) => e.stopPropagation()}>
          <DeferDialog
            project={project}
            trackId={trackId}
            canBuild={canTriage}
            onDefer={() => setDeferring(false)}
            onClose={() => setDeferring(false)}
          />
        </span>
      )}
      {replying && (
        <form
          className="rise-in mt-1 flex items-end gap-2"
          onClick={(e) => e.stopPropagation()}
          onSubmit={(e) => {
            e.preventDefault();
            setReplying(false);
          }}
        >
          <Textarea
            rows={1}
            placeholder={`Reply${playback ? ` at ${formatClock(playback.time)}` : ""}`}
            className="min-h-9 text-[13px]"
          />
          <Button
            type="submit"
            variant="primary"
            size="icon"
            aria-label="Post reply"
            className="size-9 rounded-full"
          >
            <Icon name="send" size={14} />
          </Button>
        </form>
      )}
    </article>
  );
}
