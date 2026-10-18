import { useEffect } from "react";

/**
 * Hearing a recording's channels one by one (#74): solo and mute per channel, and a stereo
 * downmix of a surround file, done in the browser with Web Audio over the lossless stream,
 * which carries every channel as recorded.
 */

/** What is chosen: one channel soloed, any muted, and whether surround folds down to stereo. */
export interface ChannelMix {
  solo: number | null;
  muted: readonly number[];
  downmix: boolean;
}

export const plainMix: ChannelMix = { solo: null, muted: [], downmix: false };

/** Whether a mix changes anything: the plain one is the recording as the browser plays it. */
export const isPlain = (mix: ChannelMix) =>
  mix.solo === null && mix.muted.length === 0 && !mix.downmix;

/**
 * Speakers as engineers name them, from ffmpeg's channel labels (FL, FR, FC, LFE...). The rear
 * pair is Ls and Rs on its own, Lrs and Rrs beside a side pair (7.1).
 */
export function speakerNames(labels: readonly string[] | null, channels: number): string[] {
  if (!labels) return Array.from({ length: channels }, (_, i) => String(i + 1));
  const sidesAndBacks = labels.includes("SL") && labels.includes("BL");
  const names: Record<string, string> = {
    FL: "L",
    FR: "R",
    FC: "C",
    LFE: "LFE",
    LFE2: "LFE2",
    FLC: "Lc",
    FRC: "Rc",
    BC: "Cs",
    BL: sidesAndBacks ? "Lrs" : "Ls",
    BR: sidesAndBacks ? "Rrs" : "Rs",
    SL: sidesAndBacks ? "Lss" : "Ls",
    SR: sidesAndBacks ? "Rss" : "Rs",
    TC: "Ts",
    TFL: "Ltf",
    TFC: "Ctf",
    TFR: "Rtf",
    TBL: "Ltr",
    TBC: "Ctr",
    TBR: "Rtr",
    TSL: "Lts",
    TSR: "Rts",
  };
  return labels.map((l) => names[l] ?? l);
}

const lefts = new Set(["FL", "FLC", "BL", "SL", "TFL", "TBL", "TSL"]);
const rights = new Set(["FR", "FRC", "BR", "SR", "TFR", "TBR", "TSR"]);

/** A channel's place in a stereo fold-down: left, right, both, or out (the LFE). */
function side(label: string): "left" | "right" | "centre" | "out" {
  if (/^LFE/.test(label)) return "out";
  if (lefts.has(label)) return "left";
  if (rights.has(label)) return "right";
  return "centre";
}

/** −3 dB: what a channel brings to each side when it sits between them, or behind. */
const HALF = Math.SQRT1_2;

/**
 * Each channel's share of the left and right of a stereo fold-down (ITU-R BS.775): the front
 * pair whole, centre and everything else at −3 dB, the LFE left out; scaled so no side can
 * sum above full scale, as ffmpeg's own downmix (the AAC rendition) is.
 */
export function downmixGains(labels: readonly string[]) {
  const gains = labels.map((label) => {
    const share = label === "FL" || label === "FR" ? 1 : HALF;
    switch (side(label)) {
      case "left":
        return { left: share, right: 0 };
      case "right":
        return { left: 0, right: share };
      case "centre":
        return { left: HALF, right: HALF };
      default:
        return { left: 0, right: 0 };
    }
  });
  const loudest = Math.max(
    1,
    gains.reduce((sum, g) => sum + g.left, 0),
    gains.reduce((sum, g) => sum + g.right, 0),
  );
  return gains.map((g) => ({ left: g.left / loudest, right: g.right / loudest }));
}

/** The most channels a browser plays from one stream, and so the most heard apart. */
export const MAX_MIX_CHANNELS = 8;

/**
 * Why a recording's channels cannot be heard apart in what is playing, or undefined when they
 * can: a stereo file in anything, a wider one only in the lossless stream, which carries
 * every channel as recorded (the AAC is a stereo downmix; a Dolby stream is decoded as the
 * browser sees fit).
 */
export function mixUnavailable(channels: number, rendition: string | null): string | undefined {
  if (channels > MAX_MIX_CHANNELS)
    return `This file has ${channels} channels; a browser plays up to ${MAX_MIX_CHANNELS} from one stream, so they cannot be heard apart yet.`;
  if (channels <= 2 || rendition === "flac") return undefined;
  if (rendition === "aac-256")
    return "Playing the AAC, which is a stereo downmix: choose Lossless to hear each channel.";
  if (rendition === "eac3" || rendition === "ac3")
    return "Playing the Dolby stream as delivered: choose Lossless to hear each channel.";
  return "Choose Lossless to hear each channel.";
}

/** Each channel's level under a mix: a solo silences the rest, a mute its channel. */
export const channelGains = (channels: number, mix: ChannelMix) =>
  Array.from({ length: channels }, (_, i) =>
    (mix.solo !== null && mix.solo !== i) || mix.muted.includes(i) ? 0 : 1,
  );

/** What the person hears, in a few words, beside the player's controls. */
export function mixLabel(mix: ChannelMix, names: readonly string[]): string | null {
  const parts = [
    mix.solo !== null ? `Solo ${names[mix.solo] ?? mix.solo + 1}` : null,
    mix.solo === null && mix.muted.length > 0
      ? `${mix.muted.map((i) => names[i] ?? i + 1).join(", ")} muted`
      : null,
    mix.downmix ? "stereo downmix" : null,
  ].filter(Boolean) as string[];
  if (parts.length === 0) return null;
  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

interface Graph {
  context: AudioContext;
  source: MediaElementAudioSourceNode;
  nodes: AudioNode[];
}

/** One graph per element: a media element can feed Web Audio only once, for good. */
const graphs = new WeakMap<HTMLMediaElement, Graph>();

/**
 * Plays a media element through a mix of its channels. Nothing is built until the mix first
 * changes from plain, so ordinary listening never passes through Web Audio; once built, the
 * graph stays, and a plain mix through it is the recording as it was.
 */
export function useChannelMix(
  media: HTMLMediaElement | null,
  channels: number,
  labels: readonly string[] | null,
  mix: ChannelMix,
) {
  useEffect(() => {
    if (!media || channels < 1) return;
    if (!graphs.has(media) && isPlain(mix)) return;
    let graph = graphs.get(media);
    if (!graph) {
      const context = new AudioContext();
      graph = { context, source: context.createMediaElementSource(media), nodes: [] };
      graphs.set(media, graph);
      // A context made outside a click starts suspended; playing resumes it.
      media.addEventListener("play", () => void graph?.context.resume());
    }
    const { context, source } = graph;
    for (const node of graph.nodes) node.disconnect();
    source.disconnect();
    const splitter = context.createChannelSplitter(channels);
    source.connect(splitter);
    const levels = channelGains(channels, mix);
    const nodes: AudioNode[] = [splitter];
    // A fold-down needs to know which speaker each channel is; without that, none is made.
    if (mix.downmix && labels) {
      const merger = context.createChannelMerger(2);
      downmixGains(labels).forEach((share, i) => {
        for (const [output, amount] of [
          [0, share.left],
          [1, share.right],
        ] as const) {
          if (amount === 0) continue;
          const gain = context.createGain();
          gain.gain.value = amount * (levels[i] ?? 0);
          splitter.connect(gain, i);
          gain.connect(merger, 0, output);
          nodes.push(gain);
        }
      });
      merger.connect(context.destination);
      nodes.push(merger);
    } else {
      // Every channel as recorded; a device with fewer outputs folds them down itself.
      const merger = context.createChannelMerger(channels);
      levels.forEach((level, i) => {
        const gain = context.createGain();
        gain.gain.value = level;
        splitter.connect(gain, i);
        gain.connect(merger, 0, i);
        nodes.push(gain);
      });
      const outputs = Math.min(channels, context.destination.maxChannelCount || 2);
      context.destination.channelCount = Math.max(outputs, 1);
      context.destination.channelInterpretation = "speakers";
      merger.connect(context.destination);
      nodes.push(merger);
    }
    graph.nodes = nodes;
    if (!media.paused) void context.resume();
  }, [media, channels, labels, mix]);
}
