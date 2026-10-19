import { isFollowingPart } from "@hekate/shared";
import type Hls from "hls.js";
import { useEffect, useRef } from "react";
import type { Playback, Rendition } from "~/lib/queries";
import { followRate } from "~/lib/speed";
import { audioBuffer, preferredRendition } from "./player";

/**
 * How far a part may drift from the stream it plays beside before it is put back. Its channels
 * are heard with the others', so it is kept far closer than a source being compared.
 */
export const PART_DRIFT = 0.02;

/** A rendition's own playlist: a part's, beside the master it is left out of (decision 139). */
export const renditionPlaylist = (playback: Playback, rendition: Rendition) =>
  playback.url.replace(/master\.m3u8$/, `r/${rendition.id}/index.m3u8`);

/**
 * The rendition a player with one element plays: the one the main player prefers, unless that
 * is the lossless stream of a layout wider than eight channels, which carries only its first
 * eight. Then the AAC, a stereo fold of every channel (#74). For a comparison source and for
 * Safari's own HLS, neither of which plays the parts.
 */
export function wholeRendition(renditions: Rendition[]): Rendition | undefined {
  const preferred = preferredRendition(renditions);
  if (preferred?.name !== "flac" || !renditions.some((r) => isFollowingPart(r.name)))
    return preferred;
  return renditions.find((r) => r.name === "aac-256") ?? preferred;
}

/**
 * What Safari's own HLS is given, as it chooses among the master's renditions itself: the
 * master, unless a wide layout's choice would be its first eight channels; then the whole
 * rendition's own playlist.
 */
export function nativeSource(playback: Playback): string {
  const whole = wholeRendition(playback.renditions);
  return whole && whole !== preferredRendition(playback.renditions)
    ? renditionPlaylist(playback, whole)
    : playback.url;
}

/**
 * One part of a layout wider than eight channels (#74): its later channels, played in step
 * with the main player on an element of its own, heard only through the main player's mix.
 * It follows play, pause, seeks, speed and volume, and is put back whenever it drifts.
 */
export function StreamPart({
  playback,
  rendition,
  master,
  onElement,
}: {
  playback: Playback;
  rendition: Rendition;
  master: HTMLMediaElement;
  /** Its element, for the mix to take its channels from; null once it is gone. */
  onElement: (element: HTMLAudioElement | null) => void;
}) {
  const element = useRef<HTMLAudioElement>(null);
  const report = useRef(onElement);
  report.current = onElement;

  useEffect(() => {
    const audio = element.current;
    if (!audio) return;
    let hls: Hls | null = null;
    let cancelled = false;
    const url = renditionPlaylist(playback, rendition);
    import("hls.js").then(({ default: Hls }) => {
      if (cancelled) return;
      if (!Hls.isSupported()) {
        audio.src = url;
        return;
      }
      hls = new Hls({ enableWorker: true, ...audioBuffer([rendition]) });
      hls.loadSource(url);
      hls.attachMedia(audio);
    });
    report.current(audio);
    return () => {
      cancelled = true;
      hls?.destroy();
      audio.removeAttribute("src");
      report.current(null);
    };
  }, [playback, rendition]);

  useEffect(() => {
    const audio = element.current;
    if (!audio) return;
    const sync = () => {
      if (Math.abs(audio.currentTime - master.currentTime) > PART_DRIFT)
        audio.currentTime = master.currentTime;
    };
    const play = () => {
      sync();
      // A rejection before the stream is attached is retried once it can play.
      void audio.play().catch(() => undefined);
    };
    const pause = () => {
      audio.pause();
      sync();
    };
    const ready = () => {
      if (!master.paused && audio.paused) play();
    };
    // The page's volume (normalised playback) and the mute button act on every part alike.
    const volume = () => {
      audio.volume = master.volume;
      audio.muted = master.muted;
    };
    master.addEventListener("play", play);
    master.addEventListener("pause", pause);
    master.addEventListener("seeked", sync);
    master.addEventListener("volumechange", volume);
    audio.addEventListener("canplay", ready);
    volume();
    const unfollow = followRate(master, audio);
    const timer = window.setInterval(() => {
      if (master.paused) return;
      sync();
      if (audio.paused) play();
    }, 250);
    sync();
    if (!master.paused) play();
    return () => {
      master.removeEventListener("play", play);
      master.removeEventListener("pause", pause);
      master.removeEventListener("seeked", sync);
      master.removeEventListener("volumechange", volume);
      audio.removeEventListener("canplay", ready);
      unfollow();
      window.clearInterval(timer);
      audio.pause();
    };
  }, [master]);

  // biome-ignore lint/a11y/useMediaCaption: a part of the recording playing, never shown.
  return <audio ref={element} preload="auto" />;
}
