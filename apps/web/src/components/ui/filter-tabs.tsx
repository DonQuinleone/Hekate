import type { ReactNode } from "react";
import { cn } from "~/lib/cn";
import { Count } from "./chip";

/**
 * How a filter tab looks (#608): borderless pills, the chosen one raised. For a filter whose
 * choice lives in the address, drawn as links with this class.
 */
export const filterTab = (chosen: boolean) =>
  cn(
    "flex h-8 shrink-0 items-center rounded-control px-3 text-[13px] whitespace-nowrap transition-colors",
    chosen ? "bg-raised text-ink shadow-1" : "text-ink-3 hover:text-ink",
  );

/**
 * Which of a list's items are shown (#608): a row of pill tabs, one chosen. A filter narrows
 * what is listed; how it is shown (cards or rows, board or calendar) is a `Segmented` instead,
 * so the control says which of the two it does.
 */
export function FilterTabs<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  /** What the filter is, for assistive technology. */
  label: string;
  value: T;
  /** Each choice, with how many it holds where that is known. */
  options: readonly { value: T; label: ReactNode; count?: number }[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <fieldset
      className={cn("m-0 flex min-w-0 flex-wrap items-center gap-1 border-0 p-0", className)}
    >
      <legend className="sr-only">{label}</legend>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={filterTab(value === o.value)}
        >
          {o.label}
          {o.count !== undefined && <Count>{o.count}</Count>}
        </button>
      ))}
    </fieldset>
  );
}
