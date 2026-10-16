/** A key, as printed on the keyboard. */
export function Kbd({ children }: { children: string }) {
  return (
    <kbd className="tabular inline-flex h-5 min-w-5 items-center justify-center rounded-chip border border-line-strong bg-raised px-1.5 font-sans text-[11px] text-ink-2">
      {children}
    </kbd>
  );
}

/** Ctrl or ⌘ K, whichever the keyboard has. */
export const paletteKey =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl K";
