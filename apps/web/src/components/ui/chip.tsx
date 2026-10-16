import type { ButtonHTMLAttributes, HTMLAttributes } from "react";
import { cn } from "~/lib/cn";

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

/** A count that needs someone, such as unread notifications: signal, tabular, round. */
export function Count({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "tabular inline-flex min-w-[18px] items-center justify-center rounded-full bg-signal px-1.5 text-[11px] leading-[18px] font-medium text-ground",
        className,
      )}
      {...props}
    />
  );
}

/**
 * A choice among a few, pressed or not, for quick picks beside a field (a due date in a week,
 * the rule an approval settles by): quieter than a segmented control, and free to wrap.
 */
export function ToggleChip({
  pressed,
  className,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type" | "aria-pressed"> & { pressed: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className={cn(
        "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-chip border px-2.5 text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink-3 disabled:cursor-not-allowed disabled:opacity-50",
        pressed
          ? "border-edge bg-raised text-ink shadow-1"
          : "border-transparent text-ink-3 hover:text-ink",
        className,
      )}
      {...props}
    />
  );
}
