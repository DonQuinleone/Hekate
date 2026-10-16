import { useMemo } from "react";
import type { File } from "~/data";
import { cn } from "~/lib/cn";
import { kindIcon } from "~/lib/files";
import { peaksFor } from "~/lib/seeded";
import { Icon } from "./icons";

/** A small picture of a file: its waveform, a frame, a page. */
export function Thumb({
  file,
  width = 56,
  height = 36,
  className,
}: {
  file: File;
  width?: number;
  height?: number;
  className?: string;
}) {
  const peaks = useMemo(
    () => (file.kind === "audio" ? (peaksFor(file.seed, Math.floor(width / 2), 1)[0] ?? []) : []),
    [file.kind, file.seed, width],
  );
  const box = cn(
    "flex shrink-0 items-center justify-center overflow-hidden rounded-[5px] bg-sunken shadow-1",
    className,
  );
  if (file.kind === "audio" && file.state === "ready") {
    const mid = height / 2;
    const amp = mid - 4;
    const top = peaks.map((v, i) => `${i * 2},${(mid - v * amp).toFixed(1)}`).join(" ");
    const bottom = [...peaks]
      .reverse()
      .map((v, i) => `${(peaks.length - 1 - i) * 2},${(mid + v * amp).toFixed(1)}`)
      .join(" ");
    return (
      <span className={box} style={{ width, height }}>
        <svg width={width} height={height} aria-hidden="true">
          <polygon points={`${top} ${bottom}`} fill="var(--hk-ink-3)" opacity={0.85} />
        </svg>
      </span>
    );
  }
  if (file.kind === "video" && file.state === "ready") {
    return (
      <span
        className={box}
        style={{
          width,
          height,
          background: `linear-gradient(135deg, oklch(0.35 0.06 ${(file.seed * 40) % 360}), oklch(0.16 0.03 ${(file.seed * 40 + 60) % 360}))`,
        }}
      >
        <Icon name="play" size={12} fill="currentColor" strokeWidth={0} className="text-ink/70" />
      </span>
    );
  }
  if (file.kind === "document" || file.kind === "image") {
    return (
      <span className={cn(box, "bg-paper/90 text-ground/60")} style={{ width, height }}>
        <Icon name={kindIcon[file.kind]} size={14} />
      </span>
    );
  }
  return (
    <span className={cn(box, "text-ink-3")} style={{ width, height }}>
      <Icon name={file.state === "failed" ? "warning" : kindIcon[file.kind]} size={14} />
    </span>
  );
}
