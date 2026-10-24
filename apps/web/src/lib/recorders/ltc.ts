import {
  addFrames,
  decodeLtc,
  initialLtcRun,
  initialLtcState,
  type LtcFrame,
  ltcRunStep,
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
 * A recorder's timecode out, read from an audio input (#51, decision 241). A Sound Devices
 * 8-Series or MixPre offers no network interface a browser can reach (its remotes, SD-Remote
 * and Wingman, speak an unpublished protocol over Bluetooth), but every recorder sends LTC from
 * its timecode out. Into an audio interface on the control room's computer, it gives the take
 * log its timecode in and out, and, with the recorder's timecode on Rec Run (running only while
 * it records), each take's start and stop. Take numbers stay typed, or matched on import.
 */

/** The worklet that passes the input's samples to the page, served from this origin. */
const WORKLET = "/worklets/ltc-capture.js";

/** How long after connecting, with no timecode heard, to say so. */
const SILENT_AFTER_MS = 3000;

const NO_INPUT =
  "This browser cannot read an audio input here: use a current Chrome, Edge, Firefox or Safari, over HTTPS.";

const supported = () =>
  typeof navigator !== "undefined" &&
  Boolean(navigator.mediaDevices?.getUserMedia) &&
  typeof AudioWorkletNode !== "undefined";

/**
 * What the frames read mean for the take log: each one a position, and the run rolling or
 * stopping, whether a frame or time passing shows it (#51). `frame` takes each frame decoded;
 * `tick` the time a block of samples brought, whatever it held.
 */
export function createLtcReader(
  out: Pick<ReturnType<typeof createEmitter>, "emit" | "position">,
  sampleRate: number,
) {
  let run = initialLtcRun();
  /** The run stopped: the last position, no longer rolling, and the stop itself. */
  const stopped = (at: number) => {
    const last = out.position();
    const position = last ? { ...last, rolling: false } : null;
    if (position) out.emit({ type: "position", position });
    out.emit({ type: "stopped", timecode: position?.timecode ?? null, at });
  };
  return {
    /** A frame whose sync word ended at `frame.end`; `at` is when that was, by the clock. */
    frame(frame: LtcFrame, at: number) {
      // A frame's label is its own start; by its sync word's end the next frame has begun.
      const timecode = addFrames(frame.timecode, 1);
      const step = ltcRunStep(run, frame, frame.end, sampleRate);
      run = step.run;
      out.emit({ type: "position", position: { timecode, at, rolling: run.rolling } });
      if (step.change === "rolling")
        // It counts as running from the first of the frames that moved on.
        out.emit({ type: "rolling", timecode: addFrames(frame.timecode, -2), at });
      // A frame held on Rec Run between takes stops the run as it is read.
      if (step.change === "stopped") stopped(at);
    },
    /** Time passing to sample `index`: frames that stop moving on, or stop coming, stop it. */
    tick(index: number, at: number) {
      const step = ltcRunStep(run, null, index, sampleRate);
      run = step.run;
      if (step.change === "stopped") stopped(at);
    },
  };
}

export function createLtcAdapter(options: RecorderOptions): RecorderAdapter {
  const out = createEmitter();
  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let node: AudioWorkletNode | null = null;
  let decoder = initialLtcState(48_000);
  let reader = createLtcReader(out, decoder.sampleRate);
  let heard = false;
  let silence: ReturnType<typeof setTimeout> | undefined;
  /** Each connection's turn: one disconnected while the browser asked is not carried on. */
  let generation = 0;

  /** The wall-clock moment a sample was heard, from where the latest block ended. */
  const momentOf = (sample: number, blockEnd: number, arrived: number) =>
    arrived - ((blockEnd - sample) / decoder.sampleRate) * 1000;

  const onBlock = (samples: Float32Array, blockEnd: number) => {
    const arrived = Date.now();
    const decoded = decodeLtc(decoder, samples);
    decoder = decoded.state;
    for (const frame of decoded.frames) {
      if (!heard) {
        heard = true;
        out.setStatus({ state: "listening" });
      }
      reader.frame(frame, momentOf(frame.end, blockEnd, arrived));
    }
    reader.tick(decoder.index, arrived);
  };
  const stop = () => {
    clearTimeout(silence);
    if (node) node.port.onmessage = null;
    node?.disconnect();
    for (const track of stream?.getTracks() ?? []) track.stop();
    void context?.close().catch(() => undefined);
    node = null;
    stream = null;
    context = null;
  };

  return {
    async connect() {
      if (!supported()) {
        out.setStatus({ state: "failed", reason: NO_INPUT });
        throw new Error(NO_INPUT);
      }
      const mine = ++generation;
      /** Disconnected while the browser asked: let go of what was opened, and go no further. */
      const abandoned = () => {
        if (mine === generation) return false;
        stop();
        return true;
      };
      out.setStatus({ state: "connecting" });
      try {
        // Timecode is a signal, not speech: nothing may clean it up on its way in.
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            ...(options.input ? { deviceId: { exact: options.input } } : {}),
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
            channelCount: { ideal: Math.max(2, options.channel + 1) },
          },
        });
      } catch (error) {
        const reason = failureWords(error, "The audio input", "the microphone");
        out.setStatus({ state: "failed", reason });
        throw new Error(reason);
      }
      if (abandoned()) return;
      try {
        context = new AudioContext();
        await context.audioWorklet.addModule(WORKLET);
        if (abandoned()) return;
        const source = context.createMediaStreamSource(stream);
        const channels = stream.getAudioTracks()[0]?.getSettings().channelCount ?? 1;
        if (options.channel >= channels) {
          throw new Error(
            `this input gives ${channels === 1 ? "one channel" : `${channels} channels`}, so it has no channel ${options.channel + 1}`,
          );
        }
        node = new AudioWorkletNode(context, "ltc-capture", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: channels,
          channelCountMode: "explicit",
          channelInterpretation: "discrete",
          processorOptions: { channel: options.channel },
        });
        decoder = initialLtcState(context.sampleRate);
        reader = createLtcReader(out, context.sampleRate);
        node.port.onmessage = (event: MessageEvent<{ samples: Float32Array; end: number }>) =>
          onBlock(event.data.samples, event.data.end);
        // Pulled through a silent gain, so the browser runs it without anything being heard.
        const mute = context.createGain();
        mute.gain.value = 0;
        source.connect(node);
        node.connect(mute);
        mute.connect(context.destination);
        await context.resume();
        if (abandoned()) return;
      } catch (error) {
        stop();
        const reason = `The timecode reader could not start: ${error instanceof Error ? error.message : "the browser refused"}.`;
        out.setStatus({ state: "failed", reason });
        throw new Error(reason);
      }
      const label = stream.getAudioTracks()[0]?.label || "the audio input";
      stream.getAudioTracks()[0]?.addEventListener("ended", () => {
        stop();
        out.setStatus({
          state: "failed",
          reason: `${label} went away. Connect again once it is back.`,
        });
      });
      out.setStatus({ state: "silent", detail: `Listening to ${label}; no timecode yet` });
      silence = setTimeout(() => {
        if (!heard)
          out.setStatus({
            state: "silent",
            detail: `No timecode on channel ${options.channel + 1} of ${label}. Check the recorder's timecode out reaches it, at line level.`,
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

/** The audio inputs, named once the browser has been allowed the microphone. */
async function audioInputs(): Promise<RecorderInput[]> {
  if (!supported()) return [];
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === "audioinput" && d.label && d.deviceId !== "default")
      .map((d) => ({ id: d.deviceId, label: d.label }));
  } catch {
    return [];
  }
}

const timecodeOut = (name: string): Omit<RecorderDefinition, "kind" | "label" | "short"> => ({
  inputLabel: "Audio input",
  channels: true,
  triggers: ["off", "rolling"],
  triggerLabels: {
    off: "No, fill in timecode only",
    rolling: "When its timecode rolls (Rec Run)",
  },
  unsupported: () => (supported() ? null : NO_INPUT),
  note: (options) =>
    `Connect ${name} timecode out to this input; the browser asks to allow the microphone. A browser cannot read its take numbers: type them, or let the import match them.${options.trigger === "rolling" ? " Set its timecode to Rec Run, so it runs only while recording." : ""}`,
  inputs: audioInputs,
  create: createLtcAdapter,
});

/** A Sound Devices 8-Series or MixPre, read from its timecode out (decision 241). */
export const soundDevices: RecorderDefinition = {
  kind: "sound-devices",
  label: "Sound Devices (8-Series, MixPre)",
  short: "Sound Devices",
  ...timecodeOut("the recorder's"),
};

/** Any other recorder that sends LTC from its timecode out. */
export const timecodeIn: RecorderDefinition = {
  kind: "ltc",
  label: "Another recorder's timecode out",
  short: "Timecode",
  ...timecodeOut("the recorder's"),
};
