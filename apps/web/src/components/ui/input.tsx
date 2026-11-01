import {
  type InputHTMLAttributes,
  type Ref,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useLayoutEffect,
  useRef,
} from "react";
import { cn } from "~/lib/cn";
import { Icon } from "../icons";

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

/** One drawing context, kept, to measure a chosen option's words against its select. */
let measurer: OffscreenCanvasRenderingContext2D | null | undefined;
const textWidth = (text: string, font: string) => {
  if (measurer === undefined)
    measurer =
      typeof OffscreenCanvas === "undefined" ? null : new OffscreenCanvas(1, 1).getContext("2d");
  if (!measurer) return 0;
  measurer.font = font;
  return measurer.measureText(text).width;
};

/** The chosen option's words as the select's title, but only where they are cut short. */
function titleCut(select: HTMLSelectElement) {
  const text = select.selectedOptions[0]?.text ?? "";
  const style = getComputedStyle(select);
  const room =
    select.clientWidth -
    Number.parseFloat(style.paddingLeft) -
    Number.parseFloat(style.paddingRight);
  const cut = text !== "" && room > 0 && textWidth(text, style.font) > room;
  if (cut) select.title = text;
  else select.removeAttribute("title");
}

/**
 * One of a known list, drawn as a field with the brand's chevron (the same as `Dropdown`'s)
 * rather than the browser's. Its width is the caller's (a settings row gives every select the
 * same one); a choice longer than that ends in an ellipsis, with the whole of it as the title.
 */
export function Select({
  className,
  size = "md",
  ref,
  onChange,
  ...props
}: Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> & {
  size?: ControlSize;
  ref?: Ref<HTMLSelectElement>;
}) {
  const own = useRef<HTMLSelectElement | null>(null);
  // After every render, as the chosen value may have been changed by whoever holds it.
  useLayoutEffect(() => {
    if (own.current) titleCut(own.current);
  });
  return (
    <span
      data-control="select"
      className={cn(
        "relative inline-flex w-full min-w-0 shrink",
        size === "sm" ? "h-7 text-[12px]" : "h-9 text-[14px]",
        className,
      )}
    >
      <select
        ref={(el) => {
          own.current = el;
          if (typeof ref === "function") return ref(el);
          if (ref) ref.current = el;
        }}
        onChange={(e) => {
          titleCut(e.currentTarget);
          onChange?.(e);
        }}
        className={cn(
          fieldClass,
          "peer h-full min-w-0 cursor-pointer appearance-none truncate text-[length:inherit] disabled:cursor-not-allowed",
          size === "sm" ? "pr-6 pl-2" : "pr-8",
        )}
        {...props}
      />
      <Icon
        name="chevronDown"
        size={12}
        className={cn(
          "pointer-events-none absolute top-1/2 -translate-y-1/2 text-ink-3 peer-disabled:opacity-60",
          size === "sm" ? "right-2" : "right-3",
        )}
      />
    </span>
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
