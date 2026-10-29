import type { ReactNode } from "react";
import { cn } from "~/lib/cn";

/**
 * Two to four views of the same thing (list and grid, light and dark): one pressed at a
 * time. Tabs are for a third level of navigation only. An `action` adds one more to the set
 * (another variation beside the dry and the wet): a small button at its end, after a hairline.
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  action,
  className,
}: {
  /** What the choice is, for assistive technology. */
  label: string;
  value: T;
  /**
   * Each choice: its value, its words, an icon to show in place of the words, and a quiet
   * word after them (a count, or "analysing").
   */
  options: readonly { value: T; label: string; icon?: ReactNode; hint?: string }[];
  onChange: (value: T) => void;
  /** A way to add to the choices, at the end: its name (read and shown on hover) and icon. */
  action?: { label: string; icon: ReactNode; onSelect: () => void } | undefined;
  className?: string;
}) {
  return (
    <fieldset
      className={cn(
        "m-0 flex h-8 min-w-0 items-center rounded-control border border-line bg-raised/40 p-0.5",
        className,
      )}
    >
      <legend className="sr-only">{label}</legend>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          aria-label={o.icon ? o.label : undefined}
          title={o.icon ? o.label : undefined}
          onClick={() => onChange(o.value)}
          className={cn(
            "flex h-7 items-center justify-center gap-1.5 rounded-[5px] text-[13px] transition-colors",
            o.icon ? "w-7" : "px-2.5",
            value === o.value ? "bg-overlay text-ink shadow-2" : "text-ink-3 hover:text-ink",
          )}
        >
          {o.icon ?? o.label}
          {!o.icon && o.hint && <span className="tabular text-ink-3">{o.hint}</span>}
        </button>
      ))}
      {action && (
        <>
          <span aria-hidden="true" className="mx-0.5 h-4 w-px shrink-0 bg-line" />
          <button
            type="button"
            aria-label={action.label}
            title={action.label}
            onClick={action.onSelect}
            className="flex h-7 w-7 items-center justify-center rounded-[5px] text-ink-3 transition-colors hover:bg-overlay/60 hover:text-ink"
          >
            {action.icon}
          </button>
        </>
      )}
    </fieldset>
  );
}
