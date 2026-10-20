import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Kbd } from "~/components/kbd";
import { Rating } from "~/components/takes";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/cn";
import { clock, type LoggedTake, type SlotStatus } from "~/lib/take-log";

/**
 * The take log in large print (#51), for the far side of the room: the take, how long it has
 * rolled, and how long the slot has left, readable from the desk or the floor. It covers the
 * page without taking its keys, so Space still starts and stops takes while it shows; where the
 * browser allows, it fills the screen, and leaving full screen closes it.
 */
export function TakeOverview({
  session,
  track,
  number,
  live,
  seconds,
  slot,
  wallClock,
  last,
  onClose,
}: {
  session: string;
  track: string;
  /** The take rolling or armed, else the next one's number; null when it cannot be known yet. */
  number: number | null;
  live: "recording" | "armed" | null;
  seconds: number;
  slot: SlotStatus;
  wallClock: string;
  /** The last take logged, when it is not the one live. */
  last: LoggedTake | null;
  onClose: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  // The clock re-renders this every second; full screen is entered once, not each time.
  const close = useRef(onClose);
  close.current = onClose;
  // Focus on the panel, not a button, so Space reaches the take log rather than a control.
  useEffect(() => {
    const node = panel.current;
    // The page it covers is out of reach while it shows: Tab stays here, and screen readers
    // read only this. The keys still reach the take log, which listens on the window.
    const app = document.getElementById("root");
    if (app) app.inert = true;
    node?.focus();
    let full = false;
    const left = () => {
      if (full && !document.fullscreenElement) close.current();
      full = Boolean(document.fullscreenElement);
    };
    document.addEventListener("fullscreenchange", left);
    node?.requestFullscreen?.().catch(() => undefined);
    return () => {
      if (app) app.inert = false;
      document.removeEventListener("fullscreenchange", left);
      if (document.fullscreenElement === node)
        void document.exitFullscreen().catch(() => undefined);
    };
  }, []);

  const recording = live === "recording";
  const state = recording ? "Recording" : live === "armed" ? "Armed" : "Next take";
  return createPortal(
    <section
      ref={panel}
      tabIndex={-1}
      aria-label="Take log in large print"
      // A layer over the page: checked on its own, not against the page it covers.
      data-e2e-layer
      className={cn(
        "fixed inset-0 z-50 flex flex-col gap-6 bg-ground p-6 outline-none transition-colors @3xl/app:p-10",
        recording && "bg-[color-mix(in_srgb,var(--hk-signal)_7%,var(--hk-ground))]",
      )}
    >
      <header className="flex items-start gap-4">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[clamp(18px,2.4vw,32px)] leading-[1.25] text-ink">
            {track}
          </span>
          <span className="truncate text-[clamp(14px,1.4vw,20px)] leading-[1.4] text-ink-3">
            {session}
          </span>
        </div>
        <span className="tabular text-[clamp(18px,2.4vw,32px)] leading-[1.25] text-ink-2">
          {wallClock}
        </span>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
          <Kbd>L</Kbd>
        </Button>
      </header>

      {/* Announced when the take or its state changes; the running time is not, every second. */}
      <span role="status" className="sr-only">
        {number != null ? `Take ${number}, ${state.toLowerCase()}` : state}
      </span>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 text-center">
        <span
          className={cn(
            // The size before the line height: merged the other way, the line height is dropped.
            "tabular text-[clamp(96px,22vmin,320px)] font-medium leading-[1.2] tracking-tight",
            recording ? "text-signal" : "text-ink",
          )}
        >
          {number != null ? `T${number}` : "T–"}
        </span>
        <span
          className={cn(
            "flex items-center gap-4 text-[clamp(28px,6vmin,72px)] leading-[1.2]",
            recording ? "text-ink" : "text-ink-2",
          )}
        >
          {recording && (
            <span aria-hidden="true" className="breathe size-[0.4em] rounded-full bg-signal" />
          )}
          {state}
          {live && <span className="tabular text-ink">{clock(seconds)}</span>}
        </span>
      </div>

      <footer className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <div className="flex min-w-0 flex-1 items-center gap-3 text-[clamp(16px,1.8vw,24px)] leading-[1.4] text-ink-2">
          {last && (
            <>
              <span className="tabular shrink-0 whitespace-nowrap text-ink">
                Last, T{last.number}
              </span>
              {last.rating > 0 && <Rating value={last.rating} />}
              {last.starred && <span className="shrink-0 text-signal">Starred</span>}
              {last.notes && <span className="min-w-0 truncate text-ink-3">{last.notes}</span>}
            </>
          )}
        </div>
        {slot && (
          <span
            className={cn(
              "tabular text-[clamp(28px,5vmin,64px)] leading-[1.15]",
              slot.kind === "plenty" ? "text-ink" : "text-signal",
            )}
          >
            {slot.kind === "over" ? `${clock(slot.over)} over` : clock(slot.left)}
            <span className="text-[0.4em] text-ink-3">
              {slot.kind === "over" ? " the slot" : " to slot end"}
            </span>
          </span>
        )}
      </footer>
    </section>,
    document.body,
  );
}
