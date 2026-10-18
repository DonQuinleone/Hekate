import { clockOf } from "@hekate/shared";
import { cn } from "~/lib/cn";
import { type EditSegment, segmentAt } from "~/lib/edit-decisions";
import { LoopSurface } from "./loop";

/**
 * A version's edits under its waveform (#56): which take each stretch comes from and its bars,
 * as the version's edit decision list says. A click goes to the start of the edit it lands on,
 * to hear the cut into it.
 */
export function EditLane({
  edits,
  duration,
  time,
  onSeek,
}: {
  edits: readonly EditSegment[];
  duration: number;
  time: number;
  onSeek: (seconds: number) => void;
}) {
  const playing = segmentAt(edits, time);
  const share = (value: number) => Math.min(100, (value / duration) * 100);
  const describe = (edit: EditSegment) =>
    `${edit.label}${edit.bars ? `, ${edit.bars}` : ""}, ${clockOf(edit.start)} to ${clockOf(edit.end)}`;
  return (
    <>
      {/* The edits as words, for those who cannot see the lane. */}
      <ol aria-label="Edits" className="sr-only">
        {edits.map((edit) => (
          <li key={edit.start}>{describe(edit)}</li>
        ))}
      </ol>
      <LoopSurface
        duration={duration}
        loop={null}
        active={false}
        onSeek={(at) => onSeek(segmentAt(edits, at)?.start ?? at)}
        label={`Edits: ${edits.length}, click one to hear it from its start`}
        valueText={playing ? `Playing ${describe(playing)}` : "Between edits"}
        className="h-6"
      >
        <div aria-hidden="true" className="absolute inset-0 overflow-hidden rounded-[3px]">
          {edits.map((edit) => (
            <div
              key={edit.start}
              className={cn(
                "absolute inset-y-0 flex items-center border-l border-ground px-1.5 text-[11px] leading-none",
                edit.take ? "bg-raised text-ink-2" : "border-y border-y-hairline text-ink-3",
                edit === playing && "bg-edge text-ink",
              )}
              style={{
                left: `${share(edit.start)}%`,
                width: `${share(edit.end) - share(edit.start)}%`,
              }}
            >
              <span className="truncate">
                {edit.label}
                {edit.bars && <span className="text-ink-3"> · {edit.bars}</span>}
              </span>
            </div>
          ))}
        </div>
      </LoopSurface>
    </>
  );
}
