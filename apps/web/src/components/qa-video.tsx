import {
  formatBytes,
  formatChannels,
  formatDuration,
  frameRateName,
  isDeliveryCheck,
  type MediaInfo,
  type QaFinding,
  type QaSeverity,
  qaCheckNames,
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
import { loudnessQuery, playbackQuery, qaQuery } from "~/lib/queries";
import { FilmstripFrame, filmstripFrame, useFilmstripPicture } from "./filmstrip";
import { QualityChecks, SeverityDot } from "./qa";

/** A level as engineers write it: one decimal, a true minus sign. */
const level = (n: number) => n.toFixed(1).replace("-", "−");

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

/** Containers by the type a file was given, where ffprobe names a family of them. */
const containers: Record<string, string> = {
  "video/quicktime": "QuickTime",
  "video/mp4": "MP4",
  "video/x-matroska": "Matroska",
  "video/webm": "WebM",
  "application/mxf": "MXF",
  "video/mxf": "MXF",
  "video/mpeg": "MPEG",
  "video/x-msvideo": "AVI",
};

/** A container's name: by the file's type, else the first of ffprobe's names for it. */
export const containerName = (format: string | undefined, contentType: string) =>
  containers[contentType] ?? format?.split(",")[0]?.toUpperCase() ?? null;

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
  out.push([
    "Audio",
    a
      ? [
          a.codec,
          `${a.sampleRate / 1000} kHz`,
          a.bitDepth ? `${a.bitDepth}-bit` : null,
          formatChannels(a.channels, a.channelLayout),
        ]
          .filter(Boolean)
          .join(" · ")
      : "None",
  ]);
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

function Tile({
  label,
  value,
  unit,
  hint,
  flag = false,
}: {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
  flag?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col rounded-panel border border-hairline bg-surface px-4 py-3">
      <span className="text-[13px] text-ink-3">{label}</span>
      <span
        className={cn(
          "tabular mt-1 truncate text-[22px] leading-[28px] font-semibold tracking-[-0.02em]",
          flag ? "text-signal" : "text-ink",
        )}
      >
        {value}
        {unit && <span className="ml-1 text-[13px] font-normal text-ink-3">{unit}</span>}
      </span>
      {hint && <span className="truncate text-xs text-ink-3">{hint}</span>}
    </div>
  );
}

const bad = (f: QaFinding | undefined) => f?.severity === "fail" || f?.severity === "warn";

/**
 * QA for a video (#42), as the prototype lays it out: the numbers that matter first, the
 * measured checks with what the delivery profile asks beside them, and on the right the
 * streams, the frames worth a look and whatever else the page adds.
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
}: {
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
  const { data: measured } = useQuery({ ...loudnessQuery(fileId), enabled: Boolean(info.audio) });
  // The player fetched the playback link; this only reads it, never asks for another.
  const { data: playback } = useQuery({ ...playbackQuery(fileId), enabled: false });
  const filmstrip = playback?.filmstrip ?? null;
  const src = useFilmstripPicture(filmstrip?.url ?? null);
  const findings = data?.findings ?? [];
  const by = (check: QaFinding["check"]) => findings.find((f) => f.check === check);
  const summary = measured?.summary ?? null;
  const loudness = by("loudness");
  const peak = by("true-peak");
  const v = info.video;
  const clock = v ? videoClock(v) : null;
  const duration = info.duration ?? 0;
  const seek = (t: number) => {
    if (media) media.currentTime = t;
  };
  const checklist = deliveryChecklist(findings);
  const frames = framesToLookAt(findings);
  const aspect = v ? v.width / v.height : 16 / 9;

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile
          label="Loudness"
          value={summary?.integrated != null ? level(summary.integrated) : "—"}
          unit={summary?.integrated != null ? "LUFS" : undefined}
          hint={
            !info.audio
              ? "No sound"
              : loudness && typeof loudness.details.target === "number"
                ? `target ${level(loudness.details.target)} ± ${loudness.details.tolerance}`
                : undefined
          }
          flag={bad(loudness)}
        />
        <Tile
          label="True peak"
          value={summary?.truePeak != null ? level(summary.truePeak) : "—"}
          unit={summary?.truePeak != null ? "dBTP" : undefined}
          hint={
            peak && typeof peak.details.ceiling === "number"
              ? `ceiling ${level(peak.details.ceiling)}`
              : undefined
          }
          flag={bad(peak)}
        />
        <Tile
          label="Picture"
          value={v ? `${v.width} × ${v.height}` : "—"}
          hint={
            v
              ? [
                  v.fps ? `${frameRateName(v.fps)} fps` : null,
                  v.scan,
                  v.primaries ? (videoPrimaries[v.primaries as VideoPrimaries] ?? null) : null,
                ]
                  .filter(Boolean)
                  .join(" · ")
              : undefined
          }
          flag={bad(by("picture-format"))}
        />
        <Tile
          label="Length"
          value={formatDuration(duration)}
          hint={
            clock
              ? `${videoTimecode(0, clock)} start · ${Math.round(duration * (v?.fps ?? 0))} frames`
              : undefined
          }
        />
      </div>
      <div className="grid grid-cols-1 items-start gap-x-8 gap-y-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-6">
          <QualityChecks
            fileId={fileId}
            media={media}
            canChoose={canChoose}
            onLoop={onLoop}
            onComment={onComment}
            omit={(f) => isDeliveryCheck(f.check)}
          />
          {checklist.length > 0 && data && (
            <section aria-label="Delivery checklist" className="flex flex-col gap-3">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <h2 className="m-0 text-[15px] font-medium">Delivery checklist</h2>
                <span className="text-xs text-ink-3">what {data.profile.label} asks for</span>
              </div>
              <ul className="m-0 grid list-none gap-x-6 border-t border-hairline p-0 md:grid-cols-2">
                {checklist.map((f) => (
                  <li
                    key={f.check}
                    className="flex items-start gap-3 border-b border-hairline py-2.5"
                  >
                    <span className="mt-[7px] flex">
                      <SeverityDot severity={f.severity} />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[13px] text-ink">{qaCheckNames[f.check]}</span>
                      <span className="block text-xs text-ink-3">{f.summary}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {children}
        </div>
        <aside aria-label="About the video" className="flex min-w-0 flex-col gap-6">
          <section aria-label="Streams" className="flex flex-col gap-2">
            <h2 className="label m-0">Streams</h2>
            <dl className="m-0 flex flex-col gap-2.5 text-[13px]">
              {streamLines(info, file).map(([term, value]) => (
                <div key={term} className="flex flex-col gap-0.5">
                  <dt className="text-ink-3">{term}</dt>
                  <dd className="m-0 text-ink-2">{value}</dd>
                </div>
              ))}
            </dl>
          </section>
          {frames.length > 0 && (
            <section aria-label="Frames to look at" className="flex flex-col gap-2">
              <h2 className="label m-0">Frames to look at</h2>
              <ul className="m-0 grid list-none grid-cols-2 gap-2 p-0">
                {frames.map((f) => {
                  const at = f.start ?? 0;
                  const label = clock ? videoTimecode(at, clock) : formatDuration(at);
                  return (
                    <li key={`${f.check}-${at}`}>
                      <button
                        type="button"
                        onClick={() => seek(at)}
                        aria-label={`${qaCheckNames[f.check]} at ${label}`}
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
                          <span className="tabular ml-auto shrink-0">{label.slice(3)}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          {aside}
        </aside>
      </div>
    </div>
  );
}
