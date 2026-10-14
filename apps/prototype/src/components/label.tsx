import type { ReactNode } from "react";
import { cn } from "~/lib/cn";

/** An upper-case mono label over a group or a column, as docs/brand.md sets it. */
export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("label", className)}>{children}</span>;
}

export function Kbd({ children }: { children: string }) {
  return (
    <kbd className="tabular inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-chip border border-edge bg-raised px-1 text-[10px] text-ink-2">
      {children}
    </kbd>
  );
}
