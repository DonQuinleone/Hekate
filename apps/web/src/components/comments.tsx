import {
  type Anchor,
  anchorShift,
  anchorTime,
  barsLabel,
  type CarryStatus,
  COMMENT_ATTACHMENT_MAX_BYTES,
  COMMENT_ATTACHMENTS_MAX,
  type CommentMention,
  carryStatuses,
  carryStatusLabel,
  drawingBounds,
  formatAnchor,
  formatBytes,
  LINK_FILES_MAX,
  mentionAt,
  mentionedIn,
  mentionRanges,
  parseBars,
  parseBeat,
  SHARE_TAKES_MAX,
  speakerOf,
  speakersOf,
  type TakeRow,
  type TriageInput,
  versionLabel,
  videoClock,
  videoTimecode,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
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
import { Failed } from "~/components/ui/states";
import { cn } from "~/lib/cn";
import {
  ago,
  arrangeThreads,
  batchesOf,
  categoryTone,
  filterHolding,
  historyLabel,
  passageLoop,
  type Thread,
  type ThreadFilter,
  threadFilterNames,
  threadFilters,
  threadsOf,
  threadsShown,
} from "~/lib/comments";
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
  type ProjectFile,
  projectMembersQuery,
  useCommentMutations,
  usePreferences,
  useProjectCan,
} from "~/lib/queries";
import { useShortcuts } from "~/lib/shortcuts";
import { useViewer } from "~/lib/viewer";
import { Avatar, personKey } from "./avatar";
import { CommentAssignee } from "./comment-assignee";
import { DeferDialog } from "./defer-dialog";
import type { RegionMarker } from "./document-viewer";
import type { FrameDraft, FrameDrawing } from "./drawings";
import { FilePicker, LinkedFiles } from "./file-picker";
import { kindIcon } from "./files";
import { Icon } from "./icons";
import type { TimelineMarker } from "./player";
import { OtherTakes, SharedTakes, TakePicker } from "./takes";
import { Button } from "./ui/button";
import { Chip, ToggleChip } from "./ui/chip";
import { Dialog } from "./ui/dialog";
import { Field } from "./ui/field";
import { Input, Select, Textarea } from "./ui/input";
import { ActionMenu, Dropdown, type MenuAction, MenuList, usePopover } from "./ui/menu";
import { UploadDialog } from "./ui/upload-dialog";

const fullTime = formatDates({ dateStyle: "medium", timeStyle: "short" });

/** Lowercase time labels read better inline than the upper-case anchor labels on markers. */
// "00:12.500" reads as "0:12.500", at either end of a range.
// A video's comments read in its own timecode instead (#146).
/** Where a comment points, written as every anchor is (#645): its own time where it has one. */
export const anchorLabel = (anchor: Anchor, time?: TimeFormat | null) =>
  formatAnchor(anchor, time ? { time } : {});

type TimeFormat = (seconds: number) => string;
/** How moments read on this file: a video's own timecode, else the clock (#146). */
const TimeFormatting = createContext<TimeFormat | null>(null);
/** How the file's project names a version: "V3", or "Cut 3" in video (#16). */
const VersionNaming = createContext<(n: number) => string>((n) => `V${n}`);

const textButton =
  "inline-flex min-h-6 min-w-6 cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-xs text-ink-3 hover:text-ink disabled:cursor-default disabled:opacity-40";

/** A document's page and regions, shared with the viewer beside the comments. */
export interface PageComments {
  focus: PageFocus;
  onFocus: (change: Partial<PageFocus>) => void;
  /** Whether the file has numbered pages (a document) or is one picture. */
  paged: boolean;
}

/** The playhead's moment as it moves, for the composer's lead until writing begins (#563). */
function Playhead({ media, format }: { media: HTMLMediaElement; format: TimeFormat | null }) {
  const [time, setTime] = useState(media.currentTime);
  useEffect(() => {
    const update = () => setTime(media.currentTime);
    update();
    media.addEventListener("timeupdate", update);
    media.addEventListener("seeked", update);
    return () => {
      media.removeEventListener("timeupdate", update);
      media.removeEventListener("seeked", update);
    };
  }, [media]);
  return <>{anchorLabel({ kind: "time", start: time, end: time }, format)}</>;
}

/** What before and after needs: the earlier file, the passage there and here. */
export interface BeforeAfter {
  fileId: string;
  /** Where the passage sits in the earlier file, relative to this one, in seconds. */
  shift: number;
  /** The passage here, with a little run-up and run-out. */
  loop: Loop;
  /** What to call it where it is no version of this track: a take ("T3", #46). */
  label?: string;
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
  takesFrom,
  filesFrom,
  submitLabel,
  pending,
  onSubmit,
  onAttach,
  onShareTakes,
  onLinkFiles,
  onSaved,
  onCancel,
  children,
  lead,
  keepOpen = false,
}: {
  /**
   * Where the comment lands, as the prototype's composer leads with it (#563): given, the
   * composer is one row (that, the text and a send button) until it is focused, and what
   * else goes with a comment (its references, channel, category, files, mentions) shows then.
   */
  lead?: ReactNode;
  /** Keeps the composer open though it has lost focus: a bar typed, say. */
  keepOpen?: boolean;
  placeholder: string;
  initial?: string;
  initialMentions?: CommentMention[];
  /** Files may go with it (#133): chosen here, sent once the comment is saved. */
  attachable?: boolean;
  /** The track whose takes may go with it too (#497), for those who may share them. */
  takesFrom?: { trackId: string; projectId: string } | undefined;
  /**
   * The project whose files may be linked to it too (#527), and the file being commented on,
   * which is the comment's already: for members who may comment, never a guest.
   */
  filesFrom?: { projectId: string; fileId: string } | undefined;
  submitLabel: string;
  pending: boolean;
  /**
   * The text and the members it mentions as the picker chose them; for an attachable comment,
   * resolves to the comment saved, which the files are then attached to.
   */
  onSubmit: (body: string, mentions: string[]) => Promise<string | undefined>;
  /** Attaches one chosen file to the comment saved. */
  onAttach?: (commentId: string, file: File) => Promise<unknown>;
  /** Shares the takes picked on the thread saved. */
  onShareTakes?: (commentId: string, takeIds: string[]) => Promise<unknown>;
  /** Links the project's files picked to the comment saved. */
  onLinkFiles?: (commentId: string, fileIds: string[]) => Promise<unknown>;
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
  /** The track's takes picked to go with it (#497). */
  const [takes, setTakes] = useState<TakeRow[]>([]);
  /** The project's files picked to go with it (#527). */
  const [linked, setLinked] = useState<ProjectFile[]>([]);
  // Busy from saving the comment until its last file is attached.
  const [sending, setSending] = useState(false);
  // A comment saved whose files did not all attach: trying again attaches the rest to it.
  const [saved, setSaved] = useState<string | null>(null);
  // Attach opens a menu in place (#497): the track's takes, the project's files (#527), or
  // files to upload. The upload dialog says what a comment may carry.
  const [attachMenu, setAttachMenu, attachBox] = usePopover();
  const [attaching, setAttaching] = useState<"upload" | "takes" | "files" | null>(null);
  /** Why a file cannot go with a comment, if it cannot: the dialog says so by the file. */
  const refuse = (f: File) =>
    f.size === 0
      ? "It is empty"
      : f.size > COMMENT_ATTACHMENT_MAX_BYTES
        ? "A file can be at most 25 MB"
        : files.some((g) => fileKey(g) === fileKey(f))
          ? "It is already attached"
          : null;
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
      if (id && onShareTakes && takes.length > 0) {
        setSaved(id);
        // As many as one request carries at a time, each batch let go of once it is shared, so
        // trying again sends only the rest.
        for (const batch of batchesOf(takes, SHARE_TAKES_MAX)) {
          await onShareTakes(
            id,
            batch.map((t) => t.id),
          );
          setTakes((list) => list.filter((t) => !batch.includes(t)));
        }
      }
      if (id && onLinkFiles && linked.length > 0) {
        setSaved(id);
        // In batches as takes are, each let go of once it is linked.
        for (const batch of batchesOf(linked, LINK_FILES_MAX)) {
          await onLinkFiles(
            id,
            batch.map((f) => f.id),
          );
          setLinked((list) => list.filter((f) => !batch.includes(f)));
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
  /** In a row (#563): open while focused, written in, or carrying something. */
  const [focused, setFocused] = useState(false);
  const row = lead !== undefined;
  const expanded =
    !row ||
    focused ||
    keepOpen ||
    body.trim() !== "" ||
    files.length + takes.length + linked.length > 0 ||
    attachMenu ||
    attaching !== null ||
    saved !== null;
  const textarea = (
    <Textarea
      ref={area}
      value={body}
      onChange={(e) => write(e.target.value, e.target.selectionStart)}
      onKeyDown={onKeyDown}
      onBlur={() => setTyping(null)}
      placeholder={placeholder}
      rows={2}
      aria-label={placeholder}
      aria-autocomplete={people.length > 0 ? "list" : undefined}
      aria-controls={open ? listId : undefined}
      aria-activedescendant={open ? `${listId}-${index}` : undefined}
      className={
        row
          ? "min-h-8 flex-1 resize-none border-0 bg-transparent px-1 py-1.5 text-[13px] leading-5 shadow-none hover:border-0 focus:border-0"
          : "min-h-14 text-[13px]"
      }
      {...(row ? { rows: expanded ? 2 : 1 } : {})}
    />
  );
  return (
    <form
      onSubmit={submit}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
      className="flex flex-col gap-2"
    >
      <div
        className={cn(
          "relative",
          row &&
            "flex items-end gap-1.5 rounded-panel border border-line bg-ground/50 p-1.5 shadow-1 transition-colors focus-within:border-edge-strong",
        )}
      >
        {lead}
        {textarea}
        {row && (
          <Button
            type="submit"
            variant={body.trim() ? "primary" : "ghost"}
            size="icon"
            aria-label={saved ? "Attach the rest" : submitLabel}
            title={`${submitLabel} (⌘↵)`}
            disabled={pending || sending || !body.trim()}
            className="size-8 shrink-0 rounded-full"
          >
            <Icon name="send" size={14} />
          </Button>
        )}
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
                <Avatar person={person.id} name={person.name} size={18} />
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
      {takes.length > 0 && (
        <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="Takes to attach">
          {takes.map((t) => (
            <li key={t.id}>
              <Chip className="h-6 gap-1 text-[12px] text-ink-2">
                <Icon name="take" size={11} />
                <span className="tabular">T{t.number}</span>
                {barsLabel(t) && <span className="text-ink-3">{barsLabel(t)}</span>}
                <Button
                  size="iconSm"
                  variant="quiet"
                  className="-mr-1 size-5"
                  aria-label={`Leave out take ${t.number}`}
                  onClick={() => setTakes(takes.filter((x) => x.id !== t.id))}
                >
                  <Icon name="close" size={11} />
                </Button>
              </Chip>
            </li>
          ))}
        </ul>
      )}
      {linked.length > 0 && (
        <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="Files to link">
          {linked.map((f) => (
            <li key={f.id} className="min-w-0 max-w-full">
              <Chip className="h-6 max-w-full gap-1 text-[12px] text-ink-2">
                <Icon name={kindIcon[f.kind]} size={11} className="shrink-0 text-ink-3" />
                <span className="max-w-48 truncate">{f.name}</span>
                <Button
                  size="iconSm"
                  variant="quiet"
                  className="-mr-1 size-5"
                  aria-label={`Leave out ${f.name}`}
                  onClick={() => setLinked(linked.filter((x) => x.id !== f.id))}
                >
                  <Icon name="close" size={11} />
                </Button>
              </Chip>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="m-0 text-xs text-signal">{error}</p>}
      <div className={cn("flex flex-wrap items-center gap-2", !expanded && "hidden")}>
        {children}
        {attachable && (
          <span ref={attachBox} className="relative">
            <Button
              size="sm"
              variant="ghost"
              aria-haspopup="menu"
              aria-expanded={attachMenu}
              onClick={() => setAttachMenu(!attachMenu)}
              className={cn(attachMenu && "bg-raised text-ink")}
            >
              <Icon name="link" size={12} />
              Attach
            </Button>
            {attachMenu && (
              <MenuList
                anchor={attachBox}
                align="left"
                side="top"
                label="Attach"
                onClose={() => setAttachMenu(false)}
                actions={[
                  ...(takesFrom
                    ? [
                        {
                          label: "Takes from this track…",
                          icon: <Icon name="take" size={14} />,
                          onSelect: () => setAttaching("takes"),
                        },
                      ]
                    : []),
                  ...(filesFrom
                    ? [
                        {
                          label: "Files from this project…",
                          icon: <Icon name="folder" size={14} />,
                          onSelect: () => setAttaching("files"),
                        },
                      ]
                    : []),
                  {
                    label: "Upload…",
                    icon: <Icon name="upload" size={14} />,
                    hint:
                      files.length >= COMMENT_ATTACHMENTS_MAX
                        ? `${COMMENT_ATTACHMENTS_MAX} already`
                        : undefined,
                    onSelect: () => setAttaching("upload"),
                  },
                ]}
              />
            )}
          </span>
        )}
        {attaching === "takes" && takesFrom && (
          <TakePicker
            trackId={takesFrom.trackId}
            projectId={takesFrom.projectId}
            chosen={takes.map((t) => t.id)}
            onPick={(picked) => {
              setTakes(picked);
              setError(null);
            }}
            onClose={() => setAttaching(null)}
          />
        )}
        {attaching === "files" && filesFrom && (
          <FilePicker
            projectId={filesFrom.projectId}
            exclude={filesFrom.fileId}
            chosen={linked.map((f) => f.id)}
            onPick={(picked) => {
              setLinked(picked);
              setError(null);
            }}
            onClose={() => setAttaching(null)}
          />
        )}
        {attaching === "upload" && (
          <UploadDialog
            title="Attach files"
            description={`Up to ${COMMENT_ATTACHMENTS_MAX} files of 25 MB each go with the comment.`}
            onClose={() => setAttaching(null)}
            width="sm"
            inputLabel="Files to attach"
            listLabel="Files chosen to attach"
            prompt="Drop the files here, or choose them"
            multiple
            limit={Math.max(0, COMMENT_ATTACHMENTS_MAX - files.length)}
            check={refuse}
            what="They are attached once the comment is sent."
            action="Attach"
            onSubmit={(chosen) => {
              setFiles([...files, ...chosen.flatMap((c) => (c.file ? [c.file] : []))]);
              setError(null);
              setAttaching(null);
            }}
          />
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
          {!row && (
            <Button
              size="sm"
              variant="primary"
              type="submit"
              disabled={pending || sending || !body.trim()}
            >
              {saved ? "Attach the rest" : submitLabel}
            </Button>
          )}
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
  guest,
  onUnlink,
  editing,
  onEditing,
  onEdit,
  onDownload,
  onRemove,
  end,
  attached,
}: {
  comment: Comment;
  /** Written by the viewer, member or guest: they may take their own files off it. */
  own: boolean;
  /** A guest reviewer is reading: a linked file opens in their own viewer. */
  guest: boolean;
  /** Taking a linked file off it (#527): its author, or whoever triages. */
  onUnlink?: (fileId: string) => void;
  /** Its words are being changed, from the thread's or the reply's menu. */
  editing: boolean;
  onEditing: (on: boolean) => void;
  onEdit: (id: string, body: string, mentions: string[]) => Promise<unknown>;
  /** A one-time download of one of its files, made for this person (#133). */
  onDownload: (attachmentId: string) => void;
  /** Taking one of your own files off it. */
  onRemove: (attachmentId: string) => void;
  /** At the end of its first line: where a thread points, or a reply's menu. */
  end?: ReactNode;
  /** Beside its files: the takes shared on a thread (#133). */
  attached?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex min-w-0 items-center gap-2 text-xs">
        <Avatar
          person={personKey({
            userId: comment.authorId,
            guestId: comment.authorGuestId,
            name: comment.authorName ?? "former",
          })}
          name={comment.authorName ?? "Former member"}
          size={20}
        />
        <span className="truncate font-medium text-ink">
          {comment.authorName ?? "Former member"}
        </span>
        {comment.authorGuest && (
          <span className="shrink-0 text-ink-3">
            {comment.authorLabel ? `${comment.authorLabel}, guest` : "Guest"}
          </span>
        )}
        <span className="shrink-0 text-ink-3" title={fullTime.format(new Date(comment.createdAt))}>
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
        {end && <span className="ml-auto flex min-w-0 shrink-0 items-center gap-1">{end}</span>}
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
            onEditing(false);
            return undefined;
          }}
          onCancel={() => onEditing(false)}
        />
      ) : (
        <Words comment={comment} />
      )}
      {(comment.attachments.length > 0 || comment.files.length > 0 || attached) && (
        <div className="flex flex-wrap items-center gap-1.5">
          {comment.attachments.length > 0 && (
            <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0" aria-label="Attached files">
              {comment.attachments.map((a) => (
                <li key={a.id} className="group/attachment flex items-center">
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-7 max-w-full gap-1.5 text-[12px]"
                    onClick={() => onDownload(a.id)}
                  >
                    <Icon name="download" size={12} />
                    <span className="sr-only">Download </span>
                    <span className="max-w-48 truncate">{a.name}</span>{" "}
                    <span className="text-ink-3">{formatBytes(a.byteSize)}</span>
                  </Button>
                  {own && (
                    // On hover or focus only (#642): a posted file keeps no permanent ×.
                    <Button
                      size="iconSm"
                      variant="quiet"
                      aria-label={`Remove ${a.name}`}
                      onClick={() => onRemove(a.id)}
                      className="opacity-0 transition-opacity group-hover/attachment:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                    >
                      <Icon name="close" size={12} />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {comment.files.length > 0 && (
            <LinkedFiles files={comment.files} guest={guest} onUnlink={onUnlink} />
          )}
          {attached}
        </div>
      )}
    </div>
  );
}

/** A reply under a thread: the same body, its own menu holding Edit where its writer may. */
function Reply({
  comment,
  own,
  guest,
  onUnlink,
  editable,
  onEdit,
  onDownload,
  onRemove,
}: {
  comment: Comment;
  own: boolean;
  guest: boolean;
  onUnlink?: (fileId: string) => void;
  editable: boolean;
  onEdit: (id: string, body: string, mentions: string[]) => Promise<unknown>;
  onDownload: (attachmentId: string) => void;
  onRemove: (attachmentId: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <CommentBody
      comment={comment}
      own={own}
      guest={guest}
      onUnlink={onUnlink}
      editing={editing}
      onEditing={setEditing}
      onEdit={onEdit}
      onDownload={onDownload}
      onRemove={onRemove}
      end={
        editable &&
        !editing && (
          // On hover or focus only (#642): never a second menu stacked over the thread's.
          <span className="opacity-0 transition-opacity group-hover/reply:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
            <ActionMenu
              always
              label="this reply"
              actions={[{ label: "Edit", onSelect: () => setEditing(true) }]}
            />
          </span>
        )
      }
    />
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
      description="The person who is to act on it. It joins their list; send them the list once triage is done."
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
  projectId,
  focused = false,
  number,
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
  /** The file's project, where a thread's task is kept (#140). */
  projectId?: string;
  /** The thread a link points at: brought into view and marked. */
  focused?: boolean;
  /** Its number on the media (#562): "#1" here and on its marker are the same thread. */
  number?: number;
}) {
  const time = useContext(TimeFormatting);
  const navigate = useNavigate();
  const label = (a: Anchor) => anchorLabel(a, time);
  const [replying, setReplying] = useState(false);
  const [editing, setEditing] = useState(false);
  const [takesOpen, setTakesOpen] = useState(false);
  const [asking, setAsking] = useState<"defer" | "assign" | null>(null);
  const { comment, replies } = thread;
  const anchor = comment.anchor;
  // A take heard against this recording from the moment a bar thread was written (#46): the
  // take's bar lined up with it, looped, level-matched, one key flipping between them.
  const heardAt = anchor?.kind === "bar" ? anchor.at : undefined;
  const audition =
    onBeforeAfter && heardAt !== undefined
      ? (take: { fileId: string; number: number; span: [number, number] }) =>
          onBeforeAfter({
            fileId: take.fileId,
            label: `T${take.number}`,
            shift: take.span[0] - heardAt,
            loop: { start: heardAt, end: heardAt + (take.span[1] - take.span[0]) },
          })
      : undefined;
  const carry = comment.carry;
  /** This version's number, for "Fixed in V3". */
  const here = comment.history?.hops.find((h) => h.fileId === fileId)?.versionNumber;
  const versionName = useContext(VersionNaming);
  const path = historyLabel(comment.history, versionName);
  const from = carry?.from.anchor;
  const setCarry = (change: { status?: CarryStatus; visible?: boolean; anchor?: Anchor | null }) =>
    carry && mutations.carry.mutate({ id: carry.id, ...change });
  const edit = (id: string, body: string, mentions: string[]) =>
    mutations.edit.mutateAsync({ id, body, mentions });
  const download = (attachmentId: string) => mutations.download.mutate(attachmentId);
  const remove = (attachmentId: string) => mutations.detach.mutate(attachmentId);
  /** Taking a linked file off a comment (#527): its author while they may comment, or triage. */
  const unlinkOf = (c: Comment) =>
    !guest && ((canComment && c.mine) || canTriage)
      ? (linkedFileId: string) =>
          mutations.unlinkFile.mutate({ commentId: c.id, fileId: linkedFileId })
      : undefined;
  /** The project's files a comment of one's own may link to (#527): members only. */
  const filesFrom = !guest && canComment && projectId ? { projectId, fileId } : undefined;
  const picked = pages?.focus.selected === comment.id || focused;
  const row = useRef<HTMLLIElement>(null);
  // Picked on the page, the thread comes into view here.
  useEffect(() => {
    if (picked) row.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [picked]);
  /** The region drawn on the page, which a carried thread can be moved to. */
  const draft = pages?.focus.draft;
  const category = categories.find((c) => c.id === comment.categoryId);
  const tone = comment.categoryId ? categoryTone(categories, comment.categoryId) : null;
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
    ? `Task, done${comment.todoDoneByName ? ` by ${comment.todoDoneByName}` : ""}`
    : "Task, to do";
  /** The moment a thread on a bar or a drawing was at, read beside its place (#496). */
  const moment = (at: number) => label({ kind: "time", start: at, end: at });
  const chip =
    "tabular inline-flex h-6 min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-chip border border-edge bg-transparent px-2 text-[11px] text-ink hover:border-signal";
  /** Its number, as its marker over the media shows it (#562); not read out, as the chip is. */
  const n = (marker?.n ?? number) !== undefined && (
    <span aria-hidden="true" className="shrink-0 text-ink-3">
      #{marker?.n ?? number}
    </span>
  );
  /** Where it points, as one chip at the end of its first line; nothing for the whole file. */
  const where = anchor ? (
    anchor.kind === "time" ? (
      // Each chip is named by its own words, the verb read out and not shown, so what it shows
      // is always part of its name.
      <button type="button" onClick={() => onSeek(anchor.start)} className={chip}>
        {n}
        <span className="sr-only">Play from </span>
        <span className="truncate">{label(anchor)}</span>
      </button>
    ) : anchor.kind === "bar" && anchor.at !== undefined ? (
      <button type="button" onClick={() => onSeek(anchor.at ?? 0)} className={chip}>
        {n}
        <span className="sr-only">Play </span>
        <span className="truncate">
          {label(anchor)}
          <span className="text-ink-3"> · {moment(anchor.at)}</span>
        </span>
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
        className={cn(chip, picked && "border-signal")}
      >
        <span className="sr-only">Show {marker ? `thread ${marker.n}, ` : ""}</span>
        {n}
        <span className="truncate">{label(anchor)}</span>
      </button>
    ) : anchor.kind === "region" && anchor.at !== undefined ? (
      // A drawing on a video's frame (#146): back to its frame, as the prototype does.
      <button type="button" onClick={() => onSeek(anchor.at ?? 0)} className={chip}>
        {n}
        <span className="sr-only">Show the drawing, </span>
        <span className="truncate">{label(anchor)}</span>
      </button>
    ) : (
      <span className="label">{formatAnchor(anchor, time ? { time } : {})}</span>
    )
  ) : null;
  /** Everything but Reply and Resolve: the passage, the takes, the words, triage. */
  const actions: (MenuAction | "divider")[] = [
    ...(anchor?.kind === "time" && onLoop && anchor.end - anchor.start >= MIN_LOOP
      ? [
          {
            label: "Loop the passage",
            onSelect: () => onLoop({ start: anchor.start, end: anchor.end }),
          },
        ]
      : []),
    ...(takesOf && anchor?.kind === "bar"
      ? [
          {
            label: takesOpen ? "Hide other takes" : `Other takes for bar ${anchor.from.bar}`,
            onSelect: () => setTakesOpen((open) => !open),
          },
        ]
      : []),
    ...(carry && onBeforeAfter && from?.kind === "time" && anchor?.kind === "time"
      ? [
          {
            label: "Before and after",
            onSelect: () =>
              onBeforeAfter({
                fileId: carry.from.fileId,
                shift: anchorShift(from, anchor),
                loop: passageLoop(anchor),
              }),
          },
        ]
      : []),
    ...(canComment && comment.mine && !guest
      ? [{ label: "Edit", onSelect: () => setEditing(true) }]
      : []),
    // The thread's task (#140), from the menu rather than a link in the row (#642).
    ...(comment.taskId && projectId && !guest
      ? [
          {
            label: "Open the task",
            onSelect: () =>
              void navigate({
                to: "/projects/$projectId/tasks",
                params: { projectId },
                search: { task: comment.taskId ?? undefined },
              }),
          },
        ]
      : []),
    ...(carry && canTriage
      ? [
          "divider" as const,
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
                    setCarry({ anchor: { kind: "time", start: loop.start, end: loop.end } }),
                },
              ]
            : []),
          {
            label: carry.visible ? "Hide on this version" : "Show on this version",
            onSelect: () => setCarry({ visible: !carry.visible }),
          },
        ]
      : []),
    ...(triageActions.length > 0 ? ["divider" as const, ...triageActions] : []),
  ];
  while (actions[0] === "divider") actions.shift();
  /** A state the thread is in, said quietly in the action row, not something to press. */
  const quiet = "text-[11px] text-ink-3";
  return (
    <li
      ref={row}
      data-thread={comment.id}
      className={cn(
        "group relative -mx-3 flex flex-col gap-2 border-b border-hairline px-3 py-row-loose transition-colors hover:bg-raised/40 lg:-mx-4 lg:px-4",
        comment.resolvedAt && "opacity-70",
        picked && "rounded-panel border-transparent bg-raised",
      )}
    >
      {/* Its category is the bar at its left edge, in the category's colour (#496). */}
      {category && tone && (
        <span
          aria-hidden="true"
          title={category.name}
          className={cn("absolute top-3 bottom-3 left-0 w-[3px] rounded-full", tone)}
        />
      )}
      <CommentBody
        comment={comment}
        own={canComment && comment.mine}
        guest={guest}
        onUnlink={unlinkOf(comment)}
        editing={editing}
        onEditing={setEditing}
        onEdit={edit}
        onDownload={download}
        onRemove={remove}
        end={
          <>
            {where}
            {comment.channel !== null && (
              <Chip title="The channel it is about" className="h-6 shrink-0">
                {speakerOf(channelNames, comment.channel)}
              </Chip>
            )}
          </>
        }
        attached={
          comment.takes.length > 0 && (
            <SharedTakes
              takes={comment.takes}
              bar={anchor?.kind === "bar" ? anchor.from.bar : undefined}
              guest={guest}
              onAudition={audition}
              onUnshare={
                canTriage && takesOf
                  ? (takeId) => mutations.unshareTake.mutate({ commentId: comment.id, takeId })
                  : undefined
              }
            />
          )
        }
      />
      {asking === "defer" && projectId && (
        <DeferDialog
          fileId={fileId}
          projectId={projectId}
          categories={categories}
          current={comment.deferredTo}
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
      {replies.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-3 border-l border-hairline p-0 pl-3">
          {replies.map((reply) => (
            <li key={reply.id} className="group/reply">
              <Reply
                comment={reply}
                own={canComment && reply.mine}
                guest={guest}
                onUnlink={unlinkOf(reply)}
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
          // Heard against this recording from the moment the thread was written (#46): the
          // take's bar lined up with it, looped, level-matched, one key flipping between them.
          onAudition={audition}
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
          filesFrom={filesFrom}
          onLinkFiles={(commentId, fileIds) =>
            mutations.linkFiles.mutateAsync({ commentId, fileIds })
          }
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
        // One row of actions, always there and quiet, as Frame.io and Figma have it (#496):
        // Reply, Resolve (or a carried thread's status), the states it is in, and the menu.
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {!comment.resolvedAt && canComment && (
            <button type="button" onClick={() => setReplying(true)} className={textButton}>
              Reply
            </button>
          )}
          {carry ? (
            canTriage ? (
              <Select
                size="sm"
                aria-label="Status on this version"
                value={carry.status}
                onChange={(e) => setCarry({ status: e.target.value as CarryStatus })}
                className="w-auto"
              >
                {carryStatuses.map((s) => (
                  <option key={s} value={s}>
                    {carryStatusLabel(s, here ?? 0, versionName)}
                  </option>
                ))}
              </Select>
            ) : (
              carry.status !== "open" && (
                <span className={quiet}>
                  {carryStatusLabel(carry.status, here ?? 0, versionName)}
                </span>
              )
            )
          ) : (
            <>
              {canTriage && (
                <button
                  type="button"
                  onClick={() =>
                    mutations.resolve.mutate({ id: comment.id, resolved: !comment.resolvedAt })
                  }
                  className={textButton}
                >
                  {comment.resolvedAt ? "Reopen" : "Resolve"}
                </button>
              )}
              {comment.resolvedAt && (
                <span className={quiet}>
                  Resolved{comment.resolvedByName ? ` by ${comment.resolvedByName}` : ""}
                </span>
              )}
            </>
          )}
          {/* A quiet chip whose words never change (#642): checked once it is done. */}
          {comment.todo &&
            (mayFinish ? (
              <ToggleChip
                pressed={!!comment.todoDoneAt}
                aria-label={doneWords}
                title={
                  comment.todoDoneAt
                    ? "Done; press to mark it to do"
                    : "To do; press to mark it done"
                }
                onClick={() =>
                  mutations.todo.mutate({ id: comment.id, todo: true, done: !comment.todoDoneAt })
                }
                className="h-6 gap-1 px-2 text-[11px] text-ink-3"
              >
                <Icon
                  name="check"
                  size={11}
                  className={comment.todoDoneAt ? "text-ink" : "opacity-40"}
                />
                Task
              </ToggleChip>
            ) : (
              <Chip title={doneWords} className="h-6 gap-1 text-[11px] text-ink-3">
                <Icon
                  name="check"
                  size={11}
                  className={comment.todoDoneAt ? "text-ink" : "opacity-40"}
                />
                Task
              </Chip>
            ))}
          {comment.deferredTo && <span className={quiet}>deferred to {comment.deferredTo}</span>}
          {comment.assigneeId && comment.assigneeName && (
            <span className={quiet}>
              <CommentAssignee id={comment.assigneeId} name={comment.assigneeName} />
            </span>
          )}
          {path && (
            <span className={cn(quiet, "tabular")} title="Versions this thread has been on">
              {path}
            </span>
          )}
          {actions.length > 0 && (
            <span className="ml-auto">
              <ActionMenu always label="this thread" actions={actions} />
            </span>
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
  frame,
  seed,
  tools,
  focus,
  heading,
}: {
  /** On a video: the drawing waiting to join the next comment (#146), and letting it go. */
  frame?: { draft: FrameDraft | null; onClear: () => void };
  /** A thread a link points at (#140): brought into view and marked, as one picked on a page. */
  focus?: string;
  /** A comment begun elsewhere (from a finding, #43): at its moment, starting with its words. */
  seed?: CommentSeed;
  /** In place of the panel's name: the switch to the transcript (#201). */
  heading?: ReactNode;
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
  const { data, error, refetch } = useQuery(commentsQuery(fileId));
  const { guest } = useViewer();
  const can = useProjectCan(guest ? undefined : projectId);
  // A guest reviewer may comment on the files of their review when it allows, never triage.
  const { data: file } = useQuery(fileQuery(fileId));
  const canComment = guest ? Boolean(file?.grant?.comment) : can("comment");
  const canTriage = !guest && can("triage");
  // A video's comments read in its own timecode (#146).
  const video = file?.mediaInfo?.video;
  const timeFormat = useMemo(() => {
    const clock = video ? videoClock(video) : null;
    return clock ? (seconds: number) => videoTimecode(seconds, clock) : null;
  }, [video]);
  // A thread on a bar of a track's version can list the track's takes of that bar (#46).
  const takesOf = !guest && can("view_takes") ? file?.variant?.trackId : undefined;
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
  /** Which threads are listed: the open ones, unless another list is chosen (#15). */
  const [filter, setFilter] = useState<ThreadFilter>("open");
  /** The newest first, rather than in the order they occur in the file; and words to find. */
  const [newest, setNewest] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
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
  /** A drawing made on the frame is where the next comment goes, unless told otherwise (#146). */
  const [onDrawing, setOnDrawing] = useState(true);
  const frameDraft = frame?.draft ?? null;
  useEffect(() => {
    if (frameDraft) setOnDrawing(true);
  }, [frameDraft]);
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
    // A drawing on the frame: the region around it, at the moment it was drawn (#146).
    if (frameDraft && onDrawing)
      return {
        kind: "region",
        at: frameDraft.at,
        ...drawingBounds(frameDraft.drawing),
        drawing: frameDraft.drawing,
      };
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

  const drawingAim = frameDraft !== null && onDrawing && !barsOn;
  const composerLabel = drawingAim
    ? "Comment on the drawing"
    : media
      ? "Comment at the playhead"
      : pages && pageAim === "region"
        ? "Comment on the region"
        : pages?.paged && pageAim === "page"
          ? `Comment on page ${pages.focus.page}`
          : "Comment on this file";
  /** Where a new comment lands, as the composer's lead says it (#563, #638). */
  const aim: "bars" | "drawing" | "whole" | "loop" | "playhead" | "region" | "page" = barsOn
    ? "bars"
    : drawingAim
      ? "drawing"
      : pages
        ? pageAim === "whole"
          ? "whole"
          : pageAim
        : wholeFile
          ? "whole"
          : loop && onPassage
            ? "loop"
            : "playhead";
  const typedBars = barsOn ? parseBars(bars, { beats: references?.beat }) : null;
  const aimTo = (next: typeof aim) => {
    setBars("");
    if (pages) {
      setPageTarget(next === "region" ? "region" : next === "page" ? "page" : "whole");
      return;
    }
    setOnDrawing(next === "drawing");
    setWholeFile(next === "whole");
    setOnPassage(next === "loop");
    if (next === "playhead" && media) setAt(Math.round(media.currentTime * 1000) / 1000);
  };
  const lead =
    media || pages ? (
      <Dropdown
        size="sm"
        label="Where the comment goes"
        value={
          <span className="tabular font-medium whitespace-nowrap text-ink">
            {aim === "bars" ? (
              typedBars ? (
                anchorLabel({ kind: "bar", ...typedBars })
              ) : (
                "Bars"
              )
            ) : aim === "drawing" && frameDraft ? (
              `Drawing at ${anchorLabel({ kind: "time", start: frameDraft.at, end: frameDraft.at }, timeFormat)}`
            ) : aim === "whole" ? (
              "Whole file"
            ) : aim === "loop" && loop ? (
              anchorLabel({ kind: "time", start: loop.start, end: loop.end }, timeFormat)
            ) : aim === "region" ? (
              "Region"
            ) : aim === "page" && pages ? (
              `p. ${pages.focus.page}`
            ) : at !== null ? (
              anchorLabel({ kind: "time", start: at, end: at }, timeFormat)
            ) : media ? (
              <Playhead media={media} format={timeFormat} />
            ) : (
              "Whole file"
            )}
          </span>
        }
        actions={
          pages
            ? [
                ...(draft
                  ? [
                      {
                        label: "The region drawn",
                        checked: aim === "region",
                        onSelect: () => aimTo("region"),
                      },
                    ]
                  : []),
                ...(pages.paged
                  ? [
                      {
                        label: `Page ${pages.focus.page}`,
                        checked: aim === "page",
                        onSelect: () => aimTo("page"),
                      },
                    ]
                  : []),
                {
                  label: "The whole file",
                  checked: aim === "whole",
                  onSelect: () => aimTo("whole"),
                },
              ]
            : [
                {
                  label: "At the playhead",
                  checked: aim === "playhead",
                  onSelect: () => aimTo("playhead"),
                },
                // The loop as one of its places (#638), where there is one.
                ...(loop
                  ? [
                      {
                        label: "Over the loop",
                        checked: aim === "loop",
                        onSelect: () => aimTo("loop"),
                      },
                    ]
                  : []),
                ...(frameDraft
                  ? [
                      {
                        label: "On the drawing",
                        checked: aim === "drawing",
                        onSelect: () => aimTo("drawing"),
                      },
                      { label: "Discard the drawing", onSelect: () => frame?.onClear() },
                    ]
                  : []),
                {
                  label: "The whole file",
                  checked: aim === "whole",
                  onSelect: () => aimTo("whole"),
                },
              ]
        }
        className="mb-0.5 h-7 shrink-0 px-1.5"
      />
    ) : undefined;
  const composerBody = (
    <Composer
      lead={lead}
      keepOpen={bars.trim() !== "" || scorePage.trim() !== "" || beat.trim() !== ""}
      // A comment begun from a finding starts with its words; a new one starts empty.
      key={seed?.key ?? 0}
      initial={seed?.body ?? ""}
      placeholder={composerLabel}
      submitLabel="Comment"
      pending={mutations.create.isPending}
      attachable
      // The track's takes (#497), by those who may share them: triage, seeing takes.
      takesFrom={takesOf && canTriage ? { trackId: takesOf, projectId } : undefined}
      onShareTakes={(commentId, takeIds) =>
        mutations.shareTakes.mutateAsync({ commentId, takeIds })
      }
      // The project's files (#527), by members who may comment.
      filesFrom={!guest && canComment ? { projectId, fileId } : undefined}
      onLinkFiles={(commentId, fileIds) => mutations.linkFiles.mutateAsync({ commentId, fileIds })}
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
        if (drawingAim) frame?.onClear();
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
      {/* Placeholders that read as what to write, never as values filled in (#563). */}
      {offersPage && (
        <Input
          size="sm"
          id={scorePageId}
          aria-label="Page"
          value={scorePage}
          onChange={(e) => setScorePage(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          placeholder="Page"
          inputMode="numeric"
          aria-invalid={!pageValid}
          className="tabular w-16"
        />
      )}
      {offersBars && (
        <Input
          size="sm"
          id={barsId}
          aria-label="Bar"
          value={bars}
          onChange={(e) => setBars(e.target.value)}
          // Space and the arrows belong to the field here, not the player.
          onKeyDown={(e) => e.stopPropagation()}
          placeholder="Bar, or 9–12"
          inputMode="decimal"
          aria-invalid={bars.trim() !== "" && parseBars(bars, { beats: references?.beat }) === null}
          className="tabular w-28"
        />
      )}
      {offersBeat && (
        <Input
          size="sm"
          id={beatId}
          aria-label="Beat"
          value={beat}
          onChange={(e) => setBeat(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          placeholder="Beat"
          inputMode="decimal"
          aria-invalid={typedBeat === null}
          className="tabular w-16"
        />
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
  // A list chosen that has emptied (its last thread reopened, say) goes back to the open ones.
  const shownFilter = threadFilters(threads).includes(filter) ? filter : "open";
  const listed = arrangeThreads(threadsShown(threads, shownFilter).filter(inCategory), {
    newest,
    query: query ?? "",
  });
  // A link to a thread (#140) lists it, whichever list was chosen.
  const holding = focus ? filterHolding(threads, focus) : null;
  useEffect(() => {
    if (holding && holding !== "open") setFilter(holding);
  }, [holding]);
  const markers = data ? regionMarkers(data) : [];
  // Each thread numbered as its marker over the media is (#562).
  const numbers = data ? threadNumbers(data) : new Map<string, number>();
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
      projectId={projectId}
      focused={t.comment.id === focus}
      number={numbers.get(t.comment.id)}
    />
  );

  return (
    <TimeFormatting.Provider value={timeFormat}>
      <VersionNaming.Provider value={(n) => versionLabel(n, file?.profile)}>
        <Mentionable value={mentionable}>
          {/*
            The column beside the player (#15), as the prototype's: its name and count, the
            list chosen (open, by default) and the categories in use, the threads scrolling
            on their own on a wide screen, and the composer at its foot.
          */}
          <section aria-label="Comments" className="flex flex-col lg:min-h-0 lg:flex-1">
            <div className="flex h-11 shrink-0 items-center gap-1 pr-2 pl-3 lg:pl-4">
              {/* The count is the header's comments toggle's, said once on the page (#642). */}
              {heading ?? (
                <>
                  <h2 className="m-0 text-[14px] font-medium text-ink">Comments</h2>
                  {/* On a phone there is no toggle in the header to carry it. */}
                  <span className="tabular text-[13px] text-ink-3 lg:hidden">
                    {threads.open.length}
                  </span>
                </>
              )}
              <span className="ml-auto flex shrink-0 items-center gap-0.5">
                <Dropdown
                  size="sm"
                  align="right"
                  label="Show"
                  value={<span>{threadFilterNames[shownFilter]}</span>}
                  actions={threadFilters(threads).map((f) => ({
                    label: threadFilterNames[f],
                    hint: String(threadsShown(threads, f).length),
                    checked: shownFilter === f,
                    onSelect: () => setFilter(f),
                  }))}
                />
                <Button
                  variant="ghost"
                  size="iconSm"
                  aria-label="Newest first"
                  title="Newest first"
                  aria-pressed={newest}
                  onClick={() => setNewest((on) => !on)}
                  className={cn(newest && "bg-raised text-ink")}
                >
                  <Icon name="sort" size={14} />
                </Button>
                <Button
                  variant="ghost"
                  size="iconSm"
                  aria-label="Search comments"
                  aria-pressed={query !== null}
                  onClick={() => setQuery(query === null ? "" : null)}
                  className={cn(query !== null && "bg-raised text-ink")}
                >
                  <Icon name="search" size={14} />
                </Button>
                {tools}
              </span>
            </div>
            {query !== null && (
              <div className="shrink-0 px-3 pb-2 lg:px-4">
                <Input
                  size="sm"
                  autoFocus
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    // The player's keys stay out of the field; Escape puts it away.
                    event.stopPropagation();
                    if (event.key === "Escape") setQuery(null);
                  }}
                  placeholder="Search comments"
                  aria-label="Search comments"
                />
              </div>
            )}
            {used.length > 1 && (
              <fieldset className="m-0 flex min-w-0 shrink-0 flex-wrap gap-1 border-0 px-3 pt-0 pb-2 lg:px-4">
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
            {canComment && (
              <>
                {/* On a phone the composer opens as a sheet, so the comments stay in view. */}
                <div className="shrink-0 px-3 pb-3 @3xl/app:hidden">
                  <Button
                    variant="secondary"
                    className="w-full"
                    onClick={() => {
                      media?.pause();
                      capture();
                      setSheet(true);
                    }}
                  >
                    <Icon name="comment" size={14} />
                    {composerLabel}
                  </Button>
                </div>
                {sheet && (
                  <Dialog title="New comment" onClose={() => setSheet(false)}>
                    {/* Opened to write in: the text box takes focus. */}
                    <div onFocusCapture={capture} ref={sheetBody}>
                      {composerBody}
                    </div>
                  </Dialog>
                )}
              </>
            )}
            <div className="scroll-quiet flex flex-col gap-3 px-3 pb-4 lg:min-h-0 lg:flex-1 lg:overflow-y-auto lg:px-4">
              {error && (
                <Failed
                  what="The comments"
                  error={error}
                  retry={refetch}
                  size="panel"
                  className="px-0"
                />
              )}
              {data && listed.length === 0 && (
                <p className="m-0 py-8 text-center text-[13px] text-ink-3">
                  {query?.trim()
                    ? "Nothing matches."
                    : onlyCategory
                      ? "Nothing in this category."
                      : shownFilter === "open"
                        ? canComment
                          ? "No comments yet. Play, then write one at the playhead, over a passage, or on the whole file."
                          : "No comments yet."
                        : shownFilter === "resolved"
                          ? "Nothing resolved yet."
                          : shownFilter === "deferred"
                            ? "Nothing deferred."
                            : "No comments yet."}
                </p>
              )}
              <ul className="m-0 flex list-none flex-col p-0">{listed.map(view)}</ul>
              {shownFilter === "open" && threads.hidden.length > 0 && (
                <p className="m-0 flex items-center gap-1.5 text-[12px] text-ink-3">
                  {threads.hidden.length} carried{" "}
                  {threads.hidden.length === 1 ? "thread is" : "threads are"} hidden on this
                  version.
                </p>
              )}
            </div>
            {canComment && (
              <div
                ref={composer}
                onFocusCapture={capture}
                className="hidden shrink-0 border-t border-line px-3 py-3 @3xl/app:block lg:px-4"
              >
                {composerBody}
              </div>
            )}
          </section>
        </Mentionable>
      </VersionNaming.Provider>
    </TimeFormatting.Provider>
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
 * The open threads with a moment, numbered in the order they play (#562): "#1" on a thread
 * and on its marker over the media are the same thread. Ties go to the one written first.
 */
export function threadNumbers(comments: Comment[]): Map<string, number> {
  const timed = comments.flatMap((c) => {
    if (c.parentId || c.resolvedAt || c.carry?.visible === false) return [];
    // A bar comment is numbered by the moment it was named at.
    const at = anchorTime(c.anchor ?? null);
    return at === null ? [] : [{ id: c.id, at, created: c.createdAt }];
  });
  timed.sort((a, b) => a.at - b.at || a.created.localeCompare(b.created));
  return new Map(timed.map((t, i) => [t.id, i + 1]));
}

/** A thread's first line, for its marker's preview on hover (#562). */
const firstLine = (c: Comment) => {
  const line = c.body.split("\n")[0]?.trim() ?? "";
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
};

/**
 * The open threads with a moment, as numbered markers over the media (#562): where each
 * starts and, for a passage, where it ends, how pressing it is, and its first line.
 */
export function commentMarkers(comments: Comment[]): TimelineMarker[] {
  const numbers = threadNumbers(comments);
  return comments
    .flatMap((c): TimelineMarker[] => {
      const number = numbers.get(c.id);
      const at = anchorTime(c.anchor ?? null);
      if (number === undefined || at === null) return [];
      const a = c.anchor;
      const end =
        a?.kind === "time" ? a.end : a?.kind === "region" && a.end !== undefined ? a.end : at;
      return [
        {
          id: c.id,
          number,
          at,
          ...(end > at ? { end } : {}),
          state: markerState(c),
          preview: `${c.authorName ?? "Former member"}: ${firstLine(c)}`,
        },
      ];
    })
    .sort((a, b) => a.number - b.number);
}

/** The open threads' drawings on a video, each shown on its frame or through its range (#146). */
export function frameDrawings(comments: Comment[]): FrameDrawing[] {
  const out: FrameDrawing[] = [];
  for (const c of comments) {
    if (c.parentId || c.resolvedAt || c.carry?.visible === false) continue;
    const a = c.anchor;
    if (a?.kind !== "region" || !a.drawing || a.at === undefined) continue;
    out.push({
      id: c.id,
      drawing: a.drawing,
      at: a.at,
      ...(a.end === undefined ? {} : { end: a.end }),
    });
  }
  return out;
}

export function useFrameDrawings(fileId: string, enabled = true): FrameDrawing[] {
  const { data } = useQuery({ ...commentsQuery(fileId), enabled });
  return data ? frameDrawings(data) : [];
}

export function useCommentMarkers(fileId: string, enabled = true): TimelineMarker[] {
  const { data } = useQuery({ ...commentsQuery(fileId), enabled });
  return data ? commentMarkers(data) : [];
}
