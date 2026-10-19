import { useEffect, useRef, useState } from "react";
import { cn } from "~/lib/cn";

/** The gap between cells, in pixels (Tailwind's gap-px). */
const GAP = 1;

/**
 * How one frame of a filmstrip fills a cell, as `object-fit: cover` would: the whole picture
 * scaled so its frame covers the cell, then moved so that frame sits in the middle of it.
 */
export function coverFrame(
  picture: { width: number; height: number },
  frames: number,
  cell: { width: number; height: number },
  index: number,
): { width: number; height: number; left: number; top: number } {
  const frameWidth = picture.width / frames;
  const scale = Math.max(cell.width / frameWidth, cell.height / picture.height);
  return {
    width: picture.width * scale,
    height: picture.height * scale,
    left: cell.width / 2 - (index + 0.5) * frameWidth * scale,
    top: (cell.height - picture.height * scale) / 2,
  };
}

/**
 * A video's frames along it (#16), under the picture: one picture of every frame side by side,
 * fetched once through the playback link and shown a frame to a cell, cropped to fill it. It
 * only shows; the lane it sits in seeks and loops.
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
  const strip = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [picture, setPicture] = useState<{ width: number; height: number } | null>(null);
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
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
      setPicture(null);
    };
  }, [url]);
  useEffect(() => {
    const element = strip.current;
    if (!element) return;
    const measure = () => setBox({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const cell = box && { width: (box.width - GAP * (frames - 1)) / frames, height: box.height };
  return (
    <div
      ref={strip}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 flex gap-px overflow-hidden rounded-control bg-hairline"
    >
      {Array.from({ length: frames }, (_, i) => {
        const fit = picture && cell && cell.width > 0 ? coverFrame(picture, frames, cell, i) : null;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: the frames are fixed, in order.
          <div key={i} className="relative h-full min-w-0 flex-1 overflow-hidden bg-ground">
            {src && (
              <img
                src={src}
                alt=""
                draggable={false}
                onLoad={(event) =>
                  setPicture({
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight,
                  })
                }
                className={cn("absolute max-w-none select-none", !fit && "invisible")}
                style={
                  fit
                    ? { width: fit.width, height: fit.height, left: fit.left, top: fit.top }
                    : undefined
                }
              />
            )}
          </div>
        );
      })}
      <div
        className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-signal"
        style={{ left: `${Math.min(1, Math.max(0, at)) * 100}%` }}
      />
    </div>
  );
}
