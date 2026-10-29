import { useSyncExternalStore } from "react";

/**
 * The player's volume (#493): 0 to 100 in steps of 5, remembered per browser as YouTube and
 * Music remember theirs. One value for every player on the page, so a slider moved in one
 * is heard in the comparison and the take page alike.
 */

export const VOLUME_MAX = 100;
export const VOLUME_STEP = 5;
const KEY = "hekate.player.volume";

/** A volume within the range, whatever was stored or typed; full where nothing sensible was. */
export function clampVolume(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return VOLUME_MAX;
  return Math.round(Math.min(VOLUME_MAX, Math.max(0, n)));
}

/** The next step up or down: to a multiple of five, so 42 goes to 45 and then 50. */
export function stepVolume(volume: number, direction: 1 | -1): number {
  const at = clampVolume(volume);
  const next =
    direction === 1
      ? Math.floor(at / VOLUME_STEP) * VOLUME_STEP + VOLUME_STEP
      : Math.ceil(at / VOLUME_STEP) * VOLUME_STEP - VOLUME_STEP;
  return clampVolume(next);
}

/** The gain a volume plays at: 0 to 1. */
export const volumeGain = (volume: number) => clampVolume(volume) / VOLUME_MAX;

function readStored(): number {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === null ? VOLUME_MAX : clampVolume(raw);
  } catch {
    return VOLUME_MAX;
  }
}

let current: number | null = null;
const listeners = new Set<() => void>();

/** The volume now, read once from the browser and kept in memory after. */
export function readVolume(): number {
  if (current === null) current = readStored();
  return current;
}

export function writeVolume(volume: number) {
  const next = clampVolume(volume);
  if (next === current) return;
  current = next;
  try {
    localStorage.setItem(KEY, String(next));
  } catch {
    // Not remembered; the volume still holds for this visit.
  }
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** The player's volume, and a way to set it, in step with every other reader. */
export function useVolume(): [number, (volume: number) => void] {
  const volume = useSyncExternalStore(subscribe, readVolume, () => VOLUME_MAX);
  return [volume, writeVolume];
}
