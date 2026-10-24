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
  ref,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "size"> & {
  size?: ControlSize;
  ref?: Ref<HTMLInputElement>;
}) {
  return <input ref={ref} className={cn(fieldClass, heights[size], className)} {...props} />;
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

/**
 * A colour, as a workspace's accent is chosen (#185): its swatch opens the system's picker, and
 * its six hexadecimal digits can be typed or pasted beside it. `value` is what was typed, whole
 * or not; the swatch shows it once it is a colour.
 */
export function ColourInput({
  value,
  onChange,
  label,
  disabled,
  invalid,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  disabled?: boolean;
  invalid?: boolean;
}) {
  const whole = /^#[0-9a-f]{6}$/i.test(value);
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className="relative size-9 shrink-0 overflow-hidden rounded-control border border-line-strong shadow-1 focus-within:border-edge-strong"
        // The colour being chosen is data here, not chrome.
        style={whole ? { background: value } : undefined}
      >
        <input
          type="color"
          aria-label={`${label}: pick`}
          value={whole ? value.toLowerCase() : "#000000"}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className="absolute inset-0 size-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
        />
      </span>
      <input
        type="text"
        aria-label={label}
        aria-invalid={invalid || undefined}
        value={value}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        maxLength={7}
        placeholder="#4fb3a9"
        onChange={(e) => {
          const typed = e.target.value.trim();
          onChange(typed && !typed.startsWith("#") ? `#${typed}` : typed);
        }}
        className={cn(fieldClass, heights.md, "tabular w-28")}
      />
    </span>
  );
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
