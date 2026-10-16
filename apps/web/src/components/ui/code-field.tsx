import { type ClipboardEvent, type KeyboardEvent, useRef } from "react";
import { cn } from "~/lib/cn";

/**
 * A code of a few digits, one box each: typing moves on, Backspace goes back, and pasting the
 * whole code fills every box. The value is the digits typed so far.
 */
export function CodeField({
  value,
  onChange,
  length = 6,
  label = "Code",
  invalid = false,
}: {
  value: string;
  onChange: (value: string) => void;
  length?: number;
  label?: string;
  invalid?: boolean;
}) {
  const boxes = useRef<(HTMLInputElement | null)[]>([]);
  const digits = value.padEnd(length, " ").slice(0, length).split("");
  const focus = (i: number) => boxes.current[Math.max(0, Math.min(length - 1, i))]?.focus();
  const set = (i: number, digit: string) => {
    const next = digits.map((d, j) => (j === i ? digit || " " : d)).join("");
    onChange(next.trimEnd().replaceAll(" ", ""));
  };
  const paste = (event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData("text").replace(/\D/g, "").slice(0, length);
    if (!pasted) return;
    event.preventDefault();
    onChange(pasted);
    focus(pasted.length);
  };
  const key = (i: number) => (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Backspace" && !digits[i]?.trim()) focus(i - 1);
    if (event.key === "ArrowLeft") focus(i - 1);
    if (event.key === "ArrowRight") focus(i + 1);
  };
  return (
    <fieldset className="m-0 grid min-w-0 grid-cols-6 gap-2 border-0 p-0">
      <legend className="sr-only">{label}</legend>
      {digits.map((d, i) => (
        <input
          // The boxes are positions in one code, fixed in number and order.
          // biome-ignore lint/suspicious/noArrayIndexKey: each box is its position.
          key={i}
          ref={(el) => {
            boxes.current[i] = el;
          }}
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={1}
          autoComplete={i === 0 ? "one-time-code" : "off"}
          aria-label={`Digit ${i + 1}`}
          aria-invalid={invalid || undefined}
          value={d.trim()}
          onChange={(e) => {
            const digit = e.target.value.replace(/\D/g, "").slice(-1);
            set(i, digit);
            if (digit) focus(i + 1);
          }}
          onKeyDown={key(i)}
          onPaste={paste}
          className={cn(
            "tabular h-14 w-full min-w-0 rounded-control border border-edge-strong bg-raised text-center text-[22px] text-ink shadow-1 focus:border-ink-2 focus:outline-none aria-[invalid=true]:border-signal/60",
          )}
        />
      ))}
    </fieldset>
  );
}
