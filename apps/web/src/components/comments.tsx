import {
  type Anchor,
  anchorShift,
  anchorTime,
  type CarryStatus,
  COMMENT_ATTACHMENT_MAX_BYTES,
  COMMENT_ATTACHMENTS_MAX,
  type CommentMention,
  carryStatuses,
  carryStatusLabel,
  formatAnchor,
  formatBytes,
  mentionAt,
  mentionedIn,
  mentionRanges,
  parseBars,
  parseBeat,
  speakerOf,
  speakersOf,
  type TriageInput,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import {
  createContext,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "~/lib/cn";
import { ago, historyLabel, passageLoop, type Thread, threadsOf } from "~/lib/comments";
import { formatDates } from "~/lib/locale";
import { type Loop, MIN_LOOP } from "~/lib/loop";
import { isWholePage, type PageFocus } from "~/lib/pages";
import {
  type Comment,
  type CommentCategory,
  categoriesQuery,
  commentsQuery,
  fileQuery,
  mentionableQuery,
  meQuery,
  projectMembersQuery,
  useCommentMutations,
  usePreferences,
  useProjectCan,
} from "~/lib/queries";
import { useShortcuts } from "~/lib/shortcuts";
import { useViewer } from "~/lib/viewer";
import { Avatar } from "./avatar";
import type { RegionMarker } from "./document-viewer";
import { Icon } from "./icons";
import type { TimelineMarker } from "./player";
import { OtherTakes, SharedTakes } from "./takes";
import { Button } from "./ui/button";
import { Chip, ToggleChip } from "./ui/chip";
import { Dialog } from "./ui/dialog";
import { Field } from "./ui/field";
import { FileInput, Input, Select, Textarea } from "./ui/input";
import { ActionMenu, type MenuAction } from "./ui/menu";

const fullTime = formatDates({ dateStyle: "medium", timeStyle: "short" });

/** Lowercase time labels read better inline than the upper-case anchor labels on markers. */
// "00:12.500" reads as "0:12.500", at either end of a range.
export const anchorLabel = (anchor: Anchor) =>
  formatAnchor(anchor).replace(/(^|\s)0(\d:)/g, "$1$2");

const textButton =
  "inline-flex min-h-6 min-w-6 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-xs text-ink-3 hover:text-ink disabled:cursor-default disabled:opacity-40";

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
        mono && "tabular",
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

/** One chosen file, told apart from another. */
const fileKey = (f: File) => `${f.name}:${f.size}:${f.lastModified}`;

/** Whom a comment here may mention (#133): the project's people; none for a guest. */
const Mentionable = createContext<CommentMention[]>([]);

function Composer({
  placeholder,
  initial = "",
  initialMentions = [],
  attachable = false,
  submitLabel,
  pending,
  onSubmit,
  onAttach,
  onSaved,
  onCancel,
  children,
}: {
  placeholder: string;
  initial?: string;
  initialMentions?: CommentMention[];
  /** Files may go with it (#133): chosen here, sent once the comment is saved. */
  attachable?: boolean;
  submitLabel: string;
  pending: boolean;
  /**
   * The text and the members it mentions as the picker chose them; for an attachable comment,
   * resolves to the comment saved, which the files are then attached to.
   */
  onSubmit: (body: string, mentions: string[]) => Promise<string | undefined>;
  /** Attaches one chosen file to the comment saved. */
  onAttach?: (commentId: string, file: File) => Promise<unknown>;
  /** Once the comment and all its files are saved. */
  onSaved?: () => void;
  onCancel?: () => void;
  children?: React.ReactNode;
}) {
  const people = useContext(Mentionable);
  const [body, setBody] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<CommentMention[]>(initialMentions);
  const [files, setFiles] = useState<File[]>([]);
  // Busy from saving the comment until its last file is attached.
  const [sending, setSending] = useState(false);
  // A comment saved whose files did not all attach: trying again attaches the rest to it.
  const [saved, setSaved] = useState<string | null>(null);
  const chooser = useRef<HTMLInputElement>(null);
  /** Files chosen, within what a comment may carry; anything past it is said, not taken. */
  const choose = (picked: File[]) => {
    const fits = picked.filter(
      (f) =>
        f.size > 0 &&
        f.size <= COMMENT_ATTACHMENT_MAX_BYTES &&
        // The same file chosen twice goes once.
        !files.some((g) => fileKey(g) === fileKey(f)),
    );
    const next = [...files, ...fits].slice(0, COMMENT_ATTACHMENTS_MAX);
    setFiles(next);
    setError(
      fits.length < picked.length
        ? "A file can be at most 25 MB"
        : files.length + fits.length > COMMENT_ATTACHMENTS_MAX
          ? `A comment can carry at most ${COMMENT_ATTACHMENTS_MAX} files`
          : null,
    );
  };
  /** The mention being typed at the caret, and the person highlighted in the list. */
  const [typing, setTyping] = useState<{ start: number; query: string } | null>(null);
  const [index, setIndex] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const offered = typing
    ? people.filter((p) => p.name.toLowerCase().includes(typing.query.toLowerCase())).slice(0, 6)
    : [];
  const write = (text: string, caret: number) => {
    setBody(text);
    setTyping(people.length > 0 ? mentionAt(text, caret) : null);
    setIndex(0);
  };
  const pick = (person: CommentMention) => {
    const el = area.current;
    if (!typing || !el) return;
    const caret = el.selectionStart;
    const text = `${body.slice(0, typing.start)}@${person.name} ${body.slice(caret)}`;
    const at = typing.start + person.name.length + 2;
    setBody(text);
    setChosen((c) => (c.some((x) => x.id === person.id) ? c : [...c, person]));
    setTyping(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(at, at);
    });
  };
  /** "@ Mention": an @ at the caret, as if typed, to open the list. */
  const startMention = () => {
    const el = area.current;
    if (!el) return;
    const caret = el.selectionStart;
    const space = caret > 0 && !/\s/.test(body[caret - 1] ?? "") ? " " : "";
    const text = `${body.slice(0, caret)}${space}@${body.slice(caret)}`;
    const at = caret + space.length + 1;
    write(text, at);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(at, at);
    });
  };
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!body.trim() || sending) return;
    setSending(true);
    let id: string | null | undefined = saved;
    try {
      // Only those still named in the text: a mention deleted while writing is gone.
      id =
        saved ??
        (await onSubmit(
          body,
          mentionedIn(body, chosen).map((p) => p.id),
        ));
      if (id && onAttach && files.length > 0) {
        setSaved(id);
        // One at a time, each let go of once it is attached, so trying again sends only the rest.
        for (const file of files) {
          await onAttach(id, file);
          setFiles((list) => list.filter((f) => f !== file));
        }
      }
      setBody("");
      setChosen([]);
      setFiles([]);
      setSaved(null);
      setError(null);
      onSaved?.();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Could not save the comment";
      setError(id ? `The comment is saved. ${message}` : message);
    } finally {
      setSending(false);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Space, K and the arrows belong to the text here, not the player.
    event.stopPropagation();
    if (offered.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setIndex((i) => (i + step + offered.length) % offered.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const person = offered[index];
        if (person) pick(person);
        return;
      }
      if (event.key === "Escape") {
        setTyping(null);
        return;
      }
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void submit();
    if (event.key === "Escape") onCancel?.();
  };
  const open = offered.length > 0;
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <div className="relative">
        <Textarea
          ref={area}
          value={body}
          onChange={(e) => write(e.target.value, e.target.selectionStart)}
          onKeyDown={onKeyDown}
          onBlur={() => setTyping(null)}
          placeholder={placeholder}
          rows={3}
          aria-label={placeholder}
          aria-autocomplete={people.length > 0 ? "list" : undefined}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={open ? `${listId}-${index}` : undefined}
          className="min-h-20 text-[13px]"
        />
        {open && (
          <div
            id={listId}
            role="listbox"
            aria-label="People to mention"
            // It floats over the composer's fields, as a menu does.
            data-e2e-overlap
            className="absolute inset-x-0 top-full z-20 mt-1 flex flex-col gap-0.5 rounded-panel border border-line bg-raised p-1 shadow-2"
          >
            {offered.map((person, i) => (
              <div
                key={person.id}
                id={`${listId}-${i}`}
                role="option"
                tabIndex={-1}
                aria-selected={i === index}
                // Picked before the text loses focus, so the list is still there to pick from.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(person);
                }}
                onKeyDown={() => undefined}
                onPointerMove={() => setIndex(i)}
                className={cn(
                  "flex h-8 cursor-pointer items-center gap-2 rounded-control px-2 text-[13px]",
                  i === index ? "bg-ground/60 text-ink" : "text-ink-2",
                )}
              >
                <Avatar id={person.id} name={person.name} size={18} />
                <span className="truncate">{person.name}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {files.length > 0 && (
        <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="Files to attach">
          {files.map((f) => (
            <li key={fileKey(f)}>
              <Chip className="h-6 gap-1 text-[12px] text-ink-2">
                <Icon name="link" size={11} />
                <span className="max-w-48 truncate">{f.name}</span>
                <span className="text-ink-3">{formatBytes(f.size)}</span>
                <Button
                  size="iconSm"
                  variant="quiet"
                  className="-mr-1 size-5"
                  aria-label={`Leave out ${f.name}`}
                  onClick={() => setFiles(files.filter((g) => fileKey(g) !== fileKey(f)))}
                >
                  <Icon name="close" size={11} />
                </Button>
              </Chip>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="m-0 text-xs text-signal">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        {children}
        {attachable && (
          <>
            <FileInput
              ref={chooser}
              multiple
              aria-label="Files to attach"
              onChange={(e) => {
                choose([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
            <Button
              size="sm"
              variant="ghost"
              disabled={files.length >= COMMENT_ATTACHMENTS_MAX}
              onClick={() => chooser.current?.click()}
            >
              <Icon name="link" size={12} />
              Attach
            </Button>
          </>
        )}
        {people.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onMouseDown={(e) => e.preventDefault()}
            onClick={startMention}
          >
            @ Mention
          </Button>
        )}
        <span className="ml-auto flex gap-2">
          {onCancel && (
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button
            size="sm"
            variant="primary"
            type="submit"
            disabled={pending || sending || !body.trim()}
          >
            {saved ? "Attach the rest" : submitLabel}
          </Button>
        </span>
      </div>
    </form>
  );
}

/** A comment's words, with the people it mentions set apart (#133). */
function Words({ comment }: { comment: Comment }) {
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const r of mentionRanges(comment.body, comment.mentions)) {
    if (r.start > at) parts.push(comment.body.slice(at, r.start));
    parts.push(
      <span key={r.start} className="font-medium text-ink">
        {comment.body.slice(r.start, r.end)}
      </span>,
    );
    at = r.end;
  }
  parts.push(comment.body.slice(at));
  return (
    <p className="m-0 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-2">
      {parts}
    </p>
  );
}

function CommentBody({
  comment,
  own,
  editable,
  onEdit,
  onDownload,
  onRemove,
}: {
  comment: Comment;
  /** Written by the viewer, member or guest: they may take their own files off it. */
  own: boolean;
  /** They may change its words, which a guest may not. */
  editable: boolean;
  onEdit: (id: string, body: string, mentions: string[]) => Promise<unknown>;
  /** A one-time download of one of its files, made for this person (#133). */
  onDownload: (attachmentId: string) => void;
  /** Taking one of your own files off it. */
  onRemove: (attachmentId: string) => void;
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
        <span className="text-ink-3" title={fullTime.format(new Date(comment.createdAt))}>
          {ago(comment.createdAt)}
          {comment.editedAt && " · edited"}
        </span>
        {comment.importedFrom && (
          <span
            className="min-w-0 truncate text-ink-3"
            title={`Imported from ${comment.importedFrom}${comment.importedByName ? ` by ${comment.importedByName}` : ""}`}
          >
            from {comment.importedFrom}
          </span>
        )}
        {editable && !editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="ml-auto inline-flex min-h-6 min-w-6 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-xs text-ink-3 hover:text-ink"
          >
            Edit
          </button>
        )}
      </div>
      {editing ? (
        <Composer
          placeholder="Edit comment"
          initial={comment.body}
          initialMentions={comment.mentions}
          submitLabel="Save"
          pending={false}
          onSubmit={async (body, mentions) => {
            await onEdit(comment.id, body, mentions);
            setEditing(false);
            return undefined;
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <Words comment={comment} />
      )}
      {comment.attachments.length > 0 && (
        <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="Attached files">
          {comment.attachments.map((a) => (
            <li key={a.id} className="flex items-center">
              <Button
                size="sm"
                variant="secondary"
                className="h-7 max-w-full gap-1.5 text-[12px]"
                aria-label={`Download ${a.name}`}
                onClick={() => onDownload(a.id)}
              >
                <Icon name="download" size={12} />
                <span className="max-w-48 truncate">{a.name}</span>
                <span className="text-ink-3">{formatBytes(a.byteSize)}</span>
              </Button>
              {own && (
                <Button
                  size="iconSm"
                  variant="quiet"
                  aria-label={`Remove ${a.name}`}
                  onClick={() => onRemove(a.id)}
                >
                  <Icon name="close" size={12} />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Defer a thread to a stage: one the project's categories name, or another. */
export function DeferDialog({
  stages,
  onDefer,
  onClose,
}: {
  stages: string[];
  onDefer: (stage: string) => void;
  onClose: () => void;
}) {
  const [stage, setStage] = useState(stages[0] ?? "");
  return (
    <Dialog
      title="Defer to a stage"
      description="It leaves this round's list, stays open, and comes back for that stage."
      onClose={onClose}
      width="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!stage.trim()} onClick={() => onDefer(stage.trim())}>
            Defer
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {stages.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {stages.map((s) => (
              <ToggleChip key={s} pressed={stage === s} onClick={() => setStage(s)}>
                {s}
              </ToggleChip>
            ))}
          </div>
        )}
        <Field label="Stage">
          <Input value={stage} maxLength={80} onChange={(e) => setStage(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}

/** Assign a thread to someone in the project, or to no one. */
export function AssignDialog({
  people,
  current,
  onAssign,
  onClose,
}: {
  people: { id: string; name: string }[];
  current: string | null;
  onAssign: (id: string | null) => void;
  onClose: () => void;
}) {
  const [who, setWho] = useState(current ?? "");
  return (
    <Dialog
      title="Assign"
      description="Who is to act on it. Send them their list once triage is done."
      onClose={onClose}
      width="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => onAssign(who || null)}>
            {who ? "Assign" : "Unassign"}
          </Button>
        </>
      }
    >
      <Field label="To">
        <Select value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="">No one</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </Field>
    </Dialog>
  );
}

function ThreadView({
  thread,
  fileId,
  me,
  guest,
  onSeek,
  onLoop,
  loop,
  onBeforeAfter,
  mutations,
  canComment,
  canTriage,
  categories,
  people,
  marker,
  pages,
  takesOf,
  channelNames = [],
}: {
  thread: Thread;
  /** The file being looked at, which a carried thread was brought to. */
  fileId: string;
  me: string | undefined;
  /** A guest reviewer is looking: they may not change a comment's words. */
  guest: boolean;
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
  /** The project's categories, to name a thread's kind and to choose one. */
  categories: CommentCategory[];
  /** Who a thread can be assigned to: the project's members. */
  people: { id: string; name: string }[];
  /** The thread's number on the page, when it points at a region of it. */
  marker?: RegionMarker;
  pages?: PageComments;
  /** The track whose takes a thread on a bar can list (#46), for those who may see takes. */
  takesOf?: string;
  /** The recording's speakers, to name the channel a thread is about (#74). */
  channelNames?: readonly string[];
}) {
  const [replying, setReplying] = useState(false);
  const [takesOpen, setTakesOpen] = useState(false);
  const [asking, setAsking] = useState<"defer" | "assign" | null>(null);
  const { comment, replies } = thread;
  const anchor = comment.anchor;
  const carry = comment.carry;
  /** This version's number, for "Fixed in V3". */
  const here = comment.history?.hops.find((h) => h.fileId === fileId)?.versionNumber;
  const path = historyLabel(comment.history);
  const from = carry?.from.anchor;
  const setCarry = (change: { status?: CarryStatus; visible?: boolean; anchor?: Anchor | null }) =>
    carry && mutations.carry.mutate({ id: carry.id, ...change });
  const edit = (id: string, body: string, mentions: string[]) =>
    mutations.edit.mutateAsync({ id, body, mentions });
  const download = (attachmentId: string) => mutations.download.mutate(attachmentId);
  const remove = (attachmentId: string) => mutations.detach.mutate(attachmentId);
  const picked = pages?.focus.selected === comment.id;
  const row = useRef<HTMLLIElement>(null);
  // Picked on the page, the thread comes into view here.
  useEffect(() => {
    if (picked) row.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [picked]);
  /** The region drawn on the page, which a carried thread can be moved to. */
  const draft = pages?.focus.draft;
  const category = categories.find((c) => c.id === comment.categoryId);
  const triage = (change: Omit<TriageInput, "commentIds">) =>
    mutations.triage.mutate({ commentIds: [comment.id], ...change });
  // Triage (#36): its kind, deferring it to a stage or back, and who is to act on it.
  const triageActions: (MenuAction | "divider")[] = canTriage
    ? [
        ...categories.map((c) => ({
          label: `Mark as ${c.name}`,
          checked: c.id === comment.categoryId,
          onSelect: () => triage({ categoryId: c.id === comment.categoryId ? null : c.id }),
        })),
        "divider",
        comment.deferredTo
          ? { label: "Undefer", onSelect: () => triage({ deferredTo: null }) }
          : { label: "Defer to a stage…", onSelect: () => setAsking("defer") },
        { label: "Assign to…", onSelect: () => setAsking("assign") },
        comment.todo
          ? {
              label: "Not a task",
              onSelect: () => mutations.todo.mutate({ id: comment.id, todo: false }),
            }
          : {
              label: "Make a task",
              onSelect: () => mutations.todo.mutate({ id: comment.id, todo: true }),
            },
      ]
    : [];
  /** A task is done by triage, or by whoever it is for. */
  const mayFinish = canTriage || (!!me && comment.assigneeId === me);
  const doneWords = comment.todoDoneAt
    ? `done${comment.todoDoneByName ? ` by ${comment.todoDoneByName}` : ""}`
    : "to do";
  return (
    <li
      ref={row}
      data-thread={comment.id}
      className={cn(
        "group flex flex-col gap-3 border-b border-hairline py-row-loose",
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
              className="tabular h-6 cursor-pointer rounded-chip border border-edge bg-transparent px-2 text-[11px] text-ink hover:border-signal"
              aria-label={`Play from ${anchorLabel(anchor)}`}
            >
              {anchorLabel(anchor)}
            </button>
          ) : anchor.kind === "bar" && anchor.at !== undefined ? (
            <button
              type="button"
              onClick={() => onSeek(anchor.at ?? 0)}
              className="tabular h-6 cursor-pointer rounded-chip border border-edge bg-transparent px-2 text-[11px] text-ink hover:border-signal"
              aria-label={`Play ${anchorLabel(anchor).toLowerCase()} from ${anchorLabel({ kind: "time", start: anchor.at, end: anchor.at })}`}
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
                "tabular flex h-6 cursor-pointer items-center gap-1.5 rounded-chip border bg-transparent px-2 text-[11px] text-ink hover:border-signal",
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
            className="inline-flex min-h-6 min-w-6 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-xs text-ink-3 hover:text-ink"
            aria-label={`Loop ${anchorLabel(anchor)}`}
          >
            Loop
          </button>
        )}
        {carry ? (
          // A carried thread is settled by its status on this version.
          canTriage ? (
            <span className="ml-auto flex items-center gap-1">
              <Select
                size="sm"
                aria-label="Status on this version"
                value={carry.status}
                onChange={(e) => setCarry({ status: e.target.value as CarryStatus })}
                className="w-auto"
              >
                {carryStatuses.map((s) => (
                  <option key={s} value={s}>
                    {carryStatusLabel(s, here ?? 0)}
                  </option>
                ))}
              </Select>
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
                  ...(triageActions.length > 0 ? ["divider" as const, ...triageActions] : []),
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
            {canTriage && <ActionMenu label="this thread" actions={triageActions} />}
          </>
        )}
      </div>
      {(category ||
        comment.channel !== null ||
        comment.deferredTo ||
        comment.assigneeName ||
        comment.todo) && (
        <p className="m-0 -mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-3">
          {comment.channel !== null && (
            <Chip title="The channel it is about">{speakerOf(channelNames, comment.channel)}</Chip>
          )}
          {category && <Chip>{category.name}</Chip>}
          {comment.todo &&
            (mayFinish ? (
              <ToggleChip
                pressed={!!comment.todoDoneAt}
                aria-label={comment.todoDoneAt ? "Done; mark as to do" : "To do; mark as done"}
                onClick={() =>
                  mutations.todo.mutate({ id: comment.id, todo: true, done: !comment.todoDoneAt })
                }
                className={cn(
                  "h-6 px-2 text-[11px]",
                  comment.todoDoneAt ? "text-ink-3 line-through" : "border-signal/50 text-signal",
                )}
              >
                {doneWords}
              </ToggleChip>
            ) : (
              <Chip
                className={cn(comment.todoDoneAt ? "line-through" : "border-signal/50 text-signal")}
              >
                {doneWords}
              </Chip>
            ))}
          {comment.deferredTo && <span>deferred to {comment.deferredTo}</span>}
          {comment.assigneeName && <span>for {comment.assigneeName}</span>}
        </p>
      )}
      {asking === "defer" && (
        <DeferDialog
          stages={[...new Set(categories.flatMap((c) => (c.stage ? [c.stage] : [])))]}
          onDefer={(stage) => {
            triage({ deferredTo: stage });
            setAsking(null);
          }}
          onClose={() => setAsking(null)}
        />
      )}
      {asking === "assign" && (
        <AssignDialog
          people={people}
          current={comment.assigneeId}
          onAssign={(id) => {
            triage({ assigneeId: id });
            setAsking(null);
          }}
          onClose={() => setAsking(null)}
        />
      )}
      {path && (
        <p
          className="tabular m-0 -mt-1.5 text-[11px] text-ink-3"
          title="Versions this thread has been on"
        >
          {path}
        </p>
      )}
      <CommentBody
        comment={comment}
        own={canComment && comment.mine}
        editable={canComment && comment.mine && !guest}
        onEdit={edit}
        onDownload={download}
        onRemove={remove}
      />
      {comment.takes.length > 0 && (
        <SharedTakes
          takes={comment.takes}
          bar={anchor?.kind === "bar" ? anchor.from.bar : undefined}
          guest={guest}
          onUnshare={
            canTriage && takesOf
              ? (takeId) => mutations.unshareTake.mutate({ commentId: comment.id, takeId })
              : undefined
          }
        />
      )}
      {replies.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-3 border-l border-hairline p-0 pl-3">
          {replies.map((reply) => (
            <li key={reply.id}>
              <CommentBody
                comment={reply}
                own={canComment && reply.mine}
                editable={canComment && reply.mine && !guest}
                onEdit={edit}
                onDownload={download}
                onRemove={remove}
              />
            </li>
          ))}
        </ul>
      )}
      {takesOpen && takesOf && anchor?.kind === "bar" && (
        <OtherTakes
          trackId={takesOf}
          bar={anchor.from.bar}
          onClose={() => setTakesOpen(false)}
          share={
            canTriage
              ? {
                  shared: comment.takes.map((t) => t.id),
                  onShare: (takeIds) =>
                    mutations.shareTakes.mutateAsync({ commentId: comment.id, takeIds }),
                }
              : undefined
          }
        />
      )}
      {replying ? (
        <Composer
          placeholder="Reply"
          submitLabel="Reply"
          pending={mutations.create.isPending}
          attachable
          onSubmit={async (body, mentions) => {
            const { comment: made } = await mutations.create.mutateAsync({
              body,
              parentId: comment.id,
              mentions,
            });
            return made.id;
          }}
          onAttach={(commentId, file) => mutations.attach.mutateAsync({ commentId, file })}
          onSaved={() => setReplying(false)}
          onCancel={() => setReplying(false)}
        />
      ) : (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {!comment.resolvedAt && canComment && (
            <button type="button" onClick={() => setReplying(true)} className={textButton}>
              Reply
            </button>
          )}
          {takesOf && anchor?.kind === "bar" && (
            <button
              type="button"
              aria-expanded={takesOpen}
              onClick={() => setTakesOpen((open) => !open)}
              className={textButton}
            >
              Other takes
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
  seed,
  tools,
}: {
  /** A comment begun elsewhere (from a finding, #43): at its moment, starting with its words. */
  seed?: CommentSeed;
  /** Controls for the panel itself, in its header: where it sits (#15). */
  tools?: ReactNode;
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
  // A thread on a bar of a track's version can list the track's takes of that bar (#46).
  const takesOf = !guest && can("view_takes") ? file?.variation?.trackId : undefined;
  const { data: me } = useQuery(meQuery);
  const mutations = useCommentMutations(fileId);
  // Categories name each thread's kind for members; whom to assign to, for those who triage.
  const { data: categories = [] } = useQuery({
    ...categoriesQuery(projectId),
    enabled: !guest,
  });
  const { data: members = [] } = useQuery({
    ...projectMembersQuery(projectId),
    enabled: canTriage,
  });
  const people = members.map((m) => ({ id: m.userId, name: m.name }));
  // Whom a member writing here may mention: the project's people (#133).
  const { data: mentionable = [] } = useQuery({
    ...mentionableQuery(fileId),
    enabled: canComment && !guest,
  });
  const [onlyCategory, setOnlyCategory] = useState<string | null>(null);
  const [showDeferred, setShowDeferred] = useState(false);
  /** The playhead when writing began; null for a whole-file comment. */
  const [at, setAt] = useState<number | null>(null);
  const [wholeFile, setWholeFile] = useState(false);
  /**
   * Those who triage give a new thread its category as they write it, as the prototype's
   * composer offers (#43): a finding turned into a comment is filed at once.
   */
  const [categoryId, setCategoryId] = useState("");
  const categoryOffered = canTriage && categories.length > 0;
  /** A recording's speakers (#74): a new thread can be about one of them. */
  const audio = file?.mediaInfo?.audio;
  const channelNames = useMemo(
    () => (audio && audio.channels >= 2 ? speakersOf(audio) : []),
    [audio],
  );
  const [channel, setChannel] = useState("");
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
  /** Bars, typed by the reviewer: in music projects, on a recording or a score. */
  const preferences = usePreferences();
  const [bars, setBars] = useState("");
  const barsId = useId();
  /** What the project lets a comment name as read from the score (#240). */
  const references = file?.references;
  const offersBars =
    file !== undefined &&
    references?.bar === true &&
    (file.kind === "audio" || file.kind === "video" || file.kind === "document");
  /** Bars typed are the comment's target: one target at a time, so the others step aside. */
  const barsOn = offersBars && bars.trim() !== "";
  /**
   * The score's page, typed beside the bars on a recording; on a score it is the page shown.
   * Only where the project takes page references.
   */
  const [scorePage, setScorePage] = useState("");
  const scorePageId = useId();
  /** A beat within the bar, in a field of its own, where the project takes beats. */
  const [beat, setBeat] = useState("");
  const beatId = useId();
  const offersBeat = offersBars && references?.beat === true;
  const typedBeat = offersBeat && beat.trim() !== "" ? parseBeat(beat) : undefined;
  const offersPage = offersBars && references?.page === true && !pages;
  const typedPage = offersPage && scorePage.trim() !== "" ? Number(scorePage) : undefined;
  const pageValid =
    typedPage === undefined ||
    (Number.isInteger(typedPage) && typedPage >= 1 && typedPage <= 100_000);

  const seek = (seconds: number) => {
    if (!media) return;
    // A moment heard from a little before it, as the member chose.
    media.currentTime = Math.max(0, seconds - preferences.preRoll);
    void media.play().catch(() => undefined);
  };
  const capture = () => {
    if (media && at === null) setAt(Math.round(media.currentTime * 1000) / 1000);
  };
  /** The anchor for a new comment: the captured time, or the playhead as it is now. */
  const anchorNow = (): Anchor | null => {
    // Bars typed: the comment points at them, and plays from the moment they were named.
    // A page or a beat names a place only with its bar.
    if (!barsOn && ((offersPage && scorePage.trim()) || (offersBeat && beat.trim())))
      throw new Error("Write the bar the page or beat belongs to");
    if (barsOn) {
      const named = parseBars(bars, { beats: references?.beat });
      if (!named)
        throw new Error(
          references?.beat
            ? "Write a bar, such as 25, a beat, such as 25.3, or bars, such as 9-12"
            : "Write a bar, such as 25, or bars, such as 9-12",
        );
      if (!pageValid) throw new Error("Write the page as a number, such as 3");
      if (typedBeat === null) throw new Error("Write the beat as a number from 1 to 32");
      if (typedBeat !== undefined) {
        if (named.to && named.to.bar !== named.from.bar)
          throw new Error("A beat belongs to one bar, not a range");
        named.from.beat = typedBeat;
      }
      const moment = media ? (at ?? Math.round(media.currentTime * 1000) / 1000) : undefined;
      // On a score, the bars are on the page shown; on a recording, the page typed.
      const page = references?.page && pages?.paged ? pages.focus.page : typedPage;
      return {
        kind: "bar",
        ...named,
        ...(page === undefined ? {} : { page }),
        ...(moment === undefined ? {} : { at: moment }),
      };
    }
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

  // "c" starts a comment at the playhead, pausing so the moment holds while you write.
  const composer = useRef<HTMLDivElement>(null);
  const [sheet, setSheet] = useState(false);
  // A comment begun from a finding points at its moment, with the composer open.
  // biome-ignore lint/correctness/useExhaustiveDependencies: each seed once, by its key.
  useEffect(() => {
    if (!seed) return;
    setAt(seed.at);
    // A finding on one channel begins a comment about that channel (#74).
    setChannel(seed.channel == null ? "" : String(seed.channel));
    // A finding about the whole file begins a comment about the whole file.
    setWholeFile(seed.at === null);
    setOnPassage(false);
    setBars("");
    // On a phone the composer is a sheet: open it; elsewhere it is already in view.
    if (composer.current?.offsetParent === null) setSheet(true);
  }, [seed?.key]);
  const sheetBody = useRef<HTMLDivElement>(null);
  // The sheet is opened to write in: its text box takes focus.
  useEffect(() => {
    if (sheet) sheetBody.current?.querySelector("textarea")?.focus({ preventScroll: true });
  }, [sheet]);
  useShortcuts(
    "comments",
    "Comments",
    [
      {
        keys: ["c"],
        label: "Comment at the playhead",
        run: () => {
          media?.pause();
          // On a phone the inline composer is hidden: the sheet opens instead.
          const inline = composer.current;
          if (inline && inline.offsetParent !== null) inline.querySelector("textarea")?.focus();
          else {
            capture();
            setSheet(true);
          }
        },
      },
    ],
    Boolean(media && canComment),
  );

  const composerLabel = media
    ? "Comment at the playhead"
    : pages && pageAim === "region"
      ? "Comment on the region"
      : pages?.paged && pageAim === "page"
        ? `Comment on page ${pages.focus.page}`
        : "Comment on this file";
  const composerBody = (
    <Composer
      // A comment begun from a finding starts with its words; a new one starts empty.
      key={seed?.key ?? 0}
      initial={seed?.body ?? ""}
      placeholder={composerLabel}
      submitLabel="Comment"
      pending={mutations.create.isPending}
      attachable
      onSubmit={async (body, mentions) => {
        const { comment: made } = await mutations.create.mutateAsync({
          body,
          anchor: anchorNow(),
          mentions,
          ...(categoryOffered && categoryId ? { categoryId } : {}),
          ...(channel !== "" ? { channel: Number(channel) } : {}),
        });
        return made.id;
      }}
      onAttach={(commentId, file) => mutations.attach.mutateAsync({ commentId, file })}
      onSaved={() => {
        setAt(null);
        setWholeFile(false);
        setCategoryId("");
        setChannel("");
        setSheet(false);
        setBars("");
        setScorePage("");
        setBeat("");
        // Each document comment starts again from the page shown.
        if (pages) {
          if (pageAim === "region") pages.onFocus({ draft: null });
          setPageTarget("page");
        }
      }}
    >
      {pages && (pages.paged || draft) && (
        <span className="flex items-center gap-1">
          {draft && (
            <Target
              pressed={!barsOn && pageAim === "region"}
              onClick={() => {
                setBars("");
                setPageTarget("region");
              }}
            >
              Region
            </Target>
          )}
          {pages.paged && (
            <Target
              pressed={!barsOn && pageAim === "page"}
              onClick={() => {
                setBars("");
                setPageTarget("page");
              }}
              mono
            >
              P. {pages.focus.page}
            </Target>
          )}
          <Target
            pressed={!barsOn && pageAim === "whole"}
            onClick={() => {
              setBars("");
              setPageTarget("whole");
            }}
          >
            Whole file
          </Target>
        </span>
      )}
      {offersPage && (
        <span className="flex items-center gap-1.5">
          <label htmlFor={scorePageId} className="label">
            Page
          </label>
          <Input
            size="sm"
            id={scorePageId}
            value={scorePage}
            onChange={(e) => setScorePage(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="3"
            inputMode="numeric"
            aria-invalid={!pageValid}
            className="tabular w-14"
          />
        </span>
      )}
      {offersBars && (
        <span className="flex items-center gap-1.5">
          <label htmlFor={barsId} className="label">
            Bar
          </label>
          <Input
            size="sm"
            id={barsId}
            value={bars}
            onChange={(e) => setBars(e.target.value)}
            // Space and the arrows belong to the field here, not the player.
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="25 or 9-12"
            inputMode="decimal"
            aria-invalid={
              bars.trim() !== "" && parseBars(bars, { beats: references?.beat }) === null
            }
            className="tabular w-24"
          />
        </span>
      )}
      {offersBeat && (
        <span className="flex items-center gap-1.5">
          <label htmlFor={beatId} className="label">
            Beat
          </label>
          <Input
            size="sm"
            id={beatId}
            value={beat}
            onChange={(e) => setBeat(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="3"
            inputMode="decimal"
            aria-invalid={typedBeat === null}
            className="tabular w-14"
          />
        </span>
      )}
      {media && (
        <span className="flex items-center gap-1">
          <button
            type="button"
            aria-pressed={!barsOn && !wholeFile && !(loop && onPassage)}
            onClick={() => {
              setBars("");
              setWholeFile(false);
              setOnPassage(false);
              setAt(Math.round(media.currentTime * 1000) / 1000);
            }}
            className={cn(
              "tabular h-6 cursor-pointer rounded-chip border px-2 text-[11px]",
              !barsOn && !wholeFile && !(loop && onPassage)
                ? "border-edge bg-raised text-ink"
                : "border-transparent bg-transparent text-ink-3",
            )}
          >
            {at === null ? "At playhead" : anchorLabel({ kind: "time", start: at, end: at })}
          </button>
          {loop && (
            <button
              type="button"
              aria-pressed={!barsOn && !wholeFile && onPassage}
              onClick={() => {
                setBars("");
                setWholeFile(false);
                setOnPassage(true);
              }}
              className={cn(
                "tabular h-6 cursor-pointer rounded-chip border px-2 text-[11px]",
                !barsOn && !wholeFile && onPassage
                  ? "border-edge bg-raised text-ink"
                  : "border-transparent bg-transparent text-ink-3",
              )}
            >
              {anchorLabel({ kind: "time", start: loop.start, end: loop.end })}
            </button>
          )}
          <button
            type="button"
            aria-pressed={!barsOn && wholeFile}
            onClick={() => {
              setBars("");
              setWholeFile(true);
            }}
            className={cn(
              "h-6 cursor-pointer rounded-chip border px-2 text-[11px]",
              !barsOn && wholeFile
                ? "border-edge bg-raised text-ink"
                : "border-transparent bg-transparent text-ink-3",
            )}
          >
            Whole file
          </button>
        </span>
      )}
      {channelNames.length > 0 && (
        <Select
          size="sm"
          aria-label="Channel"
          value={channel}
          onChange={(e) => setChannel(e.target.value)}
          className="w-auto"
        >
          <option value="">Every channel</option>
          {channelNames.map((name, i) => (
            <option key={`${name}-${String(i)}`} value={String(i)}>
              {speakerOf(channelNames, i)}
            </option>
          ))}
        </Select>
      )}
      {categoryOffered && (
        <Select
          size="sm"
          aria-label="Category"
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          className="w-auto max-w-40"
        >
          <option value="">No category</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      )}
    </Composer>
  );

  const threads = data ? threadsOf(data) : { open: [], deferred: [], resolved: [], hidden: [] };
  // Filtering by category, once more than one is in use (#36).
  const used = categories.filter((c) =>
    [...threads.open, ...threads.deferred].some((t) => t.comment.categoryId === c.id),
  );
  const inCategory = (t: Thread) => !onlyCategory || t.comment.categoryId === onlyCategory;
  const markers = data ? regionMarkers(data) : [];
  const view = (t: Thread) => (
    <ThreadView
      key={t.comment.id}
      thread={t}
      fileId={fileId}
      me={me?.user.id}
      guest={Boolean(guest)}
      onSeek={seek}
      onLoop={onLoop}
      loop={loop}
      onBeforeAfter={onBeforeAfter}
      mutations={mutations}
      canComment={canComment}
      canTriage={canTriage}
      categories={categories}
      people={people}
      marker={markers.find((m) => m.id === t.comment.id)}
      pages={pages}
      takesOf={takesOf}
      channelNames={channelNames}
    />
  );

  return (
    <Mentionable value={mentionable}>
      <section aria-label="Comments" className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-2">
          <h2 className="m-0 text-[15px] font-medium">Comments</h2>
          <div className="flex items-center gap-1">
            <span className="tabular text-xs text-ink-3">
              {threads.open.length} open
              {threads.deferred.length > 0 && ` · ${threads.deferred.length} deferred`}
              {threads.resolved.length > 0 && ` · ${threads.resolved.length} resolved`}
            </span>
            {tools}
          </div>
        </div>
        {canComment && (
          <>
            {/* On a phone the composer opens as a sheet, so the comments stay in view. */}
            <div ref={composer} onFocusCapture={capture} className="hidden @3xl/app:block">
              {composerBody}
            </div>
            <Button
              variant="secondary"
              className="w-full @3xl/app:hidden"
              onClick={() => {
                media?.pause();
                capture();
                setSheet(true);
              }}
            >
              <Icon name="comment" size={14} />
              {composerLabel}
            </Button>
            {sheet && (
              <Dialog title={composerLabel} onClose={() => setSheet(false)}>
                {/* Opened to write in: the text box takes focus. */}
                <div onFocusCapture={capture} ref={sheetBody}>
                  {composerBody}
                </div>
              </Dialog>
            )}
          </>
        )}
        {error && <p className="m-0 text-xs text-signal">{error.message}</p>}
        {data &&
          threads.open.length === 0 &&
          threads.deferred.length === 0 &&
          threads.resolved.length === 0 &&
          threads.hidden.length === 0 && (
            <p className="m-0 text-[13px] text-ink-3">No comments yet.</p>
          )}
        {used.length > 1 && (
          <fieldset className="m-0 flex min-w-0 flex-wrap gap-1 border-0 p-0">
            <legend className="sr-only">Show comments of</legend>
            <ToggleChip pressed={!onlyCategory} onClick={() => setOnlyCategory(null)}>
              All
            </ToggleChip>
            {used.map((c) => (
              <ToggleChip
                key={c.id}
                pressed={onlyCategory === c.id}
                onClick={() => setOnlyCategory(onlyCategory === c.id ? null : c.id)}
              >
                {c.name}
              </ToggleChip>
            ))}
          </fieldset>
        )}
        <ul className="m-0 flex list-none flex-col p-0">
          {threads.open.filter(inCategory).map(view)}
        </ul>
        {threads.deferred.length > 0 && (
          <div className="flex flex-col">
            <button
              type="button"
              onClick={() => setShowDeferred((v) => !v)}
              aria-expanded={showDeferred}
              className="w-fit inline-flex min-h-6 min-w-6 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-xs text-ink-3 hover:text-ink"
            >
              {showDeferred ? "Hide" : "Show"} {threads.deferred.length} deferred
            </button>
            {showDeferred && (
              <ul className="m-0 flex list-none flex-col p-0">
                {threads.deferred.filter(inCategory).map(view)}
              </ul>
            )}
          </div>
        )}
        {threads.resolved.length > 0 && (
          <div className="flex flex-col">
            <button
              type="button"
              onClick={() => setShowResolved((v) => !v)}
              aria-expanded={showResolved}
              className="w-fit inline-flex min-h-6 min-w-6 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-xs text-ink-3 hover:text-ink"
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
              className="w-fit inline-flex min-h-6 min-w-6 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-xs text-ink-3 hover:text-ink"
            >
              {showHidden ? "Hide" : "Show"} {threads.hidden.length} hidden on this version
            </button>
            {showHidden && (
              <ul className="m-0 flex list-none flex-col p-0">{threads.hidden.map(view)}</ul>
            )}
          </div>
        )}
      </section>
    </Mentionable>
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

/** A comment begun elsewhere: its moment, and the words it starts with. */
export interface CommentSeed {
  /** Changes for each comment begun, so the same finding can be begun twice. */
  key: number;
  /** Null for a comment about the whole file. */
  at: number | null;
  body: string;
  /** The channel it is about, as a finding on one channel says (#74). */
  channel?: number | null;
}

/** The region markers of a file's open threads. */
export function useRegionMarkers(fileId: string, enabled = true): RegionMarker[] {
  const { data } = useQuery({ ...commentsQuery(fileId), enabled });
  return data ? regionMarkers(data) : [];
}

/** How an open thread reads on the timeline: work to do, put off, or simply open. */
export function markerState(comment: Comment): TimelineMarker["state"] {
  if (comment.assigneeId || (comment.todo && !comment.todoDoneAt)) return "todo";
  if (comment.deferredTo) return "deferred";
  return "open";
}

/**
 * Where open time-anchored threads start, for markers on the timeline. Threads at the same
 * moment share a marker, which shows the most pressing of them.
 */
export function commentMarkers(comments: Comment[]): TimelineMarker[] {
  const rank = { todo: 2, open: 1, deferred: 0 } as const;
  const byTime = new Map<number, TimelineMarker>();
  for (const c of comments) {
    if (c.parentId || c.resolvedAt || c.carry?.visible === false) continue;
    // A bar comment marks the moment it was named at.
    const at = anchorTime(c.anchor ?? null);
    if (at === null) continue;
    const state = markerState(c);
    const seen = byTime.get(at);
    if (!seen || rank[state] > rank[seen.state]) byTime.set(at, { at, state });
  }
  return [...byTime.values()];
}

export function useCommentMarkers(fileId: string, enabled = true): TimelineMarker[] {
  const { data } = useQuery({ ...commentsQuery(fileId), enabled });
  return data ? commentMarkers(data) : [];
}
