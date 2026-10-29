import { useEffect, useRef } from "react";
import { interpolatePosition } from "~/lib/playhead";

/**
 * One frame clock for everything that shows the playhead (#492): each animation frame it
 * reads the media's time, carries it on at the playback rate between the media's own
 * updates, and hands the position to `onFrame` as a share of the duration and in seconds.
 * `onFrame` writes styles straight to the elements it drives, so nothing re-renders at
 * sixty frames a second; it may change on every render without restarting the clock.
 */
export function usePlayheadFrames(
  media: HTMLMediaElement | null,
  playing: boolean,
  rate: number,
  duration: number,
  onFrame: (share: number, seconds: number) => void,
) {
  const frame = useRef(onFrame);
  frame.current = onFrame;
  useEffect(() => {
    if (!media) return;
    let handle = 0;
    let sample = { time: media.currentTime, at: performance.now() };
    const tick = (now: number) => {
      const current = media.currentTime;
      if (current !== sample.time) sample = { time: current, at: now };
      // Carried on only while the media really advances: not paused, ended, seeking or
      // waiting for the next segment (readyState below HAVE_FUTURE_DATA), so a stall holds
      // the playhead where the media holds it, and nothing jumps back when it resumes.
      const moving =
        playing &&
        !media.paused &&
        !media.ended &&
        !media.seeking &&
        media.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA;
      let seconds = interpolatePosition(sample.time, sample.at, now, rate, moving);
      if (duration > 0) seconds = Math.min(duration, seconds);
      frame.current(duration > 0 ? seconds / duration : 0, seconds);
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [media, playing, rate, duration]);
}
