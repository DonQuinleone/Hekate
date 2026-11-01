import type { ReactNode } from "react";
import { cn } from "~/lib/cn";

/** A quiet heading over a group, a column or a property. Sentence case, the same face as everything else. */
export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("eyebrow", className)}>{children}</span>;
}

/** How many (#609), after its label as a quiet number: "Works 1", written one way everywhere. */
export function Count({ children }: { children: ReactNode }) {
  return <span className="tabular ml-1.5 font-normal text-ink-3">{children}</span>;
}

export function Kbd({ children }: { children: string }) {
  return (
    <kbd className="tabular inline-flex h-5 min-w-5 items-center justify-center rounded-chip border border-line-strong bg-raised px-1.5 font-sans text-[11px] text-ink-2">
      {children}
    </kbd>
  );
}
