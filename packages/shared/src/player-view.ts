import { z } from "zod";
import {
  defaultAnalysis,
  frequencyScales,
  spectrogramFftSizes,
  spectrogramOverlaps,
  spectrogramWindows,
} from "./spectrogram.ts";

/**
 * How someone likes the player drawn (#135), kept with their account so it follows them from
 * browser to browser: the waveform's look, where the spectrogram goes and how it is coloured,
 * and whether the line of loudness and issues shows under the player. Whether channels are
 * split is its own preference (`splitChannels`), as it was before.
 */

/** The colours a waveform may be drawn in; each is a design token. */
export const waveColours = ["ink", "signal", "cool", "warm"] as const;
export type WaveColour = (typeof waveColours)[number];

/** Where the spectrogram goes: nowhere, under the waveform, behind it, or instead of it. */
export const spectrogramPlaces = ["off", "below", "behind", "instead"] as const;
export type SpectrogramPlace = (typeof spectrogramPlaces)[number];

export const spectrogramColourMaps = ["cyan-orange", "inferno", "greyscale", "signal"] as const;
export type SpectrogramColourMap = (typeof spectrogramColourMaps)[number];

/** Brightness and height are shares, from this to 1. */
export const WAVE_LOOK_MIN = 0.15;
const share = z.number().min(WAVE_LOOK_MIN).max(1);

export const waveLookSchema = z.object({
  colour: z.enum(waveColours),
  opacity: share,
  /** How tall the wave stands in its lane; the lane itself keeps its size. */
  height: share,
});
export type WaveLook = z.infer<typeof waveLookSchema>;

/** How the spectrogram is analysed (#34): its window, FFT size and overlap. */
export const spectrumAnalysisSchema = z.object({
  window: z.enum(spectrogramWindows),
  fftSize: z.enum(spectrogramFftSizes),
  overlap: z.enum(spectrogramOverlaps),
});

export const spectrumViewSchema = z
  .object({
    colourMap: z.enum(spectrogramColourMaps),
    scale: z.enum(frequencyScales),
    /** A view kept before there was a choice is analysed as every file is. */
    analysis: spectrumAnalysisSchema.default(defaultAnalysis),
    /** Levels at or below the floor are the darkest colour; at or above the ceiling, the brightest. */
    floor: z.number().min(-200).max(20),
    ceiling: z.number().min(-200).max(20),
    /** The frequencies shown, in Hz. */
    low: z.number().min(0).max(192_000),
    high: z.number().min(0).max(192_000),
  })
  .refine((v) => v.ceiling > v.floor && v.high > v.low, "A range must span something");
export type SpectrumView = z.infer<typeof spectrumViewSchema>;

export const playerViewSchema = z.object({
  wave: waveLookSchema,
  spectrogram: z.enum(spectrogramPlaces),
  spectrum: spectrumViewSchema,
  /** The line of loudness and issues under the player. */
  loudness: z.boolean(),
});
export type PlayerViewSettings = z.infer<typeof playerViewSchema>;

export const defaultWaveLook: WaveLook = { colour: "ink", opacity: 0.5, height: 0.32 };
export const defaultSpectrumView: SpectrumView = {
  colourMap: "cyan-orange",
  scale: "log",
  analysis: defaultAnalysis,
  floor: -120,
  ceiling: 0,
  low: 20,
  high: 24_000,
};
export const defaultPlayerViewSettings: PlayerViewSettings = {
  wave: defaultWaveLook,
  spectrogram: "off",
  spectrum: defaultSpectrumView,
  loudness: true,
};

/** A view kept under a name, to come back to: "Edit", "Noise hunt". */
export const VIEW_PRESETS_MAX = 12;
export const viewPresetSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "A preset needs a name")
    .max(40, "A preset's name can be at most 40 characters"),
  view: playerViewSchema,
});
export type ViewPreset = z.infer<typeof viewPresetSchema>;
export const viewPresetsSchema = z
  .array(viewPresetSchema)
  .max(VIEW_PRESETS_MAX, `At most ${VIEW_PRESETS_MAX} presets`)
  .refine(
    (presets) => new Set(presets.map((p) => p.name.toLowerCase())).size === presets.length,
    "Each preset needs its own name",
  );

/** A preset saved under a name: a new one added at the end, one of the same name replaced. */
export function savePreset(presets: readonly ViewPreset[], preset: ViewPreset): ViewPreset[] {
  const name = preset.name.trim();
  const same = (p: ViewPreset) => p.name.toLowerCase() === name.toLowerCase();
  return presets.some(same)
    ? presets.map((p) => (same(p) ? { name, view: preset.view } : p))
    : [...presets, { name, view: preset.view }];
}
