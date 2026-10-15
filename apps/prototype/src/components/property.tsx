import type { ReactNode } from "react";

/** One row of a properties column: a quiet name, then the value. */
export function Property({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex min-h-8 items-center gap-3 text-[13px]">
      <span className="w-24 shrink-0 text-ink-3">{name}</span>
      <span className="flex min-w-0 flex-1 items-center gap-2 text-ink">{children}</span>
    </div>
  );
}
