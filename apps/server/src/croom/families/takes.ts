import type { Fields } from "../fields.ts";
import { absent, type Family, type ReplayContext, removeFrom } from "../family.ts";
import {
  type CrLifecycle,
  type CrTake,
  type FrameRate,
  nominalFps,
  type Timecode,
  takeLifecycles,
} from "../model.ts";

/**
 * The take log (decision 242). `add_take` has `number`, `work` and `movement` (the repertoire
 * piece and the movement's place in it, from 1, that the take was recorded under; 0 for none)
 * and `pdf` (its score, kept only where each score numbers its own takes). The take is changed
 * by `set_take_lifecycle` (`take`, `value`: idle, armed, recording, recorded or aborted),
 * `set_take_rating` (`take`, `rating`, held to 0 to 5), `adjust_false_start` (`take`, `delta`,
 * never below none), `set_take_notes` (`take`, `notes`) and `set_take_timecode` (`take`, `in`:
 * true for the in point, `tc`: "HH:MM:SS:FF", or null to clear), and removed by `delete_take`
 * (`take`). A take's number is never given again.
 */

/**
 * A timecode as ControlRoom reads one against the session's frame rate: "HH:MM:SS:FF", or ";"
 * before the frames; null where it is not one, or its frames do not fit the rate.
 */
export function parseTimecode(text: string, rate: FrameRate): Timecode | null {
  const match = /^\s*([+-]?\d+)\s*:\s*([+-]?\d+)\s*:\s*([+-]?\d+)\s*:\s*([+-]?\d+)/.exec(
    text.replaceAll(";", ":"),
  );
  if (!match) return null;
  const [hours, minutes, seconds, frames] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
  ];
  if (hours < 0 || minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59 || frames < 0)
    return null;
  if (frames >= nominalFps[rate]) return null;
  return { hours, minutes, seconds, frames };
}

/** A timecode as ControlRoom shows it at a rate: drop-frame writes ";" before the frames. */
export function timecodeText(tc: Timecode, rate: FrameRate): string {
  const two = (n: number) => String(n).padStart(2, "0");
  const separator = rate === "29.97DF" ? ";" : ":";
  return `${two(tc.hours)}:${two(tc.minutes)}:${two(tc.seconds)}${separator}${two(tc.frames)}`;
}

/** The take an event names by `take`, changed as `change` says. */
const onTake =
  (change: (take: CrTake, f: Fields, ctx: ReplayContext) => void) =>
  (ctx: ReplayContext, f: Fields) => {
    const held = ctx.model.takes.get(f.id("take") ?? "");
    if (!held) {
      // Read all the same, so a field of the wrong kind is still said.
      change({ ...blank("0"), number: 0 }, f, ctx);
      return absent(ctx, "a take");
    }
    change(held, f, ctx);
  };

const blank = (id: string): CrTake => ({
  id,
  number: 0,
  workId: null,
  movement: 0,
  pdfId: null,
  falseStarts: 0,
  lifecycle: "idle",
  rating: 0,
  notes: "",
  timecodeIn: null,
  timecodeOut: null,
  createdAt: null,
});

export const takes: Family = {
  name: "takes",
  events: {
    add_take(ctx, f) {
      const id = ctx.nextId();
      ctx.model.takes.set(id, {
        ...blank(id),
        number: f.int("number", 0),
        workId: f.id("work"),
        movement: f.int("movement", 0),
        pdfId: f.id("pdf"),
        createdAt: ctx.ts,
      });
    },
    delete_take(ctx, f) {
      removeFrom(ctx, f, ctx.model.takes, "a take", "take");
    },
    set_take_lifecycle: onTake((t, f) => {
      const value = f.str("value", "idle");
      // ControlRoom reads any other word as idle.
      t.lifecycle = (takeLifecycles as readonly string[]).includes(value)
        ? (value as CrLifecycle)
        : "idle";
    }),
    set_take_rating: onTake((t, f) => {
      t.rating = Math.min(5, Math.max(0, f.int("rating", 0)));
    }),
    adjust_false_start: onTake((t, f) => {
      t.falseStarts = Math.max(0, t.falseStarts + f.int("delta", 0));
    }),
    set_take_notes: onTake((t, f) => {
      t.notes = f.str("notes");
    }),
    set_take_timecode: onTake((t, f, ctx) => {
      const isIn = f.bool("in", true);
      const written = f.raw("tc");
      let tc: Timecode | null = null;
      if (typeof written === "string") {
        tc = parseTimecode(written, ctx.frameRate());
        if (!tc)
          ctx.report.problem(
            `${ctx.type}: "${written.slice(0, 16)}" is not a timecode at ${ctx.frameRate()} frames a second, so it clears the take's (as in ControlRoom)`,
          );
      } else if (written !== null && written !== undefined)
        ctx.report.problem(`${ctx.type}: tc is not text, so it clears the take's timecode`);
      if (isIn) t.timecodeIn = tc;
      else t.timecodeOut = tc;
    }),
  },
};
