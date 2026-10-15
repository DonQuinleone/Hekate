import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Icon } from "~/components/icons";
import { Kbd, Label } from "~/components/label";
import { Page } from "~/components/page";
import { usePageHeader } from "~/components/page-header";
import { usePlayback } from "~/components/player/playback";
import { Waveform } from "~/components/player/waveform";
import { SeverityDot } from "~/components/status";
import { Button } from "~/components/ui/button";
import { Select } from "~/components/ui/input";
import { comments, fileById, findingsFor, primaryFile, trackById, type Version } from "~/data";
import { cn } from "~/lib/cn";
import { formatClock } from "~/lib/format";
import { useViewer } from "~/viewer/context";
import { Refused, useScreenState } from "~/viewer/state-gate";

/** Two versions aligned by their audio: the path, the comments mapped across, what was fixed and what is new. */
export function ComparePage({
  trackId,
  a: aParam,
  b: bParam,
}: {
  trackId: string;
  a?: string;
  b?: string;
}) {
  const viewer = useViewer();
  const state = useScreenState();
  const track = trackById(trackId);
  const versions = track
    ? [...track.versions].filter((v) => v.state === "ready").sort((x, y) => x.number - y.number)
    : [];
  const [aNum, setA] = useState(
    Number(aParam) || versions.at(-2)?.number || versions[0]?.number || 1,
  );
  const [bNum, setB] = useState(Number(bParam) || versions.at(-1)?.number || 1);
  const [blind, setBlind] = useState(false);
  const [side, setSide] = useState<"a" | "b">("b");
  const a = versions.find((v) => v.number === aNum);
  const b = versions.find((v) => v.number === bNum);
  const fa = a ? primaryFile(a) : undefined;
  const fb = b ? primaryFile(b) : undefined;
  const duration = Math.max(fa?.media.duration ?? 1, fb?.media.duration ?? 1);
  const playback = usePlayback(duration, 14.3);
  usePageHeader({
    crumbs: track ? [{ label: track.name, to: `/tracks/${track.id}` }] : [],
    title: "Compare versions",
    actions: (
      <Button variant={blind ? "primary" : "secondary"} onClick={() => setBlind((v) => !v)}>
        <Icon name="eyeOff" size={14} />
        {blind ? "Blind: reveal" : "Blind A/B"}
      </Button>
    ),
    revision: String(blind),
  });
  if (!track || !viewer.canSee(track.projectId) || !viewer.tools(track.projectId).has("compare"))
    return <Refused />;
  if (!a || !b || !fa || !fb)
    return <Refused title="Nothing to compare" text="Two ready versions are needed." />;
  const quality = state === "failed" ? 31 : 94;
  const running = state === "processing";
  const mapped = comments.filter(
    (c) => c.fileId === fa.id && !c.parentId && c.anchor.kind === "time",
  );
  const fixed = findingsFor(fa.id)
    .filter((f) => f.change === "fixed")
    .concat(findingsFor(fb.id).filter((f) => f.change === "fixed"));
  const fresh = findingsFor(fb.id).filter((f) => f.change === "new");
  const label = (v: Version, which: "a" | "b") =>
    blind ? (which === "a" ? "X" : "Y") : `V${v.number}`;
  const pathPoints = Array.from({ length: 40 }, (_, i) => {
    const t = i / 39;
    const warp = state === "failed" ? Math.sin(t * 9) * 0.12 : Math.sin(t * 4) * 0.025;
    return `${(t * 200).toFixed(1)},${((1 - Math.min(1, Math.max(0, t + warp))) * 100).toFixed(1)}`;
  }).join(" ");
  return (
    <Page className="gap-6">
      <div className="flex flex-wrap items-center gap-3">
        {(["a", "b"] as const).map((which) => (
          <label key={which} className="flex items-center gap-2 text-[13px] text-ink-2">
            <Kbd>{which === "a" ? "1" : "2"}</Kbd>
            <Select
              value={which === "a" ? aNum : bNum}
              onChange={(e) =>
                which === "a" ? setA(Number(e.target.value)) : setB(Number(e.target.value))
              }
              className="w-40"
              disabled={blind}
            >
              {versions.map((v) => (
                <option key={v.id} value={v.number}>
                  V{v.number} · {v.variations.find((x) => x.primary)?.name}
                </option>
              ))}
            </Select>
          </label>
        ))}
        <span
          className={cn(
            "ml-auto flex items-center gap-2 text-[13px]",
            quality < 60 ? "text-signal" : "text-ink-3",
          )}
        >
          {running ? (
            <>
              <span className="breathe size-2 rounded-full border border-ink-2" /> Aligning the
              audio
            </>
          ) : quality < 60 ? (
            <>
              <Icon name="warning" size={14} /> Alignment too poor to map comments ({quality}%)
            </>
          ) : (
            <>Aligned by audio · {quality}% confidence</>
          )}
        </span>
      </div>
      <div className="grid gap-6 @5xl/app:grid-cols-[minmax(0,1fr)_260px]">
        <div className="flex min-w-0 flex-col gap-3">
          {(["a", "b"] as const).map((which) => {
            const v = which === "a" ? a : b;
            const f = which === "a" ? fa : fb;
            const on = side === which;
            return (
              <div
                key={which}
                className={cn(
                  "rounded-panel-lg border p-2 transition-colors",
                  on ? "border-signal/50 bg-signal/[0.04]" : "border-line bg-raised/20",
                )}
              >
                <div className="flex items-center gap-2 px-1 pb-1 text-[13px]">
                  <button
                    type="button"
                    onClick={() => setSide(which)}
                    className={cn(
                      "flex size-7 items-center justify-center rounded-full",
                      on ? "bg-signal text-ground" : "bg-raised text-ink",
                    )}
                  >
                    <Icon
                      name={on && playback.playing ? "pause" : "play"}
                      size={10}
                      fill="currentColor"
                      strokeWidth={0}
                    />
                  </button>
                  <span className="font-medium text-ink">{label(v, which)}</span>
                  {!blind && (
                    <span className="text-ink-3">
                      {v.variations.find((x) => x.primary)?.name} · {v.note}
                    </span>
                  )}
                  <span className="tabular ml-auto text-ink-3">
                    level-matched {which === "a" ? "−0.6 dB" : "0.0 dB"}
                  </span>
                </div>
                <Waveform
                  seed={f.seed}
                  duration={duration}
                  channels={f.media.channels ?? 2}
                  playback={playback}
                  split={false}
                  height={150}
                  markers={
                    quality >= 60
                      ? mapped.map((c, i) => ({
                          id: c.id,
                          at:
                            (c.anchor.kind === "time" ? c.anchor.start : 0) +
                            (which === "b" ? 0.4 : 0),
                          number: i + 1,
                        }))
                      : []
                  }
                  findings={findingsFor(f.id)}
                />
              </div>
            );
          })}
          <div className="flex items-center gap-3 px-1 text-[13px] text-ink-3">
            <button
              type="button"
              onClick={playback.toggle}
              className="flex size-9 items-center justify-center rounded-full bg-ink text-ground"
            >
              <Icon
                name={playback.playing ? "pause" : "play"}
                size={12}
                fill="currentColor"
                strokeWidth={0}
              />
            </button>
            <span className="tabular text-[15px] text-ink">{formatClock(playback.time)}</span>
            <span>Keys 1 and 2 switch gaplessly at the same musical position.</span>
            {blind && (
              <span className="ml-auto text-ink-2">Which is which is hidden until you reveal.</span>
            )}
          </div>
        </div>
        <aside className="flex min-w-0 flex-col gap-5">
          <section className="flex flex-col gap-2">
            <Label>Alignment path</Label>
            <svg
              viewBox="0 0 200 100"
              className="h-24 w-full rounded-control bg-sunken"
              role="img"
              aria-label="Alignment path"
            >
              <line
                x1={0}
                y1={100}
                x2={200}
                y2={0}
                stroke="var(--hk-line-strong)"
                strokeDasharray="3 3"
              />
              <polyline
                points={pathPoints}
                fill="none"
                stroke={quality < 60 ? "var(--hk-signal)" : "var(--hk-ink-2)"}
                strokeWidth={1.5}
              />
            </svg>
            <span className="text-[12px] text-ink-3">
              {label(a, "a")} across, {label(b, "b")} up. A straight line is the same timing; the
              bend is the new edit at bar 17.
            </span>
          </section>
          <section className="flex flex-col gap-1.5">
            <Label>
              Fixed in {label(b, "b")} · {fixed.length}
            </Label>
            {fixed.map((f) => (
              <span key={f.id} className="flex items-center gap-2 text-[13px] text-ink-2">
                <SeverityDot severity="pass" />
                {f.check}: {f.summary}
              </span>
            ))}
            {fixed.length === 0 && <span className="text-[12px] text-ink-3">Nothing changed.</span>}
          </section>
          <section className="flex flex-col gap-1.5">
            <Label>
              New in {label(b, "b")} · {fresh.length}
            </Label>
            {fresh.map((f) => (
              <span key={f.id} className="flex items-center gap-2 text-[13px] text-ink-2">
                <SeverityDot severity={f.severity} />
                {f.check}: {f.summary}
              </span>
            ))}
            {fresh.length === 0 && <span className="text-[12px] text-ink-3">Nothing new.</span>}
          </section>
          <section className="flex flex-col gap-1.5">
            <Label>Comments mapped · {quality >= 60 ? mapped.length : 0}</Label>
            <span className="text-[12px] text-ink-3">
              {quality >= 60
                ? `Each anchor on ${label(a, "a")} follows the audio to its place on ${label(b, "b")}; move any by hand from the thread.`
                : "Comments stay on their own versions until the alignment is good enough."}
            </span>
            <Link
              to="/files/$fileId"
              params={{ fileId: fb.id }}
              className="text-[13px] text-ink-2 hover:text-ink"
            >
              Open {label(b, "b")} with the mapped comments
            </Link>
          </section>
        </aside>
      </div>
    </Page>
  );
}

export { fileById };
