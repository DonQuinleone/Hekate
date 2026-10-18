import type { ReactNode, Ref } from "react";
import { cn } from "~/lib/cn";

const text =
  "m-0 py-3 pr-4 pl-12 font-mono text-[12.5px] leading-[1.6] break-words whitespace-pre-wrap";

/**
 * Text edited as code: numbered lines, each coloured by `colour`, with a plain text area laid
 * exactly over them, so typing, selecting, undo and pasting are the browser's own. Lines in
 * `marked` (from 1) are flagged, as where a file has a mistake.
 */
export function CodeEditor({
  value,
  onChange,
  label,
  colour,
  marked,
  readOnly = false,
  ref,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  colour: (line: string) => ReactNode;
  marked?: ReadonlySet<number>;
  readOnly?: boolean;
  ref?: Ref<HTMLTextAreaElement>;
  className?: string;
}) {
  return (
    <div
      // The text area's own text is transparent over the coloured copy, by design.
      data-e2e-overlap
      className={cn(
        // The frame shows the focus, not the text area spread over it.
        "relative rounded-panel-lg border border-line bg-canvas/60 focus-within:shadow-[var(--hk-focus-ring)]",
        className,
      )}
    >
      <pre aria-hidden="true" className={cn(text, "pointer-events-none min-h-[420px]")}>
        {value.split("\n").map((line, i) => (
          <span
            // Lines are positions in the text, numbered by where they are.
            // biome-ignore lint/suspicious/noArrayIndexKey: each line is its position.
            key={i}
            className={cn("relative block min-h-[1.6em]", marked?.has(i + 1) && "bg-signal/10")}
          >
            <span
              className={cn(
                "tabular absolute -left-10 w-8 text-right select-none",
                marked?.has(i + 1) ? "text-signal" : "text-ink-3/70",
              )}
            >
              {i + 1}
            </span>
            {colour(line)}
          </span>
        ))}
      </pre>
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        readOnly={readOnly}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        aria-label={label}
        className={cn(
          text,
          "absolute inset-0 h-full w-full resize-none overflow-hidden bg-transparent text-transparent caret-ink selection:bg-ink/20 focus:outline-none focus-visible:shadow-none",
        )}
      />
    </div>
  );
}
