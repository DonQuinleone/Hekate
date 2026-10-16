import type { ReactNode } from "react";

/** What a place looks like with nothing in it yet, and what to do next. */
export function Empty({
  title,
  text,
  action,
}: {
  title: string;
  text?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-panel-lg border border-dashed border-line-strong px-6 py-16 text-center">
      <h2 className="text-[16px] font-medium">{title}</h2>
      {text && <p className="max-w-sm text-ink-2">{text}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
