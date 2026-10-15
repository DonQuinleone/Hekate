import type { ReactNode } from "react";
import { cn } from "~/lib/cn";

/**
 * Every page sits in the same frame: one gutter on every side, content starting at the left,
 * capped only on very wide windows. Narrow content (a form, a letter) limits itself inside.
 */
export function Page({
  children,
  className,
  width = "default",
}: {
  children: ReactNode;
  className?: string;
  width?: "default" | "narrow" | "full";
}) {
  return (
    <div
      className={cn(
        "fade-in flex w-full flex-col gap-8 px-5 py-6 @3xl/app:px-10 @3xl/app:py-8",
        width === "default" && "max-w-[1360px]",
        width === "narrow" && "max-w-[860px]",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A heading over a group on a page: the title, a count or hint, and an action at the right. */
export function SectionHead({
  title,
  hint,
  action,
  className,
}: {
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-h-8 items-center gap-3", className)}>
      <h2 className="text-[15px] font-medium text-ink">{title}</h2>
      {hint && <span className="tabular text-[13px] text-ink-3">{hint}</span>}
      {action && <span className="ml-auto flex items-center gap-1.5">{action}</span>}
    </div>
  );
}

/** A lifted card on the pane: a hairline, a whisper of fill, a soft shadow. */
export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-panel-lg border border-line bg-raised/25 shadow-1", className)}>
      {children}
    </div>
  );
}
