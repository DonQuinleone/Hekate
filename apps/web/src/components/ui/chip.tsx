import type { HTMLAttributes } from "react";
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
