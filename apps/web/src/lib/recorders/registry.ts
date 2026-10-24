import type { RecorderDefinition } from "./adapter";
import { soundDevices, timecodeIn } from "./ltc";
import { dawMidi } from "./midi";

/**
 * Every recorder the take log can read (decision 240), in the order the choice lists them. A
 * new kind of recorder is one more adapter here: a Zaxcom (ZaxNet's take names, through a
 * serial port or a small local bridge) would join the list without anything else changing.
 */
export const recorderDefinitions: readonly RecorderDefinition[] = [
  dawMidi,
  soundDevices,
  timecodeIn,
];

/** A kind of recorder by its name; null for one this version does not know. */
export const recorderDefinition = (kind: string | null | undefined) =>
  recorderDefinitions.find((d) => d.kind === kind) ?? null;
