import {
  bandFrequency,
  byteToLevel,
  decodeSpectrogram,
  type QaFinding,
  type Spectrogram,
} from "@hekate/shared";
import type { EncodedSpectrogram } from "./spectrogram.ts";

/**
 * How high a recording's content reaches (#41), read from the spectrograms the analysis
 * already makes. A lossy encode leaves a wall: nothing above, say, 16 kHz, where real
 * music fades into noise. A hi-res file that holds nothing above 22 kHz was most likely
 * made at 44.1 or 48 kHz and converted up.
 */

/** A column this quiet everywhere says nothing about the bandwidth (dB). */
const SILENT_COLUMN = -90;
/** Content is anything within this much of the music's level between 1 and 5 kHz (dB). */
const CONTENT_RANGE = 60;
/** A wall: the level falls by at least this much across a few hundred hertz (dB). */
const WALL_DROP = 30;

export interface AverageSpectrum {
  sampleRate: number;
  /** Each band's lower edge and upper edge, in hertz, and its average level, in dB. */
  bands: { low: number; high: number; db: number }[];
}

/**
 * The spectrum over the whole recording, loudest channel band by band: each band's level
 * averaged over the columns that are not silent.
 */
export function averageSpectrum(spectrograms: readonly Spectrogram[]): AverageSpectrum | null {
  const first = spectrograms[0];
  if (!first) return null;
  const db = new Float64Array(first.bands).fill(Number.NEGATIVE_INFINITY);
  for (const s of spectrograms) {
    if (s.bands !== first.bands) continue;
    const sum = new Float64Array(s.bands);
    let counted = 0;
    for (let col = 0; col < s.columns; col++) {
      const row = s.data.subarray(col * s.bands, (col + 1) * s.bands);
      let loudest = 0;
      for (const v of row) loudest = Math.max(loudest, v);
      if (byteToLevel(loudest) < SILENT_COLUMN) continue;
      counted++;
      for (let b = 0; b < s.bands; b++) sum[b] = (sum[b] as number) + byteToLevel(row[b] as number);
    }
    if (counted === 0) continue;
    for (let b = 0; b < s.bands; b++)
      db[b] = Math.max(db[b] as number, (sum[b] as number) / counted);
  }
  if (!db.some(Number.isFinite)) return null;
  return {
    sampleRate: first.sampleRate,
    bands: Array.from({ length: first.bands }, (_, b) => ({
      low: bandFrequency(first, b),
      high: b + 1 < first.bands ? bandFrequency(first, b + 1) : first.sampleRate / 2,
      db: db[b] as number,
    })),
  };
}

const kHz = (hz: number) => `${(hz / 1000).toFixed(1)} kHz`;

/** What the spectrum says about the bandwidth: a pass, or a wall worth a look. */
export function bandwidthFinding(spectrum: AverageSpectrum | null): QaFinding | null {
  if (!spectrum) return null;
  const { bands, sampleRate } = spectrum;
  const nyquist = sampleRate / 2;
  const mid = bands
    .filter((b) => b.low >= 1000 && b.high <= 5000 && Number.isFinite(b.db))
    .map((b) => b.db)
    .sort((a, b) => a - b);
  // Nothing between 1 and 5 kHz to judge against (a test tone, a bass line alone): no verdict.
  if (mid.length === 0) return null;
  const reference = mid[Math.floor(mid.length / 2)] as number;
  if (reference < SILENT_COLUMN) return null;
  const top = bands.findLastIndex((b) => b.db >= reference - CONTENT_RANGE);
  if (top < 0) return null;
  const reach = (bands[top] as AverageSpectrum["bands"][number]).high;
  const level = (from: number, to: number, pick: (xs: number[]) => number) => {
    const xs = bands.filter((b) => b.low >= from && b.high <= to).map((b) => b.db);
    return xs.length ? pick(xs) : Number.NEGATIVE_INFINITY;
  };
  const below = level(reach - 600, reach - 100, (xs) => xs.reduce((a, b) => a + b, 0) / xs.length);
  const above = level(reach + 200, nyquist, (xs) => Math.max(...xs));
  const wall = below - Math.max(above, -200) >= WALL_DROP && reach < 0.92 * nyquist;
  const details = { reachHz: Math.round(reach), sampleRate, wall };
  const finding = (severity: QaFinding["severity"], summary: string): QaFinding => ({
    check: "bandwidth",
    severity,
    summary,
    channel: null,
    start: null,
    end: null,
    details,
  });
  if (wall && sampleRate >= 88_200 && reach >= 19_000 && reach <= 24_500)
    return finding(
      "warn",
      `Nothing above ${kHz(reach)} in a ${sampleRate / 1000} kHz file: most likely made at 44.1 or 48 kHz and converted up`,
    );
  if (wall && reach >= 10_000 && reach < 20_000)
    return finding(
      "warn",
      `Nothing above ${kHz(reach)}: a sharp cut-off, as lossy encoding (MP3, AAC) leaves`,
    );
  return finding("pass", `Content reaches ${kHz(reach)}`);
}

/** The bandwidth finding from the encoded spectrograms of each channel. */
export function bandwidthOf(spectra: readonly EncodedSpectrogram[]): QaFinding | null {
  // The channels as recorded, not their mixes.
  const own = spectra.filter((s) => /^\d+$/.test(String(s.channel)));
  return bandwidthFinding(averageSpectrum(own.map((s) => decodeSpectrogram(s.bytes))));
}
