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

/** A filmstrip's picture as a local address, or null where it could not be had. */
type Picture = Promise<string | null>;

/**
 * Pictures fetched, by link, with how many are showing each: the player's lane and the QA
 * view's frames share one fetch (each is a protected read, and a watermark drawn), and the
 * picture is let go once the last of them is gone.
 */
const pictures = new Map<string, { picture: Picture; users: number }>();

function borrow(url: string): Picture {
  const held = pictures.get(url);
  if (held) {
    held.users += 1;
    return held.picture;
  }
  const picture = fetch(url, { credentials: "same-origin" })
    .then((res) => (res.ok ? res.blob() : null))
    .then((blob) => (blob ? URL.createObjectURL(blob) : null))
    .catch(() => null);
  pictures.set(url, { picture, users: 1 });
  return picture;
}

function giveBack(url: string) {
  const held = pictures.get(url);
  if (!held) return;
  held.users -= 1;
  if (held.users > 0) return;
  pictures.delete(url);
  void held.picture.then((src) => {
    if (src) URL.revokeObjectURL(src);
  });
}

/**
 * A filmstrip's picture, fetched through the playback link and kept as a local address while
 * anything shows it: the address, null until it arrives, and whether it could not be had (the
 * video plays all the same).
 */
export function useFilmstripPicture(url: string | null): { src: string | null; failed: boolean } {
  const [state, setState] = useState<{ src: string | null; failed: boolean }>({
    src: null,
    failed: false,
  });
  useEffect(() => {
    if (!url) return;
    let current = true;
    borrow(url).then((src) => {
      if (current) setState({ src, failed: src === null });
    });
    return () => {
      current = false;
      giveBack(url);
      setState({ src: null, failed: false });
    };
  }, [url]);
  return state;
}

/** The filmstrip frame nearest a time: frame i spans the i-th equal part of the video. */
export const filmstripFrame = (time: number, duration: number, frames: number) =>
  duration > 0 ? Math.min(frames - 1, Math.max(0, Math.floor((time / duration) * frames))) : 0;

/**
 * One frame of a filmstrip, in a box shaped like the frame: the picture laid as a background
 * as wide as all its frames, moved so the one asked for shows.
 */
export function FilmstripFrame({
  src,
  frames,
  index,
  aspect,
  className,
}: {
  src: string | null;
  frames: number;
  index: number;
  /** The video's width over its height. */
  aspect: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn("block bg-ground bg-no-repeat", className)}
      style={{
        aspectRatio: aspect,
        ...(src
          ? {
              backgroundImage: `url("${src}")`,
              backgroundSize: `${frames * 100}% 100%`,
              backgroundPosition: `${frames > 1 ? (index / (frames - 1)) * 100 : 0}% 0`,
            }
          : {}),
      }}
    />
  );
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
  const { src } = useFilmstripPicture(url);
  const [picture, setPicture] = useState<{ width: number; height: number } | null>(null);
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);
  // A new picture is measured afresh when it loads.
  useEffect(() => {
    if (!src) setPicture(null);
  }, [src]);
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
