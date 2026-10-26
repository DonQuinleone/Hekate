import { useState } from "react";
import { QaReportDialog } from "~/components/exports";
import { Icon } from "~/components/icons";
import { Label } from "~/components/label";
import { Card } from "~/components/page";
import { SeverityDot } from "~/components/status";
import { Button } from "~/components/ui/button";
import { Select } from "~/components/ui/input";
import { ActionMenu } from "~/components/ui/menu";
import { Frame } from "~/components/video";
import {
  deliveryProfiles,
  type File,
  findingsFor,
  loudness as loudnessOf,
  type QaFinding,
  rulePacks,
  severityRank,
} from "~/data";
import { cn } from "~/lib/cn";
import { formatBytes, formatDuration, formatTimecode } from "~/lib/format";
import type { Playback } from "./player/playback.ts";

function Tile({
  label,
  value,
  unit,
  hint,
  flag,
}: {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
  flag?: boolean;
}) {
  return (
    <div className="flex flex-col rounded-panel-lg border border-line bg-raised/25 px-4 py-3 shadow-1">
      <span className="text-[13px] text-ink-3">{label}</span>
      <span
        className={cn(
          "tabular mt-1 text-[24px] leading-[30px] font-semibold tracking-[-0.02em]",
          flag ? "text-signal" : "text-ink",
        )}
      >
        {value}
        {unit && <span className="ml-1 text-[13px] font-normal text-ink-3">{unit}</span>}
      </span>
      {hint && <span className="mt-0.5 text-[12px] text-ink-3">{hint}</span>}
    </div>
  );
}

function Finding({
  f,
  file,
  playback,
  onComment,
  canComment,
}: {
  f: QaFinding;
  file: File;
  playback: Playback;
  onComment: () => void;
  canComment: boolean;
}) {
  const [open, setOpen] = useState(f.severity !== "pass");
  return (
    <li className="flex gap-4 border-b border-line px-4 py-3 last:border-b-0">
      {f.start !== undefined ? (
        <button
          type="button"
          aria-label={`Go to ${formatTimecode(f.start, file.media.fps)}`}
          onClick={() => {
            playback.seek(f.start ?? 0);
          }}
          className="group relative shrink-0 overflow-hidden rounded-control shadow-2"
        >
          <Frame file={file} time={f.start} thumb className="h-[54px] w-[96px]" />
          <span className="tabular absolute right-1 bottom-1 rounded-chip bg-canvas/80 px-1 text-[10px] text-ink">
            {formatTimecode(f.start, file.media.fps)}
          </span>
        </button>
      ) : (
        <span className="flex h-[54px] w-[96px] shrink-0 items-center justify-center rounded-control bg-sunken text-ink-3">
          <Icon name="film" size={16} />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <SeverityDot severity={f.severity} className="relative top-[-1px]" />
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="text-left text-[14px] font-medium text-ink"
          >
            {f.check}
          </button>
          <span className="text-[14px] text-ink-2">{f.summary}</span>
          {f.change === "new" && <Label className="text-signal">new in this cut</Label>}
          {f.pack && <Label>{rulePacks.find((p) => p.id === f.pack)?.name}</Label>}
        </div>
        {open && f.detail && (
          <p className="mt-1 text-[13px] leading-[18px] text-ink-3">{f.detail}</p>
        )}
        {open && f.fields.length > 0 && (
          <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-[13px]">
            {f.fields.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-ink-3">{k}</dt>
                <dd className="tabular text-ink-2">{v}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      <div className="flex shrink-0 items-start gap-1">
        {f.end !== undefined && f.start !== undefined && (
          <button
            type="button"
            onClick={() => {
              playback.setLoop({ start: f.start ?? 0, end: f.end ?? 0 });
              playback.setLooping(true);
              playback.seek(f.start ?? 0);
              playback.play();
            }}
            className="h-7 rounded-control px-2 text-[13px] text-ink-2 hover:bg-raised hover:text-ink"
          >
            Loop it
          </button>
        )}
        {canComment && f.severity !== "pass" && (
          <button
            type="button"
            onClick={onComment}
            className="h-7 rounded-control px-2 text-[13px] text-ink-3 hover:bg-raised hover:text-ink"
          >
            Comment
          </button>
        )}
      </div>
    </li>
  );
}

/** QA for a cut: picture, sound and delivery, against the broadcast profile, with the frames that matter. */
export function VideoQaView({
  file,
  playback,
  previous,
  canChooseProfile,
  canComment,
  onComment,
}: {
  file: File;
  playback: Playback;
  previous?: File;
  canChooseProfile: boolean;
  canComment: boolean;
  onComment: (finding: QaFinding) => void;
}) {
  const findings = findingsFor(file.id).sort(
    (a, b) =>
      severityRank[a.severity] - severityRank[b.severity] ||
      (a.start ?? 99999) - (b.start ?? 99999),
  );
  const issues = findings.filter((f) => f.severity === "fail" || f.severity === "warn");
  const advisories = findings.filter((f) => f.severity === "info");
  const passed = findings.filter((f) => f.severity === "pass");
  const [showPassed, setShowPassed] = useState(false);
  const [report, setReport] = useState(false);
  const l = loudnessOf[file.id];
  const profile = deliveryProfiles.find((p) => p.id === "broadcast");
  const m = file.media;
  const analysing = file.state === "pending";
  const delivery: { name: string; ok: boolean | null; note: string }[] = [
    {
      name: "Codec and container",
      ok: true,
      note: "ProRes 422 HQ in a .mov; nothing ever through H.264",
    },
    { name: "Picture", ok: true, note: "1920 × 1080, progressive, BT.709, SDR, native 25 fps" },
    { name: "Head and tail", ok: true, note: "1.52 s at the head, 1.8 s at the tail; 2 s allowed" },
    { name: "Slates, bars and bugs", ok: true, note: "None; the copyright card runs 4 s, centred" },
    { name: "Captions", ok: true, note: "Sidecar .ttml, 48 cues; nothing embedded" },
    { name: "Audio", ok: true, note: "PCM 48 kHz 24-bit, one track, L and R tagged" },
    { name: "Checksum", ok: true, note: "MD5 unlike any earlier submission" },
    { name: "Atmos for video", ok: null, note: "No sidecar ADM supplied; stereo only" },
  ];
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 @3xl/app:grid-cols-4">
        <Tile
          label="Loudness"
          value={l ? l.integrated.toFixed(1) : "—"}
          unit="LUFS"
          hint={profile ? `target ${profile.loudness} ± ${profile.tolerance}` : undefined}
          flag={Boolean(
            l && profile?.loudness && Math.abs(l.integrated - profile.loudness) > profile.tolerance,
          )}
        />
        <Tile
          label="True peak"
          value={l ? l.truePeak.toFixed(1) : "—"}
          unit="dBTP"
          hint={profile ? `ceiling ${profile.truePeak}` : undefined}
          flag={Boolean(l && profile && l.truePeak > profile.truePeak)}
        />
        <Tile
          label="Picture"
          value={`${m.width} × ${m.height}`}
          hint={`${m.fps} fps · progressive · Rec. 709`}
        />
        <Tile
          label="Length"
          value={formatDuration(m.duration)}
          hint={`${formatTimecode(0, m.fps).slice(0, 8)}:00 start · ${Math.round(m.duration * (m.fps ?? 25))} frames`}
        />
      </div>
      <div className="grid gap-5 @5xl/app:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex min-w-0 flex-col gap-5">
          <Card>
            <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
              <h2 className="text-[15px] font-medium">Checks</h2>
              <span className="text-[13px] text-ink-3">against</span>
              {canChooseProfile ? (
                <Select defaultValue="broadcast" className="h-8 w-auto text-[13px]">
                  {deliveryProfiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              ) : (
                <span className="text-[13px] text-ink-2">{profile?.name}</span>
              )}
              <span className="eyebrow ml-auto">
                {issues.length} {issues.length === 1 ? "issue" : "issues"} · {advisories.length}{" "}
                advisory · {passed.length} passed
              </span>
              <ActionMenu
                label="report"
                actions={[
                  { label: "Report…", onSelect: () => setReport(true) },
                  { label: "Run the checks again", onSelect: () => {} },
                ]}
              />
            </div>
            {analysing ? (
              <p className="flex items-center gap-2 px-4 py-6 text-[14px] text-ink-2">
                <span className="size-[8px] animate-pulse rounded-full border-[1.5px] border-ink-3" />{" "}
                Analysing: picture and loudness are measured in one pass. A few minutes for a cut
                this size.
              </p>
            ) : (
              <ul>
                {[...issues, ...advisories].map((f) => (
                  <Finding
                    key={f.id}
                    f={f}
                    file={file}
                    playback={playback}
                    canComment={canComment}
                    onComment={() => onComment(f)}
                  />
                ))}
                {passed.length > 0 && (
                  <li className="px-4 py-2.5">
                    <button
                      type="button"
                      onClick={() => setShowPassed((s) => !s)}
                      className="flex items-center gap-2 text-[13px] text-ink-3 hover:text-ink"
                    >
                      <SeverityDot severity="pass" /> {passed.length} checks passed
                      <Icon
                        name="chevronDown"
                        size={12}
                        className={cn("transition-transform", showPassed && "rotate-180")}
                      />
                    </button>
                  </li>
                )}
                {showPassed &&
                  passed.map((f) => (
                    <Finding
                      key={f.id}
                      f={f}
                      file={file}
                      playback={playback}
                      canComment={false}
                      onComment={() => {}}
                    />
                  ))}
              </ul>
            )}
          </Card>
          <Card>
            <div className="flex items-center gap-2 border-b border-line px-4 py-3">
              <h2 className="text-[15px] font-medium">Delivery checklist</h2>
              <span className="text-[13px] text-ink-3">
                what the profile asks for beyond the measurements
              </span>
            </div>
            <ul className="grid gap-x-6 @3xl/app:grid-cols-2">
              {delivery.map((d) => (
                <li
                  key={d.name}
                  className="flex items-start gap-3 border-b border-line px-4 py-2.5 @3xl/app:[&:nth-last-child(-n+2)]:border-b-0"
                >
                  <SeverityDot
                    severity={d.ok === null ? "info" : d.ok ? "pass" : "fail"}
                    className="mt-[6px]"
                  />
                  <span className="min-w-0">
                    <span className="block text-[14px] text-ink">{d.name}</span>
                    <span className="block text-[13px] text-ink-3">{d.note}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
          {previous && (
            <Card className="px-4 py-3">
              <div className="flex items-center gap-2">
                <h2 className="text-[15px] font-medium">Since the previous cut</h2>
                <span className="text-[13px] text-ink-3">{previous.name}</span>
              </div>
              <ul className="mt-2 flex flex-col gap-1 text-[14px] text-ink-2">
                <li className="flex items-center gap-2">
                  <SeverityDot severity="pass" /> Loudness now within tolerance (was −21.4 LUFS)
                </li>
                <li className="flex items-center gap-2">
                  <SeverityDot severity="warn" /> Flashing risk is new in this cut
                </li>
              </ul>
            </Card>
          )}
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          <Card className="p-4">
            <Label>Streams</Label>
            <dl className="mt-2 flex flex-col gap-2.5 text-[13px]">
              {[
                [
                  "Video",
                  `${m.codec ?? "ProRes 422 HQ"} · ${m.width} × ${m.height} · ${m.fps} fps · 10-bit 4:2:2 · Rec. 709`,
                ],
                ["Audio", "PCM · 48 kHz · 24-bit · stereo"],
                ["Timecode", "10:00:00:00 · 25 fps non-drop"],
                ["Container", `${m.container ?? "QuickTime"} · ${formatBytes(file.size)}`],
                ["Stored", "encrypted · local disk"],
              ].map(([k, v]) => (
                <div key={k} className="flex flex-col gap-0.5">
                  <dt className="text-ink-3">{k}</dt>
                  <dd className="text-ink-2">{v}</dd>
                </div>
              ))}
            </dl>
          </Card>
          <Card className="p-4">
            <Label>Frames to look at</Label>
            <ul className="mt-2 grid grid-cols-2 gap-2">
              {findings
                .filter((f) => f.start !== undefined && f.severity !== "pass")
                .map((f) => (
                  <li key={f.id}>
                    <button
                      type="button"
                      onClick={() => playback.seek(f.start ?? 0)}
                      className="group relative block w-full overflow-hidden rounded-control shadow-2"
                    >
                      <Frame file={file} time={f.start ?? 0} thumb className="w-full" />
                      <span className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-canvas/70 px-1.5 py-0.5 text-[10px] text-ink">
                        <SeverityDot severity={f.severity} className="size-[6px]" />
                        <span className="truncate">{f.check}</span>
                        <span className="tabular ml-auto">
                          {formatTimecode(f.start ?? 0, m.fps).slice(3)}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
            </ul>
          </Card>
          <Card className="p-4">
            <div className="flex items-center justify-between">
              {/* Not edited: a video's downloads leave its metadata out (decision 260). */}
              <Label>Embedded metadata</Label>
            </div>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
              {[
                ["Title", "Opening titles"],
                ["Reel", "OT_cut3"],
                ["Colour", "Rec. 709, full range off"],
                ["Creator", "Endless Hall Records"],
              ].map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-ink-3">{k}</dt>
                  <dd className="truncate text-ink-2">{v}</dd>
                </div>
              ))}
            </dl>
          </Card>
          <Button
            variant="secondary"
            size="sm"
            className="self-start"
            onClick={() => setReport(true)}
          >
            <Icon name="download" size={14} />
            QA report
          </Button>
        </div>
      </div>
      {report && <QaReportDialog file={file} onClose={() => setReport(false)} />}
    </div>
  );
}
