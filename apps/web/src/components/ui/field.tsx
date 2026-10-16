import type { ReactNode } from "react";
import { cn } from "~/lib/cn";

/**
 * A form field: its label above in secondary ink, the control, a hint below, and what is
 * wrong under it in signal (never a red border alone).
 */
export function Field({
  label,
  hint,
  error,
  className,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed in as a child.
    <label className={cn("flex min-w-0 flex-col gap-1.5 text-[13px] text-ink-2", className)}>
      {label}
      {children}
      {hint && !error && <span className="text-[12px] text-ink-3">{hint}</span>}
      {error && (
        <span role="alert" className="text-[12px] text-signal">
          {error}
        </span>
      )}
    </label>
  );
}
