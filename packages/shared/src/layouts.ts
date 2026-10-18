import type { MediaInfo } from "./media.ts";

/**
 * Channel layouts (#74): what a recording's channels are, named as engineers name them,
 * main channels, then LFE, then height ("5.1", "7.1.4"). Read from the layout ffmpeg reports
 * (which follows a wave file's channel mask), or from an ADM master's bed.
 */

/** The layouts a delivery profile can ask for. */
export const layoutNames = [
  "1.0",
  "2.0",
  "5.1",
  "7.1",
  "5.1.2",
  "5.1.4",
  "7.1.2",
  "7.1.4",
] as const;
export type LayoutName = (typeof layoutNames)[number];

/** How many channels a layout has: "7.1.4" has 12. */
export const layoutChannels = (name: string) =>
  name.split(".").reduce((sum, n) => sum + (Number(n) || 0), 0);

/** A layout as people say it: "Mono" and "Stereo" by name, the rest by number. */
export const layoutLabel = (name: string) =>
  name === "1.0" ? "Mono" : name === "2.0" ? "Stereo" : name;

/** A layout's name from how many of its channels are main, LFE and height. */
export const layoutOf = (counts: { main: number; lfe: number; height: number }) =>
  `${counts.main}.${counts.lfe}${counts.height ? `.${counts.height}` : ""}`;

/**
 * ffmpeg's names for its common layouts, each as its channels in order (ffmpeg keeps a wave
 * file's channel mask order: front left, right, centre, LFE, back, side, then height).
 */
const ffmpegLayouts: Record<string, string> = {
  mono: "FC",
  stereo: "FL+FR",
  "2.1": "FL+FR+LFE",
  "3.0": "FL+FR+FC",
  "3.0(back)": "FL+FR+BC",
  "3.1": "FL+FR+FC+LFE",
  "4.0": "FL+FR+FC+BC",
  "4.1": "FL+FR+FC+LFE+BC",
  quad: "FL+FR+BL+BR",
  "quad(side)": "FL+FR+SL+SR",
  "5.0": "FL+FR+FC+BL+BR",
  "5.0(side)": "FL+FR+FC+SL+SR",
  "5.1": "FL+FR+FC+LFE+BL+BR",
  "5.1(side)": "FL+FR+FC+LFE+SL+SR",
  "6.0": "FL+FR+FC+BC+SL+SR",
  "6.0(front)": "FL+FR+FLC+FRC+SL+SR",
  hexagonal: "FL+FR+FC+BL+BR+BC",
  "6.1": "FL+FR+FC+LFE+BC+SL+SR",
  "6.1(back)": "FL+FR+FC+LFE+BL+BR+BC",
  "6.1(front)": "FL+FR+LFE+FLC+FRC+SL+SR",
  "7.0": "FL+FR+FC+BL+BR+SL+SR",
  "7.0(front)": "FL+FR+FC+FLC+FRC+SL+SR",
  "7.1": "FL+FR+FC+LFE+BL+BR+SL+SR",
  "7.1(wide)": "FL+FR+FC+LFE+BL+BR+FLC+FRC",
  "7.1(wide-side)": "FL+FR+FC+LFE+FLC+FRC+SL+SR",
  "5.1.2": "FL+FR+FC+LFE+BL+BR+TFL+TFR",
  "5.1.4": "FL+FR+FC+LFE+BL+BR+TFL+TFR+TBL+TBR",
  "7.1.2": "FL+FR+FC+LFE+BL+BR+SL+SR+TFL+TFR",
  "7.1.4": "FL+FR+FC+LFE+BL+BR+SL+SR+TFL+TFR+TBL+TBR",
};

/** ffmpeg's named layouts that hold an LFE channel. */
export const layoutsWithLfe = Object.keys(ffmpegLayouts).filter((name) =>
  (ffmpegLayouts[name] as string).split("+").includes("LFE"),
);

/**
 * The channels of a layout as ffmpeg reports it ("5.1(side)", or "FL+FR+FC+LFE" for one it
 * has no name for), in order; null when it says nothing of them ("6 channels").
 */
export function channelLabels(layout: string | undefined, channels: number): string[] | null {
  if (!layout) return null;
  const spelt = ffmpegLayouts[layout] ?? (layout.includes("+") ? layout : null);
  const labels = spelt?.split("+").map((l) => l.trim()) ?? null;
  return labels && labels.length === channels ? labels : null;
}

const isLfe = (label: string) => /^LFE\d?$/i.test(label);
/** ffmpeg's height channels: top centre, and top front, side and back. */
const isHeight = (label: string) => /^T[FSB]?[LCR]$/.test(label);

/** A layout's name from its channels: "FL+FR+FC+LFE+SL+SR" is 5.1. */
export function layoutFromLabels(labels: readonly string[]): string {
  const lfe = labels.filter(isLfe).length;
  const height = labels.filter(isHeight).length;
  return layoutOf({ main: labels.length - lfe - height, lfe, height });
}

/**
 * How a recording's channels are laid out: an ADM master's bed, else the layout ffmpeg
 * reports; null when the file does not say.
 */
export function fileLayout(info: MediaInfo | null | undefined): string | null {
  const adm = info?.metadata?.adm;
  if (adm) return adm.layout ?? null;
  const audio = info?.audio;
  const labels = audio ? channelLabels(audio.channelLayout, audio.channels) : null;
  return labels ? layoutFromLabels(labels) : null;
}

/** Which channels carry LFE, 0-based: an ADM master's, else the layout's. */
export function lfeChannels(info: MediaInfo | null | undefined): number[] {
  const adm = info?.metadata?.adm;
  if (adm) return adm.lfe;
  const audio = info?.audio;
  const labels = audio ? channelLabels(audio.channelLayout, audio.channels) : null;
  return (labels ?? []).flatMap((label, i) => (isLfe(label) ? [i] : []));
}
