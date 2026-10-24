import {
  type CaptionCue,
  cuesAt,
  type Matte,
  matteBars,
  mattes,
  parseTimecode,
  safeAreas,
  type VideoClock,
  videoTimecode,
} from "@hekate/shared";
import { useId, useState } from "react";
import { cn } from "~/lib/cn";
import { Icon } from "./icons";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { usePopover } from "./ui/menu";

const share = (n: number) => `${n * 100}%`;

/**
 * Captions over the picture (#146), from the sidecar chosen in the Frame menu: what is said at
 * the playhead, low in the picture itself and sized with it, as a television lays them.
 */
export function CaptionText({
  aspect,
  cues,
  time,
}: {
  aspect: number;
  cues: readonly CaptionCue[];
  time: number;
}) {
  const now = cuesAt(cues, time);
  return (
    <div
      data-e2e-overlap
      className="pointer-events-none absolute inset-0 flex items-center justify-center select-none"
    >
      <div
        className={cn(
          "@container relative max-h-full max-w-full",
          aspect >= 16 / 9 ? "w-full" : "h-full",
        )}
        style={{ aspectRatio: aspect }}
      >
        {/* Read out as it changes, for whoever cannot hear it. */}
        <div
          aria-live="polite"
          className="absolute inset-x-[10%] bottom-[8%] flex flex-col items-center gap-1 text-center"
        >
          {now.map((cue) => (
            <span
              key={`${cue.start}-${cue.text}`}
              className="rounded-[3px] bg-paper-ink/75 px-2 py-0.5 text-[max(12px,2.6cqw)] leading-snug whitespace-pre-line text-paper"
            >
              {cue.text}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Mattes and safe areas over the picture (#146), as the prototype's Frame menu lays them:
 * fitted to the picture itself, not the player around it, so a vertical cut is guided too.
 * They never take a click; the picture beneath still plays and pauses.
 */
export function FrameGuides({
  aspect,
  matte,
  safe,
}: {
  /** The picture's width over its height. */
  aspect: number;
  matte: Matte | null;
  safe: boolean;
}) {
  if (!matte && !safe) return null;
  const bars = matte ? matteBars(aspect, mattes[matte].ratio) : { top: 0, side: 0 };
  return (
    <div
      aria-hidden="true"
      data-e2e-overlap
      className="pointer-events-none absolute inset-0 flex items-center justify-center select-none"
    >
      {/* The player is 16:9; the picture fills its width or its height, whichever it meets. */}
      <div
        className={cn("relative max-h-full max-w-full", aspect >= 16 / 9 ? "w-full" : "h-full")}
        style={{ aspectRatio: aspect }}
      >
        {bars.top > 0 && (
          <>
            <div
              className="absolute inset-x-0 top-0 bg-paper-ink/85"
              style={{ height: share(bars.top) }}
            />
            <div
              className="absolute inset-x-0 bottom-0 bg-paper-ink/85"
              style={{ height: share(bars.top) }}
            />
          </>
        )}
        {bars.side > 0 && (
          <>
            <div
              className="absolute inset-y-0 left-0 bg-paper-ink/85"
              style={{ width: share(bars.side) }}
            />
            <div
              className="absolute inset-y-0 right-0 bg-paper-ink/85"
              style={{ width: share(bars.side) }}
            />
          </>
        )}
        {safe && (
          <>
            <div
              className="absolute border border-paper/40"
              style={{ inset: share(safeAreas.action) }}
            >
              <span className="absolute top-1 left-1.5 rounded-[2px] bg-paper-ink/70 px-1 text-[10px] text-paper">
                Action safe
              </span>
            </div>
            <div
              className="absolute border border-dashed border-paper/40"
              style={{ inset: share(safeAreas.title) }}
            >
              <span className="absolute top-1 right-1.5 rounded-[2px] bg-paper-ink/70 px-1 text-[10px] text-paper">
                Title safe
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Go to a typed timecode (#146): a full one on the file's own clock, or a time from its start
 * as editors type them. Opens on the current timecode, selected, so typing replaces it.
 */
export function GoToTimecode({
  clock,
  time,
  duration,
  onGo,
}: {
  clock: VideoClock;
  time: number;
  duration: number;
  /** The frame to go to, counted from the file's first. */
  onGo: (frame: number) => void;
}) {
  const [open, setOpen, box] = usePopover();
  const [value, setValue] = useState("");
  const [wrong, setWrong] = useState(false);
  const hint = useId();
  const last = Math.max(0, Math.ceil((duration * clock.rate.num) / clock.rate.den) - 1);
  return (
    <div ref={box} className="relative">
      <Button
        variant="ghost"
        size="md"
        aria-expanded={open}
        onClick={() => {
          setValue(videoTimecode(time, clock));
          setWrong(false);
          setOpen(!open);
        }}
        className={cn(open && "bg-raised text-ink")}
      >
        <Icon name="clock" size={14} />
        Go to
      </Button>
      {open && (
        <form
          data-e2e-overlap
          className="rise-in absolute top-full right-0 z-30 mt-1 flex w-64 flex-col gap-1.5 rounded-panel bg-overlay p-2 shadow-3"
          onSubmit={(event) => {
            event.preventDefault();
            const frame = parseTimecode(value, clock);
            if (frame === null || frame > last) {
              setWrong(true);
              return;
            }
            onGo(frame);
            setOpen(false);
          }}
        >
          <Input
            size="sm"
            autoFocus
            onFocus={(event) => event.target.select()}
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setWrong(false);
            }}
            aria-label="Timecode"
            aria-invalid={wrong}
            aria-describedby={hint}
            inputMode="numeric"
            spellCheck={false}
            className="tabular"
          />
          <span id={hint} className={cn("text-[12px]", wrong ? "text-signal" : "text-ink-2")}>
            {wrong
              ? "That timecode is not in this file."
              : "A timecode, or a time from the start such as 12:00."}
          </span>
        </form>
      )}
    </div>
  );
}
