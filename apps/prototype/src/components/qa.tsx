import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Checksum } from "~/components/checksum";
import { Icon } from "~/components/icons";
import { Label } from "~/components/label";
import { SeverityDot } from "~/components/status";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ActionMenu } from "~/components/ui/menu";
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
import { formatBytes, formatChannels, formatClock, formatDuration } from "~/lib/format";
import { seeded } from "~/lib/seeded";
import type { Playback } from "./player/playback.ts";

function Stat({
  label,
  value,
  unit,
  flag,
}: {
  label: string;
  value: string;
  unit?: string;
  flag?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <Label>{label}</Label>
      <span className={cn("tabular text-[22px] leading-[30px]", flag ? "text-signal" : "text-ink")}>
        {value}
        {unit && <span className="text-[13px] text-ink-3"> {unit}</span>}
      </span>
    </div>
  );
}

/** Short-term loudness over the file, with the playhead and the target. */
function History({
  seed,
  duration,
  playback,
  target,
}: {
  seed: number;
  duration: number;
  playback: Playback;
  target: number | null;
}) {
  const rand = seeded(seed * 3);
  const w = 600;
  const h = 90;
  const points: string[] = [];
  const momentary: string[] = [];
  for (let i = 0; i <= 120; i++) {
    const t = i / 120;
    const phrase =
      -24 +
      10 *
        (0.55 + 0.35 * Math.sin(t * Math.PI * 6 + seed) * Math.sin(t * Math.PI * 2.3)) *
        (t > 0.93 ? (1 - t) / 0.07 : 1) *
        (t < 0.012 ? 0 : 1);
    const y = (lufs: number) => h - ((lufs + 40) / 36) * h;
    points.push(`${(t * w).toFixed(1)},${y(phrase + rand() * 1.2).toFixed(1)}`);
    momentary.push(`${(t * w).toFixed(1)},${y(phrase + rand() * 4 - 1).toFixed(1)}`);
  }
  const y = (lufs: number) => h - ((lufs + 40) / 36) * h;
  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        className="h-24 w-full rounded-control border border-line bg-sunken"
        role="img"
        aria-label="Loudness over time"
      >
        {[-10, -20, -30].map((v) => (
          <g key={v}>
            <line x1={0} x2={w} y1={y(v)} y2={y(v)} stroke="var(--hk-hairline-soft)" />
          </g>
        ))}
        {target !== null && (
          <line
            x1={0}
            x2={w}
            y1={y(target)}
            y2={y(target)}
            stroke="var(--hk-signal-line)"
            strokeDasharray="4 4"
          />
        )}
        <polyline
          points={momentary.join(" ")}
          fill="none"
          stroke="var(--hk-edge-strong)"
          strokeWidth={1}
        />
        <polyline
          points={points.join(" ")}
          fill="none"
          stroke="var(--hk-ink-2)"
          strokeWidth={1.5}
        />
        <line
          x1={(playback.time / duration) * w}
          x2={(playback.time / duration) * w}
          y1={0}
          y2={h}
          stroke="var(--hk-signal)"
          strokeWidth={1.5}
        />
      </svg>
      <div className="tabular pointer-events-none absolute top-1 left-2 flex flex-col gap-[14px] text-[9px] text-ink-3">
        <span>−10</span>
        <span>−20</span>
        <span>−30</span>
      </div>
      <div className="mt-1 flex gap-4 text-[12px] text-ink-3">
        <span className="flex items-center gap-1">
          <span className="h-px w-3 bg-ink-2" /> Short-term
        </span>
        <span className="flex items-center gap-1">
          <span className="h-px w-3 bg-edge-strong" /> Momentary
        </span>
        {target !== null && (
          <span className="flex items-center gap-1">
            <span className="h-px w-3 border-t border-dashed border-signal" /> Target {target}
          </span>
        )}
      </div>
    </div>
  );
}

function Meters({
  channels,
  playback,
  seed,
}: {
  channels: string[];
  playback: Playback;
  seed: number;
}) {
  const rand = seeded(Math.floor(playback.time * 10) + seed);
  // Phase between any two channels of a multichannel recording (#74), the front pair first.
  const pairs = channels.flatMap((a, i) => channels.slice(i + 1).map((b) => `${a}–${b}`));
  const [pair, setPair] = useState(0);
  const level = (i: number) =>
    playback.playing || playback.time > 0
      ? -8 - rand() * 10 - (channels[i] === "LFE" ? 12 : 0)
      : -60;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <Label>Meters</Label>
        <span className="tabular text-[12px] text-ink-3">at {formatClock(playback.time)}</span>
      </div>
      <div className="flex gap-2">
        {channels.map((c, i) => {
          const v = level(i);
          const pct = Math.max(0, Math.min(100, ((v + 60) / 60) * 100));
          return (
            <div key={c} className="flex flex-1 flex-col items-center gap-1">
              <div className="relative h-24 w-full overflow-hidden rounded-chip bg-sunken">
                <div
                  className="absolute right-0 bottom-0 left-0 bg-ink-2 transition-[height] duration-100"
                  style={{ height: `${pct}%` }}
                />
                <div
                  className="absolute right-0 left-0 h-px bg-signal/60"
                  style={{ bottom: `${((-1 + 60) / 60) * 100}%` }}
                />
              </div>
              <span className="tabular text-[11px] text-ink-3">{c}</span>
              <span className="tabular text-[12px] text-ink">{v.toFixed(1)}</span>
            </div>
          );
        })}
      </div>
      {channels.length >= 2 && (
        <StereoField spread={rand()} live={playback.playing || playback.time > 0} />
      )}
      {pairs.length > 1 && (
        <label className="flex items-center justify-between gap-2 text-[12px] text-ink-3">
          Phase between
          <select
            value={pair}
            onChange={(e) => setPair(Number(e.target.value))}
            className="h-7 rounded-chip border border-line bg-ground/60 px-2 text-[12px] text-ink"
          >
            {pairs.map((p, i) => (
              <option key={p} value={i}>
                {p}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="grid grid-cols-3 gap-2 text-center">
        {[
          ["M", "−15.1"],
          ["S", "−16.0"],
          [pairs.length > 1 ? `CORR ${pairs[pair]}` : "CORR", pair === 0 ? "+0.82" : "+0.41"],
        ].map(([k, v]) => (
          <div key={k} className="rounded-control bg-sunken py-1.5">
            <div className="tabular text-[11px] text-ink-3">{k}</div>
            <div className="tabular text-[14px] text-ink">{v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The front pair's stereo field, as a goniometer draws it: mono straight up, the speakers 45°
 * either side, out of phase flat across; the shape is where the energy is at the playhead.
 */
function StereoField({ spread, live }: { spread: number; live: boolean }) {
  const steps = Array.from({ length: 17 }, (_, i) => i - 8);
  // A centred mix, a little wider or narrower from moment to moment.
  const width = 2.2 + spread * 1.6;
  const radius = (step: number) => (live ? Math.exp(-((step / width) ** 2)) : 0);
  const point = (step: number, r: number) => {
    const angle = (step * Math.PI) / 16;
    return `${(50 + 44 * r * Math.sin(angle)).toFixed(2)},${(48 - 44 * r * Math.cos(angle)).toFixed(2)}`;
  };
  return (
    <figure className="m-0 flex flex-col gap-1">
      <figcaption className="text-[11px] text-ink-3">Stereo field</figcaption>
      <svg
        viewBox="0 0 100 52"
        className="w-32"
        role="img"
        aria-label={`Stereo field: ${live ? "Centred" : "Silent"}`}
      >
        <path
          d="M6,48 A44,44 0 0 1 94,48 Z"
          className="fill-sunken stroke-line"
          strokeWidth={0.75}
        />
        {[-4, 0, 4].map((step) => (
          <line
            key={step}
            x1={50}
            y1={48}
            x2={point(step, 1).split(",")[0]}
            y2={point(step, 1).split(",")[1]}
            className="stroke-line"
            strokeWidth={0.75}
          />
        ))}
        {live && (
          <path
            d={`M50,48 ${steps.map((step) => `L${point(step, radius(step))}`).join(" ")} Z`}
            className="fill-ink-3/50 stroke-ink-2"
            strokeWidth={0.75}
          />
        )}
        <text
          x={point(-4, 1.12).split(",")[0]}
          y={point(-4, 1.12).split(",")[1]}
          textAnchor="middle"
          dominantBaseline="middle"
          className="fill-ink-3 text-[7px]"
        >
          L
        </text>
        <text
          x={point(4, 1.12).split(",")[0]}
          y={point(4, 1.12).split(",")[1]}
          textAnchor="middle"
          dominantBaseline="middle"
          className="fill-ink-3 text-[7px]"
        >
          R
        </text>
      </svg>
      <span className="text-[11px] text-ink-2">{live ? "Centred" : "Silent"}</span>
    </figure>
  );
}

function Finding({
  f,
  playback,
  onComment,
  canComment,
}: {
  f: QaFinding;
  playback: Playback;
  onComment: () => void;
  canComment: boolean;
}) {
  const [open, setOpen] = useState(f.severity !== "pass");
  return (
    <li className={cn("border-b border-line last:border-b-0", open ? "py-3" : "py-2")}>
      <div className="flex items-start gap-3 px-4">
        <SeverityDot severity={f.severity} className="mt-[7px]" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              className="text-left text-[14px] font-medium text-ink"
            >
              {f.check}
            </button>
            <span className="text-[14px] text-ink-2">{f.summary}</span>
            {f.change === "new" && <Label className="text-signal">new in this version</Label>}
            {f.pack && <Label>{rulePacks.find((p) => p.id === f.pack)?.name}</Label>}
            {f.change === "fixed" && <Label>fixed in the next</Label>}
          </div>
          {open && f.detail && (
            <p className="mt-1 text-[13px] leading-[18px] text-ink-3">{f.detail}</p>
          )}
          {open && f.fields.length > 0 && (
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-[13px]">
              {f.fields.map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-ink-3">{k}</dt>
                  <dd className="tabular text-ink-2">{v}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {f.start !== undefined && (
            <button
              type="button"
              onClick={() => {
                playback.seek(Math.max(0, f.start ?? 0));
                playback.play();
              }}
              className="tabular flex h-7 items-center gap-1.5 rounded-control px-2 text-[13px] text-ink-2 hover:bg-raised hover:text-ink"
            >
              <Icon name="play" size={10} fill="currentColor" strokeWidth={0} />
              {formatClock(f.start)}
              {f.channel && <span className="text-ink-3">{f.channel}</span>}
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
      </div>
    </li>
  );
}

/** QA: what was measured, worst first, against the delivery profile; loudness, meters, format, metadata. */
export function QaView({
  file,
  playback,
  previous,
  canChooseProfile,
  canEditMetadata,
  canComment,
  onComment,
  meters,
}: {
  file: File;
  playback: Playback;
  previous?: File;
  canChooseProfile: boolean;
  /** Whoever organises the project's files, with QA, and the editor on (decision 264). */
  canEditMetadata: boolean;
  canComment: boolean;
  onComment: (finding: QaFinding) => void;
  meters: boolean;
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
  const navigate = useNavigate();
  const openReport = () =>
    void navigate({ to: "/files/$fileId/qa-report", params: { fileId: file.id } });
  const [editingMetadata, setEditingMetadata] = useState(false);
  // Narrowing the list (#43): to one severity, as its count is pressed, and to one check.
  const [only, setOnly] = useState<"fail" | "warn" | "info" | null>(null);
  const [check, setCheck] = useState("");
  const problems = [...issues, ...advisories];
  const checks = [...new Set(problems.map((f) => f.check))];
  // Checks, not findings: clipping in twenty places is one check failed.
  const count = (s: "fail" | "warn" | "info") =>
    new Set(problems.filter((f) => f.severity === s).map((f) => f.check)).size;
  const tallyWords = {
    fail: (n: number) => `${n} failed`,
    warn: (n: number) => `${n} to look at`,
    info: (n: number) => `${n} ${n === 1 ? "note" : "notes"}`,
  };
  const listed = problems.filter(
    (f) => (!only || f.severity === only) && (!check || f.check === check),
  );
  const l = loudnessOf[file.id];
  const profile = deliveryProfiles.find(
    (p) => p.id === (file.projectId === "proj-titles" ? "broadcast" : "apple-digital-masters"),
  );
  const fixed = previous ? findingsFor(previous.id).filter((f) => f.change === "fixed") : [];
  const channels =
    file.media.channels === 6
      ? ["L", "R", "C", "LFE", "Ls", "Rs"]
      : file.media.channels === 12
        ? ["L", "R", "C", "LFE", "Lss", "Rss", "Lrs", "Rrs", "Ltf", "Rtf", "Ltr", "Rtr"]
        : ["L", "R"];
  const analysing = file.state === "pending";
  const failed = file.state === "failed";
  return (
    <div className="grid gap-5 @5xl/app:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex min-w-0 flex-col gap-5">
        <section className="rounded-panel-lg border border-line bg-raised/40 shadow-1">
          <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
            <h2 className="text-[16px] font-medium">Checks</h2>
            <span className="text-[13px] text-ink-3">against</span>
            {canChooseProfile ? (
              <select
                defaultValue={profile?.id}
                className="h-7 rounded-control border border-edge bg-ground px-2 text-[13px] text-ink"
              >
                {deliveryProfiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-[13px] text-ink-2">{profile?.name}</span>
            )}
            <span className="eyebrow ml-auto flex items-center gap-1.5">
              {(["fail", "warn", "info"] as const)
                .filter((sev) => count(sev) > 0)
                .map((sev) => (
                  <span key={sev} className="contents">
                    <button
                      type="button"
                      aria-pressed={only === sev}
                      onClick={() => setOnly(only === sev ? null : sev)}
                      className={cn(
                        "hover:text-ink",
                        only === sev && "text-ink underline underline-offset-4",
                      )}
                    >
                      {tallyWords[sev](count(sev))}
                    </button>
                    ·
                  </span>
                ))}{" "}
              {new Set(passed.map((f) => f.check)).size} passed
            </span>
            {checks.length > 1 && (
              <select
                aria-label="Check"
                value={check}
                onChange={(e) => setCheck(e.target.value)}
                className="h-7 rounded-control border border-edge bg-ground px-2 text-[13px] text-ink"
              >
                <option value="">Every check</option>
                {checks.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            )}
            <ActionMenu
              label="report"
              actions={[
                { label: "QA report", onSelect: openReport },
                { label: "Run the checks again", onSelect: () => {} },
              ]}
            />
          </div>
          {analysing ? (
            <p className="flex items-center gap-2 px-4 py-6 text-[14px] text-ink-2">
              <span className="size-[8px] animate-pulse rounded-full border-[1.5px] border-ink-3" />{" "}
              Analysing: the checks run in the same pass as the loudness measurement. A minute or
              two for a file this size.
            </p>
          ) : failed ? (
            <p className="flex items-start gap-2 px-4 py-6 text-[14px] text-ink-2">
              <Icon name="warning" className="mt-0.5 text-signal" /> The file could not be read, so
              nothing was measured. The container says 96 kHz but holds 44.1 kHz frames; re-export
              it and replace the file.
            </p>
          ) : findings.length === 0 ? (
            <p className="px-4 py-6 text-[14px] text-ink-3">
              Not analysed yet: this file was uploaded before the checks existed. Run the checks
              again.
            </p>
          ) : (
            <ul className="list-none p-0">
              {listed.length === 0 && (
                <li className="px-4 py-4 text-[13px] text-ink-3">
                  Nothing found of that kind.{" "}
                  <button
                    type="button"
                    onClick={() => {
                      setOnly(null);
                      setCheck("");
                    }}
                    className="text-ink-2 underline underline-offset-4 hover:text-ink"
                  >
                    Show every finding
                  </button>
                </li>
              )}
              {listed.map((f) => (
                <Finding
                  key={f.id}
                  f={f}
                  playback={playback}
                  canComment={canComment}
                  onComment={() => onComment(f)}
                />
              ))}
              {passed.length > 0 && (
                <li className="px-4 py-2">
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
                    playback={playback}
                    canComment={false}
                    onComment={() => {}}
                  />
                ))}
            </ul>
          )}
        </section>
        {previous && (fixed.length > 0 || issues.some((f) => f.change === "new")) && (
          <section className="rounded-panel-lg border border-line bg-raised/40 shadow-1">
            <div className="flex items-center gap-2 border-b border-line px-4 py-3">
              <h2 className="text-[16px] font-medium">Since the previous version</h2>
              <span className="text-[13px] text-ink-3">{previous.name}</span>
            </div>
            <ul className="grid list-none gap-x-6 p-4 text-[14px] @3xl/app:grid-cols-2">
              <li>
                <Label>Fixed</Label>
                <ul className="mt-1 list-none p-0">
                  {fixed.map((f) => (
                    <li key={f.id} className="flex items-center gap-2 py-0.5 text-ink-2">
                      <SeverityDot severity="pass" /> {f.check}: {f.summary}
                    </li>
                  ))}
                  {fixed.length === 0 && <li className="text-ink-3">Nothing fixed.</li>}
                </ul>
              </li>
              <li>
                <Label>New</Label>
                <ul className="mt-1 list-none p-0">
                  {issues
                    .filter((f) => f.change === "new")
                    .map((f) => (
                      <li key={f.id} className="flex items-center gap-2 py-0.5 text-ink-2">
                        <SeverityDot severity={f.severity} /> {f.check}: {f.summary}
                      </li>
                    ))}
                  {issues.every((f) => f.change !== "new") && (
                    <li className="text-ink-3">Nothing new.</li>
                  )}
                </ul>
              </li>
            </ul>
          </section>
        )}
        {l && (
          <section className="rounded-panel-lg border border-line bg-raised/40 p-4 shadow-1">
            <div className="flex items-baseline gap-2">
              <h2 className="text-[16px] font-medium">Loudness</h2>
              <span className="text-[13px] text-ink-3">
                EBU R128 · ITU-R BS.1770-4
                {(file.media.channels ?? 2) > 2 ? " surround weighting" : ""}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-4 @3xl/app:grid-cols-4">
              <Stat label="Integrated" value={l.integrated.toFixed(1)} unit="LUFS" />
              <Stat label="Range" value={l.range.toFixed(1)} unit="LU" />
              <Stat
                label="True peak"
                value={l.truePeak.toFixed(1)}
                unit="dBTP"
                flag={profile ? l.truePeak > profile.truePeak : false}
              />
              <Stat label="Max short-term" value={l.maxShortTerm.toFixed(1)} unit="LUFS" />
            </div>
            <div className="mt-4">
              <History
                seed={file.seed}
                duration={file.media.duration}
                playback={playback}
                target={profile?.loudness ?? null}
              />
            </div>
          </section>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-5">
        {meters && !analysing && !failed && (
          <section className="rounded-panel-lg border border-line bg-raised/40 p-4 shadow-1">
            <Meters channels={channels} playback={playback} seed={file.seed} />
          </section>
        )}
        <section className="rounded-panel-lg border border-line bg-raised/40 p-4 shadow-1">
          <Label>Format</Label>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
            {[
              ["Container", `${file.media.container ?? ""} · ${file.media.codec ?? ""}`],
              ["Sample rate", file.media.sampleRate ? `${file.media.sampleRate / 1000} kHz` : ""],
              ["Bit depth", file.media.bitDepth ? `${file.media.bitDepth}-bit` : ""],
              [
                "Channels",
                `${file.media.channels} · ${formatChannels(file.media.layout, file.media.channels)}`,
              ],
              ["Length", formatDuration(file.media.duration)],
              ["Size", formatBytes(file.size)],
              ["Stored", "encrypted · local disk"],
            ].map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-ink-3">{k}</dt>
                <dd className="tabular text-ink-2">{v}</dd>
              </div>
            ))}
            <div className="contents">
              <dt className="text-ink-3">Checksum</dt>
              <dd className="min-w-0 text-ink-2">
                <Checksum />
              </dd>
            </div>
          </dl>
        </section>
        <section className="rounded-panel-lg border border-line bg-raised/40 p-4 shadow-1">
          <div className="flex items-center justify-between">
            <Label>Embedded metadata</Label>
            {canEditMetadata && !editingMetadata && (
              <button
                type="button"
                className="text-[13px] text-ink-3 hover:text-ink"
                onClick={() => setEditingMetadata(true)}
              >
                Edit
              </button>
            )}
          </div>
          {editingMetadata ? (
            // Corrections are Hekate's own record: the stored original is never rewritten, and
            // a download writes them into the file as it leaves (decision 264).
            <form
              className="mt-3 flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                setEditingMetadata(false);
              }}
              onKeyDown={(e) => e.key === "Escape" && setEditingMetadata(false)}
            >
              {[
                [
                  "Broadcast Wave",
                  ["Description", "Originator", "Origination date", "Time reference"],
                ],
                ["iXML", ["Scene", "Take"]],
                ["Tags", ["Title", "Artist", "ISRC"]],
              ].map(([group, labels]) => (
                <fieldset key={group as string} className="flex flex-col gap-2">
                  <Label>{group}</Label>
                  {(labels as string[]).map((label) => (
                    <label key={label} className="flex flex-col gap-1 text-[13px] text-ink-2">
                      {label}
                      <Input
                        defaultValue={
                          {
                            Description: "Maple Leaf Rag, V2 dry, Endless Hall",
                            Originator: "Endless Hall Records",
                            "Origination date": "2026-10-14",
                            "Time reference": "10:00:00:00",
                            Scene: "12",
                            Take: "3",
                            Title: "Maple Leaf Rag",
                            Artist: "Endless Hall Records",
                          }[label] ?? ""
                        }
                      />
                      {label === "Originator" && (
                        <span className="flex items-center justify-between text-[12px] text-ink-3">
                          In the file: Endless Hal
                          <button type="button" className="hover:text-ink">
                            Restore
                          </button>
                        </span>
                      )}
                    </label>
                  ))}
                </fieldset>
              ))}
              <div className="flex items-center gap-2">
                <Button type="submit" size="sm">
                  Save
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setEditingMetadata(false)}>
                  Cancel
                </Button>
              </div>
              <p className="text-[12px] text-ink-3">
                Kept by Hekate and written into downloads; the stored original is never changed.
              </p>
            </form>
          ) : (
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
              {[
                ["Description", "Maple Leaf Rag, V2 dry, Endless Hall"],
                ["Originator", "Endless Hall Records"],
                ["Origination", "2026-10-14 09:58"],
                ["Time reference", "10:00:00:00"],
                ["Coding history", "A=PCM,F=96000,W=24,M=stereo"],
                ["iXML", "1.2 KB embedded"],
                ["Title", "Maple Leaf Rag"],
                ["Artist", "Endless Hall Records"],
                ["ISRC", "none"],
                ["Artwork", file.media.channels === 12 ? "none" : "JPEG 1500 × 1500"],
              ].map(([k, v]) => (
                <div key={k} className="contents">
                  <dt className="text-ink-3">{k}</dt>
                  <dd className="tabular truncate text-ink-2">{v}</dd>
                </div>
              ))}
            </dl>
          )}
          {file.media.channels === 12 && (
            <div className="mt-3 border-t border-line pt-2 text-[13px]">
              <Label>ADM · Dolby Atmos</Label>
              <p className="mt-1 text-ink-2">
                7.1.4 bed + 2 objects · programme “Maple Leaf Rag” · Dolby metadata present
              </p>
            </div>
          )}
        </section>
        <Button variant="secondary" size="sm" className="self-start" onClick={openReport}>
          <Icon name="text" size={14} />
          QA report
        </Button>
      </div>
    </div>
  );
}
