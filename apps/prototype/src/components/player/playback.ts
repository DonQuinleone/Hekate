import { useCallback, useEffect, useRef, useState } from "react";

export interface Loop {
  start: number;
  end: number;
}

/**
 * A simulated transport: the prototype plays no sound, but the playhead moves, loops,
 * seeks and keeps time the way the real player will.
 */
export function usePlayback(duration: number, initial = 0) {
  const [time, setTimeState] = useState(initial);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [loop, setLoop] = useState<Loop | null>(null);
  const [looping, setLooping] = useState(false);
  const frame = useRef<number | null>(null);
  const last = useRef<number>(0);
  const timeRef = useRef(initial);
  timeRef.current = time;

  useEffect(() => {
    if (!playing) {
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = null;
      return;
    }
    last.current = performance.now();
    const tick = (now: number) => {
      const dt = ((now - last.current) / 1000) * rate;
      last.current = now;
      let next = timeRef.current + dt;
      if (looping && loop && next >= loop.end) next = loop.start + (next - loop.end);
      if (next >= duration) {
        next = duration;
        setPlaying(false);
      }
      setTimeState(next);
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, [playing, rate, duration, loop, looping]);

  const seek = useCallback(
    (t: number) => setTimeState(Math.min(duration, Math.max(0, t))),
    [duration],
  );
  const toggle = useCallback(() => {
    setPlaying((p) => {
      if (!p && timeRef.current >= duration) setTimeState(0);
      return !p;
    });
  }, [duration]);

  return {
    time,
    playing,
    rate,
    loop,
    looping,
    seek,
    toggle,
    play: () => setPlaying(true),
    pause: () => setPlaying(false),
    setRate,
    setLoop,
    setLooping,
  };
}

export type Playback = ReturnType<typeof usePlayback>;
