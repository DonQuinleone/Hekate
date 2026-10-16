import type { ReactNode } from "react";
import { cn } from "~/lib/cn";

/**
 * Two to four views of the same thing (list and grid, light and dark): one pressed at a
 * time. Tabs are for a third level of navigation only.
 */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  /** What the choice is, for assistive technology. */
  label: string;
  value: T;
  /** Each choice: its value, its words, and an icon to show in place of the words. */
  options: readonly { value: T; label: string; icon?: ReactNode }[];
  onChange: (value: T) => void;
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
            "flex h-7 items-center justify-center rounded-[5px] text-[13px] transition-colors",
            o.icon ? "w-7" : "px-2.5",
            value === o.value ? "bg-overlay text-ink shadow-2" : "text-ink-3 hover:text-ink",
          )}
        >
          {o.icon ?? o.label}
        </button>
      ))}
    </fieldset>
  );
}
