import { useEffect, useState } from "react";

/**
 * A video's frames along it (#16), under the picture: one picture of every frame side by side,
 * fetched once through the playback link and shown a frame to a cell, each from the middle of
 * its part of the video. It only shows; the lane it sits in seeks and loops.
 */
export function Filmstrip({
  url,
  frames,
  at,
}: {
  url: string;
  frames: number;
  /** Where the playhead is, from 0 to 1. */
  at: number;
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let made: string | null = null;
    let cancelled = false;
    fetch(url, { credentials: "same-origin" })
      .then((res) => (res.ok ? res.blob() : null))
      .then((blob) => {
        if (!blob || cancelled) return;
        made = URL.createObjectURL(blob);
        setSrc(made);
      })
      // Without it the lane is plain, and the video plays all the same.
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
      setSrc(null);
    };
  }, [url]);
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 flex gap-px overflow-hidden rounded-control bg-hairline"
    >
      {Array.from({ length: frames }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the frames are fixed, in order.
        <div key={i} className="relative h-full min-w-0 flex-1 overflow-hidden bg-ground">
          {src && (
            <img
              src={src}
              alt=""
              draggable={false}
              className="absolute top-0 left-1/2 h-full w-auto max-w-none select-none"
              style={{ transform: `translateX(-${((i + 0.5) / frames) * 100}%)` }}
            />
          )}
        </div>
      ))}
      <div
        className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-signal"
        style={{ left: `${Math.min(1, Math.max(0, at)) * 100}%` }}
      />
    </div>
  );
}
