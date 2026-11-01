import type { Anchor } from "./anchor.ts";
import type { MediaInfo } from "./media.ts";

const pad = (n: number, width = 2) => String(Math.trunc(n)).padStart(width, "0");

/**
 * A media position, written one way wherever one is shown (#645): `0:12.000`, `4:31.250`, or
 * `1:04:31.250` past an hour, to the millisecond, as comments are anchored.
 */
export function formatClock(seconds: number): string {
  const totalMs = Math.round(Math.max(0, seconds) * 1000);
  const ms = totalMs % 1000;
  const s = Math.floor(totalMs / 1000) % 60;
  const m = Math.floor(totalMs / 60_000) % 60;
  const h = Math.floor(totalMs / 3_600_000);
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}.${pad(ms, 3)}` : `${m}:${pad(s)}.${pad(ms, 3)}`;
}

/** A stretch of media, its two ends joined by an en dash: `0:12.000–0:15.500` (#645). */
export function formatSpan(
  start: number,
  end: number,
  time: (seconds: number) => string = formatClock,
): string {
  return end > start ? `${time(start)}–${time(end)}` : time(start);
}

/** SMPTE non-drop-frame timecode, `00:01:12:08`. */
export function formatTimecode(seconds: number, fps: number): string {
  const rate = Math.round(fps);
  const frames = Math.round(seconds * fps);
  const f = frames % rate;
  const totalSeconds = Math.floor(frames / rate);
  return `${pad(totalSeconds / 3600)}:${pad((totalSeconds / 60) % 60)}:${pad(totalSeconds % 60)}:${pad(f)}`;
}

/**
 * Where a comment points, as its chip says it (#645, #702): the moment or stretch as every
 * media position is written, bars in sentence case with an en dash ("Bars 9–12"), a page
 * once ("p. 3 · bar 5"). A region says no more than where it is; a drawing says it is one.
 */
export function formatAnchor(
  anchor: Anchor,
  options: {
    fps?: number;
    /** How a moment reads instead, such as a video's own timecode (#146). */
    time?: (seconds: number) => string;
  } = {},
): string {
  const time = (s: number) =>
    options.time ? options.time(s) : options.fps ? formatTimecode(s, options.fps) : formatClock(s);
  switch (anchor.kind) {
    case "time": {
      const range = formatSpan(anchor.start, anchor.end, time);
      return anchor.frame === undefined ? range : `${range} · frame ${anchor.frame}`;
    }
    case "region": {
      if (anchor.page === undefined && anchor.at === undefined)
        return anchor.drawing ? "Drawing" : "Region";
      const at = anchor.at ?? 0;
      const where =
        anchor.page !== undefined
          ? `p. ${anchor.page}`
          : formatSpan(at, anchor.end !== undefined ? anchor.end : at, time);
      // A drawing says so (#146); a region on a page or a frame is simply where it is (#702).
      return anchor.drawing ? `${where} · drawing` : where;
    }
    case "bar": {
      // The score's page first, when the reviewer gave it (#240).
      const page = anchor.page === undefined ? "" : `p. ${anchor.page} · `;
      const bars =
        anchor.to && anchor.to.bar !== anchor.from.bar
          ? `bars ${anchor.from.bar}–${anchor.to.bar}`
          : // The beat only when it says something: bar 25 is its first beat.
            anchor.from.beat === 1
            ? `bar ${anchor.from.bar}`
            : `bar ${anchor.from.bar}.${anchor.from.beat}`;
      return page ? `${page}${bars}` : capitalFirst(bars);
    }
  }
}

const capitalFirst = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** File sizes in decimal units, as operating systems show them: `412 KB`, `1.3 GB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** `4:31` or `1:02:03`: a duration for lists, to the second. */
export function formatDuration(seconds: number): string {
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/**
 * A channel layout as engineers say it: `mono`, `stereo`, `5.1`, `7.1.4`. Uses ffprobe's
 * layout name when it has one, without the variant (`5.1(side)` reads as `5.1`).
 */
export function formatChannels(channels: number, layout?: string): string {
  if (layout && !/channels?$/.test(layout)) return layout.replace(/\(.*\)$/, "");
  if (channels === 1) return "mono";
  if (channels === 2) return "stereo";
  return `${channels} ch`;
}

/**
 * Short names for each channel, in FFmpeg's order for its named layouts. FFmpeg tells side
 * and back surrounds apart: plain `5.1` carries back channels (Lb, Rb) and `5.1(side)` side
 * channels (Ls, Rs), and the immersive layouts build on the back variant.
 */
const layoutChannels: Record<string, string[]> = {
  mono: ["M"],
  stereo: ["L", "R"],
  "2.1": ["L", "R", "LFE"],
  "3.0": ["L", "R", "C"],
  quad: ["L", "R", "Lb", "Rb"],
  "quad(side)": ["L", "R", "Ls", "Rs"],
  "5.0": ["L", "R", "C", "Lb", "Rb"],
  "5.0(side)": ["L", "R", "C", "Ls", "Rs"],
  "5.1": ["L", "R", "C", "LFE", "Lb", "Rb"],
  "5.1(side)": ["L", "R", "C", "LFE", "Ls", "Rs"],
  "7.1": ["L", "R", "C", "LFE", "Lb", "Rb", "Ls", "Rs"],
  "5.1.2": ["L", "R", "C", "LFE", "Lb", "Rb", "Ltf", "Rtf"],
  "5.1.4": ["L", "R", "C", "LFE", "Lb", "Rb", "Ltf", "Rtf", "Ltb", "Rtb"],
  "7.1.2": ["L", "R", "C", "LFE", "Lb", "Rb", "Ls", "Rs", "Ltf", "Rtf"],
  "7.1.4": ["L", "R", "C", "LFE", "Lb", "Rb", "Ls", "Rs", "Ltf", "Rtf", "Ltb", "Rtb"],
};

export function channelNames(channels: number, layout?: string): string[] {
  const named = layout ? layoutChannels[layout] : undefined;
  if (named && named.length === channels) return named;
  if (!layout || /channels?$/.test(layout)) {
    if (channels === 1) return ["M"];
    if (channels === 2) return ["L", "R"];
  }
  return Array.from({ length: channels }, (_, i) => String(i + 1));
}

/**
 * A sound's encoding as people say it (#635), never ffmpeg's id: "PCM 16-bit", "FLAC", "AAC",
 * "Dolby Digital Plus". The bit depth goes with PCM, which is nothing without it.
 */
export function audioCodecName(codec: string, bitDepth?: number): string {
  const pcm = /^pcm_([suf])(\d+)/.exec(codec);
  if (pcm) {
    const bits = pcm[2] ?? (bitDepth ? String(bitDepth) : "");
    return pcm[1] === "f" ? `PCM ${bits}-bit float` : `PCM ${bits}-bit`;
  }
  const named: Record<string, string> = {
    flac: "FLAC",
    alac: "Apple Lossless",
    aac: "AAC",
    mp3: "MP3",
    opus: "Opus",
    vorbis: "Vorbis",
    ac3: "Dolby Digital",
    eac3: "Dolby Digital Plus",
    truehd: "Dolby TrueHD",
    dts: "DTS",
  };
  return named[codec] ?? codec.toUpperCase();
}

/** Containers by the type a file was given, where ffprobe names a family of them. */
const containers: Record<string, string> = {
  "audio/wav": "WAV",
  "audio/x-wav": "WAV",
  "audio/wave": "WAV",
  "audio/flac": "FLAC",
  "audio/x-flac": "FLAC",
  "audio/aiff": "AIFF",
  "audio/x-aiff": "AIFF",
  "audio/mpeg": "MP3",
  "audio/mp4": "MPEG-4 audio",
  "audio/x-m4a": "MPEG-4 audio",
  "audio/ogg": "Ogg",
  "video/quicktime": "QuickTime",
  "video/mp4": "MP4",
  "video/x-matroska": "Matroska",
  "video/webm": "WebM",
  "application/mxf": "MXF",
  "video/mxf": "MXF",
  "video/mpeg": "MPEG",
  "video/x-msvideo": "AVI",
};

/**
 * A file's container in words (#635): by its type, else the first of ffprobe's names for it.
 * Never a MIME type.
 */
export const containerName = (format: string | undefined, contentType: string): string | null =>
  containers[contentType] ?? format?.split(",")[0]?.toUpperCase() ?? null;

/** A sound as one line (#635): "PCM 16-bit · 44.1 kHz · stereo". */
export function soundLine(audio: NonNullable<MediaInfo["audio"]>): string {
  const codec = audioCodecName(audio.codec, audio.bitDepth);
  return [
    codec,
    `${audio.sampleRate / 1000} kHz`,
    // PCM names its depth already; another codec says it apart, where it has one.
    audio.bitDepth && !codec.includes("-bit") ? `${audio.bitDepth}-bit` : null,
    formatChannels(audio.channels, audio.channelLayout),
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * A recording's or a video's format in one line, the one summary every place says it with
 * (#635): "PCM 16-bit · 44.1 kHz · stereo", "1280 × 720 · 25 fps · AAC · stereo".
 */
export function mediaFormat(info: MediaInfo | null): string | null {
  if (!info) return null;
  const parts: string[] = [];
  if (info.video) {
    parts.push(`${info.video.width} × ${info.video.height}`);
    if (info.video.fps) parts.push(`${Math.round(info.video.fps * 100) / 100} fps`);
  }
  if (info.audio) parts.push(soundLine(info.audio));
  return parts.length > 0 ? parts.join(" · ") : null;
}
