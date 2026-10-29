import { formatBytes } from "@hekate/shared";
import { type DragEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Icon, type IconName } from "~/components/icons";
import { cn } from "~/lib/cn";
import { type Picked, pickedFromDrop, pickedFromList } from "~/lib/picked-files";
import { Button } from "./button";
import { Dialog } from "./dialog";

/**
 * The one way a file is chosen in a dialog (#477): a new version, a variation, a marker
 * list, a session's takes, a comment's attachments. A drop zone that is also the file picker
 * (a real file input under it, for the keyboard and screen readers), the files chosen listed
 * with their size and a way to take each off, the one or two fields the job needs, a line on
 * what will happen, and the primary action named for the job. Where the job uploads, each
 * file's progress shows on its row; what goes wrong is said in the dialog, by the file it
 * concerns.
 */

export type ChosenState = "waiting" | "sending" | "sent" | "failed";

/** A file on the list: from this computer, or one the project already holds. */
export interface ChosenFile<T = unknown> {
  key: string;
  name: string;
  size: number | null;
  /** The file itself; null for one already in the project, which needs no upload. */
  file: File | null;
  /** The folder it was found in, when a folder was dropped or chosen; "" otherwise. */
  folder: string;
  state: ChosenState;
  /** Sent, out of the whole, while uploading. */
  share: number;
  error: string | null;
  /** What sending it returned (the file made, say); set from the start for a project's own. */
  result: T | null;
}

/** One the project already holds, put on the list as sent. */
export interface ReadyFile<T> {
  key: string;
  name: string;
  size?: number | null;
  result: T;
}

/** Files uploaded at once; each sends its chunks three at a time. */
const PARALLEL = 2;
/** Rows drawn of a long list; the rest are counted. */
const SHOWN = 40;

/** The same file twice is one; two alike in different folders (one per microphone) are two. */
const keyOf = (file: File, folder: string) =>
  `${folder}/${file.name}:${file.size}:${file.lastModified}`;

/** The file's kind by its name, for the row's icon: a finer reading comes once it is probed. */
export function iconFor(name: string): IconName {
  if (/\.(wav|wave|bwf|rf64|aif|aiff|flac|mp3|m4a|aac|ogg|opus|wma|caf)$/i.test(name))
    return "music";
  if (/\.(mp4|mov|mkv|mxf|avi|webm|m4v|mts|m2ts|prores)$/i.test(name)) return "film";
  if (/\.(png|jpe?g|gif|webp|tiff?|heic|avif|bmp|svg)$/i.test(name)) return "image";
  return "file";
}

const plural = (n: number, one: string) => `${n.toLocaleString()} ${n === 1 ? one : `${one}s`}`;

/**
 * Where files are dropped or chosen: a label over a file input, so clicking it, tabbing to
 * it and dropping on it all choose. `compact` once something is chosen and more may follow.
 */
export function UploadZone({
  prompt,
  hint,
  inputLabel,
  accept,
  multiple = false,
  compact = false,
  disabled = false,
  onPick,
}: {
  prompt: string;
  hint?: string | undefined;
  /** The file input's accessible name: "Marker list", "Session files". */
  inputLabel: string;
  accept?: string | undefined;
  multiple?: boolean;
  compact?: boolean;
  disabled?: boolean;
  onPick: (picked: Picked[]) => void;
}) {
  const [over, setOver] = useState(false);
  const stop = (event: DragEvent) => {
    // The page behind (a project's files) takes drops of its own; this one is the dialog's.
    event.preventDefault();
    event.stopPropagation();
  };
  return (
    <label
      onDragEnter={stop}
      onDragOver={(event) => {
        stop(event);
        setOver(true);
      }}
      onDragLeave={(event) => {
        stop(event);
        setOver(false);
      }}
      onDrop={(event) => {
        stop(event);
        setOver(false);
        if (!disabled) void pickedFromDrop(event.dataTransfer).then(onPick);
      }}
      className={cn(
        "relative flex w-full cursor-pointer flex-col items-center gap-2 rounded-panel border border-dashed text-center transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ink-3 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60",
        compact ? "px-4 py-4" : "px-6 py-10",
        over ? "border-ink-3 bg-raised/40" : "border-edge hover:bg-raised/40",
      )}
    >
      <input
        type="file"
        className="sr-only"
        aria-label={inputLabel}
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        onChange={(event) => {
          if (event.target.files?.length) onPick(pickedFromList(event.target.files));
          event.target.value = "";
        }}
      />
      <Icon name="upload" size={compact ? 16 : 20} className="text-ink-3" />
      <span className="text-[14px] text-ink">{prompt}</span>
      {hint && !compact && <span className="text-[13px] text-ink-3">{hint}</span>}
    </label>
  );
}

/** A whole folder chosen at once, beside the zone: a day's recording as the recorder left it. */
export function FolderChooser({
  label,
  disabled = false,
  onPick,
}: {
  label: string;
  disabled?: boolean;
  onPick: (picked: Picked[]) => void;
}) {
  return (
    <Button variant="ghost" size="sm" asChild>
      <label className="relative has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ink-3">
        <input
          type="file"
          className="sr-only"
          aria-label={label}
          disabled={disabled}
          {...{ webkitdirectory: "" }}
          onChange={(event) => {
            if (event.target.files?.length) onPick(pickedFromList(event.target.files));
            event.target.value = "";
          }}
        />
        <Icon name="folder" size={14} />
        Choose a folder
      </label>
    </Button>
  );
}

function stateOf<T>(chosen: ChosenFile<T>) {
  switch (chosen.state) {
    case "sending":
      return `${Math.floor(chosen.share * 100)}%`;
    case "failed":
      return "Failed";
    case "sent":
      return chosen.file ? "Uploaded" : chosen.size === null ? "In the project" : null;
    default:
      return null;
  }
}

/** The files chosen, each with its size, its state and a way to take it off the list. */
export function ChosenList<T>({
  chosen,
  label = "Files chosen",
  row,
  disabled = false,
  onRemove,
}: {
  chosen: ChosenFile<T>[];
  label?: string;
  /** Below a file: what the job asks of it (a variation's name). */
  row?: ((chosen: ChosenFile<T>) => ReactNode) | undefined;
  disabled?: boolean;
  onRemove: (key: string) => void;
}) {
  if (chosen.length === 0) return null;
  const more = Math.max(0, chosen.length - SHOWN);
  return (
    <ul aria-label={label} className="m-0 flex list-none flex-col gap-1 p-0">
      {chosen.slice(0, SHOWN).map((c) => {
        const state = stateOf(c);
        return (
          <li key={c.key} className="flex flex-col gap-1.5 rounded-control bg-ground px-3 py-2">
            <div className="flex items-center gap-3">
              <Icon name={iconFor(c.name)} size={14} className="shrink-0 text-ink-3" />
              <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{c.name}</span>
              <span
                className={cn(
                  "tabular shrink-0 text-[12px]",
                  c.state === "failed" ? "text-signal" : "text-ink-3",
                )}
              >
                {[c.size !== null && c.state !== "sending" ? formatBytes(c.size) : null, state]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
              <Button
                variant="ghost"
                size="iconSm"
                aria-label={`Remove ${c.name}`}
                disabled={disabled || c.state === "sending"}
                onClick={() => onRemove(c.key)}
              >
                <Icon name="close" size={12} />
              </Button>
            </div>
            {c.state === "sending" && (
              <span
                role="progressbar"
                aria-label={`Uploading ${c.name}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.floor(c.share * 100)}
                className="block h-1 overflow-hidden rounded-full bg-raised"
              >
                <span
                  className="block h-full bg-ink-2 transition-[width]"
                  style={{ width: `${c.share * 100}%` }}
                />
              </span>
            )}
            {c.state === "failed" && c.error && (
              <p className="m-0 text-[12px] text-signal">{c.error}</p>
            )}
            {row && <div className="pl-7">{row(c)}</div>}
          </li>
        );
      })}
      {more > 0 && (
        <li className="px-3 py-1.5 text-[12px] text-ink-3">and {plural(more, "more")}</li>
      )}
    </ul>
  );
}

export interface UploadDialogProps<T> {
  title: string;
  description?: string | undefined;
  width?: "sm" | "md" | "lg" | "xl";
  onClose: () => void;
  /** The file input's accessible name: "Marker list", "Session files". */
  inputLabel: string;
  /** The zone's line: "Drop the marker list here, or choose it". */
  prompt: string;
  /** The zone's second line, while nothing is chosen. */
  hint?: string | undefined;
  accept?: string | undefined;
  multiple?: boolean;
  /** Files dropped on the page before the dialog opened (a track's takes): taken as it opens. */
  initial?: Picked[] | undefined;
  /** The list's accessible name. */
  listLabel?: string;
  /** Offers a whole folder too, under this name for its input. */
  folderLabel?: string | undefined;
  /** Why a file cannot be taken, if it cannot; it is then said, not taken. */
  check?: (file: File) => string | null;
  /** Most files the list holds. */
  limit?: number | undefined;
  /**
   * Sends one file when the action is pressed; what it returns stays on the row. Without it
   * the files go to `onSubmit` as they are (read in the page, or attached later).
   */
  send?: (file: File, onProgress: (share: number) => void, signal: AbortSignal) => Promise<T>;
  /** The primary action's name, or how to name it for what is chosen. */
  action: string | ((chosen: ChosenFile<T>[]) => string);
  /**
   * Once every file is sent: what the job does with them. `hint` is what a retry from
   * `problem` passed (letting a refused version through, say). Throwing shows the error.
   */
  onSubmit: (chosen: ChosenFile<T>[], hint?: unknown) => Promise<unknown> | unknown;
  /** The job's own reasons not to go yet, besides needing a file. */
  disabled?: boolean;
  /** Each time the list changes: a file taken, one taken off. */
  onChange?: (chosen: ChosenFile<T>[]) => void;
  /** Below each file: what the job asks of it (a variation's name). */
  row?: ((chosen: ChosenFile<T>) => ReactNode) | undefined;
  /** One or two fields the job needs, after the list. */
  fields?: ReactNode;
  /** One line on what will happen, before the action. */
  what?: ReactNode;
  /** Another way to a file, beside the zone: `add` puts one the project holds on the list. */
  alternatives?: ((add: (ready: ReadyFile<T>) => void) => ReactNode) | undefined;
  /** Something wrong with the choice, in the job's words. */
  error?: ReactNode;
  /** A problem the job raised, drawn with a way to try again; by default, its message. */
  problem?: (error: Error, again: (hint?: unknown) => void) => ReactNode;
  children?: ReactNode;
}

export function UploadDialog<T = unknown>({
  title,
  description,
  width,
  onClose,
  inputLabel,
  prompt,
  hint,
  accept,
  multiple = false,
  initial,
  listLabel,
  folderLabel,
  check,
  limit,
  send,
  action,
  onSubmit,
  disabled = false,
  onChange,
  row,
  fields,
  what,
  alternatives,
  error,
  problem,
  children,
}: UploadDialogProps<T>) {
  const formId = useId();
  const [chosen, setChosen] = useState<ChosenFile<T>[]>([]);
  // The list as it stands, for the sending that outlives a render.
  const latest = useRef<ChosenFile<T>[]>([]);
  const [refused, setRefused] = useState<string[]>([]);
  const [fault, setFault] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const stopper = useRef<AbortController | null>(null);
  // The callback as it is when the uploads finish, not when they began: a name or a choice
  // edited meanwhile goes with the files.
  const submit = useRef(onSubmit);
  submit.current = onSubmit;
  useEffect(() => {
    const controller = new AbortController();
    stopper.current = controller;
    // Closing the dialog stops what it was sending.
    return () => controller.abort();
  }, []);

  const change = (next: (list: ChosenFile<T>[]) => ChosenFile<T>[]) => {
    latest.current = next(latest.current);
    setChosen(latest.current);
  };
  const update = (key: string, patch: Partial<ChosenFile<T>>) =>
    change((list) => list.map((c) => (c.key === key ? { ...c, ...patch } : c)));
  const changed = () => {
    setFault(null);
    onChange?.(latest.current);
  };

  const take = (picked: Picked[]) => {
    const reasons: string[] = [];
    const fits: ChosenFile<T>[] = [];
    for (const { file, folder } of multiple ? picked : picked.slice(0, 1)) {
      const key = keyOf(file, folder);
      // The same file chosen twice goes once.
      if (latest.current.some((c) => c.key === key) || fits.some((c) => c.key === key)) continue;
      const why = check?.(file) ?? null;
      if (why) {
        reasons.push(`${file.name}: ${why}`);
        continue;
      }
      fits.push({
        key,
        name: file.name,
        size: file.size,
        file,
        folder,
        state: "waiting",
        share: 0,
        error: null,
        result: null,
      });
    }
    const room =
      limit === undefined
        ? fits.length
        : Math.max(0, limit - (multiple ? latest.current.length : 0));
    if (fits.length > room) {
      reasons.push(
        room === 0
          ? `At most ${plural(limit ?? 0, "file")} here`
          : `At most ${plural(limit ?? 0, "file")} here: the first ${room} of these were taken`,
      );
    }
    const kept = fits.slice(0, room);
    if (kept.length > 0) {
      change((list) => (multiple ? [...list, ...kept] : kept));
      changed();
    }
    setRefused(reasons.slice(0, 5));
  };
  const add = (ready: ReadyFile<T>) => {
    const entry: ChosenFile<T> = {
      key: ready.key,
      name: ready.name,
      size: ready.size ?? null,
      file: null,
      folder: "",
      state: "sent",
      share: 1,
      error: null,
      result: ready.result,
    };
    change((list) => (multiple ? [...list.filter((c) => c.key !== entry.key), entry] : [entry]));
    setRefused([]);
    changed();
  };
  const remove = (key: string) => {
    change((list) => list.filter((c) => c.key !== key));
    setRefused([]);
    changed();
  };
  // What was dropped before the dialog opened goes on the list once, as it opens.
  const opened = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: taken once, as the dialog opens.
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    if (initial && initial.length > 0) take(initial);
  }, []);

  /** Every file not yet sent, a couple at a time; false if any could not be. */
  const sendAll = async (signal: AbortSignal) => {
    if (!send) return true;
    const queue = latest.current.filter((c) => c.file && c.state !== "sent");
    let ok = true;
    const worker = async () => {
      for (let item = queue.shift(); item; item = queue.shift()) {
        const { key, file } = item;
        if (!file) continue;
        update(key, { state: "sending", share: 0, error: null });
        try {
          const result = await send(file, (share) => update(key, { share }), signal);
          update(key, { state: "sent", share: 1, result });
        } catch (failure) {
          if (signal.aborted) return;
          ok = false;
          update(key, {
            state: "failed",
            share: 0,
            error: failure instanceof Error ? failure.message : "It could not be uploaded",
          });
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(PARALLEL, Math.max(queue.length, 1)) }, worker),
    );
    return ok;
  };
  const go = async (hint?: unknown) => {
    if (busy || latest.current.length === 0) return;
    const signal = stopper.current?.signal ?? new AbortController().signal;
    setBusy(true);
    setFault(null);
    try {
      if (!(await sendAll(signal)) || signal.aborted) return;
      await submit.current(latest.current, hint);
    } catch (failure) {
      if (!signal.aborted)
        setFault(failure instanceof Error ? failure : new Error("It could not be done"));
    } finally {
      setBusy(false);
    }
  };

  const sending = chosen.some((c) => c.state === "sending");
  const label = typeof action === "function" ? action(chosen) : action;
  // One file at a time: the zone gives way to the file, and comes back when it is taken off.
  const zone = multiple || chosen.length === 0;
  return (
    <Dialog
      title={title}
      description={description}
      onClose={onClose}
      width={width}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={formId}
            variant="primary"
            disabled={chosen.length === 0 || busy || sending || disabled}
          >
            {label}
          </Button>
        </>
      }
    >
      <form
        id={formId}
        onSubmit={(event) => {
          event.preventDefault();
          // Opened from inside a form (a comment's composer), it must not send that one too.
          event.stopPropagation();
          void go();
        }}
        className="flex flex-col gap-4"
      >
        {zone && (
          <div className="flex flex-col gap-2">
            <UploadZone
              prompt={prompt}
              hint={hint}
              inputLabel={inputLabel}
              accept={accept}
              multiple={multiple}
              compact={chosen.length > 0}
              disabled={busy}
              onPick={take}
            />
            {(folderLabel || alternatives) && (
              <div className="flex flex-wrap items-center justify-center gap-2">
                {folderLabel && <FolderChooser label={folderLabel} disabled={busy} onPick={take} />}
                {alternatives?.(add)}
              </div>
            )}
          </div>
        )}
        {refused.length > 0 && (
          <ul
            role="alert"
            className="m-0 flex list-none flex-col gap-0.5 p-0 text-[13px] text-signal"
          >
            {refused.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        )}
        <ChosenList chosen={chosen} label={listLabel} row={row} disabled={busy} onRemove={remove} />
        {fields}
        {children}
        {what && <p className="m-0 text-[13px] text-ink-2">{what}</p>}
        {error && (
          <p role="alert" className="m-0 text-[13px] text-signal">
            {error}
          </p>
        )}
        {fault &&
          (problem?.(fault, (hint) => void go(hint)) ?? (
            <p role="alert" className="m-0 text-[13px] text-signal">
              {fault.message}
            </p>
          ))}
      </form>
    </Dialog>
  );
}
