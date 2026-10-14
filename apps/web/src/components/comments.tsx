import {
  type Anchor,
  anchorShift,
  type CarryStatus,
  carryStatuses,
  carryStatusLabel,
  formatAnchor,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { cn } from "~/lib/cn";
import { ago, historyLabel, passageLoop, type Thread, threadsOf } from "~/lib/comments";
import { type Loop, MIN_LOOP } from "~/lib/loop";
import { isWholePage, type PageFocus } from "~/lib/pages";
import {
  type Comment,
  commentsQuery,
  fileQuery,
  meQuery,
  useCommentMutations,
  useProjectCan,
} from "~/lib/queries";
import { useViewer } from "~/lib/viewer";
import type { RegionMarker } from "./document-viewer";
import { Button } from "./ui/button";
import { ActionMenu } from "./ui/menu";

/** Lowercase time labels read better inline than the upper-case anchor labels on markers. */
// "00:12.500" reads as "0:12.500", at either end of a range.
const anchorLabel = (anchor: Anchor) => formatAnchor(anchor).replace(/(^|\s)0(\d:)/g, "$1$2");

const textButton =
  "cursor-pointer border-0 bg-transparent p-0 text-xs text-ink-3 hover:text-ink disabled:cursor-default disabled:opacity-40";

/** A document's page and regions, shared with the viewer beside the comments. */
export interface PageComments {
  focus: PageFocus;
  onFocus: (change: Partial<PageFocus>) => void;
  /** Whether the file has numbered pages (a document) or is one picture. */
  paged: boolean;
}

/** One way a new comment can point, as a pressed-or-not chip beside the composer. */
function Target({
  pressed,
  onClick,
  mono = false,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  mono?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        "h-6 cursor-pointer rounded-chip border px-2 text-[11px]",
        mono && "tabular font-mono",
        pressed ? "border-edge bg-raised text-ink" : "border-transparent bg-transparent text-ink-3",
      )}
    >
      {children}
    </button>
  );
}

/** What before and after needs: the earlier file, the passage there and here. */
export interface BeforeAfter {
  fileId: string;
  /** Where the passage sits in the earlier file, relative to this one, in seconds. */
  shift: number;
  /** The passage here, with a little run-up and run-out. */
  loop: Loop;
}

function Composer({
  placeholder,
  initial = "",
  submitLabel,
  pending,
  onSubmit,
  onCancel,
  children,
}: {
  placeholder: string;
  initial?: string;
  submitLabel: string;
  pending: boolean;
  onSubmit: (body: string) => Promise<unknown>;
  onCancel?: () => void;
  children?: React.ReactNode;
}) {
  const [body, setBody] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!body.trim()) return;
    try {
      await onSubmit(body);
      setBody("");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the comment");
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Space, K and the arrows belong to the text here, not the player.
    event.stopPropagation();
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void submit();
    if (event.key === "Escape") onCancel?.();
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        rows={3}
        aria-label={placeholder}
        className="min-h-20 w-full resize-y rounded-control border border-edge bg-ground px-3 py-2 text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-ink-3"
      />
      {error && <p className="m-0 text-xs text-signal">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {children}
        <span className="ml-auto flex gap-2">
          {onCancel && (
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button size="sm" variant="primary" type="submit" disabled={pending || !body.trim()}>
            {submitLabel}
          </Button>
        </span>
      </div>
    </form>
  );
}

function CommentBody({
  comment,
  own,
  onEdit,
}: {
  comment: Comment;
  own: boolean;
  onEdit: (id: string, body: string) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline gap-2 text-xs">
        <span className="font-medium text-ink">{comment.authorName ?? "Former member"}</span>
        {comment.authorGuest && (
          <span className="text-ink-3">
            {comment.authorLabel ? `${comment.authorLabel}, guest` : "Guest"}
          </span>
        )}
        <span className="text-ink-3" title={new Date(comment.createdAt).toLocaleString("en-GB")}>
          {ago(comment.createdAt)}
          {comment.editedAt && " · edited"}
        </span>
        {own && !editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="ml-auto cursor-pointer border-0 bg-transparent p-0 text-xs text-ink-3 hover:text-ink"
          >
            Edit
          </button>
        )}
      </div>
      {editing ? (
        <Composer
          placeholder="Edit comment"
          initial={comment.body}
          submitLabel="Save"
          pending={false}
          onSubmit={async (body) => {
            await onEdit(comment.id, body);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <p className="m-0 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-2">
          {comment.body}
        </p>
      )}
    </div>
  );
}

function ThreadView({
  thread,
  fileId,
  me,
  onSeek,
  onLoop,
  loop,
  onBeforeAfter,
  mutations,
  canComment,
  canTriage,
  marker,
  pages,
}: {
  thread: Thread;
  /** The file being looked at, which a carried thread was brought to. */
  fileId: string;
  me: string | undefined;
  onSeek: (seconds: number) => void;
  /** Loop a comment's passage, when it covers one. */
  onLoop?: (loop: Loop) => void;
  /** The passage being looped, which a carried thread can be moved to. */
  loop: Loop | null;
  /** Hear a carried passage where it began, then here. */
  onBeforeAfter?: (target: BeforeAfter) => void;
  mutations: ReturnType<typeof useCommentMutations>;
  canComment: boolean;
  canTriage: boolean;
  /** The thread's number on the page, when it points at a region of it. */
  marker?: RegionMarker;
  pages?: PageComments;
}) {
  const [replying, setReplying] = useState(false);
  const { comment, replies } = thread;
  const anchor = comment.anchor;
  const carry = comment.carry;
  /** This version's number, for "Fixed in V3". */
  const here = comment.history?.hops.find((h) => h.fileId === fileId)?.versionNumber;
  const path = historyLabel(comment.history);
  const from = carry?.from.anchor;
  const setCarry = (change: { status?: CarryStatus; visible?: boolean; anchor?: Anchor | null }) =>
    carry && mutations.carry.mutate({ id: carry.id, ...change });
  const edit = (id: string, body: string) => mutations.edit.mutateAsync({ id, body });
  const picked = pages?.focus.selected === comment.id;
  const row = useRef<HTMLLIElement>(null);
  // Picked on the page, the thread comes into view here.
  useEffect(() => {
    if (picked) row.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [picked]);
  /** The region drawn on the page, which a carried thread can be moved to. */
  const draft = pages?.focus.draft;
  return (
    <li
      ref={row}
      data-thread={comment.id}
      className={cn(
        "group flex flex-col gap-3 border-b border-hairline py-4",
        comment.resolvedAt && "opacity-70",
        picked && "-mx-3 rounded-panel border-transparent bg-raised px-3",
      )}
    >
      <div className="flex items-center gap-2">
        {anchor ? (
          anchor.kind === "time" ? (
            <button
              type="button"
              onClick={() => onSeek(anchor.start)}
              className="tabular h-6 cursor-pointer rounded-chip border border-edge bg-transparent px-2 font-mono text-[11px] text-ink hover:border-signal"
              aria-label={`Play from ${anchorLabel(anchor)}`}
            >
              {anchorLabel(anchor)}
            </button>
          ) : anchor.kind === "region" && pages ? (
            <button
              type="button"
              onClick={() =>
                pages.onFocus({
                  ...(anchor.page !== undefined && { page: anchor.page }),
                  selected: picked ? null : comment.id,
                  draft: null,
                })
              }
              aria-pressed={picked}
              className={cn(
                "tabular flex h-6 cursor-pointer items-center gap-1.5 rounded-chip border bg-transparent px-2 font-mono text-[11px] text-ink hover:border-signal",
                picked ? "border-signal" : "border-edge",
              )}
              aria-label={`Show ${marker ? `thread ${marker.n}, ` : ""}${anchorLabel(anchor)}`}
            >
              {marker && <span className="text-signal">{marker.n}</span>}
              {anchorLabel(anchor)}
            </button>
          ) : (
            <span className="label">{formatAnchor(anchor)}</span>
          )
        ) : (
          <span className="label">Whole file</span>
        )}
        {anchor?.kind === "time" && onLoop && anchor.end - anchor.start >= MIN_LOOP && (
          <button
            type="button"
            onClick={() => onLoop({ start: anchor.start, end: anchor.end })}
            className="cursor-pointer border-0 bg-transparent p-0 text-xs text-ink-3 hover:text-ink"
            aria-label={`Loop ${anchorLabel(anchor)}`}
          >
            Loop
          </button>
        )}
        {carry ? (
          // A carried thread is settled by its status on this version.
          canTriage ? (
            <span className="ml-auto flex items-center gap-1">
              <select
                aria-label="Status on this version"
                value={carry.status}
                onChange={(e) => setCarry({ status: e.target.value as CarryStatus })}
                className="h-6 cursor-pointer rounded-chip border border-hairline bg-transparent px-1.5 text-xs text-ink-2 outline-none hover:border-edge focus:border-ink-3"
              >
                {carryStatuses.map((s) => (
                  <option key={s} value={s}>
                    {carryStatusLabel(s, here ?? 0)}
                  </option>
                ))}
              </select>
              <ActionMenu
                label="this thread"
                actions={[
                  ...(draft && pages
                    ? [
                        {
                          label: "Move to the drawn region",
                          onSelect: () => {
                            setCarry({
                              anchor: {
                                kind: "region",
                                ...(pages.paged && { page: pages.focus.page }),
                                ...draft,
                              },
                            });
                            pages.onFocus({ draft: null, selected: comment.id });
                          },
                        },
                      ]
                    : []),
                  ...(loop
                    ? [
                        {
                          label: "Move to the loop",
                          onSelect: () =>
                            setCarry({
                              anchor: { kind: "time", start: loop.start, end: loop.end },
                            }),
                        },
                      ]
                    : []),
                  {
                    label: carry.visible ? "Hide on this version" : "Show on this version",
                    onSelect: () => setCarry({ visible: !carry.visible }),
                  },
                ]}
              />
            </span>
          ) : (
            carry.status !== "open" && (
              <span className="ml-auto text-xs text-ink-3">
                {carryStatusLabel(carry.status, here ?? 0)}
              </span>
            )
          )
        ) : (
          <>
            {comment.resolvedAt && (
              <span className="text-xs text-ink-3">
                Resolved{comment.resolvedByName ? ` by ${comment.resolvedByName}` : ""}
              </span>
            )}
            {canTriage && (
              <button
                type="button"
                onClick={() =>
                  mutations.resolve.mutate({ id: comment.id, resolved: !comment.resolvedAt })
                }
                className={cn(textButton, "ml-auto")}
              >
                {comment.resolvedAt ? "Reopen" : "Resolve"}
              </button>
            )}
          </>
        )}
      </div>
      {path && (
        <p
          className="tabular m-0 -mt-1.5 text-[11px] text-ink-3"
          title="Versions this thread has been on"
        >
          {path}
        </p>
      )}
      <CommentBody comment={comment} own={canComment && comment.authorId === me} onEdit={edit} />
      {replies.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-3 border-l border-hairline p-0 pl-3">
          {replies.map((reply) => (
            <li key={reply.id}>
              <CommentBody
                comment={reply}
                own={canComment && reply.authorId === me}
                onEdit={edit}
              />
            </li>
          ))}
        </ul>
      )}
      {replying ? (
        <Composer
          placeholder="Reply"
          submitLabel="Reply"
          pending={mutations.create.isPending}
          onSubmit={async (body) => {
            await mutations.create.mutateAsync({ body, parentId: comment.id });
            setReplying(false);
          }}
          onCancel={() => setReplying(false)}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {!comment.resolvedAt && canComment && (
            <button type="button" onClick={() => setReplying(true)} className={textButton}>
              Reply
            </button>
          )}
          {carry && onBeforeAfter && from?.kind === "time" && anchor?.kind === "time" && (
            <button
              type="button"
              onClick={() =>
                onBeforeAfter({
                  fileId: carry.from.fileId,
                  shift: anchorShift(from, anchor),
                  loop: passageLoop(anchor),
                })
              }
              className={textButton}
            >
              Before and after
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Comment threads on one file. New comments on audio and video point at the playhead
 * when the reviewer starts writing; the time label on each thread plays from there.
 */
export function Comments({
  fileId,
  projectId,
  media,
  loop = null,
  onLoop,
  onBeforeAfter,
  pages,
}: {
  fileId: string;
  /** The file's project, whose role decides who may comment and resolve. */
  projectId: string;
  /** The player's media element, when the file plays. */
  media: HTMLMediaElement | null;
  /** The passage the player is looping: a new comment can point at it. */
  loop?: Loop | null;
  /** Loop a comment's passage in the player. */
  onLoop?: (loop: Loop) => void;
  /** Hear a carried thread's passage where it began, then here. */
  onBeforeAfter?: (target: BeforeAfter) => void;
  /** On a document or picture: the page shown and the region drawn on it. */
  pages?: PageComments;
}) {
  const { data, error } = useQuery(commentsQuery(fileId));
  const { guest } = useViewer();
  const can = useProjectCan(guest ? undefined : projectId);
  // A guest reviewer may comment on the files of their review when it allows, never triage.
  const { data: file } = useQuery(fileQuery(fileId));
  const canComment = guest ? Boolean(file?.grant?.comment) : can("comment");
  const canTriage = !guest && can("triage");
  const { data: me } = useQuery(meQuery);
  const mutations = useCommentMutations(fileId);
  /** The playhead when writing began; null for a whole-file comment. */
  const [at, setAt] = useState<number | null>(null);
  const [wholeFile, setWholeFile] = useState(false);
  /** With a loop set, new comments point at the looped passage unless told otherwise. */
  const [onPassage, setOnPassage] = useState(true);
  const [showResolved, setShowResolved] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  /** On a page: whether a new comment points at the region drawn, the page, or the file. */
  const [pageTarget, setPageTarget] = useState<"region" | "page" | "whole">("page");
  const draft = pages?.focus.draft ?? null;
  // Drawing a region is saying where the next comment goes.
  useEffect(() => {
    if (draft) setPageTarget("region");
  }, [draft]);
  /** What a new comment on a page points at, given what has been drawn. */
  const pageAim = pageTarget === "region" && !draft ? "page" : pageTarget;

  const seek = (seconds: number) => {
    if (!media) return;
    media.currentTime = seconds;
    void media.play().catch(() => undefined);
  };
  const capture = () => {
    if (media && at === null) setAt(Math.round(media.currentTime * 1000) / 1000);
  };
  /** The anchor for a new comment: the captured time, or the playhead as it is now. */
  const anchorNow = (): Anchor | null => {
    if (pages) {
      const page = pages.paged ? { page: pages.focus.page } : {};
      if (pageAim === "region" && draft) return { kind: "region", ...page, ...draft };
      // A picture is one page: the whole of it is the whole file.
      if (pageAim === "page" && pages.paged)
        return { kind: "region", ...page, x: 0, y: 0, width: 1, height: 1 };
      return null;
    }
    if (!media || wholeFile) return null;
    if (loop && onPassage) return { kind: "time", start: loop.start, end: loop.end };
    const start = at ?? Math.round(media.currentTime * 1000) / 1000;
    return { kind: "time", start, end: start };
  };

  const threads = data ? threadsOf(data) : { open: [], resolved: [], hidden: [] };
  const markers = data ? regionMarkers(data) : [];
  const view = (t: Thread) => (
    <ThreadView
      key={t.comment.id}
      thread={t}
      fileId={fileId}
      me={me?.user.id}
      onSeek={seek}
      onLoop={onLoop}
      loop={loop}
      onBeforeAfter={onBeforeAfter}
      mutations={mutations}
      canComment={canComment}
      canTriage={canTriage}
      marker={markers.find((m) => m.id === t.comment.id)}
      pages={pages}
    />
  );

  return (
    <section aria-label="Comments" className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between">
        <h2 className="m-0 text-[15px] font-medium">Comments</h2>
        <span className="tabular text-xs text-ink-3">
          {threads.open.length} open
          {threads.resolved.length > 0 && ` · ${threads.resolved.length} resolved`}
        </span>
      </div>
      {canComment && (
        <div onFocusCapture={capture}>
          <Composer
            placeholder={
              media
                ? "Comment at the playhead"
                : pages && pageAim === "region"
                  ? "Comment on the region"
                  : pages?.paged && pageAim === "page"
                    ? `Comment on page ${pages.focus.page}`
                    : "Comment on this file"
            }
            submitLabel="Comment"
            pending={mutations.create.isPending}
            onSubmit={async (body) => {
              await mutations.create.mutateAsync({ body, anchor: anchorNow() });
              setAt(null);
              setWholeFile(false);
              if (pages && pageAim === "region") {
                pages.onFocus({ draft: null });
                setPageTarget("page");
              }
            }}
          >
            {pages && (pages.paged || draft) && (
              <span className="flex items-center gap-1">
                {draft && (
                  <Target pressed={pageAim === "region"} onClick={() => setPageTarget("region")}>
                    Region
                  </Target>
                )}
                {pages.paged && (
                  <Target pressed={pageAim === "page"} onClick={() => setPageTarget("page")} mono>
                    P. {pages.focus.page}
                  </Target>
                )}
                <Target pressed={pageAim === "whole"} onClick={() => setPageTarget("whole")}>
                  Whole file
                </Target>
              </span>
            )}
            {media && (
              <span className="flex items-center gap-1">
                <button
                  type="button"
                  aria-pressed={!wholeFile && !(loop && onPassage)}
                  onClick={() => {
                    setWholeFile(false);
                    setOnPassage(false);
                    setAt(Math.round(media.currentTime * 1000) / 1000);
                  }}
                  className={cn(
                    "tabular h-6 cursor-pointer rounded-chip border px-2 font-mono text-[11px]",
                    !wholeFile && !(loop && onPassage)
                      ? "border-edge bg-raised text-ink"
                      : "border-transparent bg-transparent text-ink-3",
                  )}
                >
                  {at === null ? "At playhead" : anchorLabel({ kind: "time", start: at, end: at })}
                </button>
                {loop && (
                  <button
                    type="button"
                    aria-pressed={!wholeFile && onPassage}
                    onClick={() => {
                      setWholeFile(false);
                      setOnPassage(true);
                    }}
                    className={cn(
                      "tabular h-6 cursor-pointer rounded-chip border px-2 font-mono text-[11px]",
                      !wholeFile && onPassage
                        ? "border-edge bg-raised text-ink"
                        : "border-transparent bg-transparent text-ink-3",
                    )}
                  >
                    {anchorLabel({ kind: "time", start: loop.start, end: loop.end })}
                  </button>
                )}
                <button
                  type="button"
                  aria-pressed={wholeFile}
                  onClick={() => setWholeFile(true)}
                  className={cn(
                    "h-6 cursor-pointer rounded-chip border px-2 text-[11px]",
                    wholeFile
                      ? "border-edge bg-raised text-ink"
                      : "border-transparent bg-transparent text-ink-3",
                  )}
                >
                  Whole file
                </button>
              </span>
            )}
          </Composer>
        </div>
      )}
      {error && <p className="m-0 text-xs text-signal">{error.message}</p>}
      {data &&
        threads.open.length === 0 &&
        threads.resolved.length === 0 &&
        threads.hidden.length === 0 && (
          <p className="m-0 text-[13px] text-ink-3">No comments yet.</p>
        )}
      <ul className="m-0 flex list-none flex-col p-0">{threads.open.map(view)}</ul>
      {threads.resolved.length > 0 && (
        <div className="flex flex-col">
          <button
            type="button"
            onClick={() => setShowResolved((v) => !v)}
            aria-expanded={showResolved}
            className="w-fit cursor-pointer border-0 bg-transparent p-0 text-xs text-ink-3 hover:text-ink"
          >
            {showResolved ? "Hide" : "Show"} {threads.resolved.length} resolved
          </button>
          {showResolved && (
            <ul className="m-0 flex list-none flex-col p-0">{threads.resolved.map(view)}</ul>
          )}
        </div>
      )}
      {threads.hidden.length > 0 && (
        <div className="flex flex-col">
          <button
            type="button"
            onClick={() => setShowHidden((v) => !v)}
            aria-expanded={showHidden}
            className="w-fit cursor-pointer border-0 bg-transparent p-0 text-xs text-ink-3 hover:text-ink"
          >
            {showHidden ? "Hide" : "Show"} {threads.hidden.length} hidden on this version
          </button>
          {showHidden && (
            <ul className="m-0 flex list-none flex-col p-0">{threads.hidden.map(view)}</ul>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * Open threads that point at part of a page, numbered in reading order (page by page,
 * top to bottom) as the list shows them, for the viewer to mark and the list to label.
 */
export function regionMarkers(comments: Comment[]): RegionMarker[] {
  const markers: RegionMarker[] = [];
  for (const { comment } of threadsOf(comments).open) {
    const a = comment.anchor;
    if (a?.kind !== "region" || isWholePage(a)) continue;
    markers.push({
      id: comment.id,
      n: markers.length + 1,
      page: a.page,
      rect: { x: a.x, y: a.y, width: a.width, height: a.height },
    });
  }
  return markers;
}

/** The region markers of a file's open threads. */
export function useRegionMarkers(fileId: string): RegionMarker[] {
  const { data } = useQuery(commentsQuery(fileId));
  return data ? regionMarkers(data) : [];
}

/** Where open time-anchored threads start, for markers on the timeline. */
export function useCommentMarkers(fileId: string): number[] {
  const { data } = useQuery(commentsQuery(fileId));
  if (!data) return [];
  return [
    ...new Set(
      data
        .filter(
          (c) =>
            !c.parentId && !c.resolvedAt && c.carry?.visible !== false && c.anchor?.kind === "time",
        )
        .map((c) => (c.anchor?.kind === "time" ? c.anchor.start : 0)),
    ),
  ];
}
