import { type ReactNode, useState } from "react";
import { Icon } from "~/components/icons";
import { cn } from "~/lib/cn";
import { ApiError } from "~/lib/queries";
import { Button } from "./button";

/*
 * A place's states besides its content (#545), as the prototype draws them
 * (apps/prototype/src/viewer/state-gate.tsx): Loading is the content's shape in quiet blocks,
 * never a word or a spinner; Failed says what could not be loaded, gives the reference to
 * quote and a way to try again; Refused says what cannot be opened and why, with a way back.
 * `page` fills a page or a pane; `panel` sits in a list or a section, a row high.
 */

type Size = "page" | "panel" | "line";

const widths = [72, 48, 64, 40, 58, 52];

/** Rows of placeholder blocks where the content will be: no spinner, no shift when it arrives. */
export function Loading({
  rows,
  size = "page",
  label = "Loading",
  className,
}: {
  rows?: number;
  size?: Size;
  /** What screen readers hear, when "Loading" alone would not say what. */
  label?: string;
  className?: string;
}) {
  if (size === "line") {
    return (
      <output
        aria-live="polite"
        aria-label={label}
        className={cn(
          "inline-block h-3 w-20 animate-pulse rounded-chip bg-raised align-middle",
          className,
        )}
      />
    );
  }
  const count = rows ?? (size === "page" ? 6 : 3);
  return (
    <output
      aria-live="polite"
      aria-label={label}
      className={cn(
        "flex flex-col",
        size === "page" ? "gap-3 px-6 py-6" : "gap-2 px-4 py-3",
        className,
      )}
    >
      {Array.from({ length: count }, (_, i) => (
        <span
          key={String(i)}
          className={cn(
            "block animate-pulse rounded-control bg-raised/60",
            size === "page" ? "h-9" : "h-5",
          )}
          style={{ width: `${widths[i % widths.length]}%`, animationDelay: `${i * 80}ms` }}
        />
      ))}
    </output>
  );
}

/** Whether an error is a refusal (not there, or not theirs to open) rather than a failure. */
export const isRefusal = (error: unknown) =>
  error instanceof ApiError && (error.code === "not_found" || error.code === "forbidden");

/** A failure's reference (#159), to quote to support, when the server recorded one. */
export const referenceOf = (error: unknown) =>
  error instanceof ApiError ? error.reference : undefined;

/**
 * What to say about a failure: the server's own words where it refused something for a
 * reason it gave, and otherwise plain words, the reference standing on its own line.
 */
export function failureText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.reference || error.code === "internal")
      return "Something went wrong on the server. Your work is kept; try again in a moment.";
    // The server's message is written for people, but quoting adds the reference to it.
    return error.message;
  }
  return "Hekate could not reach the server. Your work is kept; try again in a moment.";
}

/** The reference, with a way to copy it. */
function Reference({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="inline-flex items-center gap-2 text-[13px] text-ink-3">
      Reference <span className="tabular text-ink-2 select-all">{value}</span>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => setCopied(true));
        }}
      >
        {copied ? "Copied" : "Copy"}
      </Button>
    </span>
  );
}

/**
 * Something could not be loaded: what, why in plain words, the reference to quote, and Try
 * again. A refusal (not found, not allowed) is shown as Refused instead.
 */
export function Failed({
  what,
  error,
  retry,
  size = "page",
  className,
}: {
  /** What could not be loaded, as the start of a sentence: "This track", "The board". */
  what?: string;
  error?: unknown;
  /** Usually the query's `refetch`. */
  retry?: () => unknown;
  size?: Exclude<Size, "line">;
  className?: string;
}) {
  if (isRefusal(error)) return <Refused size={size} className={className} />;
  const title = `${what ?? "This"} could not be loaded`;
  const text = failureText(error);
  const reference = referenceOf(error);
  if (size === "panel") {
    return (
      <div
        role="alert"
        className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3", className)}
      >
        <Icon name="close" size={13} className="shrink-0 text-signal" />
        <span className="min-w-0 flex-1 text-[13px] text-ink-2">
          <span className="text-ink">{title}.</span> {text}
        </span>
        {reference && <Reference value={reference} />}
        {retry && (
          <Button size="sm" onClick={() => void retry()}>
            Try again
          </Button>
        )}
      </div>
    );
  }
  return (
    <div
      role="alert"
      className={cn(
        "mx-auto flex w-full max-w-md flex-col items-start gap-3 px-6 py-16",
        className,
      )}
    >
      <span className="flex size-8 items-center justify-center rounded-full border border-signal/60 text-signal">
        <Icon name="close" size={14} />
      </span>
      <h2 className="m-0 text-[16px] font-medium text-ink">{title}</h2>
      <p className="m-0 text-ink-2">{text}</p>
      {reference && <Reference value={reference} />}
      {retry && <Button onClick={() => void retry()}>Try again</Button>}
    </div>
  );
}

/** Something cannot be opened: not there, or not this person's to open, and a way back. */
export function Refused({
  title = "Not found",
  text = "There is nothing at this address, or you do not have access to it.",
  action,
  size = "page",
  className,
}: {
  title?: string;
  text?: string;
  /** A way on: back to where they came from, or to sign in as someone else. */
  action?: ReactNode;
  size?: Exclude<Size, "line">;
  className?: string;
}) {
  if (size === "panel") {
    return (
      <p className={cn("m-0 px-4 py-3 text-[13px] text-ink-2", className)}>
        <span className="text-ink">{title}.</span> {text}
      </p>
    );
  }
  return (
    <div
      className={cn(
        "mx-auto flex w-full max-w-md flex-col items-start gap-3 px-6 py-16",
        className,
      )}
    >
      <h2 className="m-0 text-[16px] font-medium text-ink">{title}</h2>
      <p className="m-0 text-ink-2">{text}</p>
      {action}
    </div>
  );
}
