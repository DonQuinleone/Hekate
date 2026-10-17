import type { InputHTMLAttributes, Ref, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { cn } from "~/lib/cn";

export const fieldClass =
  "w-full rounded-control border border-line-strong bg-ground/70 px-3 text-[14px] text-ink shadow-1 transition-colors placeholder:text-ink-3 hover:border-edge focus:border-edge-strong focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-signal/60";

/** Default for forms; small for dense toolbars such as the player's settings. */
export type ControlSize = "sm" | "md";
const heights: Record<ControlSize, string> = { sm: "h-7 px-2 text-[12px]", md: "h-9" };

export function Input({
  className,
  size = "md",
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & { size?: ControlSize }) {
  return <input className={cn(fieldClass, heights[size], className)} {...props} />;
}

export function Textarea({
  className,
  ref,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return <textarea ref={ref} className={cn(fieldClass, "resize-y py-2", className)} {...props} />;
}

export function Select({
  className,
  size = "md",
  ...props
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> & { size?: ControlSize }) {
  return (
    <select
      className={cn(fieldClass, heights[size], size === "sm" ? "pr-6" : "pr-8", className)}
      {...props}
    />
  );
}

/** The hidden file chooser behind an Upload button: opened by the button, never shown. */
export function FileInput({
  ref,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "className"> & {
  ref?: Ref<HTMLInputElement>;
}) {
  return <input ref={ref} type="file" className="hidden" {...props} />;
}

/** A name edited where it is shown: no border until hovered or focused, as in Linear and Notion. */
export function InlineInput({
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "size">) {
  return (
    <input
      className={cn(
        "h-7 rounded-control border border-transparent bg-transparent px-1 text-ink outline-none transition-colors hover:border-edge focus:border-ink-3",
        className,
      )}
      {...props}
    />
  );
}

/** A field whose container is its box, such as the palette's search line: no border of its own. */
export function BareInput({
  ref,
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & { ref?: Ref<HTMLInputElement> }) {
  return (
    <input
      ref={ref}
      className={cn(
        "min-w-0 bg-transparent text-ink placeholder:text-ink-2 focus:outline-none focus-visible:shadow-none focus-visible:outline-none",
        className,
      )}
      {...props}
    />
  );
}
