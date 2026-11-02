import type { ButtonHTMLAttributes, HTMLAttributes } from "react";
import { cn } from "~/lib/cn";
import { Icon } from "../icons";

/** A small bordered pill for a tag, a count or a filter; never for a type an icon already shows. */
export function Chip({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-chip border border-line px-1.5 text-[11px] leading-5 text-ink-3",
        className,
      )}
      {...props}
    />
  );
}

/**
 * How many (#609), written one way: after its label, as a number and nothing else ("Works 1",
 * never "Works · 1" or "1 work"). Quiet by default; `signal` for a count that needs someone,
 * such as unread notifications: tabular and round.
 */
export function Count({
  className,
  tone = "quiet",
  ...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: "quiet" | "signal" }) {
  return (
    <span
      className={cn(
        "tabular",
        tone === "signal"
          ? "inline-flex min-w-[18px] items-center justify-center rounded-full bg-signal px-1.5 text-[11px] leading-[18px] font-medium text-ground"
          : "ml-1.5 text-[0.875em] font-normal text-ink-3",
        className,
      )}
      {...props}
    />
  );
}

/**
 * One of several things that are each on or off (the fields a board card shows, a guest's
 * tools, the ways people may sign in), free to wrap. Pressed, it takes the raised ground, ink
 * and a tick; off, a hairline and tertiary ink. One choice among a few is a `Segmented`
 * instead, whose selection looks different.
 */
export function ToggleChip({
  pressed,
  className,
  children,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "aria-pressed"> & { pressed: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className={cn(
        "inline-flex h-7 cursor-pointer items-center gap-1 rounded-chip border px-2.5 text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-3 disabled:cursor-not-allowed disabled:opacity-50",
        pressed
          ? "border-edge-strong bg-raised pl-1.5 text-ink"
          : "border-line text-ink-3 enabled:hover:border-edge enabled:hover:text-ink",
        className,
      )}
      {...props}
    >
      {pressed && <Icon name="check" size={13} className="shrink-0" />}
      {children}
    </button>
  );
}
