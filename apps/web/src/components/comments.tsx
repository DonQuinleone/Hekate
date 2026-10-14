import { type Anchor, formatAnchor } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, type KeyboardEvent, useState } from "react";
import { cn } from "~/lib/cn";
import { ago, type Thread, threadsOf } from "~/lib/comments";
import { type Loop, MIN_LOOP } from "~/lib/loop";
import {
  type Comment,
  commentsQuery,
  meQuery,
  useCommentMutations,
  useProjectCan,
} from "~/lib/queries";
import { useViewer } from "~/lib/viewer";
import { Button } from "./ui/button";

/** Lowercase time labels read better inline than the upper-case anchor labels on markers. */
// "00:12.500" reads as "0:12.500", at either end of a range.
const anchorLabel = (anchor: Anchor) => formatAnchor(anchor).replace(/(^|\s)0(\d:)/g, "$1$2");

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
  me,
  onSeek,
  onLoop,
  mutations,
  canComment,
  canTriage,
}: {
  thread: Thread;
  me: string | undefined;
  onSeek: (seconds: number) => void;
  /** Loop a comment's passage, when it covers one. */
  onLoop?: (loop: Loop) => void;
  mutations: ReturnType<typeof useCommentMutations>;
  canComment: boolean;
  canTriage: boolean;
}) {
  const [replying, setReplying] = useState(false);
  const { comment, replies } = thread;
  const anchor = comment.anchor;
  const edit = (id: string, body: string) => mutations.edit.mutateAsync({ id, body });
  return (
    <li
      className={cn(
        "flex flex-col gap-3 border-b border-hairline py-4",
        comment.resolvedAt && "opacity-70",
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
            className="ml-auto cursor-pointer border-0 bg-transparent p-0 text-xs text-ink-3 hover:text-ink"
          >
            {comment.resolvedAt ? "Reopen" : "Resolve"}
          </button>
        )}
      </div>
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
        !comment.resolvedAt &&
        canComment && (
          <button
            type="button"
            onClick={() => setReplying(true)}
            className="w-fit cursor-pointer border-0 bg-transparent p-0 text-xs text-ink-3 hover:text-ink"
          >
            Reply
          </button>
        )
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
}) {
  const { data, error } = useQuery(commentsQuery(fileId));
  const { guest } = useViewer();
  const can = useProjectCan(guest ? undefined : projectId);
  // A guest reviewer may comment on the files of their review, never triage.
  const canComment = guest || can("comment");
  const canTriage = !guest && can("triage");
  const { data: me } = useQuery(meQuery);
  const mutations = useCommentMutations(fileId);
  /** The playhead when writing began; null for a whole-file comment. */
  const [at, setAt] = useState<number | null>(null);
  const [wholeFile, setWholeFile] = useState(false);
  /** With a loop set, new comments point at the looped passage unless told otherwise. */
  const [onPassage, setOnPassage] = useState(true);
  const [showResolved, setShowResolved] = useState(false);

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
    if (!media || wholeFile) return null;
    if (loop && onPassage) return { kind: "time", start: loop.start, end: loop.end };
    const start = at ?? Math.round(media.currentTime * 1000) / 1000;
    return { kind: "time", start, end: start };
  };

  const threads = data ? threadsOf(data) : { open: [], resolved: [] };

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
            placeholder={media ? "Comment at the playhead" : "Comment on this file"}
            submitLabel="Comment"
            pending={mutations.create.isPending}
            onSubmit={async (body) => {
              await mutations.create.mutateAsync({ body, anchor: anchorNow() });
              setAt(null);
              setWholeFile(false);
            }}
          >
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
      {data && threads.open.length === 0 && threads.resolved.length === 0 && (
        <p className="m-0 text-[13px] text-ink-3">No comments yet.</p>
      )}
      <ul className="m-0 flex list-none flex-col p-0">
        {threads.open.map((t) => (
          <ThreadView
            key={t.comment.id}
            thread={t}
            me={me?.user.id}
            onSeek={seek}
            onLoop={onLoop}
            mutations={mutations}
            canComment={canComment}
            canTriage={canTriage}
          />
        ))}
      </ul>
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
            <ul className="m-0 flex list-none flex-col p-0">
              {threads.resolved.map((t) => (
                <ThreadView
                  key={t.comment.id}
                  thread={t}
                  me={me?.user.id}
                  onSeek={seek}
                  onLoop={onLoop}
                  mutations={mutations}
                  canComment={canComment}
                  canTriage={canTriage}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/** Where open time-anchored threads start, for markers on the timeline. */
export function useCommentMarkers(fileId: string): number[] {
  const { data } = useQuery(commentsQuery(fileId));
  if (!data) return [];
  return [
    ...new Set(
      data
        .filter((c) => !c.parentId && !c.resolvedAt && c.anchor?.kind === "time")
        .map((c) => (c.anchor?.kind === "time" ? c.anchor.start : 0)),
    ),
  ];
}
