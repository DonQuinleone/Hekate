import {
  byteToLevel,
  defaultSpectrumView,
  type FrequencyScale,
  frequencyScales,
  rowBands,
  type Spectrogram,
  type SpectrogramColourMap,
  type SpectrumView,
  spectrogramColourMaps,
} from "@hekate/shared";

export const colourMaps = spectrogramColourMaps;
export type ColourMap = SpectrogramColourMap;

export const colourMapNames: Record<ColourMap, string> = {
  "cyan-orange": "Cyan to orange",
  inferno: "Inferno",
  greyscale: "Greyscale",
  signal: "Signal",
};

export const scaleNames: Record<FrequencyScale, string> = {
  linear: "Linear",
  log: "Log",
  mel: "Mel",
  bark: "Bark",
};

/**
 * Colour maps for measured data, not interface colours, so they are fixed here rather than
 * taken from the design tokens: each must read the same in every theme. The Signal map is
 * the exception and is built from the tokens at runtime (`signalStops`).
 */
const stops: Record<Exclude<ColourMap, "signal">, string[]> = {
  // Dark through deep blue and cyan to orange and a warm white, in the manner of RX.
  "cyan-orange": [
    "#000000",
    "#06143a",
    "#0d4f8a",
    "#16a3c4",
    "#7fd3c8",
    "#f0a23a",
    "#ff6a1a",
    "#fff1dc",
  ],
  // Matplotlib's inferno, sampled at ten points.
  inferno: [
    "#000004",
    "#160b39",
    "#420a68",
    "#6a176e",
    "#932667",
    "#bc3754",
    "#dd513a",
    "#f37819",
    "#fca50a",
    "#f6d746",
    "#fcffa4",
  ],
  greyscale: ["#000000", "#ffffff"],
};

const parse = (hex: string): [number, number, number] => {
  const value = Number.parseInt(hex.replace("#", "").slice(0, 6), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};

/** A 256-entry RGB lookup table through evenly spaced colour stops. */
export function lookupTable(colours: string[]): Uint8Array {
  const rgb = colours.map(parse);
  const table = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const position = (i / 255) * (rgb.length - 1);
    const at = Math.min(rgb.length - 2, Math.floor(position));
    const t = position - at;
    const a = rgb[at] as [number, number, number];
    const b = rgb[at + 1] as [number, number, number];
    for (let c = 0; c < 3; c++) {
      const from = a[c] as number;
      table[i * 3 + c] = Math.round(from + ((b[c] as number) - from) * t);
    }
  }
  return table;
}

export function colourTable(map: ColourMap, signalStops?: string[]): Uint8Array {
  return lookupTable(map === "signal" ? (signalStops ?? ["#000000", "#ffffff"]) : stops[map]);
}

export type SpectrogramView = SpectrumView;
export const defaultView: SpectrogramView = defaultSpectrumView;

/** A view from storage, with anything missing or invalid replaced by the default. */
export function readView(value: unknown): SpectrogramView {
  const v = (typeof value === "object" && value !== null ? value : {}) as Partial<
    Record<keyof SpectrogramView, unknown>
  >;
  const number = (x: unknown, fallback: number) =>
    typeof x === "number" && Number.isFinite(x) ? x : fallback;
  const within = (x: number, min: number, max: number) => Math.min(max, Math.max(min, x));
  // Within what the account keeps (spectrumViewSchema): −200 to +20 dB, up to 192 kHz.
  const floor = within(number(v.floor, defaultView.floor), -200, 19);
  const ceiling = within(number(v.ceiling, defaultView.ceiling), -199, 20);
  const low = within(number(v.low, defaultView.low), 0, 191_999);
  const high = within(number(v.high, defaultView.high), 1, 192_000);
  return {
    colourMap: colourMaps.includes(v.colourMap as ColourMap)
      ? (v.colourMap as ColourMap)
      : defaultView.colourMap,
    scale: frequencyScales.includes(v.scale as FrequencyScale)
      ? (v.scale as FrequencyScale)
      : defaultView.scale,
    // A range always spans something: a ceiling at or below the floor, or a top at or
    // below the bottom, moves up.
    floor,
    ceiling: Math.max(ceiling, floor + 1),
    low: Math.max(0, low),
    high: Math.max(high, Math.max(0, low) + 1),
  };
}

/**
 * Draw a spectrogram into RGBA pixels, `width × height`, top row highest. Every pixel
 * shows the loudest value of the columns and bands it covers, so nothing narrow vanishes
 * when the view is smaller than the data.
 */
/**
 * Several channels' spectrograms as one: each cell the loudest of them, as the combined
 * waveform shows each moment's widest swing across every channel.
 */
export function combineSpectrograms(spectrograms: Spectrogram[]): Spectrogram | undefined {
  const [first] = spectrograms;
  if (!first) return undefined;
  const data = new Uint8Array(first.data);
  for (const other of spectrograms.slice(1)) {
    if (other.data.length !== data.length) continue;
    for (let i = 0; i < data.length; i++) {
      if ((other.data[i] as number) > (data[i] as number)) data[i] = other.data[i] as number;
    }
  }
  return { ...first, data };
}

export function renderSpectrogram(
  spectrogram: Spectrogram,
  width: number,
  height: number,
  view: SpectrogramView,
  table: Uint8Array,
  into?: Uint8ClampedArray,
): Uint8ClampedArray {
  const out = into ?? new Uint8ClampedArray(width * height * 4);
  const nyquist = spectrogram.sampleRate / 2;
  const high = Math.min(view.high, nyquist);
  const low = Math.min(view.low, high - 1);
  const rows = rowBands(spectrogram, height, view.scale, low, high);
  // Byte value to colour index, through the floor and ceiling.
  const index = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    const t = (byteToLevel(v) - view.floor) / (view.ceiling - view.floor);
    index[v] = Math.round(Math.max(0, Math.min(1, t)) * 255);
  }
  const { columns, bands, data } = spectrogram;
  for (let x = 0; x < width; x++) {
    const first = Math.floor((x * columns) / width);
    const last = Math.max(first + 1, Math.floor(((x + 1) * columns) / width));
    for (let y = 0; y < height; y++) {
      const from = rows[y * 2] as number;
      const to = rows[y * 2 + 1] as number;
      let top = 0;
      for (let c = first; c < last && c < columns; c++) {
        const base = c * bands;
        for (let b = from; b <= to; b++) {
          const value = data[base + b] as number;
          if (value > top) top = value;
        }
      }
      const colour = (index[top] as number) * 3;
      const at = (y * width + x) * 4;
      out[at] = table[colour] as number;
      out[at + 1] = table[colour + 1] as number;
      out[at + 2] = table[colour + 2] as number;
      out[at + 3] = 255;
    }
  }
  return out;
}
