import {
  defaultPlayerViewSettings,
  defaultPreferences,
  defaultWaveLook,
  type PlayerViewSettings,
  type SpectrogramPlace,
  spectrogramPlaces,
  WAVE_LOOK_MIN,
  WAVE_OPACITY_MIN,
  type WaveColour,
  type WaveLook,
  waveColours,
} from "@hekate/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { meQuery, usePreferences, useSavePreferences } from "./queries";
import { readView } from "./spectrogram";
import { useViewer } from "./viewer";

/** Where a browser kept the view before it went with the account (#135). */
const LEGACY_VIEW = "hekate.player.view";
const LEGACY_SPECTRUM = "hekate.spectrogram.view";

/** A look as stored, kept within its range; anything unknown falls back to the default. */
export function waveLookOf(saved: unknown): WaveLook {
  const value = (saved ?? {}) as Partial<Record<keyof WaveLook, unknown>>;
  const share = (n: unknown, fallback: number, min: number) =>
    typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(min, n)) : fallback;
  return {
    colour: waveColours.includes(value.colour as WaveColour)
      ? (value.colour as WaveColour)
      : defaultWaveLook.colour,
    // No fainter than it is drawn (#495), so the slider shows what is seen.
    opacity: share(value.opacity, defaultWaveLook.opacity, WAVE_OPACITY_MIN),
    height: share(value.height, defaultWaveLook.height, WAVE_LOOK_MIN),
  };
}

/**
 * A view from what a browser kept before the account kept it: a spectrogram switch with its
 * placement beside it, later a place of its own, and the spectrogram's settings apart.
 */
export function legacyViewOf(saved: unknown, spectrum: unknown): PlayerViewSettings {
  const value = (saved && typeof saved === "object" ? saved : {}) as Record<string, unknown>;
  const place = (p: unknown): SpectrogramPlace | undefined =>
    spectrogramPlaces.includes(p as SpectrogramPlace) ? (p as SpectrogramPlace) : undefined;
  return {
    wave: waveLookOf(value.wave),
    spectrogram:
      value.spectrogram === true
        ? (place(value.placement) ?? "below")
        : (place(value.spectrogram) ?? "off"),
    spectrum: readView(spectrum),
    loudness: defaultPlayerViewSettings.loudness,
  };
}

/** What this browser keeps for a guest, who has no account to keep it with. */
interface LocalView {
  view: PlayerViewSettings;
  split: boolean;
}

const readJson = (key: string) => JSON.parse(localStorage.getItem(key) ?? "null") as unknown;

function legacyView(): PlayerViewSettings {
  try {
    return legacyViewOf(readJson(LEGACY_VIEW), readJson(LEGACY_SPECTRUM));
  } catch {
    return defaultPlayerViewSettings;
  }
}

/** A guest's view, from this browser: the same place a member's was kept before. */
export function localViewOf(saved: unknown, spectrum: unknown): LocalView {
  const value = (saved && typeof saved === "object" ? saved : {}) as Record<string, unknown>;
  return {
    view: {
      ...legacyViewOf(value, value.spectrum ?? spectrum),
      loudness: value.loudness !== false,
    },
    split: value.split === true,
  };
}

function readLocal(): LocalView {
  try {
    return localViewOf(readJson(LEGACY_VIEW), readJson(LEGACY_SPECTRUM));
  } catch {
    return { view: defaultPlayerViewSettings, split: false };
  }
}

function writeLocal(local: LocalView) {
  try {
    localStorage.setItem(LEGACY_VIEW, JSON.stringify({ ...local.view, split: local.split }));
  } catch {
    // Not remembered; the choice still holds for this visit.
  }
}

const GUEST_VIEW = ["player-view", "guest"] as const;

/** How long after the last change (a slider dragged, say) the view is saved. */
const SAVE_AFTER_MS = 400;

export interface PlayerViewState {
  view: PlayerViewSettings;
  setView: (next: PlayerViewSettings) => void;
  /** Each channel in its own lane: the account's preference, or a guest's own. */
  split: boolean;
  setSplit: (split: boolean) => void;
}

/**
 * The player's view (#135), the same for everything on the page that reads it (the player,
 * the line of loudness and issues under it). A member's goes with their account: shown at
 * once, everywhere, and saved a moment after the last change, so a dragged slider is one
 * save; a save that fails puts back what the account holds. Until it is first changed, a
 * view this browser kept before is used. A guest's is kept in this browser.
 */
export function usePlayerView(): PlayerViewState {
  const { guest } = useViewer();
  const preferences = usePreferences();
  const client = useQueryClient();
  const save = useSavePreferences();
  const [fallback] = useState(legacyView);
  const { data: local = { view: fallback, split: false } } = useQuery({
    queryKey: GUEST_VIEW,
    queryFn: readLocal,
    // Read once, now: nothing fetched later can land over a change.
    initialData: readLocal,
    staleTime: Number.POSITIVE_INFINITY,
    enabled: guest,
  });
  const timer = useRef<number | undefined>(undefined);
  const unsaved = useRef<PlayerViewSettings | null>(null);
  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    const next = unsaved.current;
    unsaved.current = null;
    if (!next) return;
    const res = await api.me.preferences.$patch({ json: { playerView: next } }).catch(() => null);
    // Not kept: what the account holds shows again.
    if (!res?.ok) await client.invalidateQueries({ queryKey: meQuery.queryKey });
  }, [client]);
  // Leaving the page saves what was changed last.
  useEffect(() => () => void flush(), [flush]);
  const setLocal = (next: LocalView) => {
    client.setQueryData(GUEST_VIEW, next);
    writeLocal(next);
  };
  const setView = (next: PlayerViewSettings) => {
    if (guest) return setLocal({ ...local, view: next });
    client.setQueryData(meQuery.queryKey, (me) =>
      me
        ? {
            ...me,
            user: {
              ...me.user,
              preferences: { ...(me.user.preferences ?? defaultPreferences), playerView: next },
            },
          }
        : me,
    );
    unsaved.current = next;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), SAVE_AFTER_MS);
  };
  return guest
    ? {
        view: local.view,
        setView,
        split: local.split,
        setSplit: (split) => setLocal({ ...local, split }),
      }
    : {
        view: preferences.playerView ?? fallback,
        setView,
        split: preferences.splitChannels,
        setSplit: (split) => save.mutate({ splitChannels: split }),
      };
}
