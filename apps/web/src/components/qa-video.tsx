import {
  containerName,
  formatBytes,
  formatClock,
  formatDuration,
  frameRateName,
  isDeliveryCheck,
  type MediaInfo,
  type QaFinding,
  type QaSeverity,
  qaCheckNames,
  soundLine,
  type VideoCodec,
  type VideoPrimaries,
  videoClock,
  videoCodecs,
  videoPrimaries,
  videoTimecode,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { cn } from "~/lib/cn";
import type { Loop } from "~/lib/loop";
import { playbackQuery, qaQuery } from "~/lib/queries";
import { FilmstripFrame, filmstripFrame, useFilmstripPicture } from "./filmstrip";
import { QaLayout, QualityChecks, SeverityDot, soundStats } from "./qa";

const severityOrder: Record<QaSeverity, number> = { fail: 0, warn: 1, info: 2, pass: 3 };

/** The worst finding of each delivery check, in the order the checks are listed. */
export function deliveryChecklist(findings: readonly QaFinding[]): QaFinding[] {
  const worst = new Map<QaFinding["check"], QaFinding>();
  for (const f of findings) {
    if (!isDeliveryCheck(f.check)) continue;
    const kept = worst.get(f.check);
    if (!kept || severityOrder[f.severity] < severityOrder[kept.severity]) worst.set(f.check, f);
  }
  return [...worst.values()];
}

/**
 * The problems worth seeing in the picture, in the order they come: one per moment, at most
 * eight, so a broken file does not fill the column.
 */
export function framesToLookAt(findings: readonly QaFinding[], max = 8): QaFinding[] {
  const seen = new Set<number>();
  return findings
    .filter((f) => f.severity !== "pass" && f.start !== null)
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0))
    .filter((f) => {
      const at = Math.round((f.start ?? 0) * 10);
      if (seen.has(at)) return false;
      seen.add(at);
      return true;
    })
    .slice(0, max);
}

/** A container's name (#635): by the file's type, else ffprobe's first name for it. */
export { containerName };

/** A video's streams, a line each, as an editor reads them off a delivery sheet. */
export function streamLines(
  info: MediaInfo,
  file: { byteSize: number; contentType: string },
): [string, string][] {
  const out: [string, string][] = [];
  const v = info.video;
  if (v) {
    const codec = videoCodecs[v.codec as VideoCodec] ?? v.codec;
    out.push([
      "Video",
      [
        v.profile ? `${codec} ${v.profile}` : codec,
        `${v.width} × ${v.height}`,
        v.fps ? `${frameRateName(v.fps)} fps` : null,
        v.scan,
        v.primaries ? (videoPrimaries[v.primaries as VideoPrimaries] ?? v.primaries) : null,
        v.range ? `${v.range} range` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    ]);
  }
  const a = info.audio;
  // The sound in words (#635), never ffmpeg's id for its codec.
  out.push(["Audio", a ? soundLine(a) : "None"]);
  const clock = v ? videoClock(v) : null;
  if (v?.timecode && clock)
    out.push([
      "Timecode",
      `${v.timecode} · ${clock.rate.nominal} fps ${clock.rate.drop ? "drop-frame" : "non-drop"}`,
    ]);
  out.push([
    "Container",
    [containerName(info.format, file.contentType), formatBytes(file.byteSize)]
      .filter(Boolean)
      .join(" · "),
  ]);
  return out;
}

/**
 * The loudness and true peak the tiles show, from the checks themselves: QA is all a viewer
 * needs to see them, without the meters (#240).
 */
export function soundFigures(findings: readonly QaFinding[]): {
  integrated: number | null;
  truePeak: number | null;
} {
  const figure = (check: QaFinding["check"], key: string) => {
    const value = findings.find((f) => f.check === check)?.details[key];
    return typeof value === "number" ? value : null;
  };
  return {
    integrated: figure("loudness", "integrated"),
    truePeak: figure("true-peak", "truePeak"),
  };
}

/** Where a frame is, short: the timecode without its hour, or the time from the start. */
export const frameLabel = (at: number, clock: ReturnType<typeof videoClock>) =>
  clock ? videoTimecode(at, clock).slice(3) : formatDuration(at);

/**
 * QA for a video (#42), laid out as a recording's is (#634): the figures that matter first in
 * one hairline row, the checks (the delivery profile's among them), the frames worth a look,
 * then whatever the page adds and the streams.
 */
export function VideoQa({
  fileId,
  info,
  file,
  media,
  canChoose,
  onLoop,
  onComment,
  children,
  aside,
  figures = true,
}: {
  /** Whether the row of figures gives loudness and true peak (the meters give them otherwise). */
  figures?: boolean;
  fileId: string;
  info: MediaInfo;
  file: { byteSize: number; contentType: string };
  media: HTMLMediaElement | null;
  canChoose: boolean;
  onLoop?: (loop: Loop) => void;
  onComment?: (finding: QaFinding) => void;
  /** More for the main column, under the checks. */
  children?: ReactNode;
  /** More for the side column, under the frames. */
  aside?: ReactNode;
}) {
  const { data } = useQuery(qaQuery(fileId));
  // The player fetched the playback link; this only reads it, never asks for another.
  const { data: playback } = useQuery({ ...playbackQuery(fileId), enabled: false });
  const filmstrip = playback?.filmstrip ?? null;
  const { src, failed } = useFilmstripPicture(filmstrip?.url ?? null);
  // Without a filmstrip (a video made before them, or one that would not load), the frames
  // are listed by name and time, a click away all the same.
  const thumbnails = Boolean(filmstrip) && !failed;
  const findings = data?.findings ?? [];
  const v = info.video;
  const clock = v ? videoClock(v) : null;
  const duration = info.duration ?? 0;
  const seek = (t: number) => {
    if (media) media.currentTime = t;
  };
  const frames = framesToLookAt(findings);
  const aspect = v ? v.width / v.height : 16 / 9;

  // The recording's layout (#634): the figures in one hairline row, the checks (the delivery
  // profile's among them, so the badge and the tally count the same), then the frames, the
  // loudness and the streams.
  return (
    <QaLayout
      stats={[
        ...(figures ? soundStats(findings) : []),
        {
          label: "Length",
          value: formatClock(duration),
          hint: clock
            ? `From ${videoTimecode(0, clock)} · ${Math.round(duration * (v?.fps ?? 0))} frames`
            : undefined,
        },
      ]}
      checks={
        <QualityChecks
          fileId={fileId}
          media={media}
          canChoose={canChoose}
          onLoop={onLoop}
          onComment={onComment}
        />
      }
      format={streamLines(info, file)}
      aside={aside}
    >
      {frames.length > 0 && (
        <section aria-label="Frames to look at" className="flex flex-col gap-2">
          <h2 className="label m-0">Frames to look at</h2>
          <ul
            className={cn(
              "m-0 list-none p-0",
              thumbnails
                ? "grid grid-cols-2 gap-2 sm:grid-cols-4"
                : "flex flex-col border-t border-hairline",
            )}
          >
            {frames.map((f) => {
              const at = f.start ?? 0;
              const label = frameLabel(at, clock);
              return !thumbnails ? (
                <li key={`${f.check}-${at}`} className="border-b border-hairline">
                  <button
                    type="button"
                    onClick={() => seek(at)}
                    className="flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent px-0 py-2 text-left text-[13px] text-ink-2 hover:text-ink"
                  >
                    <SeverityDot severity={f.severity} />
                    <span className="truncate">{qaCheckNames[f.check]}</span>
                    <span className="tabular ml-auto shrink-0 text-ink-3">{label}</span>
                  </button>
                </li>
              ) : (
                <li key={`${f.check}-${at}`}>
                  <button
                    type="button"
                    onClick={() => seek(at)}
                    className="group relative block w-full cursor-pointer overflow-hidden rounded-control border border-hairline bg-transparent p-0 hover:border-edge focus-visible:border-edge"
                  >
                    <FilmstripFrame
                      src={src}
                      frames={filmstrip?.frames ?? 1}
                      index={filmstrip ? filmstripFrame(at, duration, filmstrip.frames) : 0}
                      aspect={aspect}
                      className="w-full"
                    />
                    <span className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-ground/75 px-1.5 py-0.5 text-[11px] text-ink">
                      <SeverityDot severity={f.severity} />
                      <span className="truncate">{qaCheckNames[f.check]}</span>
                      <span className="tabular ml-auto shrink-0">{label}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      {children}
    </QaLayout>
  );
}
