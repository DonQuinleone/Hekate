import type { ReactNode } from "react";

/** One fact in a list of them: its name, then its value. Use inside a `<dl>`. */
export function Property({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex min-h-9 items-start gap-3 py-1.5 text-[13px]">
      <dt className="w-20 shrink-0 pt-px text-ink-3">{name}</dt>
      <dd className="m-0 min-w-0 flex-1 break-words text-ink">{children}</dd>
    </div>
  );
}
