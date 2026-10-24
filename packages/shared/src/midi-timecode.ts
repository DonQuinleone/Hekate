import type { FrameRateId } from "./comment-export.ts";
import {
  addFrames,
  type RecorderEvent,
  type RecorderPosition,
  type RecorderTimecode,
  timecodeFrames,
  timecodeNow,
} from "./recorders.ts";

/**
 * MIDI Time Code and MIDI Machine Control, read (#450, decision 240): what a DAW sends to a
 * virtual MIDI port as it plays, records and locates, decoded without a dependency. The decoder
 * is a pure step over the bytes as they arrive (`decodeMidi`), so the same code reads Web MIDI's
 * messages in the browser and a recorded stream in a test.
 *
 * - Quarter frames (`F1 0n`): eight make a timecode, two frames long; sent only while rolling.
 * - Full frames (`F0 7F dev 01 01 hr mn sc fr F7`): the position at once, sent on a locate.
 * - Machine control (`F0 7F dev 06 cmd … F7`): play, stop, record strobe and exit, locate.
 *
 * Full frames and machine control are system exclusive messages, which Web MIDI delivers only
 * with its SysEx permission.
 */

/** The rate an MTC hours byte names in its top bits: 24, 25, 30 dropping frames, or 30. */
export const mtcRates: readonly FrameRateId[] = ["24", "25", "29.97df", "30"];

/** The machine control commands a DAW sends from its transport, by their number. */
export const mmcCommands = {
  1: "stop",
  2: "play",
  3: "deferred-play",
  4: "fast-forward",
  5: "rewind",
  6: "record-strobe",
  7: "record-exit",
  8: "record-pause",
  9: "pause",
  10: "eject",
  11: "chase",
  13: "reset",
  68: "locate",
} as const;
export type MmcCommand = (typeof mmcCommands)[keyof typeof mmcCommands];

/** What the decoder heard, each with when it arrived (ms, the caller's clock). */
export type MidiTimecodeEvent =
  | {
      type: "timecode";
      timecode: RecorderTimecode;
      /** Quarter frames while rolling, or a full frame on a locate. */
      source: "quarter-frame" | "full-frame";
      /** Forwards, or backwards (scrubbing). */
      direction: 1 | -1;
      at: number;
    }
  | { type: "transport"; command: Exclude<MmcCommand, "locate">; at: number }
  | { type: "locate"; timecode: RecorderTimecode; at: number };

export interface MidiDecoderState {
  /** The eight quarter-frame pieces as last heard, by piece number. */
  pieces: (number | null)[];
  /** The last piece heard, and when. */
  lastPiece: number | null;
  lastPieceAt: number | null;
  /** How many pieces in a row have come in order (one way or the other). */
  run: number;
  direction: 1 | -1;
  /** A message being read, across the messages Web MIDI or a stream splits it into. */
  partial: number[];
  /** Whether that message is system exclusive, read until its F7. */
  inSysex: boolean;
}

export const initialMidiState = (): MidiDecoderState => ({
  pieces: new Array(8).fill(null),
  lastPiece: null,
  lastPieceAt: null,
  run: 0,
  direction: 1,
  partial: [],
  inSysex: false,
});

/** How long after the last quarter frame the DAW is taken to have stopped rolling. */
export const MTC_STOPPED_MS = 250;

/** Whether quarter frames are still arriving: the DAW is rolling. */
export const mtcRolling = (state: MidiDecoderState, now: number) =>
  state.lastPieceAt !== null && now - state.lastPieceAt <= MTC_STOPPED_MS;

/** A timecode from MTC's four bytes: hours with the rate in its top bits, minutes, seconds, frames. */
function timecodeOf(hr: number, mn: number, sc: number, fr: number): RecorderTimecode | null {
  const rate = mtcRates[(hr >> 5) & 0x03] ?? "30";
  const tc = { hours: hr & 0x1f, minutes: mn & 0x3f, seconds: sc & 0x3f, frames: fr & 0x1f, rate };
  if (tc.hours > 23 || timecodeFrames(tc) === null) return null;
  return tc;
}

/** How many data bytes follow a channel or system status byte; undefined for none known. */
function dataLength(status: number): number {
  if (status < 0xf0) return (status & 0xf0) === 0xc0 || (status & 0xf0) === 0xd0 ? 1 : 2;
  if (status === 0xf1 || status === 0xf3) return 1;
  if (status === 0xf2) return 2;
  return 0;
}

/** A complete system exclusive message, read: a full frame or a machine control command. */
function sysexEvent(msg: number[], at: number): MidiTimecodeEvent | null {
  // F0 7F <device> <sub-id 1> <sub-id 2> … F7: universal real time.
  if (msg[1] !== 0x7f) return null;
  const [, , , sub1, sub2] = msg;
  if (sub1 === 0x01 && sub2 === 0x01 && msg.length >= 10) {
    const tc = timecodeOf(msg[5] ?? 0, msg[6] ?? 0, msg[7] ?? 0, msg[8] ?? 0);
    return tc ? { type: "timecode", timecode: tc, source: "full-frame", direction: 1, at } : null;
  }
  if (sub1 === 0x06 && sub2 !== undefined) {
    const command = mmcCommands[sub2 as keyof typeof mmcCommands];
    if (!command) return null;
    if (command === "locate") {
      // 44 06 01 hr mn sc fr subframes: locate to a target given in full.
      if (msg[5] !== 0x06 || msg[6] !== 0x01 || msg.length < 12) return null;
      const tc = timecodeOf(msg[7] ?? 0, msg[8] ?? 0, msg[9] ?? 0, msg[10] ?? 0);
      return tc ? { type: "locate", timecode: tc, at } : null;
    }
    return { type: "transport", command, at };
  }
  return null;
}

/**
 * A quarter frame taken in. A timecode is whole once eight pieces have come in order; going
 * forwards it was true when its first piece was sent, two frames before its last arrives, so
 * it is given two frames on. Each further piece in order gives the next whole one on the
 * piece that completes it.
 */
function quarterFrame(
  state: MidiDecoderState,
  byte: number,
  at: number,
): { state: MidiDecoderState; event: MidiTimecodeEvent | null } {
  const piece = (byte >> 4) & 0x07;
  const value = byte & 0x0f;
  const pieces = [...state.pieces];
  pieces[piece] = value;
  let { run, direction } = state;
  const expectedForward = state.lastPiece === null ? null : (state.lastPiece + 1) % 8;
  const expectedBackward = state.lastPiece === null ? null : (state.lastPiece + 7) % 8;
  // A gap of more than a few frames means the DAW stopped and started again: begin afresh.
  const fresh = state.lastPieceAt === null || at - state.lastPieceAt > MTC_STOPPED_MS;
  if (!fresh && piece === expectedForward) {
    run = direction === 1 ? run + 1 : 2;
    direction = 1;
  } else if (!fresh && piece === expectedBackward) {
    run = direction === -1 ? run + 1 : 2;
    direction = -1;
  } else run = 1;
  const next = { ...state, pieces, lastPiece: piece, lastPieceAt: at, run, direction };
  const completes = direction === 1 ? piece === 7 : piece === 0;
  if (!completes || run < 8 || pieces.some((p) => p === null)) return { state: next, event: null };
  const [f0 = 0, f1 = 0, s0 = 0, s1 = 0, m0 = 0, m1 = 0, h0 = 0, h1 = 0] = pieces as number[];
  const tc = timecodeOf(h0 | (h1 << 4), m0 | (m1 << 4), s0 | (s1 << 4), f0 | (f1 << 4));
  if (!tc) return { state: next, event: null };
  return {
    state: next,
    event: {
      type: "timecode",
      timecode: direction === 1 ? addFrames(tc, 2) : tc,
      source: "quarter-frame",
      direction,
      at,
    },
  };
}

/**
 * Bytes taken in, as Web MIDI delivers a message or a stream carries them: what they complete,
 * in order. Real-time bytes (clock, start, stop) may fall anywhere, even inside a system
 * exclusive message, and are passed over; running status is not used by timecode or machine
 * control, so other channel messages are skipped by their length.
 */
export function decodeMidi(
  state: MidiDecoderState,
  bytes: ArrayLike<number>,
  at: number,
): { state: MidiDecoderState; events: MidiTimecodeEvent[] } {
  let s = state;
  let partial = [...state.partial];
  let inSysex = state.inSysex;
  const events: MidiTimecodeEvent[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const byte = (bytes[i] ?? 0) & 0xff;
    if (byte >= 0xf8) continue;
    if (inSysex) {
      if (byte === 0xf7) {
        const event = sysexEvent([...partial, byte], at);
        if (event) events.push(event);
        partial = [];
        inSysex = false;
      } else if (byte & 0x80) {
        // Another status before the end: the message was cut short; read the new one.
        partial = [];
        inSysex = false;
        i--;
      } else partial.push(byte);
      continue;
    }
    if (byte === 0xf0) {
      partial = [byte];
      inSysex = true;
      continue;
    }
    if (byte & 0x80) {
      partial = [byte];
    } else if (partial.length > 0) {
      partial.push(byte);
    } else continue;
    const status = partial[0] ?? 0;
    if (partial.length - 1 < dataLength(status)) continue;
    if (status === 0xf1) {
      const step = quarterFrame({ ...s, partial: [], inSysex: false }, partial[1] ?? 0, at);
      s = step.state;
      if (step.event) events.push(step.event);
    }
    partial = [];
  }
  return { state: { ...s, partial, inSysex }, events };
}

/** Where the DAW is, as the recorder events need it: its position, and whether it rolls. */
export interface MidiRun {
  position: RecorderPosition | null;
  rolling: boolean;
}

export const initialMidiRun = (): MidiRun => ({ position: null, rolling: false });

/**
 * What the DAW's MIDI means for the take log, as recorder events: each timecode a position;
 * quarter frames starting, rolling, and stopping (or an MMC stop), stopped; the record strobe,
 * recording, and record exit, its end. A step with no event (`null`) is time passing, which is
 * how quarter frames that have stopped arriving are noticed (`rolling`, from the decoder).
 */
export function midiRecorderStep(
  run: MidiRun,
  event: MidiTimecodeEvent | null,
  now: number,
  rolling: boolean,
): { run: MidiRun; events: RecorderEvent[] } {
  const here = run.position ? timecodeNow(run.position, now) : null;
  if (!event) {
    if (!run.rolling || rolling) return { run, events: [] };
    const position = run.position ? { ...run.position, rolling: false } : null;
    return {
      run: { position, rolling: false },
      events: [
        ...(position ? [{ type: "position" as const, position }] : []),
        { type: "stopped", timecode: position?.timecode ?? null, at: now },
      ],
    };
  }
  if (event.type === "timecode") {
    const moving = event.source === "quarter-frame";
    const position = { timecode: event.timecode, at: event.at, rolling: moving };
    const events: RecorderEvent[] = [{ type: "position", position }];
    if (moving && !run.rolling)
      events.push({
        type: "rolling",
        // The timecode was whole two frames after it began: the DAW started then.
        timecode: addFrames(event.timecode, -2),
        at: event.at,
      });
    if (!moving && run.rolling)
      events.push({ type: "stopped", timecode: event.timecode, at: event.at });
    return { run: { position, rolling: moving }, events };
  }
  if (event.type === "locate") {
    const position = { timecode: event.timecode, at: event.at, rolling: false };
    return { run: { ...run, position }, events: [{ type: "position", position }] };
  }
  switch (event.command) {
    case "record-strobe":
      return { run, events: [{ type: "record", timecode: here, at: event.at }] };
    case "record-exit":
      return { run, events: [{ type: "record-stop", timecode: here, at: event.at }] };
    case "stop":
    case "pause": {
      if (!run.rolling) return { run, events: [] };
      const position = here ? { timecode: here, at: event.at, rolling: false } : null;
      return {
        run: { position, rolling: false },
        events: [
          ...(position ? [{ type: "position" as const, position }] : []),
          { type: "stopped", timecode: here, at: event.at },
        ],
      };
    }
    default:
      return { run, events: [] };
  }
}
