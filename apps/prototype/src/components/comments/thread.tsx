import { useState } from "react";
import { Avatar } from "~/components/avatar";
import { Icon } from "~/components/icons";
import { Label } from "~/components/label";
import { ActionMenu } from "~/components/ui/menu";
import { type Comment, categories, type Project, personById } from "~/data";
import { cn } from "~/lib/cn";
import { ago, formatAnchor, formatClock, formatReference } from "~/lib/format";
import type { FileAccess } from "~/viewer/context";
import type { Playback } from "../player/playback.ts";
import { OtherTakes, SharedTakes } from "./takes.tsx";

const carryCopy = { open: "Open", fixed: "Fixed", not_fixed: "Not fixed", wont_fix: "Won't fix" };

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

/** One thread: its anchor and reference, the comment, replies, and what the viewer may do with it. */
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
  const author = personById(comment.authorId);
  const category = categories.find((c) => c.id === comment.categoryId);
  const carry = comment.carries?.find((c) => c.versionNumber === versionNumber);
  const carriedFrom = comment.carries?.[0]?.versionNumber;
  const refs = project.references;
  const reference = formatReference(comment.reference, refs);
  const anchorText =
    comment.anchor.kind === "whole"
      ? reference
        ? ""
        : "WHOLE FILE"
      : formatAnchor(comment.anchor, { video, fps });
  const chip = [anchorText, reference].filter(Boolean).join(" · ");
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
  return (
    <article
      aria-current={active ? "true" : undefined}
      className={cn(
        "rounded-panel border px-3 pt-3 pb-2",
        active ? "border-edge bg-overlay shadow-2" : "border-transparent hover:bg-raised/60",
        resolved && !active && "opacity-70",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {number !== null ? (
          <button
            type="button"
            onClick={seekTo}
            aria-label={`Comment ${number}, go to it`}
            className="tabular flex size-[17px] shrink-0 items-center justify-center rounded-full bg-signal text-[10px] font-medium text-ground"
          >
            {number}
          </button>
        ) : (
          <span className="flex size-[17px] shrink-0 items-center justify-center text-ink-3">
            <Icon name="check" size={12} />
          </span>
        )}
        {chip ? (
          <button
            type="button"
            onClick={seekTo}
            className={cn("label truncate hover:text-ink", active ? "text-ink" : "text-ink-2")}
          >
            {chip}
          </button>
        ) : (
          <Label>Whole file</Label>
        )}
        {comment.channel && <Label className="text-ink-3">{comment.channel}</Label>}
        <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-ink-3">
          <Avatar personId={comment.authorId} size={18} />
          <span className="hidden @md/app:inline">
            {isGuest && !mine ? author.name.split(" ")[0] : author.name}
          </span>
          <span>{ago(comment.createdAt)}</span>
        </span>
      </div>
      {(category ||
        comment.deferredToStage ||
        carriedFrom !== undefined ||
        comment.assigneeId ||
        comment.todo) && (
        <div className="mt-1.5 ml-[25px] flex flex-wrap items-center gap-1.5">
          {category && (
            <span className="rounded-chip border border-hairline px-1.5 text-[11px] leading-[18px] text-ink-2">
              {category.name}
            </span>
          )}
          {comment.deferredToStage && (
            <span className="rounded-chip bg-raised px-1.5 text-[11px] leading-[18px] text-ink-3">
              deferred to {comment.deferredToStage}
            </span>
          )}
          {carriedFrom !== undefined && versionNumber !== null && carriedFrom !== versionNumber && (
            <span className="rounded-chip bg-raised px-1.5 text-[11px] leading-[18px] text-ink-3">
              carried from V{carriedFrom}
            </span>
          )}
          {comment.assigneeId && (
            <span className="flex items-center gap-1 rounded-chip bg-raised px-1.5 text-[11px] leading-[18px] text-ink-3">
              <Avatar personId={comment.assigneeId} size={12} />{" "}
              {personById(comment.assigneeId).name.split(" ")[0]}
            </span>
          )}
          {comment.todo && (
            <span
              className={cn(
                "rounded-chip px-1.5 text-[11px] leading-[18px]",
                comment.todo.done
                  ? "bg-raised text-ink-3 line-through"
                  : "border border-signal/50 text-signal",
              )}
            >
              to do
            </span>
          )}
        </div>
      )}
      <p className="m-0 mt-1 ml-[25px] text-[13px] leading-[19px] text-ink">{comment.body}</p>
      {comment.sharedTakeIds && !access.tools.has("takes") && (
        <div className="ml-[25px]">
          <SharedTakes ids={comment.sharedTakeIds} />
        </div>
      )}
      {carry && canTriage && versionNumber !== null && (
        <div className="mt-2 ml-[25px] flex flex-wrap items-center gap-2 text-xs text-ink-3">
          <span>On V{versionNumber}:</span>
          <select
            defaultValue={carry.status}
            className="h-6 rounded-chip border border-hairline bg-ground px-1.5 text-[11px] text-ink-2"
          >
            <option value="open">Open</option>
            <option value="fixed">Fixed in V{versionNumber}</option>
            <option value="not_fixed">Not fixed</option>
            <option value="wont_fix">Won't fix</option>
          </select>
          <label className="flex items-center gap-1">
            <input type="checkbox" defaultChecked={carry.visible} /> show on this version
          </label>
          {carry.movedByHand === undefined && comment.anchor.kind === "time" && (
            <span>anchor followed the audio to {formatClock(carry.at)}</span>
          )}
        </div>
      )}
      {carry && !canTriage && carry.status !== "open" && (
        <p className="m-0 mt-1 ml-[25px] text-xs text-ink-3">
          {carryCopy[carry.status]} in V{carry.versionNumber}
        </p>
      )}
      {comment.carries &&
        comment.carries.length > 1 &&
        comment.carries.some((c) => c.status === "fixed") &&
        playback && (
          <div className="mt-2 ml-[25px] flex items-center gap-1 rounded-control border border-hairline bg-ground p-1">
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
                  onClick={() => {
                    setBeforeAfter(beforeAfter === side ? null : side);
                    if (c) {
                      playback.setLoop({ start: Math.max(0, c.at - 1.5), end: c.at + 2.5 });
                      playback.setLooping(true);
                      playback.seek(Math.max(0, c.at - 1.5));
                    }
                  }}
                  className={cn(
                    "tabular flex h-7 flex-1 items-center justify-center gap-1.5 rounded-[4px] text-xs",
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
                  {side === "before"
                    ? `Before · V${c?.versionNumber}`
                    : `After · V${c?.versionNumber}`}
                </button>
              );
            })}
            <span className="px-2 text-[11px] text-ink-3">level-matched</span>
          </div>
        )}
      {replies.map((r) => (
        <div key={r.id} className="mt-2 ml-[25px] border-l border-hairline pl-3">
          <div className="flex items-center gap-1.5 text-xs text-ink-3">
            <Avatar personId={r.authorId} size={16} />
            <span className="text-ink-2">{personById(r.authorId).name}</span>
            <span>{ago(r.createdAt)}</span>
          </div>
          <p className="m-0 mt-0.5 text-[13px] leading-[19px] text-ink">{r.body}</p>
        </div>
      ))}
      {takesOpen && trackId && bar !== undefined && (
        <div className="ml-[25px]">
          <OtherTakes
            trackId={trackId}
            bar={bar}
            versionNumber={versionNumber ?? 0}
            canShare={canTriage}
            onClose={() => setTakesOpen(false)}
          />
        </div>
      )}
      <div className="mt-1.5 ml-[25px] flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-3">
        {access.comment && (
          <button type="button" onClick={() => setReplying((r) => !r)} className="hover:text-ink">
            Reply
          </button>
        )}
        {playback && access.tools.has("loops") && comment.anchor.kind !== "whole" && (
          <button type="button" onClick={loopIt} className="hover:text-ink">
            Loop
          </button>
        )}
        {trackId && bar !== undefined && (access.tools.has("takes") || canTriage) && (
          <button type="button" onClick={() => setTakesOpen((o) => !o)} className="hover:text-ink">
            Other takes for bar {bar}
          </button>
        )}
        {(canTriage || mine) && (
          <button type="button" onClick={() => setResolved((r) => !r)} className="hover:text-ink">
            {resolved ? "Reopen" : "Resolve"}
          </button>
        )}
        {canTriage && (
          <span className="ml-auto">
            <ActionMenu
              label="comment"
              actions={[
                ...categories.map((c) => ({ label: `Mark as ${c.name}`, onSelect: () => {} })),
                {
                  label: comment.deferredToStage ? "Undefer" : "Defer to a stage…",
                  onSelect: () => {},
                },
                { label: "Assign to…", onSelect: () => {} },
                { label: "Make a task", onSelect: () => {} },
                { label: "Move the anchor to the loop", onSelect: () => {} },
                { label: "Copy link", onSelect: () => {} },
                ...(mine
                  ? [
                      { label: "Edit", onSelect: () => {} },
                      { label: "Delete", danger: true, onSelect: () => {} },
                    ]
                  : []),
              ]}
            />
          </span>
        )}
      </div>
      {replying && (
        <form
          className="mt-2 ml-[25px] flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setReplying(false);
          }}
        >
          <textarea
            rows={2}
            placeholder={`Reply${playback ? ` at ${formatClock(playback.time)}` : ""}`}
            className="flex-1 rounded-control border border-edge bg-ground px-3 py-2 text-[13px] text-ink placeholder:text-ink-3 focus:border-ink-3 focus:outline-none"
          />
          <button
            type="submit"
            className="h-8 rounded-control bg-signal px-3 text-[13px] font-medium text-ground"
          >
            Post
          </button>
        </form>
      )}
    </article>
  );
}
