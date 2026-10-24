import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decodeMidi,
  initialMidiRun,
  initialMidiState,
  type MidiDecoderState,
  type MidiTimecodeEvent,
  MTC_STOPPED_MS,
  midiRecorderStep,
  mtcRolling,
} from "./midi-timecode.ts";
import { type RecorderEvent, type RecorderTimecode, timecodeLabel } from "./recorders.ts";

/** A recorded stream: each line its time in milliseconds, then its bytes in hex. */
function readStream(name: string): { at: number; bytes: number[] }[] {
  return readFileSync(join(import.meta.dirname, "fixtures", "midi", name), "utf8")
    .split("\n")
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean)
    .map((line) => {
      const [at = "0", ...bytes] = line.split(/\s+/);
      return { at: Number(at), bytes: bytes.map((b) => Number.parseInt(b, 16)) };
    });
}

/** Everything a stream decodes to, fed a message at a time as Web MIDI delivers them. */
function decodeAll(stream: { at: number; bytes: number[] }[], state = initialMidiState()) {
  const events: MidiTimecodeEvent[] = [];
  let s: MidiDecoderState = state;
  for (const { at, bytes } of stream) {
    const step = decodeMidi(s, bytes, at);
    s = step.state;
    events.push(...step.events);
  }
  return { state: s, events };
}

const label = (e: MidiTimecodeEvent) =>
  "timecode" in e ? timecodeLabel(e.timecode as RecorderTimecode) : null;

/** Quarter frames for a run of frames from a label, as a DAW sends them, every `step` ms. */
function quarterFrames(
  start: { h: number; m: number; s: number; f: number },
  pairs: number,
  fps: number,
  rateBits: number,
  t0 = 0,
  backwards = false,
) {
  const out: { at: number; bytes: number[] }[] = [];
  const step = 1000 / fps / 4;
  let t = t0;
  let total = ((start.h * 60 + start.m) * 60 + start.s) * fps + start.f;
  for (let pair = 0; pair < pairs; pair++) {
    const f = total % fps;
    const s = Math.floor(total / fps) % 60;
    const m = Math.floor(total / (fps * 60)) % 60;
    const h = Math.floor(total / (fps * 3600)) % 24;
    const values = [
      f & 15,
      f >> 4,
      s & 15,
      s >> 4,
      m & 15,
      m >> 4,
      h & 15,
      (h >> 4) | (rateBits << 1),
    ];
    const order = backwards ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
    for (const p of order) {
      out.push({ at: t, bytes: [0xf1, (p << 4) | (values[p] ?? 0)] });
      t += step;
    }
    total += backwards ? -2 : 2;
  }
  return out;
}

describe("decodeMidi on a recorded stream", () => {
  const { events } = decodeAll(readStream("daw-25fps.txt"));

  it("reads the locate and the full frame before the DAW rolls", () => {
    expect(events[0]).toMatchObject({ type: "locate" });
    expect(label(events[0] as MidiTimecodeEvent)).toBe("01:00:00:00");
    expect(events[1]).toMatchObject({ type: "timecode", source: "full-frame" });
    expect(label(events[1] as MidiTimecodeEvent)).toBe("01:00:00:00");
    expect(events[2]).toMatchObject({ type: "transport", command: "play" });
  });

  it("assembles quarter frames into timecode, two frames on from its first piece", () => {
    const quarter = events.filter((e) => e.type === "timecode" && e.source === "quarter-frame");
    // Eight pieces make the first whole timecode (01:00:00:00, sent from its first piece), so
    // it is 01:00:00:02 when its last arrives; each pair of frames after it, the next.
    expect(label(quarter[0] as MidiTimecodeEvent)).toBe("01:00:00:02");
    expect(label(quarter[1] as MidiTimecodeEvent)).toBe("01:00:00:04");
    expect(quarter.every((e) => e.type === "timecode" && e.timecode.rate === "25")).toBe(true);
    expect(quarter).toHaveLength(80);
  });

  it("passes over clocks and notes, and reads record strobe, exit and stop in order", () => {
    const transport = events.flatMap((e) => (e.type === "transport" ? [e.command] : []));
    expect(transport).toEqual(["play", "record-strobe", "record-exit", "stop"]);
  });

  it("gives the timecode the record strobe came at, from the quarter frames before it", () => {
    const strobe = events.findIndex((e) => e.type === "transport" && e.command === "record-strobe");
    const before = events
      .slice(0, strobe)
      .filter((e) => e.type === "timecode")
      .at(-1);
    expect(label(before as MidiTimecodeEvent)).toBe("01:00:02:00");
  });

  it("reads a full frame sent on a locate while stopped", () => {
    expect(label(events.at(-1) as MidiTimecodeEvent)).toBe("01:00:10:00");
  });
});

describe("decodeMidi", () => {
  it("reads each rate from the hours byte's top bits", () => {
    for (const [bits, rate, fps] of [
      [0, "24", 24],
      [1, "25", 25],
      [3, "30", 30],
    ] as const) {
      const { events } = decodeAll(quarterFrames({ h: 10, m: 0, s: 0, f: 0 }, 2, fps, bits));
      expect(events[0]).toMatchObject({ type: "timecode", timecode: { rate } });
    }
    const { events } = decodeAll(quarterFrames({ h: 10, m: 1, s: 0, f: 2 }, 2, 30, 2));
    expect(events[0]).toMatchObject({ timecode: { rate: "29.97df" } });
    // Two frames on from 10:01:00;02, past the frames drop-frame skips.
    expect(label(events[0] as MidiTimecodeEvent)).toBe("10:01:00;04");
  });

  it("wraps past midnight", () => {
    const { events } = decodeAll(quarterFrames({ h: 23, m: 59, s: 59, f: 23 }, 1, 25, 1));
    expect(label(events[0] as MidiTimecodeEvent)).toBe("00:00:00:00");
  });

  it("reads quarter frames backwards, for a DAW scrubbing", () => {
    const { events } = decodeAll(quarterFrames({ h: 1, m: 0, s: 5, f: 10 }, 3, 25, 1, 0, true));
    expect(events[0]).toMatchObject({ direction: -1 });
    expect(label(events[0] as MidiTimecodeEvent)).toBe("01:00:05:10");
    expect(label(events[1] as MidiTimecodeEvent)).toBe("01:00:05:08");
  });

  it("waits for eight pieces in order after a gap, rather than mixing two positions", () => {
    const first = quarterFrames({ h: 1, m: 0, s: 0, f: 0 }, 1, 25, 1, 0);
    // Half a timecode, then the DAW stops and starts again elsewhere.
    const cut = first.slice(0, 4);
    const again = quarterFrames({ h: 2, m: 0, s: 0, f: 0 }, 1, 25, 1, 1000);
    const { events } = decodeAll([...cut, ...again]);
    expect(events.map(label)).toEqual(["02:00:00:02"]);
  });

  it("takes a message split across deliveries, and bytes in one stream", () => {
    const sysex = [0xf0, 0x7f, 0x7f, 0x06, 0x06, 0xf7];
    const a = decodeMidi(initialMidiState(), sysex.slice(0, 3), 0);
    const b = decodeMidi(a.state, [0xf8, ...sysex.slice(3)], 1);
    expect(a.events).toEqual([]);
    expect(b.events).toEqual([{ type: "transport", command: "record-strobe", at: 1 }]);
    const stream = quarterFrames({ h: 1, m: 0, s: 0, f: 0 }, 1, 25, 1).flatMap((m) => m.bytes);
    expect(decodeMidi(initialMidiState(), stream, 5).events.map(label)).toEqual(["01:00:00:02"]);
  });

  it("drops a system exclusive message cut short, and ignores others' and bad timecode", () => {
    const cut = decodeMidi(initialMidiState(), [0xf0, 0x7f, 0x7f, 0x06, 0xf1, 0x00], 0);
    expect(cut.events).toEqual([]);
    expect(cut.state.lastPiece).toBe(0);
    // A manufacturer's message, an unknown command, and a full frame at 25:00:00:00.
    const other = decodeMidi(
      initialMidiState(),
      [
        ...[0xf0, 0x41, 0x10, 0x42, 0xf7],
        ...[0xf0, 0x7f, 0x7f, 0x06, 0x60, 0xf7],
        ...[0xf0, 0x7f, 0x7f, 0x01, 0x01, 0x39, 0, 0, 0, 0xf7],
      ],
      0,
    );
    expect(other.events).toEqual([]);
  });

  it("says the DAW rolls while quarter frames arrive, and stopped soon after they end", () => {
    const { state } = decodeAll(quarterFrames({ h: 1, m: 0, s: 0, f: 0 }, 2, 25, 1));
    const last = state.lastPieceAt ?? 0;
    expect(mtcRolling(state, last + 10)).toBe(true);
    expect(mtcRolling(state, last + MTC_STOPPED_MS + 1)).toBe(false);
    expect(mtcRolling(initialMidiState(), 0)).toBe(false);
  });
});

describe("midiRecorderStep on a recorded stream", () => {
  /** The recorder events a stream makes, with time passing between its messages. */
  function recorderEvents(stream: { at: number; bytes: number[] }[]) {
    let decoder = initialMidiState();
    let run = initialMidiRun();
    const out: RecorderEvent[] = [];
    const step = (event: MidiTimecodeEvent | null, now: number) => {
      const next = midiRecorderStep(run, event, now, mtcRolling(decoder, now));
      run = next.run;
      out.push(...next.events.filter((e) => e.type !== "position"));
    };
    for (const { at, bytes } of stream) {
      step(null, at);
      const decoded = decodeMidi(decoder, bytes, at);
      decoder = decoded.state;
      for (const event of decoded.events) step(event, at);
    }
    step(null, (stream.at(-1)?.at ?? 0) + 1000);
    return out.map((e) =>
      "timecode" in e ? `${e.type} ${e.timecode ? timecodeLabel(e.timecode) : "?"}` : e.type,
    );
  }

  it("rolls, records, stops recording and stops, each at the DAW's timecode", () => {
    expect(recorderEvents(readStream("daw-25fps.txt"))).toEqual([
      "rolling 01:00:00:00",
      "record 01:00:02:00",
      "record-stop 01:00:06:00",
      "stopped 01:00:06:10",
    ]);
  });

  it("notices quarter frames that stop without an MMC stop", () => {
    const stream = quarterFrames({ h: 1, m: 0, s: 0, f: 0 }, 5, 25, 1);
    expect(recorderEvents(stream)).toEqual(["rolling 01:00:00:00", "stopped 01:00:00:10"]);
  });
});
