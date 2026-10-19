import { losslessParts, STREAM_CHANNELS } from "@hekate/shared";
import { useEffect } from "react";

/**
 * Hearing a recording's channels one by one (#74): solo and mute per channel, and a stereo
 * downmix of a surround file, done in the browser with Web Audio over the lossless stream,
 * which carries every channel as recorded.
 */

/**
 * What is chosen: one channel soloed, any muted, and whether surround folds down to stereo or
 * is rendered binaurally for headphones (one or the other).
 */
export interface ChannelMix {
  solo: number | null;
  muted: readonly number[];
  downmix: boolean;
  binaural: boolean;
}

export const plainMix: ChannelMix = { solo: null, muted: [], downmix: false, binaural: false };

/** Whether a mix changes anything: the plain one is the recording as the browser plays it. */
export const isPlain = (mix: ChannelMix) =>
  mix.solo === null && mix.muted.length === 0 && !mix.downmix && !mix.binaural;

export { speakerNames } from "@hekate/shared";

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

/** The most channels a browser plays from one stream. */
export const MAX_MIX_CHANNELS = STREAM_CHANNELS;

/**
 * Why a recording's channels cannot be heard apart in what is playing, or undefined when they
 * can: a stereo file in anything, a wider one only in the lossless stream, which carries
 * every channel as recorded (the AAC is a stereo downmix; a Dolby stream is decoded as the
 * browser sees fit). A layout wider than eight is carried in parts that play together
 * (decision 139): `carried` is how many of its channels they hold.
 */
export function mixUnavailable(
  channels: number,
  rendition: string | null,
  carried = Math.min(channels, MAX_MIX_CHANNELS),
): string | undefined {
  if (channels > carried)
    return `This file has ${channels} channels, but its streams carry ${carried}: it was prepared before wider layouts were carried whole, so its channels cannot be heard apart.`;
  if (channels <= 2 || rendition === "flac") return undefined;
  if (rendition === "aac-256")
    return "Playing the AAC, which is a stereo downmix: choose Lossless to hear each channel.";
  if (rendition === "eac3" || rendition === "ac3")
    return "Playing the Dolby stream as delivered: choose Lossless to hear each channel.";
  return "Choose Lossless to hear each channel.";
}

/** Degrees to the left of straight ahead (azimuth) and above the ear (elevation). */
interface Direction {
  azimuth: number;
  elevation: number;
}

/**
 * Where each speaker stands around the listener, as ITU-R BS.2051 places them: the front pair
 * at 30°, the surrounds of 5.1 at 110°, those of 7.1 at 90° (sides) and 135° (rears), and the
 * height layer 30° up. The LFE has no place: it is heard from everywhere.
 */
export function speakerDirection(label: string, labels: readonly string[]): Direction | null {
  const withRears = labels.includes("SL") && labels.includes("BL");
  const at = (azimuth: number, elevation = 0) => ({ azimuth, elevation });
  switch (label) {
    case "FL":
      return at(30);
    case "FR":
      return at(-30);
    case "FC":
      return at(0);
    case "FLC":
      return at(15);
    case "FRC":
      return at(-15);
    case "SL":
      return at(withRears ? 90 : 110);
    case "SR":
      return at(withRears ? -90 : -110);
    case "BL":
      return at(withRears ? 135 : 110);
    case "BR":
      return at(withRears ? -135 : -110);
    case "BC":
      return at(180);
    case "TFL":
      return at(45, 30);
    case "TFR":
      return at(-45, 30);
    case "TFC":
      return at(0, 30);
    case "TSL":
      return at(90, 30);
    case "TSR":
      return at(-90, 30);
    case "TBL":
      return at(135, 30);
    case "TBR":
      return at(-135, 30);
    case "TBC":
      return at(180, 30);
    case "TC":
      return at(0, 90);
    // The wides, the surround directs and a downmix pair, as ffmpeg names them.
    case "WL":
      return at(60);
    case "WR":
      return at(-60);
    case "SDL":
      return at(90);
    case "SDR":
      return at(-90);
    case "DL":
      return at(30);
    case "DR":
      return at(-30);
    // The bottom layer, below the ear.
    case "BFL":
      return at(45, -30);
    case "BFR":
      return at(-45, -30);
    case "BFC":
      return at(0, -30);
    default:
      return null;
  }
}

const isLfe = (label: string) => /^LFE\d?$/.test(label);

/**
 * Whether a layout can be heard binaurally: each channel an LFE or a speaker with a known
 * place. One that is neither would be guessed at, so the option is not offered.
 */
export const canBinaural = (labels: readonly string[] | null) =>
  Boolean(labels?.every((l) => isLfe(l) || speakerDirection(l, labels) !== null));

/**
 * A direction as Web Audio's coordinates, a metre away: the listener at the origin facing −z,
 * x to the right, y up.
 */
export function panPosition({ azimuth, elevation }: Direction) {
  const a = (azimuth * Math.PI) / 180;
  const e = (elevation * Math.PI) / 180;
  const round = (n: number) => Math.round(n * 1e6) / 1e6 || 0;
  return {
    x: round(-Math.sin(a) * Math.cos(e)),
    y: round(Math.sin(e)),
    z: round(-Math.cos(a) * Math.cos(e)),
  };
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
    mix.binaural ? "binaural" : mix.downmix ? "stereo downmix" : null,
  ].filter(Boolean) as string[];
  if (parts.length === 0) return null;
  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

interface Graph {
  context: AudioContext;
  source: MediaElementAudioSourceNode;
  /** The elements playing a wide layout's later channels (#74), fed into the same context. */
  parts: Map<HTMLMediaElement, MediaElementAudioSourceNode>;
  nodes: AudioNode[];
}

/** One graph per element: a media element can feed Web Audio only once, for good. */
const graphs = new WeakMap<HTMLMediaElement, Graph>();

/**
 * Plays a media element through a mix of its channels. Nothing is built until the mix first
 * changes from plain, so ordinary listening never passes through Web Audio; once built, the
 * graph stays, and a plain mix through it is the recording as it was.
 *
 * A layout wider than eight channels (#74) plays from `parts` too: the elements carrying its
 * later channels, eight to a stream, in step with this one. They are always heard through the
 * graph, so every channel is one of the same recording, whichever stream carries it.
 */
export function useChannelMix(
  media: HTMLMediaElement | null,
  channels: number,
  labels: readonly string[] | null,
  mix: ChannelMix,
  parts: readonly HTMLMediaElement[] = [],
) {
  useEffect(() => {
    if (!media || channels < 1) return;
    if (!graphs.has(media) && isPlain(mix) && parts.length === 0) return;
    let graph = graphs.get(media);
    if (!graph) {
      const context = new AudioContext();
      graph = {
        context,
        source: context.createMediaElementSource(media),
        parts: new Map(),
        nodes: [],
      };
      graphs.set(media, graph);
      // A context made outside a click starts suspended; playing resumes it.
      media.addEventListener("play", () => void graph?.context.resume());
    }
    const { context, source } = graph;
    for (const node of graph.nodes) node.disconnect();
    source.disconnect();
    for (const part of graph.parts.values()) part.disconnect();
    // Each stream's channels, from the recording's channel where it starts.
    const streams = losslessParts(channels);
    const inputs = parts.length > 0 ? streams.slice(0, parts.length + 1) : [streams[0]];
    const splitters = inputs.map((stream, i) => {
      const element = i === 0 ? null : parts[i - 1];
      let input: MediaElementAudioSourceNode = source;
      if (element) {
        // An element feeds Web Audio once, for good: its source is kept for every rebuild.
        input = graph.parts.get(element) ?? context.createMediaElementSource(element);
        graph.parts.set(element, input);
      }
      const count = i === 0 && parts.length === 0 ? channels : (stream?.count ?? channels);
      const splitter = context.createChannelSplitter(count);
      input.connect(splitter);
      return { splitter, from: stream?.from ?? 0, count };
    });
    /** Connects a channel of the recording, wherever it travels, to a node. */
    const tap = (channel: number, node: AudioNode) => {
      const carrier = splitters.find((s) => channel >= s.from && channel < s.from + s.count);
      carrier?.splitter.connect(node, channel - carrier.from);
    };
    // What the parts carry is all there is to hear; a channel no stream carries stays silent.
    const heard = splitters.reduce((n, s) => Math.max(n, s.from + s.count), 0);
    const levels = channelGains(heard, mix);
    const nodes: AudioNode[] = splitters.map((s) => s.splitter);
    // A wide layout as recorded on a device with fewer outputs is folded down here, as the
    // browser does for one stream: otherwise it would only drop the channels it has no room for.
    const outputs = context.destination.maxChannelCount || 2;
    const fold = mix.downmix || (parts.length > 0 && !mix.binaural && heard > outputs);
    // A fold-down needs to know which speaker each channel is; without that, none is made.
    if (mix.binaural && labels && canBinaural(labels)) {
      // Each speaker at its place around the listener, through the browser's HRTF; the LFE
      // to both ears. Scaled by the speakers' count so a wide layout is no louder than stereo.
      const placed = labels.filter((l) => speakerDirection(l, labels)).length;
      const scale = Math.sqrt(2 / Math.max(2, placed));
      const out = context.createGain();
      out.gain.value = scale;
      labels.forEach((label, i) => {
        const gain = context.createGain();
        gain.gain.value = levels[i] ?? 0;
        tap(i, gain);
        nodes.push(gain);
        const direction = speakerDirection(label, labels);
        // canBinaural leaves only the LFE without a place: to both ears.
        if (!direction) {
          gain.gain.value *= HALF;
          gain.connect(out);
          return;
        }
        const { x, y, z } = panPosition(direction);
        // No fall-off with distance: only the direction is wanted.
        const panner = new PannerNode(context, {
          panningModel: "HRTF",
          rolloffFactor: 0,
          positionX: x,
          positionY: y,
          positionZ: z,
        });
        gain.connect(panner);
        panner.connect(out);
        nodes.push(panner);
      });
      context.destination.channelCount = 2;
      out.connect(context.destination);
      nodes.push(out);
    } else if (fold && labels) {
      const merger = context.createChannelMerger(2);
      downmixGains(labels).forEach((share, i) => {
        for (const [output, amount] of [
          [0, share.left],
          [1, share.right],
        ] as const) {
          if (amount === 0) continue;
          const gain = context.createGain();
          gain.gain.value = amount * (levels[i] ?? 0);
          tap(i, gain);
          gain.connect(merger, 0, output);
          nodes.push(gain);
        }
      });
      merger.connect(context.destination);
      nodes.push(merger);
    } else {
      // Every channel as recorded; a device with fewer outputs folds them down itself.
      const merger = context.createChannelMerger(heard);
      levels.forEach((level, i) => {
        const gain = context.createGain();
        gain.gain.value = level;
        tap(i, gain);
        gain.connect(merger, 0, i);
        nodes.push(gain);
      });
      context.destination.channelCount = Math.max(Math.min(heard, outputs), 1);
      context.destination.channelInterpretation = "speakers";
      merger.connect(context.destination);
      nodes.push(merger);
    }
    graph.nodes = nodes;
    if (!media.paused) void context.resume();
  }, [media, channels, labels, mix, parts]);
}
