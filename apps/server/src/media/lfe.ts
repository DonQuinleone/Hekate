import { channelName, decodeSpectrogram, type QaFinding } from "@hekate/shared";
import { type AverageSpectrum, averageSpectrum } from "./bandwidth.ts";
import type { EncodedSpectrogram } from "./spectrogram.ts";

/**
 * Content on the LFE above its crossover (#74), read from the LFE channel's spectrogram.
 * The LFE carries only what lies below 120 Hz; anything well above it is a missing low-pass,
 * or a full-range channel in its place because the channels are in another order (film
 * order, for one, puts the LFE last).
 */

/** The LFE's crossover, in hertz (ITU-R BS.775, annex 7). */
export const LFE_CROSSOVER = 120;
/** An octave above the crossover, content within this much of the LFE's bass is a fault (dB). */
const LEAK_DB = 20;
/** Content above as loud as this, near the bass, is a full-range channel (dB). */
const FULL_RANGE_DB = 3;
/** A channel this quiet everywhere carries nothing (dB). */
const SILENT_DB = -90;

const loudest = (bands: AverageSpectrum["bands"], from: number, to: number) => {
  let best: AverageSpectrum["bands"][number] | null = null;
  for (const b of bands) {
    if (b.low < from || b.high > to || !Number.isFinite(b.db)) continue;
    if (!best || b.db > best.db) best = b;
  }
  return best;
};

const round = (n: number) => Math.round(n * 10) / 10;
const hz = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)} kHz` : `${Math.round(n)} Hz`);

/** What the LFE channel's average spectrum says: a pass, or content above the crossover. */
export function lfeFinding(spectrum: AverageSpectrum | null, channel: number): QaFinding {
  const finding = (
    severity: QaFinding["severity"],
    summary: string,
    details: QaFinding["details"] = {},
  ): QaFinding => ({
    check: "lfe",
    severity,
    summary,
    channel,
    start: null,
    end: null,
    details: { crossoverHz: LFE_CROSSOVER, ...details },
  });
  const bass = spectrum ? loudest(spectrum.bands, 20, LFE_CROSSOVER) : null;
  const above = spectrum
    ? loudest(spectrum.bands, 2 * LFE_CROSSOVER, spectrum.sampleRate / 2)
    : null;
  const reference = Math.max(
    bass?.db ?? Number.NEGATIVE_INFINITY,
    above?.db ?? Number.NEGATIVE_INFINITY,
  );
  // Every check records its pass, a silent LFE included, so the report shows it was looked at.
  if (reference < SILENT_DB) return finding("pass", `Nothing on the LFE (${channelName(channel)})`);
  const bassDb = bass?.db ?? Number.NEGATIVE_INFINITY;
  const details = {
    bassDb: Number.isFinite(bassDb) ? round(bassDb) : null,
    aboveDb: above ? round(above.db) : null,
    aboveHz: above ? Math.round(above.low) : null,
  };
  if (above && above.db >= bassDb - FULL_RANGE_DB)
    return finding(
      "fail",
      `Full-range content on the LFE (${channelName(channel)}): most likely the channels are in another order, as film order puts the LFE last`,
      details,
    );
  if (above && above.db > bassDb - LEAK_DB)
    return finding(
      "fail",
      `Content above the ${LFE_CROSSOVER} Hz crossover on the LFE (${channelName(channel)}), at ${hz(above.low)} only ${Math.round(bassDb - above.db)} dB below its bass: low-pass it at ${LFE_CROSSOVER} Hz`,
      details,
    );
  return finding("pass", `Nothing above the ${LFE_CROSSOVER} Hz crossover on the LFE`, details);
}

/** The LFE findings, one for each LFE channel, from the encoded spectrograms of each channel. */
export function lfeOf(
  spectra: readonly { channel: EncodedSpectrogram["channel"] | string; bytes: Uint8Array }[],
  lfe: readonly number[],
): QaFinding[] {
  return lfe.flatMap((channel) => {
    const own = spectra.find((s) => String(s.channel) === String(channel));
    if (!own) return [];
    return [lfeFinding(averageSpectrum([decodeSpectrogram(own.bytes)]), channel)];
  });
}
