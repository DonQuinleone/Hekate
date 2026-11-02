import type { ReactNode } from "react";

/**
 * The foot of a settings form inside its section (#682): what saving does, or what went wrong,
 * at the left, and its actions (Test, Save) at the right, once per form rather than as rows
 * named after buttons.
 */
export function FormFooter({ note, children }: { note?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 px-4 py-row @3xl/app:flex-row @3xl/app:items-center">
      <div className="min-w-0 flex-1 text-[13px] text-ink-3">{note}</div>
      <div className="flex shrink-0 items-center justify-end gap-2">{children}</div>
    </div>
  );
}
