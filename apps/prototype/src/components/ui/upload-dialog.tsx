import type { ReactNode } from "react";
import { Icon, type IconName } from "~/components/icons";
import { cn } from "~/lib/cn";
import { formatBytes } from "~/lib/format";
import { Button } from "./button";
import { Dialog } from "./dialog";

/**
 * The one way a file is chosen in a dialog (#477): a new version, a variation, a marker
 * list, a session's takes, a comment's attachments. A drop zone that is also the file picker
 * (a real file input under it, for the keyboard and screen readers), the files chosen listed
 * with their size and a way to take each off, the field or two the job needs, a line on what
 * will happen, and the primary action named for the job. Where the job uploads, each file's
 * progress shows on its row; what went wrong sits under the file it concerns.
 *
 * The prototype has no files to take: the zone, however it is used, picks the screen's
 * sample files.
 */

export type ChosenState = "waiting" | "sending" | "sent" | "failed";

export interface ChosenFile {
  key: string;
  name: string;
  size: number | null;
  state?: ChosenState;
  /** Sent, out of the whole, while uploading. */
  share?: number;
  error?: string | null;
}

/** The file's kind by its name, for the row's icon. */
function iconFor(name: string): IconName {
  if (/\.(wav|wave|bwf|rf64|aif|aiff|flac|mp3|m4a|aac|ogg|opus|caf)$/i.test(name)) return "music";
  if (/\.(mp4|mov|mkv|mxf|avi|webm|m4v|mts|m2ts)$/i.test(name)) return "film";
  if (/\.(png|jpe?g|gif|webp|tiff?|heic|avif|bmp|svg)$/i.test(name)) return "image";
  return "file";
}

/** Where files are dropped or chosen: a label over a file input. */
export function UploadZone({
  prompt,
  hint,
  inputLabel,
  multiple = false,
  compact = false,
  onPick,
}: {
  prompt: string;
  hint?: string;
  inputLabel: string;
  multiple?: boolean;
  /** Once something is chosen and more may follow. */
  compact?: boolean;
  onPick: () => void;
}) {
  return (
    <label
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onPick();
      }}
      className={cn(
        "relative flex w-full cursor-pointer flex-col items-center gap-2 rounded-panel border border-edge border-dashed text-center transition-colors hover:bg-raised/40 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ink-3",
        compact ? "px-4 py-4" : "px-6 py-10",
      )}
    >
      <input
        type="file"
        className="sr-only"
        aria-label={inputLabel}
        multiple={multiple}
        onClick={(e) => {
          // No chooser here: the click itself picks the sample.
          e.preventDefault();
          onPick();
        }}
      />
      <Icon name="upload" size={compact ? 16 : 20} className="text-ink-3" />
      <span className="text-[14px] text-ink">{prompt}</span>
      {hint && !compact && <span className="text-[13px] text-ink-3">{hint}</span>}
    </label>
  );
}

function stateOf(chosen: ChosenFile) {
  switch (chosen.state) {
    case "sending":
      return `${Math.floor((chosen.share ?? 0) * 100)}%`;
    case "failed":
      return "Failed";
    case "sent":
      return "Uploaded";
    default:
      return null;
  }
}

/** The files chosen, each with its size, its state and a way to take it off the list. */
export function ChosenList({
  chosen,
  label = "Files chosen",
  row,
  onRemove,
}: {
  chosen: ChosenFile[];
  label?: string;
  /** Below a file: what the job asks of it (a variation's name). */
  row?: (chosen: ChosenFile) => ReactNode;
  onRemove?: (key: string) => void;
}) {
  if (chosen.length === 0) return null;
  return (
    <ul aria-label={label} className="m-0 flex list-none flex-col gap-1 p-0">
      {chosen.map((c) => (
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
              {[c.size !== null && c.state !== "sending" ? formatBytes(c.size) : null, stateOf(c)]
                .filter(Boolean)
                .join(" · ")}
            </span>
            <Button
              variant="ghost"
              size="iconSm"
              aria-label={`Remove ${c.name}`}
              disabled={c.state === "sending"}
              onClick={() => onRemove?.(c.key)}
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
              aria-valuenow={Math.floor((c.share ?? 0) * 100)}
              className="block h-1 overflow-hidden rounded-full bg-raised"
            >
              <span
                className="block h-full bg-ink-2"
                style={{ width: `${(c.share ?? 0) * 100}%` }}
              />
            </span>
          )}
          {c.state === "failed" && c.error && (
            <p className="m-0 text-[12px] text-signal">{c.error}</p>
          )}
          {row && <div className="pl-7">{row(c)}</div>}
        </li>
      ))}
    </ul>
  );
}

export function UploadDialog({
  title,
  description,
  width,
  onClose,
  inputLabel,
  prompt,
  hint,
  multiple = false,
  listLabel,
  chosen,
  onPick,
  onRemove,
  row,
  fields,
  alternatives,
  what,
  error,
  action,
  disabled = false,
  onAction,
  children,
}: {
  title: string;
  description?: string;
  width?: "sm" | "md" | "lg" | "xl";
  onClose: () => void;
  /** The file input's accessible name: "Marker list", "Session files". */
  inputLabel: string;
  /** The zone's line: "Drop the marker list here, or choose it". */
  prompt: string;
  /** The zone's second line, while nothing is chosen. */
  hint?: string;
  multiple?: boolean;
  listLabel?: string;
  chosen: ChosenFile[];
  /** The zone was used: the screen puts its sample files on the list. */
  onPick: () => void;
  onRemove?: (key: string) => void;
  /** Below each file: what the job asks of it (a variation's name). */
  row?: (chosen: ChosenFile) => ReactNode;
  /** One or two fields the job needs, after the list. */
  fields?: ReactNode;
  /** Another way to a file, beside the zone: the project's own, say. */
  alternatives?: ReactNode;
  /** One line on what will happen, before the action. */
  what?: ReactNode;
  /** What went wrong, in the job's words, with any way out it offers. */
  error?: ReactNode;
  /** The primary action's name: "Upload version 3", "Add variation", "Import markers". */
  action: string;
  disabled?: boolean;
  onAction: () => void;
  children?: ReactNode;
}) {
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
          <Button variant="primary" disabled={chosen.length === 0 || disabled} onClick={onAction}>
            {action}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          // Opened from inside a form (a comment's composer), it must not send that one too.
          e.stopPropagation();
          if (chosen.length > 0 && !disabled) onAction();
        }}
      >
        {zone && (
          <div className="flex flex-col gap-2">
            <UploadZone
              prompt={prompt}
              hint={hint}
              inputLabel={inputLabel}
              multiple={multiple}
              compact={chosen.length > 0}
              onPick={onPick}
            />
            {alternatives && (
              <div className="flex flex-wrap items-center justify-center gap-2">{alternatives}</div>
            )}
          </div>
        )}
        <ChosenList chosen={chosen} label={listLabel} row={row} onRemove={onRemove} />
        {fields}
        {children}
        {what && <p className="m-0 text-[13px] text-ink-2">{what}</p>}
        {error}
      </form>
    </Dialog>
  );
}
