import type { InputHTMLAttributes, ReactNode } from "react";
import { cn } from "~/lib/cn";

/**
 * One of a few larger choices, each a card with a title and a line: a radio underneath for the
 * keyboard, the card itself showing which is chosen. Disabled, its title dims and its line
 * stays readable, to say why (a plan that leaves it out).
 */
export function ChoiceCard({
  title,
  hint,
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "size" | "children" | "title"> & {
  title: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer flex-col gap-1 rounded-panel border border-line p-3 text-[14px] text-ink-2 transition-colors hover:border-edge has-[:checked]:border-signal/60 has-[:checked]:bg-signal/10 has-[:checked]:text-ink has-[:focus-visible]:border-edge-strong has-[:disabled]:cursor-not-allowed has-[:disabled]:hover:border-line",
        className,
      )}
    >
      <input type="radio" className="peer sr-only" {...props} />
      <span className="flex items-center gap-2 font-medium peer-disabled:text-ink-3">{title}</span>
      {hint && <span className="text-[13px] text-ink-2">{hint}</span>}
    </label>
  );
}
