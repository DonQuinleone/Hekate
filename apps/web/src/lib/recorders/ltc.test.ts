import { type LtcFrame, parseTimecodeLabel, type RecorderEvent } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import { createEmitter } from "./adapter";
import { createLtcReader } from "./ltc";

const RATE = 48_000;
/** A 25 fps frame ending at `end`: 1,920 samples long. */
const frame = (end: number, advancing: boolean, label = "10:00:00:00") =>
  ({
    timecode: parseTimecodeLabel(label, "25"),
    start: end - 1920,
    end,
    advancing,
  }) as LtcFrame;

describe("reading a recorder's timecode out (#51)", () => {
  it("stops when a frame held on Rec Run shows it, not only when time passes", () => {
    const out = createEmitter();
    const seen: RecorderEvent["type"][] = [];
    out.subscribe((event) => {
      if (event.type === "rolling" || event.type === "stopped") seen.push(event.type);
    });
    const reader = createLtcReader(out, RATE);
    // Rolling: frames moving on, read in blocks of 2,048 samples.
    for (const n of [1, 2, 3, 4]) {
      reader.frame(frame(n * 1920, true), n * 40);
      reader.tick(n * 1920 + 100, n * 40);
    }
    expect(seen).toEqual(["rolling"]);
    // Between takes the recorder holds its last frame: the run stops as the frames are read,
    // and the tick after them finds nothing more to say.
    for (const n of [5, 6, 7, 8, 9, 10, 11]) {
      reader.frame(frame(n * 1920, false), n * 40);
      reader.tick(n * 1920, n * 40);
    }
    expect(seen).toEqual(["rolling", "stopped"]);
    // The next take rolls again.
    for (const n of [12, 13, 14]) reader.frame(frame(n * 1920, true), n * 40);
    expect(seen).toEqual(["rolling", "stopped", "rolling"]);
  });
});
