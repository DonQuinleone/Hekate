import { type PointerEvent, type ReactNode, useRef, useState } from "react";
import { cn } from "~/lib/cn";
import { type Loop, loopFrom, MAX_ROLL, nudge, type Rolls, roll } from "~/lib/loop";
import { Button } from "./ui/button";
import { Choice } from "./ui/choice";
import { Input, Select } from "./ui/input";

/** Movement, in pixels, that turns a click into a drag. */
const DRAG_THRESHOLD = 4;

/** A time to the millisecond: 1:05.250. */
export function preciseTime(seconds: number) {
  const whole = Math.max(0, seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole - minutes * 60;
  return `${minutes}:${rest.toFixed(3).padStart(6, "0")}`;
}

/** The shaded passage a loop covers, with its edges. */
function Band({ loop, duration, draft }: { loop: Loop; duration: number; draft?: boolean }) {
  if (!(duration > 0)) return null;
  const left = (loop.start / duration) * 100;
  const width = ((loop.end - loop.start) / duration) * 100;
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-y-0 border-x border-signal",
        draft ? "bg-signal/5" : "bg-signal/10",
      )}
      style={{ left: `${left}%`, width: `${width}%` }}
    />
  );
}

/**
 * A surface over the waveform, spectrogram or a loop lane: a click moves the playhead, a
 * drag marks a loop. The loop already set is shaded.
 */
export function LoopSurface({
  duration,
  loop,
  active,
  onSeek,
  onLoop,
  label,
  className,
  children,
}: {
  duration: number;
  loop: Loop | null;
  active: boolean;
  onSeek: (seconds: number) => void;
  /** Make a loop from a drag; without it, the surface only seeks. */
  onLoop?: (loop: Loop) => void;
  label: string;
  className?: string;
  children?: ReactNode;
}) {
  const from = useRef<{ x: number; time: number } | null>(null);
  const [draft, setDraft] = useState<Loop | null>(null);
  const timeAt = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return box.width > 0 ? ((event.clientX - box.left) / box.width) * duration : 0;
  };
  return (
    <div className={cn("relative", className)}>
      {children}
      {/* On top of what it covers, so the waveform's own seeking never runs underneath. */}
      <div
        role="slider"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={loop?.start ?? 0}
        aria-valuetext={
          loop ? `Loop ${preciseTime(loop.start)} to ${preciseTime(loop.end)}` : "No loop"
        }
        tabIndex={-1}
        className="absolute inset-0 z-10 cursor-crosshair touch-none select-none"
        onPointerDown={(event) => {
          if (event.button !== 0 || !(duration > 0)) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          from.current = { x: event.clientX, time: timeAt(event) };
        }}
        onPointerMove={(event) => {
          const start = from.current;
          if (!onLoop || !start || Math.abs(event.clientX - start.x) < DRAG_THRESHOLD) return;
          setDraft(loopFrom(start.time, timeAt(event), duration));
        }}
        onPointerUp={(event) => {
          const start = from.current;
          from.current = null;
          if (!start) return;
          const made =
            onLoop && Math.abs(event.clientX - start.x) >= DRAG_THRESHOLD
              ? loopFrom(start.time, timeAt(event), duration)
              : null;
          setDraft(null);
          if (made) onLoop?.(made);
          else onSeek(Math.max(0, Math.min(duration, timeAt(event))));
        }}
        onPointerCancel={() => {
          from.current = null;
          setDraft(null);
        }}
      >
        {loop && !draft && (
          <div className={cn("pointer-events-none absolute inset-0", !active && "opacity-40")}>
            <Band loop={loop} duration={duration} />
          </div>
        )}
        {draft && (
          <div className="pointer-events-none absolute inset-0">
            <Band loop={draft} duration={duration} draft />
          </div>
        )}
      </div>
    </div>
  );
}

/** How far a nudge moves an edge. */
function stepsFor(fps: number | undefined) {
  return [
    { label: "1 ms", seconds: 0.001 },
    { label: "10 ms", seconds: 0.01 },
    { label: "100 ms", seconds: 0.1 },
    ...(fps ? [{ label: "1 frame", seconds: 1 / fps }] : []),
  ];
}

function Edge({
  name,
  at,
  onNudge,
}: {
  name: string;
  at: number;
  onNudge: (direction: -1 | 1) => void;
}) {
  return (
    <span className="flex items-center gap-1">
      <span className="text-xs text-ink-3">{name}</span>
      <Button variant="ghost" size="sm" aria-label={`${name} earlier`} onClick={() => onNudge(-1)}>
        −
      </Button>
      <span className="tabular text-xs text-ink">{preciseTime(at)}</span>
      <Button variant="ghost" size="sm" aria-label={`${name} later`} onClick={() => onNudge(1)}>
        +
      </Button>
    </span>
  );
}

/** The loop's edges, nudged by a chosen step; pre-roll and post-roll; on, off and clear. */
export function LoopControls({
  loop,
  duration,
  fps,
  active,
  rolls,
  onLoop,
  onActive,
  onRolls,
}: {
  loop: Loop;
  duration: number;
  fps?: number;
  active: boolean;
  rolls: Rolls;
  onLoop: (loop: Loop | null) => void;
  onActive: (active: boolean) => void;
  onRolls: (rolls: Rolls) => void;
}) {
  const steps = stepsFor(fps);
  const [step, setStep] = useState(steps[1]?.seconds ?? 0.01);
  return (
    <section
      aria-label="Loop"
      className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-hairline pt-3"
    >
      <Choice
        checked={active}
        onChange={(e) => onActive(e.target.checked)}
        className="items-center text-xs text-ink-2"
      >
        Loop
      </Choice>
      <Edge
        name="In"
        at={loop.start}
        onNudge={(d) => onLoop(nudge(loop, "start", d * step, duration))}
      />
      <Edge
        name="Out"
        at={loop.end}
        onNudge={(d) => onLoop(nudge(loop, "end", d * step, duration))}
      />
      <label className="flex items-center gap-2 text-xs text-ink-3">
        Step
        <Select
          size="sm"
          className="w-auto"
          value={step}
          onChange={(e) => setStep(Number(e.target.value))}
        >
          {steps.map((s) => (
            <option key={s.label} value={s.seconds}>
              {s.label}
            </option>
          ))}
        </Select>
      </label>
      <label className="flex items-center gap-2 text-xs text-ink-3">
        Pre-roll
        <Input
          size="sm"
          type="number"
          min={0}
          max={MAX_ROLL}
          step={0.5}
          className="w-14"
          value={rolls.pre}
          onChange={(e) => onRolls({ ...rolls, pre: roll(Number(e.target.value)) })}
        />
        s
      </label>
      <label className="flex items-center gap-2 text-xs text-ink-3">
        Post-roll
        <Input
          size="sm"
          type="number"
          min={0}
          max={MAX_ROLL}
          step={0.5}
          className="w-14"
          value={rolls.post}
          onChange={(e) => onRolls({ ...rolls, post: roll(Number(e.target.value)) })}
        />
        s
      </label>
      <Button variant="ghost" size="sm" className="ml-auto" onClick={() => onLoop(null)}>
        Clear loop
      </Button>
    </section>
  );
}
