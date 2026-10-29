import {
  type CaptionTrack,
  channelLabels,
  type DrawingColour,
  type DrawingTool,
  formatChannels,
  formatClock,
  formatDuration,
  frameShowing,
  frameTime,
  isFollowingPart,
  layoutChannels,
  losslessPartIndex,
  type Matte,
  type MediaInfo,
  mattes,
  type Normalisation,
  normalisationLabel,
  parseTimeEntry,
  regionShowsAt,
  type SpectrogramPlace,
  STREAM_CHANNELS,
  savePreset,
  spectrogramPlaces,
  type TimeEntryContext,
  timecodeFor,
  timeEntryHint,
  VIEW_PRESETS_MAX,
  type VideoClock,
  videoClock,
  videoTimecode,
  WAVE_LOOK_MIN,
  type WatermarkPosition,
  type WaveLook,
  waveColours,
} from "@hekate/shared";
import { Link } from "@tanstack/react-router";
import type Hls from "hls.js";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type ChannelMix,
  canBinaural,
  mixUnavailable,
  plainMix,
  speakerNames,
  useChannelMix,
} from "~/lib/channel-mix";
import { cn } from "~/lib/cn";
import type { EditSegment } from "~/lib/edit-decisions";
import { type Loop, loopEntry, loopFrom, type Rolls, roll, wrapTarget } from "~/lib/loop";
import { adjacentMarker, markerTimes } from "~/lib/markers";
import { usePlayerView } from "~/lib/player-view";
import { type Playback, type Rendition, usePreferences, useSavePreferences } from "~/lib/queries";
import { useAnnounce, useShortcuts } from "~/lib/shortcuts";
import { readView, type SpectrogramView } from "~/lib/spectrogram";
import { holdRate } from "~/lib/speed";
import { familyOf, type VideoFamily, videoFamilyFor } from "~/lib/video-family";
import { useViewer } from "~/lib/viewer";
import { stepVolume, useVolume, VOLUME_MAX, VOLUME_STEP, volumeGain } from "~/lib/volume";
import { anchoredScroll, followScroll, maxZoom, panScroll, zoomLabel, zoomStep } from "~/lib/zoom";
import { ChannelsButton, ChannelsPanel } from "./channels";
import { CutVideo } from "./cut-video";
import {
  DrawingMarks,
  DrawLayer,
  DrawToolbar,
  type FrameDraft,
  type FrameDrawing,
  useFrameClock,
} from "./drawings";
import { EditLane } from "./edit-lane";
import { Filmstrip } from "./filmstrip";
import { Icon } from "./icons";
import { LoopControls, LoopSurface } from "./loop";
import { PlayheadMeters } from "./loudness";
import { Spectrogram, type SpectrogramChannelChoice } from "./spectrogram";
import { SpectrogramLook, SpectrogramSettings } from "./spectrogram-settings";
import { nativeSource, StreamPart, wholeRendition } from "./stream-part";
import { CaptionLine, CaptionsMenu } from "./transcript";
import { Button } from "./ui/button";
import { Floating } from "./ui/floating";
import { Input, Select } from "./ui/input";
import { Dropdown, usePopover } from "./ui/menu";
import { Segmented } from "./ui/segmented";
import { Slider } from "./ui/slider";
import { Toggle } from "./ui/toggle";
import { CaptionText, FrameGuides } from "./video-frame";
import {
  WAVEFORM_HEIGHT,
  Waveform,
  type WaveformView,
  waveColourNames,
  waveTokens,
} from "./waveform";

const ROLLS_KEY = "hekate.loop.rolls";

/** Pre-roll and post-roll, remembered per browser; storage can be missing or refuse. */
function useRolls(): [Rolls, (rolls: Rolls) => void] {
  const [rolls, setRolls] = useState<Rolls>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(ROLLS_KEY) ?? "null") as Partial<Rolls> | null;
      return { pre: roll(saved?.pre ?? 0), post: roll(saved?.post ?? 0) };
    } catch {
      return { pre: 0, post: 0 };
    }
  });
  const save = (next: Rolls) => {
    setRolls(next);
    try {
      localStorage.setItem(ROLLS_KEY, JSON.stringify(next));
    } catch {
      // Not remembered; the setting still holds for this visit.
    }
  };
  return [rolls, save];
}

/** How the audio is drawn above the transport. */
type Display = "waveform" | "spectrogram" | "both" | "overlay";

const placeNames: Record<SpectrogramPlace, string> = {
  off: "Off",
  below: "Below",
  behind: "Behind",
  instead: "Instead",
};

/** A problem the quality checks found, where it is (#43): a failure filled, a warning outlined. */
export interface FindingMark {
  start: number;
  end: number | null;
  severity: "fail" | "warn";
}

/** A comment's mark on the timeline: open ones quiet, ones with work to do in the signal colour. */
export interface TimelineMarker {
  at: number;
  state: "open" | "todo" | "deferred";
}
const markerStyles: Record<TimelineMarker["state"], string> = {
  open: "bg-ink-2",
  todo: "bg-signal",
  deferred: "bg-ink-3 opacity-60",
};

/** What a reviewer chooses between, in plain words. */
export function renditionLabel(rendition: Rendition, info: MediaInfo | null): string {
  const audio = info?.audio;
  // An ADM master's lossless stream carries its render onto a layout (decision 140).
  const rendered = info?.metadata?.adm?.rendered;
  const layout = rendered
    ? `${rendered} render`
    : audio
      ? formatChannels(audio.channels, audio.channelLayout)
      : "";
  switch (rendition.name) {
    case "aac-256":
      return "AAC · stereo";
    case "flac":
      return audio
        ? `Lossless · ${audio.sampleRate / 1000} kHz${audio.bitDepth ? ` · ${audio.bitDepth}-bit` : ""} · ${layout}`
        : "Lossless";
    case "eac3":
      return audio ? `Dolby Digital Plus · ${layout}` : "Dolby Digital Plus";
    case "ac3":
      return audio ? `Dolby Digital · ${layout}` : "Dolby Digital";
    default: {
      // A royalty-free encoding beside H.264 says which it is (#148).
      const free = /-(av1|vp9)$/.exec(rendition.name)?.[1];
      if (!rendition.height) return rendition.name;
      return free ? `${rendition.height}p · ${free.toUpperCase()}` : `${rendition.height}p`;
    }
  }
}

/**
 * The rendition to start with: the original Dolby stream when the browser can decode it,
 * then lossless, then whatever is left. Video starts on automatic selection.
 */
export function preferredRendition(available: Rendition[]): Rendition | undefined {
  const order = ["eac3", "ac3", "flac", "aac-256"];
  return [...available]
    .filter((r) => order.includes(r.name))
    .sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name))[0];
}

/** The speeds offered, as the prototype's: slower to follow a passage, faster to skim. */
export const playbackRates = [0.5, 0.75, 1, 1.25, 1.5] as const;

/** A speed as the player shows it: "1×", "0.75×". */
export const rateLabel = (rate: number) => `${rate}×`;

interface Choice {
  rendition: Rendition;
  level: number;
}

type Failure = "unsupported" | "codecs" | "expired" | "failed";

const failureCopy: Record<Failure, string> = {
  unsupported: "This browser cannot play protected streams.",
  codecs: "This browser cannot decode any of this file's renditions.",
  expired: "This playback link has expired.",
  failed: "Playback stopped because the stream could not be loaded.",
};

/** About half of the smallest audio buffer a browser gives (Chrome's is about 12 MB). */
const AUDIO_BUFFER_BYTES = 6_000_000;

/**
 * Browsers give audio-only streams a small buffer, which a few segments of high-resolution
 * surround overflow. hls.js reads ahead by bytes and by seconds, so bound both: about 6 MB
 * of the heaviest rendition, between 6 and 30 seconds. Streams too heavy for 30 seconds
 * also let played audio go at once, so nothing behind the playhead takes the space.
 */
export function audioBuffer(renditions: Rendition[]) {
  const peak = Math.max(1, ...renditions.map((r) => r.bandwidth));
  const seconds = Math.min(30, Math.max(6, Math.floor((AUDIO_BUFFER_BYTES * 8) / peak)));
  return {
    maxBufferSize: AUDIO_BUFFER_BYTES,
    maxBufferLength: seconds,
    maxMaxBufferLength: seconds,
    backBufferLength: seconds < 30 ? 0 : 10,
  };
}

/**
 * Plays a protected stream: encrypted HLS, decrypted in the browser through Media Source
 * Extensions. Only this session can fetch the playlists, segments and keys.
 */
export function Player({
  fileId,
  kind,
  playback,
  info,
  onExpired,
  onMedia,
  markers = [],
  findings = [],
  edits = [],
  loop = null,
  onLoop = () => {},
  cue,
  tools = null,
  mark = null,
  normalisation = null,
  normalised = false,
  onNormalised,
  drawings = [],
  draft = null,
  onDraft,
  cuts = null,
  captions = [],
  caption: captionChosen,
  onCaption,
  compact = false,
  strip,
  compare = null,
  follow = null,
  gain = 1,
}: {
  fileId: string;
  kind: "audio" | "video";
  playback: Playback;
  info: MediaInfo | null;
  onExpired: () => void;
  /** The media element, once mounted, so other panels can read and move the playhead. */
  onMedia?: (element: HTMLMediaElement | null) => void;
  /** Moments to mark on the timeline, such as anchored comments. */
  markers?: TimelineMarker[];
  /** What the quality checks found, marked under the timeline (#43). */
  findings?: FindingMark[];
  /** A version's edits, from its edit decision list, laid under the waveform (#56). */
  edits?: readonly EditSegment[];
  /** The passage being looped; kept by the page so it holds across files. */
  loop?: Loop | null;
  onLoop?: (loop: Loop | null) => void;
  /** Changes each time the page asks to hear the loop, which switches it back on. */
  cue?: number;
  /** The tools a guest's review or a member's role allows; null for every one. */
  tools?: readonly string[] | null;
  /** The viewer's visible mark, laid over a video where the project marks them (#31). */
  mark?: VisibleMark | null;
  /** A deliverable's cut and the one before it, to compare frame by frame (#147). */
  cuts?: {
    mine: string;
    previous: { fileId: string; label: string };
    /** The two cuts' versions on the comparison page, for whoever may open it. */
    compare?: { trackId: string; a: number; b: number } | null;
  } | null;
  /**
   * A video's picture small, beside its lanes and transport, where what matters is what was
   * measured (QA, #42). The same element plays on, so switching views never stops it.
   */
  compact?: boolean;
  /** A video's or a recording's caption tracks (#146, #201), offered in the Captions menu. */
  captions?: readonly CaptionTrack[];
  /**
   * The track shown, by id, where the page keeps it (for the transcript to follow); the
   * player keeps its own otherwise. None until chosen.
   */
  caption?: string | null;
  onCaption?: (id: string | null) => void;
  /**
   * The page's part of the strip above the player (#15): what leads it (the version and
   * variant), and what sits at its end before the player's own menus (the score's switch).
   */
  strip?: { lead?: ReactNode; end?: ReactNode };
  /** The comparison under the transport (#44), where it is offered: whether it is open. */
  compare?: { open: boolean; onToggle: () => void } | null;
  /** Normalised playback (#240): offered as a switch where it is each person's choice. */
  normalisation?: Normalisation | null;
  /** Whether it is heard normalised now, and the switch's choice. */
  normalised?: boolean;
  onNormalised?: (normalised: boolean) => void;
  /** Threads' drawings on the video, shown on their frame or through their range (#146). */
  drawings?: FrameDrawing[];
  /** The drawing waiting to join the comment being written. */
  draft?: FrameDraft | null;
  /** Drawing is offered where it is given: to someone who may comment on a video. */
  onDraft?: (draft: FrameDraft | null) => void;
  /** Following a DAW (#450): its settings, at the View menu's end, where the page offers it. */
  follow?: ReactNode;
  /**
   * The gain it plays at under the volume (#240): normalised playback's, or full. Null while
   * something else sets the element's volume (the comparison, level-matching its sources).
   */
  gain?: number | null;
}) {
  const preferences = usePreferences();
  const { guest } = useViewer();
  const canLoop = !tools || tools.includes("loops");
  /** Where normalising is each person's choice, the View menu offers it (#240). */
  const offersNormalise = normalisation?.mode === "optional";
  // The project grants the spectrogram; the member chooses whether to see it offered.
  const canSpectrogram = (!tools || tools.includes("spectrogram")) && preferences.showSpectrogram;
  const media = useRef<HTMLVideoElement & HTMLAudioElement>(null);
  // Kept in a ref so a new callback from the parent does not restart playback.
  const announce = useRef(onMedia);
  announce.current = onMedia;
  const hls = useRef<Hls | null>(null);
  const [choices, setChoices] = useState<Choice[]>([]);
  /** A level index, or -1 for automatic selection. */
  const [level, setLevel] = useState(-1);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(info?.duration ?? 0);
  const [buffered, setBuffered] = useState(0);
  const [muted, setMuted] = useState(false);
  /** The volume (#493), one per browser, under the page's gain. */
  const [volume, setVolume] = useVolume();
  /** The last volume above silence, for the speaker to come back to from zero. */
  const lastLoud = useRef(volume > 0 ? volume : VOLUME_MAX);
  if (volume > 0) lastLoud.current = volume;
  /** Where the spectrogram was before the toolbar switched it off, to come back to. */
  const lastPlace = useRef<SpectrogramPlace>("below");
  /** How fast it plays (#15), as the prototype offers; pitch is kept. */
  const [rate, setRate] = useState(1);
  /** A source is attached, so play can start. */
  const [ready, setReady] = useState(false);
  /** The encoding the video plays in (#148), for another cut compared with it to match. */
  const [family, setFamily] = useState<VideoFamily | null>(null);
  /** Safari on iOS plays the stream itself, so its errors come from the element, not hls.js. */
  const native = useRef(false);
  /** The media element once mounted, for the waveform to follow. */
  const [element, setElement] = useState<HTMLMediaElement | null>(null);
  const fps = info?.video?.fps;
  const { view: playerView, setView: setPlayerView, split, setSplit } = usePlayerView();
  const savePreferences = useSavePreferences();
  // A video counts in frames on its own timecode (#146); null where its rate is unknown.
  const clock = useMemo(() => (info?.video ? videoClock(info.video) : null), [info?.video]);
  /** How long a frame shows: a drawing on one shows for that long (#146). */
  const frameSeconds = clock ? frameTime(1, clock.rate) : 1 / 25;
  /** The captions shown over the picture, by id; none until chosen. */
  const [ownCaption, setOwnCaption] = useState<string | null>(null);
  const captionId = captionChosen !== undefined ? captionChosen : ownCaption;
  const setCaptionId = onCaption ?? setOwnCaption;
  const caption = captions.find((c) => c.id === captionId) ?? null;
  // Followed frame by frame while it plays, but only when there is a drawing or a caption to
  // show (#146).
  const frameNow = useFrameClock(
    media,
    kind === "video" && playing && (drawings.length > 0 || Boolean(caption)),
    time,
  );
  /** The drafts each new drawing replaced, newest last, for Undo; gone once the draft is. */
  const undo = useRef<(FrameDraft | null)[]>([]);
  useEffect(() => {
    if (!draft) undo.current = [];
  }, [draft]);
  const [matte, setMatte] = useState<Matte | null>(null);
  // Comparing with the cut before (#147): one over the other with a wipe, or side by side.
  const [cutView, setCutView] = useState<"wipe" | "side" | null>(null);
  const [wipe, setWipe] = useState(0.5);
  // A small picture is for reading measurements beside, not for comparing cuts.
  const canCompareCuts =
    kind === "video" && Boolean(cuts) && !compact && (!tools || tools.includes("compare"));
  const comparing = canCompareCuts && cuts ? cutView : null;
  const [safe, setSafe] = useState(false);
  // Drawing on the frame (#146): the tool and colour chosen, kept while drawing is on.
  const [drawingOn, setDrawingOn] = useState(false);
  const [tool, setTool] = useState<DrawingTool>("box");
  const [colour, setColour] = useState<DrawingColour>("signal");
  const channels = info?.audio?.channels ?? 0;
  // Each channel to hear apart (#74), over the lossless stream that carries them all.
  const [mix, setMix] = useState<ChannelMix>(plainMix);
  // The Channels and View menus open from the strip above the player, as the prototype's do.
  const [channelsOpen, setChannelsOpen, channelsBox] = usePopover();
  // biome-ignore lint/correctness/useExhaustiveDependencies: each file starts as recorded.
  useEffect(() => setMix(plainMix), [fileId]);
  // What is heard: a recording's own channels, or an ADM master's render of its bed and objects
  // onto a layout (decision 140), which is what its streams carry. Drawings and analysis stay
  // the master's own.
  const rendered = info?.metadata?.adm?.rendered;
  const heard = rendered ? layoutChannels(rendered) : channels;
  const channelLayout = rendered
    ? rendered === "2.0"
      ? "stereo"
      : rendered
    : info?.audio?.channelLayout;
  const labels = useMemo(() => channelLabels(channelLayout, heard), [channelLayout, heard]);
  const names = useMemo(() => speakerNames(labels, heard), [labels, heard]);
  const heardRendition = choices.find((c) => c.level === level)?.rendition.name ?? null;
  // A layout wider than eight channels (#74) also plays its later channels from parts of their
  // own, in step with the lossless stream and heard through the same mix.
  const partRenditions = useMemo(
    () =>
      playback.renditions
        .filter((r) => isFollowingPart(r.name))
        .sort((a, b) => (losslessPartIndex(a.name) ?? 0) - (losslessPartIndex(b.name) ?? 0)),
    [playback.renditions],
  );
  const carried = Math.min(heard, STREAM_CHANNELS * (partRenditions.length + 1));
  const [partElements, setPartElements] = useState<(HTMLAudioElement | null)[]>([]);
  const playsParts = kind === "audio" && heardRendition === "flac" && partRenditions.length > 0;
  const parts = useMemo(() => {
    const ready = partElements.slice(0, partRenditions.length);
    return playsParts && ready.length === partRenditions.length && ready.every(Boolean)
      ? (ready as HTMLAudioElement[])
      : [];
  }, [playsParts, partElements, partRenditions.length]);
  const channelsUnavailable = mixUnavailable(heard, heardRendition, carried);
  // Folding down or placing the speakers needs each channel's speaker; a file that does not
  // say offers neither.
  const heardMix = channelsUnavailable
    ? plainMix
    : labels
      ? { ...mix, binaural: mix.binaural && canBinaural(labels) }
      : { ...mix, downmix: false, binaural: false };
  useChannelMix(element, heard, labels, heardMix, parts);
  const view: WaveformView = split && channels > 1 ? "channels" : "combined";
  const display: Display =
    !canSpectrogram || playerView.spectrogram === "off"
      ? "waveform"
      : playerView.spectrogram === "behind"
        ? "overlay"
        : playerView.spectrogram === "instead"
          ? "spectrogram"
          : "both";
  const look = playerView.wave;
  const setLook = (wave: Partial<WaveLook>) =>
    setPlayerView({ ...playerView, wave: { ...playerView.wave, ...wave } });
  const spectrum = playerView.spectrum;
  const setSpectrum = (next: SpectrogramView) =>
    setPlayerView({ ...playerView, spectrum: readView(next) });
  const [spectrumChannel, setSpectrumChannel] = useState<SpectrogramChannelChoice>(
    channels > 1 ? (split ? "each" : "all") : "0",
  );
  /** Naming the view to keep it as a preset, and why it could not be. */
  const [naming, setNaming] = useState<string | null>(null);
  const [presetError, setPresetError] = useState<string | null>(null);
  const presets = preferences.viewPresets;
  const keepPreset = () => {
    const name = (naming ?? "").trim();
    if (!name) return setPresetError("A preset needs a name");
    const next = savePreset(presets, { name, view: playerView });
    if (next.length > VIEW_PRESETS_MAX)
      return setPresetError(`At most ${VIEW_PRESETS_MAX} presets; remove one in your account`);
    savePreferences.mutate({ viewPresets: next });
    setNaming(null);
    setPresetError(null);
  };
  const [settingsOpen, setSettingsOpen, settingsBox] = usePopover();
  /** The spectrogram's own settings, a level below the view menu. */
  const [tuning, setTuning] = useState(false);
  /** A loop can be kept but switched off, to hear on past it. */
  const [looping, setLooping] = useState(true);
  const [rolls, setRolls] = useRolls();
  const active = Boolean(loop) && looping;
  // Zoomed into the waveform and spectrogram (#34); the scrub bar keeps the whole file.
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const [surfaceWidth, setSurfaceWidth] = useState(0);
  const [chosenZoom, setZoom] = useState(1);
  const mostZoom = maxZoom(duration, info?.audio?.sampleRate ?? 0, surfaceWidth);
  const zoom = Math.min(chosenZoom, mostZoom);
  /** Where the view was when the zoom changed, to keep the same moment under the anchor. */
  const zooming = useRef<{ from: number; scroll: number; anchor: number } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each file opens whole.
  useEffect(() => setZoom(1), [fileId]);
  useEffect(() => {
    if (!surface) return;
    const observer = new ResizeObserver(([entry]) =>
      setSurfaceWidth(Math.round(entry?.contentRect.width ?? 0)),
    );
    observer.observe(surface);
    return () => observer.disconnect();
  }, [surface]);
  const zoomTo = (next: number) => {
    const element = surface;
    if (!element || next === zoom) return;
    const view = element.clientWidth;
    const playhead =
      duration > 0 ? (time / duration) * element.scrollWidth - element.scrollLeft : -1;
    zooming.current = {
      from: zoom,
      scroll: element.scrollLeft,
      anchor: playhead >= 0 && playhead <= view ? playhead : view / 2,
    };
    setZoom(next);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: only a new zoom moves the view.
  useLayoutEffect(() => {
    const element = surface;
    const from = zooming.current;
    zooming.current = null;
    if (element && from)
      element.scrollLeft = anchoredScroll(from.scroll, from.anchor, from.from, zoom);
  }, [zoom]);
  // The playhead stays in view as it plays or is moved, a page at a time.
  useEffect(() => {
    const element = surface;
    if (!element || zoom <= 1 || !(duration > 0)) return;
    const next = followScroll(
      element.scrollLeft,
      element.clientWidth,
      element.scrollWidth,
      (time / duration) * element.scrollWidth,
    );
    if (next !== null) element.scrollLeft = next;
  }, [surface, time, zoom, duration]);

  useEffect(() => {
    const element = media.current;
    if (!element) return;
    setElement(element);
    announce.current?.(element);
    let cancelled = false;
    setFailure(null);
    setChoices([]);
    setReady(false);
    native.current = false;
    // A video plays one of its two encodings (#148), chosen before the stream starts.
    const family =
      kind === "video" ? videoFamilyFor(playback.renditions, fps) : Promise.resolve(null);
    Promise.all([import("hls.js"), family])
      .then(([{ default: Hls }, chosen]) => {
        if (cancelled) return;
        setFamily(chosen);
        if (!Hls.isSupported()) {
          // Safari on iOS has no Media Source Extensions but plays AES-128 HLS natively.
          if (element.canPlayType("application/vnd.apple.mpegurl")) {
            native.current = true;
            const source = nativeSource(playback);
            element.src = source;
            // Where it is given one rendition (a wide layout's whole AAC), say which.
            const whole = wholeRendition(playback.renditions);
            if (whole && source !== playback.url) {
              setChoices([{ rendition: whole, level: 0 }]);
              setLevel(0);
            }
            setReady(true);
          } else setFailure("unsupported");
          return;
        }
        const instance = new Hls({
          enableWorker: true,
          startFragPrefetch: true,
          ...(kind === "audio" ? audioBuffer(playback.renditions) : {}),
        });
        hls.current = instance;
        instance.on(Hls.Events.MANIFEST_PARSED, () => {
          // The other encoding goes, so the picture never changes codec as it plays.
          if (chosen)
            for (let i = instance.levels.length - 1; i >= 0; i--) {
              const level = instance.levels[i];
              const codecs = level?.videoCodec ?? level?.codecSet ?? "";
              if (instance.levels.length > 1 && familyOf({ codecs }) !== chosen)
                instance.removeLevel(i);
            }
          // The browser drops renditions it cannot decode; offer what is left.
          const found: Choice[] = [];
          instance.levels.forEach((l, index) => {
            const rendition = playback.renditions.find((r) => l.uri.includes(`/r/${r.id}/`));
            if (rendition) found.push({ rendition, level: index });
          });
          setChoices(found);
          setReady(true);
          if (kind === "audio") {
            const preferred = preferredRendition(found.map((c) => c.rendition));
            const choice = found.find((c) => c.rendition === preferred);
            if (choice) {
              instance.currentLevel = choice.level;
              setLevel(choice.level);
            }
          }
        });
        instance.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          if (data.details === Hls.ErrorDetails.MANIFEST_INCOMPATIBLE_CODECS_ERROR)
            setFailure("codecs");
          else if (data.response?.code === 403) setFailure("expired");
          else setFailure("failed");
          instance.destroy();
        });
        instance.loadSource(playback.url);
        instance.attachMedia(element);
      })
      // The player's code could not be fetched (a dropped connection, or a new release).
      .catch(() => {
        if (!cancelled) setFailure("failed");
      });
    return () => {
      cancelled = true;
      announce.current?.(null);
      hls.current?.destroy();
      hls.current = null;
      element.removeAttribute("src");
      // Reset the element, so nothing of this source (its metadata, its position) outlives it.
      element.load();
    };
  }, [kind, playback, fps]);

  const choose = (index: number) => {
    if (!hls.current) return;
    // Keep the position: switch at the next segment rather than starting again.
    hls.current.nextLevel = index;
    setLevel(index);
  };

  // The speed holds through a new source (a rendition, a version), which resets the element's.
  useEffect(() => (element ? holdRate(element, rate) : undefined), [element, rate]);

  // Heard at the volume under the page's gain, unless something else sets it for now (#493).
  useEffect(() => {
    if (element && gain !== null) element.volume = gain * volumeGain(volume);
  }, [element, gain, volume]);
  /** A volume chosen above silence is meant to be heard: it unmutes. */
  const chooseVolume = (next: number) => {
    setVolume(next);
    if (next > 0 && media.current?.muted) media.current.muted = false;
  };
  /** The speaker: mute or unmute; from silence it comes back to the last volume heard. */
  const toggleMute = () => {
    const el = media.current;
    if (!el) return;
    if (volume === 0) {
      setVolume(lastLoud.current);
      el.muted = false;
      return;
    }
    el.muted = !el.muted;
  };

  const toggle = useCallback(() => {
    const element = media.current;
    if (!element) return;
    if (!element.paused) {
      element.pause();
      return;
    }
    element.play().catch((error: unknown) => {
      // A pause or a new source interrupting play is not a failure.
      if (error instanceof DOMException && error.name === "AbortError") return;
      setFailure("failed");
    });
  }, []);

  const seek = (seconds: number) => {
    const element = media.current;
    if (element) element.currentTime = Math.max(0, Math.min(duration, seconds));
  };

  /** A new loop starts playing from its entry, so it can be heard at once. */
  const setLoop = (next: Loop | null) => {
    onLoop(next);
    if (next) {
      setLooping(true);
      seek(loopEntry(next, rolls));
    }
  };

  // A loop set from outside (a comment's Loop, a new address) is switched on.
  // By value: the page makes a new loop object on every render.
  const loopStart = loop?.start;
  const loopEnd = loop?.end;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the cue is the trigger; asked again for the same passage, it comes back on.
  useEffect(() => {
    if (loopStart !== undefined && loopEnd !== undefined) setLooping(true);
  }, [loopStart, loopEnd, cue]);

  // A loop that does not fit this file (an address, or one carried from a longer version)
  // is cut to it, or dropped if nothing of it is left.
  useEffect(() => {
    if (!loop || !(duration > 0) || loop.end <= duration) return;
    onLoop(loopFrom(loop.start, Math.min(loop.end, duration), duration));
  }, [loop, duration, onLoop]);

  // A page opened with a loop (from its address, or a switch of version) starts at it.
  const placed = useRef(false);
  useEffect(() => {
    const element = media.current;
    if (!ready || !element || placed.current) return;
    placed.current = true;
    if (loop && looping) element.currentTime = loopEntry(loop, rolls);
  }, [ready, loop, looping, rolls]);

  // Go round the loop. Checked every frame while playing: the media's own time updates
  // come only a few times a second, too coarse for a tight passage.
  useEffect(() => {
    const element = media.current;
    if (!element || !playing || !loop || !looping) return;
    let frame = 0;
    const check = () => {
      const target = wrapTarget(element.currentTime, loop, rolls, duration);
      if (target !== null) element.currentTime = target;
      frame = requestAnimationFrame(check);
    };
    frame = requestAnimationFrame(check);
    return () => cancelAnimationFrame(frame);
  }, [playing, loop, looping, rolls, duration]);

  const seekBy = (seconds: number) => {
    const element = media.current;
    if (element)
      element.currentTime = Math.max(0, Math.min(duration, element.currentTime + seconds));
  };

  const say = useAnnounce();
  const goToFrame = (frame: number) => {
    const element = media.current;
    if (!element || !clock) return;
    const last = Math.max(0, Math.ceil((duration * clock.rate.num) / clock.rate.den) - 1);
    element.currentTime = frameTime(Math.max(0, Math.min(last, frame)), clock.rate);
  };
  /** One frame of video, or a hundredth of a second of audio. */
  const step = info?.video?.fps ? 1 / info.video.fps : 0.01;
  const stepBy = (direction: -1 | 1) => {
    const element = media.current;
    if (!element) return;
    element.pause();
    // A video lands on a frame's own time, so each step shows the next frame exactly.
    if (clock) goToFrame(frameShowing(element.currentTime, clock.rate) + direction);
    else seekBy(direction * step);
  };
  /** Loop in or out at the playhead; the other edge stays, or the loop runs to the end. */
  const edge = (which: "in" | "out") => {
    const element = media.current;
    if (!element || !(duration > 0)) return;
    const at = element.currentTime;
    const next =
      which === "in"
        ? loopFrom(at, loop && loop.end > at ? loop.end : duration, duration)
        : loopFrom(loop && loop.start < at ? loop.start : 0, at, duration);
    if (next) {
      onLoop(next);
      setLooping(true);
      say(`Loop ${which} point set`);
    }
  };
  /** Where the playhead jumps between: the comment markers and the checks' findings. */
  const marked = useMemo(
    () =>
      markerTimes(
        markers.map((m) => m.at),
        findings.map((f) => f.start),
      ),
    [markers, findings],
  );
  const toMarker = (direction: 1 | -1) => {
    const element = media.current;
    if (!element) return;
    const at = adjacentMarker(marked, element.currentTime, direction);
    if (at === null) {
      say(direction === 1 ? "No marker after the playhead" : "No marker before the playhead");
      return;
    }
    element.currentTime = Math.min(duration, at);
    say(`Marker at ${formatClock(at)}`);
  };
  // The player's keys work anywhere on the page it is on, as in Frame.io; never in a field.
  useShortcuts("player", "Player", [
    {
      keys: ["Space", "k"],
      label: "Play or pause",
      run: () => {
        const element = media.current;
        toggle();
        if (element) say(element.paused ? "Paused" : "Playing");
      },
    },
    {
      keys: ["j", "ArrowLeft"],
      label: `Back ${preferences.skipSeconds} seconds`,
      run: () => seekBy(-preferences.skipSeconds),
    },
    {
      keys: ["l", "ArrowRight"],
      label: `Forward ${preferences.skipSeconds} seconds`,
      run: () => seekBy(preferences.skipSeconds),
    },
    {
      keys: [","],
      label: info?.video?.fps ? "One frame back" : "A hundredth of a second back",
      run: () => stepBy(-1),
    },
    {
      keys: ["."],
      label: info?.video?.fps ? "One frame forward" : "A hundredth of a second forward",
      run: () => stepBy(1),
    },
    { keys: ["Home"], label: "Go to the start", run: () => seekBy(-duration) },
    { keys: ["End"], label: "Go to the end", run: () => seekBy(duration) },
    { keys: ["ArrowUp"], label: "Volume up", run: () => chooseVolume(stepVolume(volume, 1)) },
    {
      keys: ["ArrowDown"],
      label: "Volume down",
      run: () => chooseVolume(stepVolume(volume, -1)),
    },
    { keys: ["m"], label: "Mute or unmute", run: toggleMute },
    ...(marked.length > 0
      ? [
          { keys: ["Shift+ArrowUp"], label: "Previous marker", run: () => toMarker(-1) },
          { keys: ["Shift+ArrowDown"], label: "Next marker", run: () => toMarker(1) },
        ]
      : []),
    ...(kind === "audio" && mostZoom > 1
      ? [
          {
            keys: ["="],
            label: "Zoom into the waveform",
            run: () => zoomTo(zoomStep(zoom, 1, mostZoom)),
          },
          {
            keys: ["-"],
            label: "Zoom out of the waveform",
            run: () => zoomTo(zoomStep(zoom, -1, mostZoom)),
          },
          { keys: ["0"], label: "Fit the whole file", run: () => zoomTo(1) },
        ]
      : []),
    ...(canLoop
      ? [
          { keys: ["i"], label: "Loop from the playhead", run: () => edge("in") },
          { keys: ["o"], label: "Loop to the playhead", run: () => edge("out") },
          {
            keys: ["Shift+L"],
            label: "Loop on or off",
            run: () => {
              if (!loop) return;
              setLooping((on) => {
                say(on ? "Loop off" : "Loop on");
                return !on;
              });
            },
          },
        ]
      : []),
  ]);

  const events = {
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onEnded: () => {
      // A loop that runs to the very end goes round when the media stops.
      const element = media.current;
      // Only a loop that itself runs to the end; one earlier was left behind on purpose.
      if (element && loop && looping && loop.end + rolls.post >= duration - 0.05) {
        element.currentTime = loopEntry(loop, rolls);
        element.play().catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          setPlaying(false);
          setFailure("failed");
        });
        return;
      }
      setPlaying(false);
    },
    onTimeUpdate: () => setTime(media.current?.currentTime ?? 0),
    onDurationChange: () => {
      const d = media.current?.duration;
      if (d && Number.isFinite(d)) setDuration(d);
    },
    onProgress: () => {
      const element = media.current;
      if (element && element.buffered.length > 0)
        setBuffered(element.buffered.end(element.buffered.length - 1));
    },
    onVolumeChange: () => setMuted(media.current?.muted ?? false),
    onError: () => {
      // hls.js reports and recovers its own errors; only the native player needs this.
      if (native.current) setFailure("failed");
    },
  };

  const share = (value: number) => (duration > 0 ? Math.min(100, (value / duration) * 100) : 0);

  // The View menu: how the recording is drawn, and normalised playback (#240).
  const viewPanel = settingsOpen && (
    <StripPanel anchor={settingsBox} onClose={() => setSettingsOpen(false)}>
      <section id="player-view" aria-label="View" className="flex flex-col gap-3">
        <div className="flex flex-col gap-2.5">
          {/* No waveform drawn, nothing to choose about it. */}
          {kind === "audio" && display !== "spectrogram" && (
            <fieldset className="m-0 flex flex-col gap-2.5 border-0 p-0">
              <legend className="sr-only">Waveform</legend>
              <div className="flex items-center justify-between gap-4">
                <span aria-hidden="true" className="text-[14px] text-ink">
                  Waveform
                </span>
                <span className="flex gap-1.5">
                  {waveColours.map((colour) => (
                    <button
                      key={colour}
                      type="button"
                      aria-pressed={look.colour === colour}
                      aria-label={`${waveColourNames[colour]} waveform`}
                      title={waveColourNames[colour]}
                      onClick={() => setLook({ colour })}
                      className={cn(
                        "flex size-7 cursor-pointer items-center justify-center rounded-full border bg-transparent p-0",
                        look.colour === colour ? "border-ink" : "border-transparent",
                      )}
                    >
                      <span
                        className="size-4 rounded-full"
                        style={{ background: `var(${waveTokens[colour]})` }}
                      />
                    </button>
                  ))}
                </span>
              </div>
              <LookSlider
                label="Brightness"
                value={look.opacity}
                onChange={(opacity) => setLook({ opacity })}
              />
              <LookSlider
                label="Height"
                value={look.height}
                onChange={(height) => setLook({ height })}
              />
            </fieldset>
          )}
          {kind === "audio" && channels > 1 && (
            <Toggle
              label="Split channels"
              checked={split}
              onChange={(split) => {
                setSplit(split);
                // The spectrogram follows: a lane per channel, or all of them together.
                setSpectrumChannel(split ? "each" : "all");
              }}
            />
          )}
          {kind === "audio" && canSpectrogram && (
            <div className="flex items-center justify-between gap-4">
              <span aria-hidden="true" className="text-[14px] text-ink">
                Spectrogram
              </span>
              <Segmented
                label="Spectrogram"
                value={playerView.spectrogram}
                options={spectrogramPlaces.map((p) => ({ value: p, label: placeNames[p] }))}
                onChange={(spectrogram) => setPlayerView({ ...playerView, spectrogram })}
              />
            </div>
          )}
          {kind === "audio" && canSpectrogram && playerView.spectrogram !== "off" && (
            <SpectrogramLook view={spectrum} onView={setSpectrum} />
          )}
          {kind === "audio" && canSpectrogram && playerView.spectrogram !== "off" && (
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={tuning}
              onClick={() => setTuning((t) => !t)}
              className="self-start px-0 text-ink-3 hover:text-ink"
            >
              {tuning ? "Hide spectrogram settings" : "Channel, levels, range and analysis…"}
            </Button>
          )}
          {kind === "audio" && !canSpectrogram && tools && !tools.includes("spectrogram") && (
            <span className="text-[12px] text-ink-3">
              The spectrogram is not among your tools here.
            </span>
          )}
          {offersNormalise && (
            <Toggle
              label="Normalised playback"
              checked={normalised}
              onChange={(on) => onNormalised?.(on)}
            />
          )}
          {follow}
          {/* Presets go with an account; a guest has none to keep them in. */}
          {kind === "audio" && !guest && (
            <div className="flex items-center justify-between gap-4 border-t border-hairline pt-2.5">
              <span aria-hidden="true" className="text-[14px] text-ink">
                Presets
              </span>
              <span className="flex items-center gap-1.5">
                {presets.length > 0 && (
                  <Select
                    size="sm"
                    aria-label="Apply a preset"
                    className="w-36"
                    value=""
                    onChange={(e) => {
                      const preset = presets.find((p) => p.name === e.target.value);
                      if (preset) setPlayerView(preset.view);
                    }}
                  >
                    <option value="" disabled>
                      Apply…
                    </option>
                    {presets.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  aria-expanded={naming !== null}
                  onClick={() => {
                    setNaming(naming === null ? "" : null);
                    setPresetError(null);
                  }}
                >
                  Save as…
                </Button>
              </span>
            </div>
          )}
          {kind === "audio" && !guest && naming !== null && (
            <form
              className="flex flex-col gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                keepPreset();
              }}
            >
              <span className="flex items-center gap-1.5">
                <Input
                  size="sm"
                  aria-label="Preset name"
                  placeholder="Name this view"
                  maxLength={40}
                  value={naming}
                  autoFocus
                  onChange={(e) => setNaming(e.target.value)}
                  className="min-w-0 flex-1"
                />
                <Button size="sm" type="submit">
                  Save
                </Button>
              </span>
              {presetError && <span className="text-[12px] text-signal">{presetError}</span>}
            </form>
          )}
        </div>
        {kind === "audio" && display !== "waveform" && tuning && (
          <SpectrogramSettings
            view={spectrum}
            onView={setSpectrum}
            channel={spectrumChannel}
            onChannel={setSpectrumChannel}
            channels={channels}
            layout={info?.audio?.channelLayout}
            sampleRate={info?.audio?.sampleRate ?? 48_000}
          />
        )}
      </section>
    </StripPanel>
  );

  // The player's own menus, at the strip's end after the page's (#15): drawing, the frame's
  // guides and comparing cuts, captions, a timecode to go to, the channels and the view.
  const menus = !failure && (
    <>
      {kind === "video" && onDraft && (
        <Button
          variant="ghost"
          size="md"
          aria-pressed={drawingOn}
          onClick={() => {
            // The frame holds still while it is drawn on.
            media.current?.pause();
            setDrawingOn((on) => !on);
          }}
          className={cn(drawingOn && "bg-raised text-ink")}
        >
          <Icon name="edit" size={14} />
          Draw
        </Button>
      )}
      {kind === "video" && info?.video && (
        <Dropdown
          align="right"
          value={
            <>
              <Icon name="grid" size={14} />
              Frame
            </>
          }
          actions={[
            { label: "Safe areas", checked: safe, onSelect: () => setSafe((on) => !on) },
            ...(Object.keys(mattes) as Matte[]).map((m) => ({
              label: `Matte ${mattes[m].label}`,
              checked: matte === m,
              onSelect: () => setMatte((on) => (on === m ? null : m)),
            })),
            ...(canCompareCuts && cuts
              ? [
                  "divider" as const,
                  {
                    label: "Compare cuts: wipe",
                    hint: `With ${cuts.previous.label}`,
                    checked: comparing === "wipe",
                    onSelect: () => setCutView((on) => (on === "wipe" ? null : "wipe")),
                  },
                  {
                    label: "Compare cuts: side by side",
                    checked: comparing === "side",
                    onSelect: () => setCutView((on) => (on === "side" ? null : "side")),
                  },
                ]
              : []),
          ]}
        />
      )}
      {captions.length > 0 && (
        <CaptionsMenu tracks={captions} current={captionId} onChange={setCaptionId} />
      )}
      {kind === "audio" && heard >= 2 && (
        <div ref={channelsBox} className="relative">
          <ChannelsButton
            names={names}
            mix={heardMix}
            open={channelsOpen}
            onToggle={() => setChannelsOpen(!channelsOpen)}
          />
          {channelsOpen && (
            <StripPanel anchor={channelsBox} onClose={() => setChannelsOpen(false)}>
              <ChannelsPanel
                names={names}
                mix={heardMix}
                canDownmix={labels !== null}
                canBinaural={canBinaural(labels)}
                onMix={setMix}
                unavailable={channelsUnavailable}
                levelsOf={
                  !tools || tools.includes("meters") ? { fileId, media: element } : undefined
                }
              />
            </StripPanel>
          )}
        </div>
      )}
      {(kind === "audio" || offersNormalise || follow) && (
        <div ref={settingsBox} className="relative">
          <Button
            variant="ghost"
            size="md"
            aria-expanded={settingsOpen}
            aria-controls="player-view"
            onClick={() => setSettingsOpen(!settingsOpen)}
            className={cn(settingsOpen && "bg-raised text-ink")}
          >
            <Icon name="waveform" size={14} />
            View
          </Button>
          {viewPanel}
        </div>
      )}
    </>
  );

  const scrub = (
    <div className="relative h-4 shrink-0">
      <div className="absolute inset-x-0 top-1/2 h-0.5 -translate-y-1/2 rounded-full bg-hairline" />
      {loop && duration > 0 && (
        <div
          aria-hidden="true"
          className={cn(
            "absolute top-1/2 h-1.5 -translate-y-1/2 bg-signal/30",
            !active && "opacity-40",
          )}
          style={{
            left: `${share(loop.start)}%`,
            width: `${share(loop.end) - share(loop.start)}%`,
          }}
        />
      )}
      {findings.map((f) => (
        <div
          key={`${f.start}-${f.end}-${f.severity}`}
          aria-hidden="true"
          className={cn(
            "absolute bottom-0 h-1.5 min-w-[3px] rounded-[1px] border border-signal",
            f.severity === "fail" ? "bg-signal" : "bg-transparent",
          )}
          style={{
            left: `${share(f.start)}%`,
            width:
              f.end !== null && f.end - f.start > 0.2
                ? `${share(f.end) - share(f.start)}%`
                : undefined,
          }}
        />
      ))}
      {markers.map(({ at, state }) => (
        <div
          key={at}
          aria-hidden="true"
          className={cn("absolute top-0 h-1.5 w-px -translate-x-1/2", markerStyles[state])}
          style={{ left: `${share(at)}%` }}
        />
      ))}
      <div
        className="absolute top-1/2 left-0 h-0.5 -translate-y-1/2 rounded-full bg-edge"
        style={{ width: `${share(buffered)}%` }}
      />
      <div
        className="absolute top-1/2 left-0 h-0.5 -translate-y-1/2 rounded-full bg-signal"
        style={{ width: `${share(time)}%` }}
      />
      <div
        className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink"
        style={{ left: `${share(time)}%` }}
      />
      <Slider
        aria-label="Position"
        min={0}
        max={duration || 0}
        step={0.01}
        value={Math.min(time, duration || 0)}
        onChange={(event) => {
          const element = media.current;
          if (element) element.currentTime = Number(event.target.value);
        }}
        className="absolute inset-0 m-0 w-full cursor-pointer opacity-0"
      />
    </div>
  );

  // Video has no waveform to drag on: its filmstrip, or a plain loop lane, stands in.
  const videoLanes = kind === "video" && (
    <>
      {edits.length > 0 && duration > 0 && (
        <EditLane edits={edits} duration={duration} time={time} onSeek={seek} />
      )}
      {(canLoop || playback.filmstrip) && (
        <LoopSurface
          duration={duration}
          loop={loop}
          active={active}
          onSeek={seek}
          onLoop={canLoop ? setLoop : undefined}
          label={
            playback.filmstrip
              ? canLoop
                ? "Filmstrip: click to move the playhead, drag to loop a passage"
                : "Filmstrip: click to move the playhead"
              : "Loop lane: drag to loop a passage"
          }
          className={cn("shrink-0", playback.filmstrip ? "h-12" : "h-7")}
        >
          {playback.filmstrip ? (
            <Filmstrip
              url={playback.filmstrip.url}
              frames={playback.filmstrip.frames}
              at={duration > 0 ? time / duration : 0}
            />
          ) : (
            <div
              aria-hidden="true"
              className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-hairline/60"
            />
          )}
        </LoopSurface>
      )}
    </>
  );

  /** The picture, or two cuts side by side; mounted even when it fails, as the media is. */
  const picture = kind === "video" && (
    <div
      className={cn(
        comparing === "side" && "grid grid-cols-2 gap-px bg-hairline",
        failure && "hidden",
      )}
    >
      {comparing === "side" && cuts && element && (
        <div className="relative">
          <CutVideo
            fileId={cuts.previous.fileId}
            master={element}
            frameSeconds={frameSeconds}
            family={family}
            className="aspect-video w-full"
          />
          <CutLabel>{cuts.previous.label}</CutLabel>
          {mark && <VideoMark mark={mark} />}
        </div>
      )}
      <div className="relative">
        <video
          ref={media}
          playsInline
          onClick={toggle}
          className={cn(
            "aspect-video w-full cursor-pointer bg-ground",
            comparing !== "side" && "rounded-panel",
          )}
          {...events}
        />
        {info?.video && (
          <FrameGuides aspect={info.video.width / info.video.height} matte={matte} safe={safe} />
        )}
        {info?.video && caption && (
          <CaptionText
            aspect={info.video.width / info.video.height}
            cues={caption.cues}
            time={frameNow}
          />
        )}
        {info?.video && (
          <DrawingMarks
            aspect={info.video.width / info.video.height}
            drawings={drawings
              .filter((d) => regionShowsAt(d, frameNow, frameSeconds))
              .map((d) => d.drawing)}
            draft={draft?.drawing ?? null}
          />
        )}
        {drawingOn && onDraft && info?.video && (
          <>
            <DrawLayer
              tool={tool}
              colour={colour}
              aspect={info.video.width / info.video.height}
              onDrawn={(drawing) => {
                // Each drawing replaces the one before, which Undo brings back.
                undo.current.push(draft);
                onDraft({
                  drawing,
                  at: Math.round((media.current?.currentTime ?? time) * 1000) / 1000,
                });
              }}
            />
            <DrawToolbar
              tool={tool}
              onTool={setTool}
              colour={colour}
              onColour={setColour}
              onUndo={draft ? () => onDraft(undo.current.pop() ?? null) : undefined}
              onClose={() => setDrawingOn(false)}
            />
          </>
        )}
        {comparing === "wipe" && cuts && element && (
          <>
            <CutVideo
              fileId={cuts.previous.fileId}
              master={element}
              frameSeconds={frameSeconds}
              family={family}
              className="pointer-events-none absolute inset-0 aspect-video w-full"
              style={{ clipPath: `inset(0 0 0 ${wipe * 100}%)` }}
            />
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 w-px bg-signal"
              style={{ left: `${wipe * 100}%` }}
            />
            <CutLabel>{cuts.mine}</CutLabel>
            <CutLabel right>{cuts.previous.label}</CutLabel>
          </>
        )}
        {comparing === "side" && cuts && <CutLabel>{cuts.mine}</CutLabel>}
        {mark && <VideoMark mark={mark} />}
      </div>
    </div>
  );

  const failed = failure && (
    <div className="flex flex-wrap items-center justify-between gap-3 py-4">
      <p className="m-0 text-sm text-ink-2">{failureCopy[failure]}</p>
      {(failure === "expired" || failure === "failed") && (
        <Button size="sm" onClick={onExpired}>
          Load again
        </Button>
      )}
    </div>
  );
  /** How much the lanes under the picture take, for the picture to leave room for them. */
  const lanesHeight =
    (playback.filmstrip ? 48 : canLoop ? 28 : 0) +
    (edits.length > 0 ? 36 : 0) +
    (comparing ? 44 : 0) +
    16 +
    36;

  const cutBar = comparing && cuts && !failure && (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 text-[13px]">
      {/* Which cut is which, the labels on the frame say. */}
      {/* On a phone the bar's controls say it; the room goes to them. */}
      <span className="sr-only font-medium text-ink @md/app:not-sr-only">Compare cuts</span>
      {comparing === "wipe" && (
        <span className="w-32 shrink-0">
          <Slider
            aria-label="Wipe"
            min={0}
            max={1}
            step={0.005}
            value={wipe}
            onChange={(event) => setWipe(Number(event.target.value))}
            className="w-full"
          />
        </span>
      )}
      <Segmented
        label="Compare cuts"
        value={comparing}
        options={[
          { value: "wipe", label: "Wipe" },
          { value: "side", label: "Side by side" },
        ]}
        onChange={setCutView}
        className="ml-auto"
      />
      {cuts.compare && (
        <Button variant="ghost" size="sm" asChild>
          <Link
            to="/tracks/$trackId/compare"
            params={{ trackId: cuts.compare.trackId }}
            search={{ a: cuts.compare.a, b: cuts.compare.b }}
          >
            Comments and findings
          </Link>
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        aria-label="Stop comparing"
        title="Stop comparing"
        onClick={() => setCutView(null)}
      >
        <Icon name="close" size={14} />
      </Button>
    </div>
  );

  const audioSurface = kind === "audio" && element && (
    // Scrolls once zoomed in; everything on the surface widens with it. It fills the height
    // the frame gives it (#493): the waveform grows with a tall window.
    <div
      ref={setSurface}
      className={cn(
        "flex min-h-0 flex-1 flex-col",
        zoom > 1 && "overflow-x-auto overscroll-x-contain",
      )}
      // Zoomed in, it scrolls, so the keyboard can reach it and move along it.
      {...(zoom > 1 && {
        tabIndex: 0,
        role: "group",
        "aria-label": `Waveform, zoomed ${zoom} times: the arrow keys move along it`,
        onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
          const box = event.currentTarget;
          const next = panScroll(event.key, box.scrollLeft, box.clientWidth, box.scrollWidth);
          if (next === null || event.altKey || event.metaKey || event.ctrlKey) return;
          // Handled here, so the player's own arrows do not seek as well.
          event.preventDefault();
          box.scrollLeft = next;
        },
      })}
      data-zoom={zoom}
    >
      <div className="flex min-h-0 flex-1 flex-col" style={{ width: `${zoom * 100}%` }}>
        <LoopSurface
          duration={duration}
          loop={loop}
          active={active}
          onSeek={seek}
          onLoop={canLoop ? setLoop : undefined}
          label={
            canLoop
              ? "Waveform: click to move the playhead, drag to loop a passage"
              : "Waveform: click to move the playhead"
          }
          className="flex min-h-0 flex-1 flex-col gap-3"
        >
          {(display === "waveform" || display === "both") && (
            <Waveform
              fileId={fileId}
              media={element}
              duration={duration}
              layout={info?.audio?.channelLayout}
              view={view}
              look={look}
              fill
            />
          )}
          {(display === "spectrogram" || display === "both") && (
            <Spectrogram
              fileId={fileId}
              media={element}
              duration={duration}
              layout={info?.audio?.channelLayout}
              channel={spectrumChannel}
              view={spectrum}
              height={WAVEFORM_HEIGHT}
              fill
            />
          )}
          {display === "overlay" && (
            // The waveform, drawn see-through, sits on the spectrogram and keeps the playhead.
            <div className="relative flex min-h-0 flex-1 flex-col">
              <div className="absolute inset-0 flex flex-col">
                <Spectrogram
                  fileId={fileId}
                  media={element}
                  duration={duration}
                  layout={info?.audio?.channelLayout}
                  // Row for row under the waveform: each channel, or all of them combined.
                  channel={view === "combined" ? "all" : "each"}
                  view={spectrum}
                  height={WAVEFORM_HEIGHT}
                  playhead={false}
                  labels={false}
                  fill
                />
              </div>
              <Waveform
                fileId={fileId}
                media={element}
                duration={duration}
                layout={info?.audio?.channelLayout}
                view={view}
                look={look}
                overlay
                fill
              />
            </div>
          )}
        </LoopSurface>
        {edits.length > 0 && duration > 0 && (
          <div className="mt-1.5 shrink-0">
            <EditLane edits={edits} duration={duration} time={time} onSeek={seek} />
          </div>
        )}
      </div>
    </div>
  );

  const iconButton =
    "flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent p-0 text-ink-2 transition-colors hover:bg-raised hover:text-ink disabled:cursor-default disabled:opacity-40";

  // What is heard, as a quiet line in the strip (#493): the rendition, or where there are
  // several a quiet menu to choose one, and normalised playback; never a button.
  const heardChoice = choices.find((c) => c.level === level)?.rendition;
  const formatLine = !failure && (choices.length > 0 || (normalised && normalisation)) && (
    // On a wide screen it gives way (truncates) before the strip's menus wrap under the version
    // and variant. On a phone the words are hidden, as the details sheet says the same, but the
    // Quality menu stays: it is the only way to choose what is heard.
    <span
      className={cn(
        "min-w-0 items-center gap-1 text-[12px] text-ink-3 sm:flex",
        choices.length > 1 ? "flex" : "hidden",
      )}
      title={[
        heardChoice ? renditionLabel(heardChoice, info) : null,
        normalised && normalisation ? normalisationLabel(normalisation) : null,
      ]
        .filter(Boolean)
        .join(" · ")}
    >
      {choices.length > 1 ? (
        <Dropdown
          label="Quality"
          size="sm"
          value={
            <span className="tabular truncate">
              {heardChoice ? renditionLabel(heardChoice, info) : "Auto"}
            </span>
          }
          actions={[
            ...(kind === "video"
              ? [{ label: "Auto", checked: level === -1, onSelect: () => choose(-1) }]
              : []),
            ...choices.map((c) => ({
              label: renditionLabel(c.rendition, info),
              checked: level === c.level,
              onSelect: () => choose(c.level),
            })),
          ]}
          className="h-7 px-1.5 text-[12px] text-ink-3"
        />
      ) : (
        choices[0] && (
          <span className="tabular truncate px-1">
            {renditionLabel(choices[0].rendition, info)}
          </span>
        )
      )}
      {normalised && normalisation && (
        <span className="tabular hidden truncate sm:inline">
          {choices.length > 0 ? "· " : ""}
          {normalisationLabel(normalisation)}
        </span>
      )}
    </span>
  );

  // The view toolbar at the waveform's edge (#493): how the recording is looked at (the loop,
  // the spectrogram, the meters, the zoom). Playback stays in the transport beneath.
  const spectrogramOn = kind === "audio" && canSpectrogram && playerView.spectrogram !== "off";
  const showsMeters = kind === "audio" && (!tools || tools.includes("meters"));
  const toggleSpectrogram = () => {
    if (spectrogramOn) {
      lastPlace.current = playerView.spectrogram;
      setPlayerView({ ...playerView, spectrogram: "off" });
    } else setPlayerView({ ...playerView, spectrogram: lastPlace.current });
  };
  // The compact QA player (#42) keeps the loop toggle, the one view control a video has, so a
  // looped finding can be heard straight through without clearing the passage.
  const viewBar = !failure &&
    (canLoop ||
      (!compact && kind === "audio" && (canSpectrogram || showsMeters || mostZoom > 1))) && (
      <div
        role="toolbar"
        aria-label="View"
        className="flex h-8 shrink-0 items-center justify-end gap-0.5 px-2 lg:px-3"
      >
        {canLoop && (
          <button
            type="button"
            aria-pressed={active}
            disabled={!loop}
            title={
              loop
                ? "Loop on or off (Shift+L)"
                : "Drag on the waveform, or press I and O, to loop a passage"
            }
            onClick={() => setLooping(!looping)}
            className={cn(
              viewButton,
              active && "bg-signal/15 text-signal hover:bg-signal/20 hover:text-signal",
            )}
          >
            <Icon name="loop" size={14} />
            Loop
            {loop && active && (
              <span className="tabular hidden sm:inline">
                {formatDuration(loop.start)}–{formatDuration(loop.end)}
              </span>
            )}
          </button>
        )}
        {kind === "audio" && canSpectrogram && (
          <button
            type="button"
            aria-pressed={spectrogramOn}
            title="Spectrogram; its place and colours are in View"
            onClick={toggleSpectrogram}
            className={cn(viewButton, spectrogramOn && "bg-raised text-ink")}
          >
            <Icon name="chart" size={14} />
            Spectrogram
          </button>
        )}
        {showsMeters && (
          <button
            type="button"
            aria-pressed={playerView.loudness}
            title="Levels beside the waveform"
            onClick={() => setPlayerView({ ...playerView, loudness: !playerView.loudness })}
            className={cn(viewButton, playerView.loudness && "bg-raised text-ink")}
          >
            <Icon name="pulse" size={14} />
            Meters
          </button>
        )}
        {kind === "audio" && mostZoom > 1 && (
          <span className="ml-1.5 flex items-center border-l border-line pl-1.5">
            <button
              type="button"
              aria-label="Zoom out of the waveform"
              title="Zoom out (−)"
              disabled={zoom <= 1}
              onClick={() => zoomTo(zoomStep(zoom, -1, mostZoom))}
              className={cn(viewButton, "w-7 justify-center px-0")}
            >
              <Icon name="zoomOut" size={14} />
            </button>
            <button
              type="button"
              onClick={() => zoomTo(1)}
              title="Fit the whole file (0)"
              className={cn(viewButton, "tabular min-w-9 justify-center")}
            >
              {zoomLabel(zoom)}
            </button>
            <button
              type="button"
              aria-label="Zoom into the waveform"
              title="Zoom in (=)"
              disabled={zoom >= mostZoom}
              onClick={() => zoomTo(zoomStep(zoom, 1, mostZoom))}
              className={cn(viewButton, "w-7 justify-center px-0")}
            >
              <Icon name="zoomIn" size={14} />
            </button>
          </span>
        )}
      </div>
    );

  // The levels at the playhead beside the waveform, where Meters is on (#493).
  const meters = showsMeters && playerView.loudness && element && (
    <PlayheadMeters fileId={fileId} media={element} layout={info?.audio?.channelLayout} />
  );

  // The transport, directly under the waveform or the picture (#493): to the start, back ten
  // and five seconds, play, the time (a double-click types one), then the speed, the
  // comparison and the volume. The view's controls are in the toolbar at the waveform's edge.
  const transport = (
    <div className="flex min-h-14 flex-wrap items-center gap-x-0.5 gap-y-1 px-2 py-1.5 lg:px-3">
      <button
        type="button"
        aria-label="Go to the start"
        title="Go to the start (Home)"
        disabled={!ready}
        onClick={() => seek(0)}
        className={iconButton}
      >
        <Icon name="skipBack" size={16} />
      </button>
      <button
        type="button"
        aria-label="Back 10 seconds"
        title="Back 10 s"
        disabled={!ready}
        onClick={() => seekBy(-10)}
        className={iconButton}
      >
        <SkipIcon seconds={10} />
      </button>
      <button
        type="button"
        aria-label="Back 5 seconds"
        title="Back 5 s"
        disabled={!ready}
        onClick={() => seekBy(-5)}
        className={iconButton}
      >
        <SkipIcon seconds={5} />
      </button>
      <button
        type="button"
        aria-label={playing ? "Pause" : "Play"}
        title="Play or pause (Space)"
        disabled={!ready}
        onClick={toggle}
        className="mx-1 flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-ink p-0 text-ground shadow-2 transition-transform duration-150 hover:scale-105 active:scale-95 disabled:cursor-default disabled:opacity-40 disabled:hover:scale-100"
      >
        <Icon name={playing ? "pause" : "play"} size={16} />
      </button>
      <TimeReadout
        shown={kind === "video" && clock ? videoTimecode(time, clock) : formatDuration(time)}
        total={kind === "video" && clock ? timecodeFor(duration, clock) : formatDuration(duration)}
        duration={duration}
        clock={clock}
        disabled={!ready}
        onSeek={seek}
      />
      {kind === "video" && clock && (
        <span className="tabular ml-2 hidden text-[13px] text-ink-3 sm:inline">
          frame {frameShowing(time, clock.rate)}
        </span>
      )}
      <span className="ml-auto flex items-center gap-0.5">
        <Dropdown
          label="Speed"
          above="wide"
          align="right"
          value={<span className="tabular">{rateLabel(rate)}</span>}
          actions={playbackRates.map((r) => ({
            label: rateLabel(r),
            checked: rate === r,
            onSelect: () => setRate(r),
          }))}
        />
        {compare && (
          <Button
            variant="ghost"
            size="md"
            aria-pressed={compare.open}
            onClick={compare.onToggle}
            className={cn(compare.open && "bg-raised text-ink")}
          >
            <Icon name="compare" size={14} />
            Compare
          </Button>
        )}
        <VolumeControl
          volume={volume}
          muted={muted}
          onVolume={chooseVolume}
          onMute={toggleMute}
          className={iconButton}
        />
      </span>
    </div>
  );

  return (
    <section aria-label="Player" className="flex min-h-0 flex-1 flex-col outline-none">
      <PlayerStrip lead={strip?.lead} after={formatLine}>
        {strip?.end}
        {menus}
      </PlayerStrip>
      {kind === "audio" && (
        <>
          <audio ref={media} {...events} />
          {playsParts &&
            element &&
            partRenditions.map((rendition, i) => (
              <StreamPart
                key={rendition.id}
                playback={playback}
                rendition={rendition}
                master={element}
                onElement={(part) =>
                  setPartElements((all) => {
                    const next = [...all];
                    next[i] = part;
                    return next;
                  })
                }
              />
            ))}
        </>
      )}
      {viewBar}
      {/* The media fills the height the frame gives it (#493); the transport sits directly beneath. */}
      <div className="flex min-h-0 flex-1 flex-col px-3 pb-3 lg:px-4">
        {kind === "audio" ? (
          failure ? (
            failed
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              <div className="flex min-h-0 min-w-0 flex-1 gap-3">
                {audioSurface}
                {meters}
              </div>
              {caption && <CaptionLine cues={caption.cues} time={time} />}
              {scrub}
            </div>
          )
        ) : compact ? (
          // QA (#42): the picture small, its lanes beside it.
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:gap-4">
            <div className="md:w-[300px] md:shrink-0 md:self-start">{picture}</div>
            {failure ? (
              failed
            ) : (
              <div className="flex flex-col gap-3 md:min-w-0 md:flex-1">
                {videoLanes}
                {scrub}
              </div>
            )}
          </div>
        ) : (
          // The picture as wide as the column allows and, on a wide screen, no taller than the
          // frame leaves it once its lanes are under it (#15), so the transport stays in view.
          <div className="flex min-h-0 flex-col justify-center lg:min-h-[220px] lg:flex-1 lg:[container-type:size]">
            <div
              className="mx-auto flex w-full flex-col gap-3 lg:w-[min(100cqw,calc((100cqh-var(--lanes))*var(--picture)))]"
              style={{
                ["--picture" as string]: comparing === "side" ? 32 / 9 : 16 / 9,
                ["--lanes" as string]: `${lanesHeight}px`,
              }}
            >
              {picture}
              {failure ? (
                failed
              ) : (
                <>
                  {cutBar}
                  {videoLanes}
                  {scrub}
                </>
              )}
            </div>
          </div>
        )}
      </div>
      {!failure && (
        <div className="shrink-0 border-t border-line">
          {transport}
          {loop && (
            <LoopControls
              loop={loop}
              duration={duration}
              fps={info?.video?.fps}
              rolls={rolls}
              onLoop={(next) => onLoop(next)}
              onRolls={setRolls}
            />
          )}
        </div>
      )}
    </section>
  );
}

/** A view toolbar control: quiet, 28 px, pressed when its view is on. */
const viewButton =
  "flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-control border-0 bg-transparent px-2 text-[12px] text-ink-3 transition-colors hover:bg-raised hover:text-ink disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-3";

/** The circular arrow with the seconds it skips inside, as Music and YouTube draw theirs. */
function SkipIcon({ seconds }: { seconds: 5 | 10 }) {
  return (
    <span className="relative flex size-[18px] items-center justify-center">
      <Icon name="back5" size={18} />
      <span
        aria-hidden="true"
        className="absolute inset-0 flex items-center justify-center pt-px text-[7px] leading-none font-medium"
      >
        {seconds}
      </span>
    </span>
  );
}

/**
 * The time, elapsed over the whole (#493). A double-click (or Enter on it) turns it into a
 * field: a typed time (seconds, m:ss, a timecode on a video's clock, or a bar where bars map
 * to time) and Enter seeks there; Escape leaves it as it was.
 */
function TimeReadout({
  shown,
  total,
  duration,
  clock,
  barTime = null,
  disabled = false,
  onSeek,
}: {
  shown: string;
  total: string;
  duration: number;
  clock: VideoClock | null;
  /** Where the project maps bars to time; none does yet. */
  barTime?: TimeEntryContext["barTime"];
  disabled?: boolean;
  onSeek: (seconds: number) => void;
}) {
  const [typing, setTyping] = useState<string | null>(null);
  const [wrong, setWrong] = useState(false);
  const editing = typing !== null;
  const field = useRef<HTMLInputElement>(null);
  const hint = useId();
  // The field takes focus as it appears: the double-click asked for it.
  useEffect(() => {
    if (editing) field.current?.focus();
  }, [editing]);
  const context: TimeEntryContext = { duration, clock, barTime };
  if (typing !== null)
    return (
      <form
        className="ml-2 flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const at = parseTimeEntry(typing, context);
          if (at === null) {
            setWrong(true);
            return;
          }
          onSeek(at);
          setTyping(null);
        }}
      >
        <Input
          ref={field}
          size="sm"
          value={typing}
          aria-label="Go to time"
          aria-invalid={wrong}
          aria-describedby={hint}
          spellCheck={false}
          onFocus={(event) => event.target.select()}
          onChange={(event) => {
            setTyping(event.target.value);
            setWrong(false);
          }}
          onBlur={() => setTyping(null)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setTyping(null);
            }
          }}
          className={cn("tabular text-[14px]", clock ? "w-32" : "w-24")}
        />
        <span id={hint} className={cn("tabular text-[13px]", wrong ? "text-signal" : "text-ink-3")}>
          {wrong ? "Not a time in this file" : `/ ${total}`}
        </span>
        <span className="sr-only">{timeEntryHint(context)}</span>
      </form>
    );
  return (
    <button
      type="button"
      disabled={disabled}
      title="Double-click to type a time"
      onDoubleClick={() => setTyping(shown)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          setTyping(shown);
        }
      }}
      className="tabular ml-1 h-8 cursor-text rounded-control border-0 bg-transparent px-1.5 text-left text-[15px] text-ink hover:bg-raised disabled:cursor-default"
    >
      {shown} <span className="text-[13px] text-ink-3">/ {total}</span>
    </button>
  );
}

/**
 * The speaker (#493): a click mutes, as YouTube and Music have it; hovering or focusing it
 * opens a slider from 0 to 100 in steps of 5, remembered per browser. The arrows on the
 * speaker step the volume too.
 */
function VolumeControl({
  volume,
  muted,
  onVolume,
  onMute,
  className,
}: {
  volume: number;
  muted: boolean;
  onVolume: (volume: number) => void;
  onMute: () => void;
  className: string;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const closing = useRef<number | undefined>(undefined);
  const stay = () => {
    window.clearTimeout(closing.current);
    setOpen(true);
  };
  const leave = () => {
    window.clearTimeout(closing.current);
    closing.current = window.setTimeout(() => setOpen(false), 250);
  };
  useEffect(() => () => window.clearTimeout(closing.current), []);
  const silent = muted || volume === 0;
  const heard = silent ? 0 : volume;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hovering the speaker shows its slider; the button and the slider are the controls.
    <div
      ref={box}
      className="relative"
      onPointerEnter={stay}
      onPointerLeave={leave}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        aria-label={silent ? "Unmute" : "Mute"}
        title={`${silent ? "Unmute" : "Mute"} (M) · volume ${volume}%`}
        onClick={onMute}
        onFocus={stay}
        onBlur={leave}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowRight") {
            event.preventDefault();
            onVolume(stepVolume(volume, 1));
          } else if (event.key === "ArrowDown" || event.key === "ArrowLeft") {
            event.preventDefault();
            onVolume(stepVolume(volume, -1));
          }
        }}
        className={className}
      >
        <Icon name={silent ? "mute" : "volume"} size={16} />
      </button>
      {open && (
        <Floating
          anchor={box}
          side="top"
          align="end"
          onClose={() => setOpen(false)}
          onPointerEnter={stay}
          onPointerLeave={leave}
          data-e2e-overlap
          className="rise-in flex items-center gap-2.5 rounded-panel bg-overlay px-3 py-2 shadow-3"
        >
          <Slider
            aria-label="Volume"
            min={0}
            max={VOLUME_MAX}
            step={VOLUME_STEP}
            value={heard}
            aria-valuetext={`${heard}%`}
            onChange={(event) => onVolume(Number(event.target.value))}
            onFocus={stay}
            onBlur={leave}
            className="w-28"
          />
          <span className="tabular w-9 text-right text-[12px] text-ink-2">{heard}%</span>
        </Floating>
      )}
    </div>
  );
}

/**
 * The strip above the player (#15), as the prototype draws it: what leads (the version and
 * variant) at the left, then a quiet line that gives way before the menus do (the format,
 * #493), the menus at the right, wrapping under them on a phone.
 */
export function PlayerStrip({
  lead,
  after,
  children,
}: {
  lead?: ReactNode;
  /** A quiet line after the lead, truncated on a wide screen rather than wrapping the menus. */
  after?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 py-2 lg:px-4">
      {/* On a phone the lead keeps its width and the menus wrap under it; on a wide screen it grows, and the line after it gives way. */}
      <div className="flex flex-wrap items-center gap-2 lg:min-w-0 lg:flex-1 lg:flex-nowrap">
        <div className="flex shrink-0 flex-wrap items-center gap-2">{lead}</div>
        {after}
      </div>
      <div className="ml-auto flex flex-wrap items-center justify-end gap-1">{children}</div>
    </div>
  );
}

/** A menu's panel, opened from the strip: floating from its control, at the right, within the window. */
function StripPanel({
  anchor,
  onClose,
  children,
}: {
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Floating
      anchor={anchor}
      align="end"
      onClose={onClose}
      data-e2e-layer
      className="rise-in scroll-quiet max-h-[min(70vh,560px)] w-[min(22rem,calc(100vw-2rem))] rounded-panel bg-overlay p-4 text-left shadow-3"
    >
      {children}
    </Floating>
  );
}

/** A share of the waveform's look, from 15% to 100%. */
function LookSlider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const percent = Math.round(value * 100);
  return (
    <label className="flex items-center gap-3 text-[12px] text-ink-3">
      <span className="w-16 shrink-0">{label}</span>
      <Slider
        min={Math.round(WAVE_LOOK_MIN * 100)}
        max={100}
        value={percent}
        aria-valuetext={`${percent}%`}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        className="min-w-0 flex-1"
      />
      <span className="tabular w-9 text-right">{percent}%</span>
    </label>
  );
}

/** A video's mark, as the server words and places it (#31). */
export interface VisibleMark {
  text: string;
  position: WatermarkPosition;
  opacity: number;
}

/** Where the mark sits over the picture, in shares of it: staggered rows, a corner or the middle. */
const markPlaces: Record<WatermarkPosition, { left: string; top: string }[]> = {
  tiled: [0.06, 0.22, 0.38, 0.54, 0.7, 0.86].map((y, i) => ({
    left: `${i % 2 === 0 ? 4 : 30}%`,
    top: `${y * 100}%`,
  })),
  corner: [{ left: "auto", top: "auto" }],
  centre: [{ left: "50%", top: "50%" }],
};

/**
 * Who is watching, laid over the video so a screen capture says whose it was (#31,
 * docs/security.md). It never takes a click: the picture beneath still plays and pauses.
 */
export function VideoMark({ mark }: { mark: VisibleMark }) {
  return (
    <div
      aria-hidden="true"
      data-e2e-overlap
      className="pointer-events-none absolute inset-0 overflow-hidden select-none"
      style={{ opacity: mark.opacity / 100 }}
    >
      {markPlaces[mark.position].map((place) => (
        <span
          key={`${place.left}-${place.top}`}
          className={cn(
            "absolute text-[11px] leading-snug whitespace-pre-line text-paper sm:text-[13px]",
            mark.position === "corner" && "right-[3%] bottom-[3%] text-right",
            mark.position === "centre" && "-translate-x-1/2 -translate-y-1/2 text-center",
          )}
          style={mark.position === "corner" ? undefined : place}
        >
          {mark.text}
        </span>
      ))}
    </div>
  );
}

/** Which cut a frame shows, in its top corner (#147). */
function CutLabel({ children, right = false }: { children: string; right?: boolean }) {
  return (
    <span
      className={cn(
        "pointer-events-none absolute top-2 rounded-[4px] bg-ground/80 px-1.5 py-0.5 text-[12px] text-ink",
        right ? "right-2" : "left-2",
      )}
    >
      {children}
    </span>
  );
}
