import type {
  RecorderEvent,
  RecorderPosition,
  RecorderStatus,
  TakeTrigger,
} from "@hekate/shared";

/**
 * A recorder adapter (#51, decision 240): how the control room's browser reads one kind of
 * recorder. Each adapter connects in its own way (Web MIDI, an audio input; later a serial
 * port or a small local bridge, for a recorder such as a Zaxcom whose take names come over its
 * own network) and turns what it hears into the shared recorder events. The take log and the
 * player use only this interface, so adding a recorder is adding an adapter to the registry.
 */
export interface RecorderAdapter {
  /** Asks the browser, and the person, for what it needs, then listens. */
  connect(): Promise<void>;
  /** Stops listening and lets go of the device. */
  disconnect(): void;
  status(): RecorderStatus;
  /** Where the recorder is, or null before it has said. */
  position(): RecorderPosition | null;
  /** Everything it hears, in order; returns a way to stop listening. */
  subscribe(listener: (event: RecorderEvent) => void): () => void;
}

/** How a recorder is connected, as the person chose: its input, channel and takes' trigger. */
export interface RecorderOptions {
  /** A device's id (a MIDI input, an audio input); null for the first or the default. */
  input: string | null;
  /** The channel of an audio input that carries the timecode, from 0. */
  channel: number;
  trigger: TakeTrigger;
}

export const defaultRecorderOptions: RecorderOptions = { input: null, channel: 0, trigger: "off" };

/** A device an adapter can listen to, by its id and the name the browser gives it. */
export interface RecorderInput {
  id: string;
  label: string;
}

/** One kind of recorder, as the registry offers it. */
export interface RecorderDefinition {
  kind: string;
  /** As the choice of recorder says it, and as the control's label shortens it. */
  label: string;
  short: string;
  /** What its input is called: "MIDI input", "Audio input". */
  inputLabel: string;
  /** Whether its audio input's channel is chosen. */
  channels: boolean;
  /** The triggers it can start and stop takes on, "off" first. */
  triggers: readonly TakeTrigger[];
  /** How each trigger reads in the choice. */
  triggerLabels: Partial<Record<TakeTrigger, string>>;
  /** Why it cannot work in this browser, or null where it can. */
  unsupported(): string | null;
  /** What the person should know before connecting, for the options chosen. */
  note(options: RecorderOptions): string;
  /** The devices it could listen to; unnamed or none until the browser has been allowed. */
  inputs(): Promise<RecorderInput[]>;
  create(options: RecorderOptions): RecorderAdapter;
}

/** Listeners and the latest status and position, which every adapter keeps the same way. */
export function createEmitter() {
  const listeners = new Set<(event: RecorderEvent) => void>();
  let status: RecorderStatus = { state: "idle" };
  let position: RecorderPosition | null = null;
  const emit = (event: RecorderEvent) => {
    if (event.type === "status") status = event.status;
    if (event.type === "position") position = event.position;
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        // One listener's fault never keeps the others from hearing the recorder.
        console.error(error);
      }
    }
  };
  return {
    emit,
    setStatus: (next: RecorderStatus) => emit({ type: "status", status: next }),
    status: () => status,
    position: () => position,
    subscribe(listener: (event: RecorderEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Words for a browser's refusal or failure, never a bare error name. */
export function failureWords(error: unknown, what: string, allow: string): string {
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return `${what} was not allowed. Allow ${allow} for this site in the browser's settings, then connect again.`;
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return `${what} is not there. Check it is plugged in, then connect again.`;
  if (name === "NotReadableError" || name === "AbortError")
    return `${what} is in use elsewhere or could not be opened. Close what else uses it, then connect again.`;
  const message = error instanceof Error && error.message ? `: ${error.message}` : "";
  return `${what} could not be opened${message}.`;
}
