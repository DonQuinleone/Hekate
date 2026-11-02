import type { InputHTMLAttributes, Ref, TextareaHTMLAttributes } from "react";
import { cn } from "~/lib/cn";
import { Icon } from "../icons";

export const fieldClass =
  "w-full rounded-control border border-line-strong bg-ground/70 px-3 text-[14px] text-ink shadow-1 transition-colors placeholder:text-ink-3 hover:border-edge focus:border-edge-strong focus:outline-none";

export function Input({
  className,
  ref,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <input ref={ref} className={cn(fieldClass, "h-9", className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(fieldClass, "resize-y py-2", className)} {...props} />;
}

/**
 * One of a known list, drawn as a field with the brand's chevron (the same as `Dropdown`'s)
 * rather than the browser's. A choice longer than its width ends in an ellipsis.
 */
export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span
      data-control="select"
      className={cn("relative inline-flex h-9 w-full min-w-0 shrink text-[14px]", className)}
    >
      <select
        className={cn(
          fieldClass,
          "peer h-full min-w-0 cursor-pointer appearance-none truncate pr-8 text-[length:inherit]",
        )}
        {...props}
      />
      <Icon
        name="chevronDown"
        size={12}
        className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-ink-3 peer-disabled:opacity-60"
      />
    </span>
  );
}
