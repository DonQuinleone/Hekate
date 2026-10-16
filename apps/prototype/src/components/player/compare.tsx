import { useEffect, useState } from "react";
import { Kbd } from "~/components/label";
import { cn } from "~/lib/cn";
import { inField } from "~/lib/dom";

export interface Source {
  id: string;
  label: string;
  /** How this source sits against the one playing: aligned by audio, or at the same time. */
  aligned: boolean;
  gain: string;
}

/**
 * Quick comparison: up to four sources on the number keys, gapless and level-matched,
 * aligned to the same musical position; blind mode hides which is which.
 */
export function CompareBar({
  sources,
  current,
  onCurrent,
  onClose,
}: {
  sources: Source[];
  current: string;
  onCurrent: (id: string) => void;
  onClose: () => void;
}) {
  const [blind, setBlind] = useState(false);
  const [order, setOrder] = useState<string[]>(sources.map((s) => s.id));
  const [pinned, setPinned] = useState<string[]>(sources.slice(0, 2).map((s) => s.id));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (inField(e)) return;
      const n = Number(e.key);
      if (n >= 1 && n <= pinned.length) onCurrent(pinned[n - 1] ?? current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pinned, onCurrent, current]);
  const letters = ["A", "B", "C", "D"];
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2">
      <span className="eyebrow">Compare</span>
      <div className="flex flex-wrap gap-1">
        {pinned.map((id, i) => {
          const s = sources.find((x) => x.id === id);
          if (!s) return null;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={current === id}
              onClick={() => onCurrent(id)}
              className={cn(
                "flex h-8 items-center gap-2 rounded-control border px-2.5 text-[14px]",
                current === id
                  ? "border-signal/60 bg-signal/10 text-ink"
                  : "border-line text-ink-2 hover:border-edge",
              )}
            >
              <Kbd>{String(i + 1)}</Kbd>
              {blind ? letters[order.indexOf(id)] : s.label}
              {!blind && (
                <span className="tabular text-[12px] text-ink-3">
                  {s.aligned ? "aligned" : "same time"} · {s.gain}
                </span>
              )}
            </button>
          );
        })}
        {pinned.length < Math.min(4, sources.length) && (
          <select
            aria-label="Pin a source"
            value=""
            onChange={(e) => {
              if (e.target.value) setPinned([...pinned, e.target.value]);
            }}
            className="h-8 rounded-control border border-line border-dashed bg-transparent px-2 text-[13px] text-ink-3"
          >
            <option value="">+ pin</option>
            {sources
              .filter((s) => !pinned.includes(s.id))
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
          </select>
        )}
      </div>
      <span className="hidden text-[13px] text-ink-3 @3xl/app:inline">
        Level-matched · gapless · the loop holds
      </span>
      <button
        type="button"
        aria-pressed={blind}
        onClick={() => {
          if (!blind) setOrder([...order].sort(() => Math.random() - 0.5));
          setBlind(!blind);
        }}
        className={cn(
          "ml-auto h-7 rounded-chip border px-2.5 text-[13px]",
          blind ? "border-edge bg-raised text-ink" : "border-transparent text-ink-3 hover:text-ink",
        )}
      >
        {blind ? "Reveal" : "Listen blind"}
      </button>
      <button type="button" onClick={onClose} className="text-[13px] text-ink-3 hover:text-ink">
        Close
      </button>
    </div>
  );
}
