import {
  type BarMap,
  barAt,
  barLabel,
  formBars,
  parseBarLabels,
  parseForm,
  pointsFromTaps,
  repeatsAt,
  rulerBars,
} from "@hekate/shared";
import { useEffect, useId, useRef, useState } from "react";
import { cn } from "~/lib/cn";
import { type FileBarMap, useBarMapMutations } from "~/lib/queries";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

/**
 * A ruler of bar numbers under the waveform (#13): a tick at every barline, numbers as
 * often as they fit. A number plays from its bar.
 */
export function BarRuler({
  map,
  duration,
  onSeek,
}: {
  map: BarMap;
  duration: number;
  onSeek: (seconds: number) => void;
}) {
  const ruler = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ruler.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.round(entry?.contentRect.width ?? 0)),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  if (duration <= 0) return null;
  const share = (t: number) => `${Math.min(100, (t / duration) * 100)}%`;
  const numbered = new Set(rulerBars(map, duration, width));
  const repeats = new Set(repeatsAt(map));
  // Every barline gets a small tick along the bottom only while they stay apart.
  const minor = width / Math.max(1, map.points.length) >= 5;
  return (
    <nav ref={ruler} className="relative h-6 border-t border-hairline" aria-label="Bars">
      {map.points.map(([t, bar], i) => {
        const isNumbered = numbered.has(i);
        if (!isNumbered && !repeats.has(i) && !minor) return null;
        return (
          <div
            // Barlines repeat their numbers in a repeat: the index keeps them apart.
            // biome-ignore lint/suspicious/noArrayIndexKey: barlines are in heard order and never reorder.
            key={i}
            className="absolute inset-y-0"
            style={{ left: share(t) }}
          >
            {repeats.has(i) ? (
              // Where the music goes back: a double line, as a repeat is printed.
              <div aria-hidden className="absolute inset-y-0 -left-px flex gap-[2px]">
                <span className="w-px bg-ink-3/70" />
                <span className="w-px bg-ink-3/70" />
              </div>
            ) : isNumbered ? (
              <div aria-hidden className="absolute top-0 h-3 w-px bg-ink-3/70" />
            ) : (
              <div aria-hidden className="absolute bottom-0 h-1 w-px bg-edge" />
            )}
            {isNumbered && (
              // The number sits beside its own barline, in a 28 px target for a finger.
              <button
                type="button"
                onClick={() => onSeek(t)}
                aria-label={`Play from bar ${bar}`}
                className="tabular absolute -top-1 -left-1 flex h-7 min-w-7 cursor-pointer items-start rounded-chip border-0 bg-transparent pt-1 pr-1 pl-[9px] font-mono text-[10px] leading-3 text-ink-3 outline-none hover:text-ink focus-visible:ring-1 focus-visible:ring-signal"
              >
                {bar}
              </button>
            )}
          </div>
        );
      })}
    </nav>
  );
}

/** "Bar 12.2" for the playhead, beside its time. */
export function BarReadout({ map, time }: { map: BarMap; time: number }) {
  const position = barAt(map, time);
  if (!position) return null;
  return <span className="tabular font-mono text-xs text-ink-2">{barLabel(position)}</span>;
}

type Draft = { points: BarMap["points"]; source: "tapped" | "imported" };

/**
 * Sync a recording to its score (#13): tap along on each barline while it plays, or
 * import a label track from Audacity or Sonic Visualiser. Repeats are written as the bar
 * order ("1-16, 1-16, 17-"), so a tap numbers the bar the music has reached.
 */
export function BarSync({
  fileId,
  media,
  map,
  canEdit,
}: {
  fileId: string;
  media: HTMLMediaElement | null;
  map: FileBarMap | null;
  canEdit: boolean;
}) {
  const { save, clear } = useBarMapMutations(fileId);
  const [open, setOpen] = useState(false);
  const [beats, setBeats] = useState(String(map?.beatsPerBar ?? 4));
  // The saved map's time signature, once it arrives, unless someone is already editing.
  const savedBeats = map?.beatsPerBar;
  useEffect(() => {
    if (savedBeats !== undefined && !open) setBeats(String(savedBeats));
  }, [savedBeats, open]);
  const [order, setOrder] = useState("1-");
  const [taps, setTaps] = useState<number[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const ids = { beats: useId(), order: useId(), labels: useId() };
  const form = parseForm(order);
  const beatsPerBar = Number(beats);
  const beatsValid = Number.isInteger(beatsPerBar) && beatsPerBar >= 1 && beatsPerBar <= 32;
  const tapping = taps !== null;
  // Kept in refs so the key handler sees the latest taps without re-binding.
  const tapsRef = useRef<number[] | null>(null);
  tapsRef.current = taps;

  const tap = () => {
    if (!media || !tapsRef.current) return;
    setTaps([...tapsRef.current, media.currentTime]);
  };
  const stop = () => {
    const done = tapsRef.current;
    setTaps(null);
    media?.pause();
    if (done && done.length > 0 && form) {
      setDraft({ points: pointsFromTaps(done, form), source: "tapped" });
    }
  };

  // While tapping: B (or Enter) marks a barline, Backspace takes the last back, Escape stops.
  useEffect(() => {
    if (!tapping) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select")) return;
      if (event.key === "b" || event.key === "B" || event.key === "Enter") tap();
      else if (event.key === "Backspace") setTaps((t) => (t ? t.slice(0, -1) : t));
      else if (event.key === "Escape") stop();
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const summary = map
    ? `${map.points.length} barlines, ${map.source === "imported" ? "imported" : map.source === "carried" ? "carried from the last version" : "tapped"}${map.updatedByName ? ` by ${map.updatedByName}` : ""}`
    : "Not synced to the score";

  if (!canEdit && !map) return null;
  /** The bar the next tap will number. */
  const next = taps && form ? formBars(form, taps.length + 1).at(-1) : undefined;

  return (
    <section aria-label="Bars" className="flex flex-col gap-4 border-t border-hairline pt-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="m-0 text-[15px] font-medium">Bars</h2>
        <span className="text-xs text-ink-3">{summary}</span>
        {canEdit && !open && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setOpen(true)}>
            {map ? "Sync again" : "Sync bars"}
          </Button>
        )}
      </div>
      {canEdit && open && (
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-[120px_minmax(0,1fr)]">
            <label htmlFor={ids.beats} className="flex flex-col gap-1.5">
              <span className="label">Beats a bar</span>
              <Input
                id={ids.beats}
                inputMode="numeric"
                value={beats}
                onChange={(e) => setBeats(e.target.value)}
                aria-invalid={!beatsValid}
              />
            </label>
            <label htmlFor={ids.order} className="flex flex-col gap-1.5">
              <span className="label">Bar order</span>
              <Input
                id={ids.order}
                value={order}
                onChange={(e) => setOrder(e.target.value)}
                placeholder="1-16, 1-16, 17-"
                aria-invalid={!form}
                aria-describedby={`${ids.order}-hint`}
              />
              <span id={`${ids.order}-hint`} className="text-xs text-ink-3">
                {form
                  ? "Bars in the order they are played, repeats written out. Start at 0 for an upbeat."
                  : "Write bars as ranges, such as 1-16, 1-16, 17-"}
              </span>
            </label>
          </div>

          {tapping ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" onClick={tap} className="min-w-40">
                Barline (B)
              </Button>
              <span className="tabular text-xs text-ink-2">
                {taps.length} {taps.length === 1 ? "barline" : "barlines"}
                {next !== undefined && ` · next is bar ${next}`}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={taps.length === 0}
                onClick={() => setTaps(taps.slice(0, -1))}
              >
                Undo
              </Button>
              <Button size="sm" variant="ghost" className="ml-auto" onClick={stop}>
                Done
              </Button>
            </div>
          ) : draft ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className="tabular text-xs text-ink-2">
                {draft.points.length} barlines, bar {draft.points[0]?.[1]} to bar{" "}
                {draft.points.at(-1)?.[1]}
              </span>
              <Button
                size="sm"
                variant="primary"
                disabled={!beatsValid || save.isPending}
                onClick={async () => {
                  setProblem(null);
                  try {
                    await save.mutateAsync({
                      beatsPerBar,
                      points: draft.points,
                      source: draft.source,
                    });
                    setDraft(null);
                    setOpen(false);
                  } catch (error) {
                    setProblem(error instanceof Error ? error.message : "Could not save the bars");
                  }
                }}
              >
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
                Discard
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                size="sm"
                variant="primary"
                disabled={!media || !form || !beatsValid}
                onClick={() => {
                  if (!media) return;
                  setProblem(null);
                  setTaps([]);
                  void media.play().catch(() => undefined);
                }}
              >
                Tap along
              </Button>
              <label
                htmlFor={ids.labels}
                className="cursor-pointer text-xs text-ink-3 underline-offset-2 hover:text-ink hover:underline"
              >
                Import labels
              </label>
              <input
                id={ids.labels}
                type="file"
                accept=".txt,.csv,.tsv,text/plain,text/csv"
                className="sr-only"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  const points = parseBarLabels(await file.text());
                  if (!points)
                    setProblem("No barlines found: each line needs a time and a bar number.");
                  else {
                    setProblem(null);
                    setDraft({ points, source: "imported" });
                  }
                }}
              />
              {map && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={clear.isPending || map.fileId !== fileId}
                  title={
                    map.fileId !== fileId
                      ? "This map belongs to another mix of the version: clear it there"
                      : undefined
                  }
                  onClick={async () => {
                    await clear.mutateAsync();
                    setOpen(false);
                  }}
                >
                  Clear bars
                </Button>
              )}
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setOpen(false)}>
                Close
              </Button>
            </div>
          )}
          {!tapping && !draft && (
            <p className="m-0 text-xs text-ink-3">
              Tap along plays from the playhead: press B on each barline, Backspace to take one
              back. Or import a label track (Audacity or Sonic Visualiser), one bar a label.
            </p>
          )}
          {problem && <p className="m-0 text-xs text-signal">{problem}</p>}
        </div>
      )}
    </section>
  );
}
