import {
  decodeMidi,
  initialMidiRun,
  initialMidiState,
  type MidiTimecodeEvent,
  midiRecorderStep,
  mtcRolling,
} from "@hekate/shared";
import {
  createEmitter,
  failureWords,
  type RecorderAdapter,
  type RecorderDefinition,
  type RecorderInput,
  type RecorderOptions,
} from "./adapter";

/**
 * A DAW as the recorder (#450, decisions 237 and 240): its MIDI Time Code and MIDI Machine
 * Control, sent to a virtual port (IAC on macOS, loopMIDI or Windows MIDI Services' own on
 * Windows), read through Web MIDI. Quarter frames carry the position while it rolls; machine
 * control (record strobe and exit, stop) and full frames on a locate are system exclusive, so
 * the browser is asked for SysEx only when takes start and stop as the DAW records.
 */

const SAFARI = "This browser has no Web MIDI (Safari has none): use Chrome, Edge or Firefox.";

/** How long after connecting, with nothing heard, to say so. */
const SILENT_AFTER_MS = 3000;

const supported = () => typeof navigator !== "undefined" && "requestMIDIAccess" in navigator;

/** Whether MIDI is already allowed, so inputs can be listed without asking. */
async function allowed(): Promise<boolean> {
  try {
    const state = await navigator.permissions.query({ name: "midi" as PermissionName });
    return state.state === "granted";
  } catch {
    return false;
  }
}

export function createMidiAdapter(options: RecorderOptions): RecorderAdapter {
  const out = createEmitter();
  // Machine control is SysEx; a trigger on rolling reads quarter frames alone.
  const sysex = options.trigger === "record";
  let access: MIDIAccess | null = null;
  let input: MIDIInput | null = null;
  let decoder = initialMidiState();
  let run = initialMidiRun();
  let heard = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let silence: ReturnType<typeof setTimeout> | undefined;

  const step = (event: MidiTimecodeEvent | null, now: number) => {
    const next = midiRecorderStep(run, event, now, mtcRolling(decoder, now));
    run = next.run;
    for (const e of next.events) out.emit(e);
  };
  const onMessage = (message: MIDIMessageEvent) => {
    if (!message.data) return;
    const now = Date.now();
    const decoded = decodeMidi(decoder, message.data, now);
    decoder = decoded.state;
    if (decoded.events.length > 0 && !heard) {
      heard = true;
      out.setStatus({ state: "listening" });
    }
    for (const event of decoded.events) step(event, now);
  };
  /** Each connection's turn: one disconnected while the browser asked is not carried on. */
  let generation = 0;
  const stop = () => {
    clearInterval(timer);
    clearTimeout(silence);
    if (input) input.onmidimessage = null;
    if (access) access.onstatechange = null;
    // Closing the port lets the DAW's port go for other applications.
    void input?.close().catch(() => undefined);
    input = null;
    access = null;
  };

  return {
    async connect() {
      if (!supported()) {
        out.setStatus({ state: "failed", reason: SAFARI });
        throw new Error(SAFARI);
      }
      const mine = ++generation;
      out.setStatus({ state: "connecting" });
      try {
        access = await navigator.requestMIDIAccess({ sysex });
      } catch (error) {
        const reason = failureWords(
          error,
          sysex ? "MIDI with system messages" : "MIDI",
          sysex ? "MIDI devices, with control and reprogramming," : "MIDI devices",
        );
        out.setStatus({ state: "failed", reason });
        throw new Error(reason);
      }
      // Disconnected while the browser asked: go no further.
      if (mine !== generation) {
        stop();
        return;
      }
      const inputs = [...access.inputs.values()];
      input = (options.input ? inputs.find((i) => i.id === options.input) : inputs[0]) ?? null;
      if (!input) {
        const reason =
          "No MIDI input to listen to. Make a virtual port (the IAC Driver on a Mac, loopMIDI on Windows) and set the DAW to send MIDI timecode to it.";
        stop();
        out.setStatus({ state: "failed", reason });
        throw new Error(reason);
      }
      input.onmidimessage = onMessage;
      const name = input.name ?? "the MIDI input";
      access.onstatechange = (event) => {
        const port = (event as MIDIConnectionEvent).port;
        if (port?.id === input?.id && port?.state === "disconnected") {
          stop();
          out.setStatus({
            state: "failed",
            reason: `${name} went away. Connect again once it is back.`,
          });
        }
      };
      // Time passing: quarter frames that stop arriving mean the DAW stopped.
      timer = setInterval(() => step(null, Date.now()), 100);
      out.setStatus({ state: "silent", detail: `Listening to ${name}; no timecode yet` });
      silence = setTimeout(() => {
        if (!heard)
          out.setStatus({
            state: "silent",
            detail: `Nothing heard from ${name}. Set the DAW to send MIDI timecode${sysex ? " and MMC" : ""} to this port, then play.`,
          });
      }, SILENT_AFTER_MS);
    },
    disconnect() {
      generation += 1;
      stop();
      out.setStatus({ state: "idle" });
    },
    status: out.status,
    position: out.position,
    subscribe: out.subscribe,
  };
}

export const dawMidi: RecorderDefinition = {
  kind: "daw-midi",
  label: "A DAW, over MIDI",
  short: "DAW",
  inputLabel: "MIDI input",
  channels: false,
  triggers: ["off", "record", "rolling"],
  triggerLabels: {
    off: "No, fill in timecode only",
    record: "When the DAW records",
    rolling: "When the DAW rolls",
  },
  unsupported: () => (supported() ? null : SAFARI),
  note: (options) =>
    options.trigger === "record"
      ? "Reads the DAW's machine control, so the browser asks to allow MIDI system messages. Set the DAW to send MIDI timecode and MMC to this port."
      : "Reads the DAW's MIDI timecode; the browser asks to allow MIDI. Set the DAW to send MIDI timecode to this port.",
  async inputs(): Promise<RecorderInput[]> {
    if (!supported() || !(await allowed())) return [];
    try {
      const access = await navigator.requestMIDIAccess();
      return [...access.inputs.values()].map((i) => ({ id: i.id, label: i.name ?? i.id }));
    } catch {
      return [];
    }
  },
  create: createMidiAdapter,
};
