import type { Comment, File } from "~/data";
import { cn } from "~/lib/cn";
import type { Playback } from "./player/playback.ts";

/** A frame of the cut, drawn: the street at night, the lamp, the title. */
export function Frame({
  file,
  time,
  className,
  watermark,
  portrait = false,
  thumb = false,
}: {
  file: File;
  time: number;
  className?: string;
  watermark?: string;
  portrait?: boolean;
  thumb?: boolean;
}) {
  const t = time / Math.max(1, file.media.duration);
  const lamp = t > 0.28 && t < 0.34;
  const cool = t > 0.85;
  return (
    <div
      className={cn(
        "relative overflow-hidden bg-[#0b0b0d]",
        portrait ? "aspect-[9/16]" : "aspect-video",
        className,
      )}
    >
      <div
        className="absolute inset-0"
        style={{
          background: `radial-gradient(ellipse at ${30 + t * 40}% 30%, ${cool ? "#1c2a38" : "#3a2a24"} 0%, #0b0b0d 70%)`,
        }}
      />
      <div
        className="absolute inset-x-0 bottom-0 h-[38%]"
        style={{ background: "linear-gradient(to top, #141416, transparent)" }}
      />
      {lamp && (
        <div className="absolute top-[18%] left-[62%] size-[14%] rounded-full bg-signal/80 blur-xl" />
      )}
      <div className="absolute bottom-[32%] left-[34%] h-[46%] w-[12%] rounded-t-full bg-[#1a1a1c]" />
      {!thumb && t > 0.05 && t < 0.2 && (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="font-sans text-[clamp(16px,4cqw,40px)] font-medium tracking-[-0.02em] text-paper opacity-90">
            Opening titles
          </span>
        </div>
      )}
      {t < 0.012 && <div className="absolute inset-0 bg-black" />}
      {watermark && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 flex items-end justify-end p-3"
        >
          <span className="font-sans text-[11px] tracking-[0.2em] text-paper/40">{watermark}</span>
        </div>
      )}
    </div>
  );
}

/** Thumbnails along the cut, with comment ticks; click seeks. */
export function Filmstrip({
  file,
  playback,
  markers,
}: {
  file: File;
  playback: Playback;
  markers: Comment[];
}) {
  const frames = 12;
  return (
    <div className="relative mt-2">
      <div
        className="flex h-12 cursor-crosshair overflow-hidden rounded-control border border-line"
        onPointerDown={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          playback.seek(((e.clientX - r.left) / r.width) * file.media.duration);
        }}
      >
        {Array.from({ length: frames }, (_, i) => (
          <Frame
            key={i}
            file={file}
            time={((i + 0.5) / frames) * file.media.duration}
            className="h-12 flex-1 aspect-auto"
            thumb
          />
        ))}
      </div>
      <div
        className="pointer-events-none absolute top-0 bottom-0 w-[2px] bg-signal"
        style={{ left: `${(playback.time / file.media.duration) * 100}%` }}
      />
      {markers.map((c, i) => {
        const at =
          c.anchor.kind === "time"
            ? c.anchor.start
            : c.anchor.kind === "region"
              ? (c.anchor.at ?? 0)
              : null;
        if (at === null) return null;
        return (
          <span
            key={c.id}
            className="tabular pointer-events-none absolute -top-2 flex size-[16px] -translate-x-1/2 items-center justify-center rounded-full bg-signal text-[9px] font-medium text-ground"
            style={{ left: `${(at / file.media.duration) * 100}%` }}
          >
            {i + 1}
          </span>
        );
      })}
    </div>
  );
}
