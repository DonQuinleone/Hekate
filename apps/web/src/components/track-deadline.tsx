import { deadlinePassed } from "@hekate/shared";
import { useId } from "react";
import { Icon } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { Field } from "~/components/ui/field";
import { Floating } from "~/components/ui/floating";
import { Input } from "~/components/ui/input";
import { usePopover } from "~/components/ui/menu";
import { cn } from "~/lib/cn";
import { dayHere, formatDates } from "~/lib/locale";
import { type Track, useProjectCan, useTrackMutations } from "~/lib/queries";

const dateFormat = formatDates({ day: "numeric", month: "short", year: "numeric" });

/** A day as the deadline's instant: five in the afternoon where the member is, as reviews are. */
const dueOn = (day: string) => new Date(`${day}T17:00:00`).toISOString();

/**
 * A track's deadline (#505) in its details: shown to everyone, late ones marked; whoever may
 * organise tracks sets, moves or clears it from a small sheet. It goes on the calendar and the
 * timeline, and on the track's card on the board.
 */
export function TrackDeadline({ track, className }: { track: Track; className?: string }) {
  const can = useProjectCan(track.projectId);
  const { updateTrack } = useTrackMutations(track.projectId);
  const [open, setOpen, box] = usePopover();
  const id = useId();
  const editable = can("organise");
  const late = deadlinePassed(track.dueAt, new Date());
  const words = track.dueAt ? `Due ${dateFormat.format(new Date(track.dueAt))}` : "No deadline";
  if (!editable && !track.dueAt) return null;
  const face = (
    <>
      <Icon name="flag" size={13} className={cn(late ? "text-signal" : "text-ink-3")} />
      <span className={cn(late && "text-signal")}>{words}</span>
      {late && <span className="text-signal">· late</span>}
    </>
  );
  if (!editable)
    return (
      <span className={cn("flex h-8 items-center gap-1.5 text-[13px] text-ink-2", className)}>
        {face}
      </span>
    );
  return (
    <div ref={box} className={cn("relative", className)}>
      <Button variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
        {face}
      </Button>
      {open && (
        <Floating
          anchor={box}
          align="end"
          side="bottom"
          onClose={() => setOpen(false)}
          role="dialog"
          aria-label="Deadline"
          data-e2e-overlap
          className="rise-in w-64 rounded-panel-lg bg-overlay p-3 shadow-4"
        >
          <Field label="Due on" hint="On the calendar, the timeline and the board.">
            <Input
              id={id}
              type="date"
              autoFocus
              value={track.dueAt ? dayHere(track.dueAt) : ""}
              onChange={(e) => {
                if (e.target.value)
                  updateTrack.mutate({ id: track.id, dueAt: dueOn(e.target.value) });
              }}
            />
          </Field>
          <div className="mt-3 flex items-center justify-between gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={!track.dueAt || updateTrack.isPending}
              onClick={() => {
                updateTrack.mutate({ id: track.id, dueAt: null });
                setOpen(false);
              }}
            >
              Clear
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>
              Done
            </Button>
          </div>
          {updateTrack.error && (
            <p role="alert" className="m-0 mt-2 text-[12px] text-signal">
              {updateTrack.error.message}
            </p>
          )}
        </Floating>
      )}
    </div>
  );
}
