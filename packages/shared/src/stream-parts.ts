/**
 * How a recording's channels travel in its lossless streams (#74, decision 139). A browser
 * plays at most eight channels from one stream, so a wider recording (7.1.4, 9.1.6) is carried
 * in parts of up to eight channels each, in the recording's own order: the first part is the
 * bed and the rest follow. The parts play in step and are heard as one recording.
 */

/** The most channels a browser plays from one stream. */
export const STREAM_CHANNELS = 8;

export interface StreamPart {
  /** The rendition's name: "flac" for the first part, "flac-2" and on for the rest. */
  name: string;
  /** The recording's first channel in this part, from 0. */
  from: number;
  /** How many of its channels the part carries. */
  count: number;
}

/** A recording's lossless parts: one for up to eight channels, more for a wider layout. */
export function losslessParts(channels: number): StreamPart[] {
  const parts: StreamPart[] = [];
  for (let from = 0; from < channels; from += STREAM_CHANNELS) {
    const index = parts.length;
    parts.push({
      name: index === 0 ? "flac" : `flac-${index + 1}`,
      from,
      count: Math.min(STREAM_CHANNELS, channels - from),
    });
  }
  return parts;
}

/** Which part a rendition is, by its name: 0 for "flac", 1 for "flac-2"; null for any other. */
export function losslessPartIndex(name: string): number | null {
  if (name === "flac") return 0;
  const match = /^flac-(\d+)$/.exec(name);
  const n = match ? Number(match[1]) : 0;
  return n >= 2 ? n - 1 : null;
}

/** Whether a rendition only follows another, carrying channels beyond the eighth. */
export const isFollowingPart = (name: string) => (losslessPartIndex(name) ?? 0) > 0;
