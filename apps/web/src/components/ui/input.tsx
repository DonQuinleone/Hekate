import type { InputHTMLAttributes } from "react";
import { cn } from "~/lib/cn";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        "h-8 w-full rounded-control border border-edge bg-ground px-2.5 text-[13px] text-ink placeholder:text-ink-3 focus:border-ink-3 focus:outline-none",
        className,
      )}
      {...props}
    />
  );
}
