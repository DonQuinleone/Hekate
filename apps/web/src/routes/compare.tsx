import {
  type AlignmentPoints,
  formatClock,
  invertAlignment,
  mapTime,
  type QaFinding,
} from "@hekate/shared";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { FollowerSource, StreamSource } from "~/components/compare";
import { Empty } from "~/components/empty";
import { Icon } from "~/components/icons";
import { Kbd } from "~/components/kbd";
import { Page } from "~/components/page";
import { PageHeader } from "~/components/page-header";
import { SeverityDot } from "~/components/qa";
import { Button } from "~/components/ui/button";
import { Select } from "~/components/ui/input";
import { Waveform } from "~/components/waveform";
import { cn } from "~/lib/cn";
import { gainLabel, levelGains } from "~/lib/compare";
import {
  type CompareSide,
  loudnessQuery,
  projectQuery,
  type TrackComparison,
  trackCompareQuery,
  useItemWords,
  useProjectCan,
  useRealign,
} from "~/lib/queries";
import { useAnnounce, useShortcuts } from "~/lib/shortcuts";

type Which = "a" | "b";

/**
 * Two versions of a track side by side (#137): heard in step, one key flipping between them at
 * the same musical position, level-matched; where the audio says the same music sits in each;
 * what the checks found fixed and new; and the earlier one's comments where they fall now.
 */
export function ComparePage({ trackId, a, b }: { trackId: string; a?: number; b?: number }) {
  const navigate = useNavigate();
  const { data, error } = useQuery(trackCompareQuery(trackId, a, b));
  const { data: project } = useQuery({
    ...projectQuery(data?.track.projectId ?? ""),
    enabled: Boolean(data),
  });
  const can = useProjectCan(data?.track.projectId);
  const { words, versionLabel, video } = useItemWords(data?.track.projectId);
  const compareTitle = `Compare ${words.versions}`;
  const realign = useRealign(trackId);
  const [blind, setBlind] = useState(false);
  /** Blind: whether key 1 is B rather than A. */
  const [swapped, setSwapped] = useState(false);
  const [heard, setHeard] = useState<Which>("b");
  const [master, setMaster] = useState<HTMLAudioElement | null>(null);
  const [follower, setFollower] = useState<HTMLAudioElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const loudness = useQueries({
    queries: (data ? [data.a.fileId, data.b.fileId] : []).map((id) => loudnessQuery(id)),
  });
  const gains = levelGains(loudness.map((q) => q.data?.summary?.integrated));
  const points: AlignmentPoints | null = data?.alignment.points ?? null;
  // A's times to B's and back, where the music is known to line up; else the same time.
  const toB = useMemo(
    () => (points ? (t: number) => mapTime(points, t) : (t: number) => t),
    [points],
  );
  const toA = useMemo(() => {
    const back = points ? invertAlignment(points) : null;
    return back ? (t: number) => mapTime(back, t) : (t: number) => t;
  }, [points]);
  // The longer version leads, so all of each can be reached: music only in the other one's
  // span (a new ending, say) is still played by the one that has it.
  const lead: Which = (data?.b.duration ?? 0) > (data?.a.duration ?? 0) ? "b" : "a";
  const other: Which = lead === "a" ? "b" : "a";
  const gainOf = (which: Which) => gains[which === "a" ? 0 : 1] ?? 1;
  const toFollower = lead === "a" ? toB : toA;
  const toLead = lead === "a" ? toA : toB;

  // The master is the lead; what is heard is either it or the other version following it.
  const leadVolume = heard === lead ? gainOf(lead) : 0;
  useEffect(() => {
    if (master) master.volume = leadVolume;
  }, [master, leadVolume]);
  useEffect(() => {
    if (!master) return;
    const on = () => setPlaying(!master.paused);
    const tick = () => setTime(master.currentTime);
    master.addEventListener("play", on);
    master.addEventListener("pause", on);
    master.addEventListener("timeupdate", tick);
    return () => {
      master.removeEventListener("play", on);
      master.removeEventListener("pause", on);
      master.removeEventListener("timeupdate", tick);
    };
  }, [master]);
  // A seek on the follower's waveform moves the lead to the same music; the follower then
  // follows it there.
  useEffect(() => {
    if (!master || !follower) return;
    const seeked = () => {
      const target = toLead(follower.currentTime);
      if (Math.abs(target - master.currentTime) > 0.3) master.currentTime = target;
    };
    follower.addEventListener("seeked", seeked);
    return () => follower.removeEventListener("seeked", seeked);
  }, [master, follower, toLead]);

  const say = useAnnounce();
  const label = (which: Which) =>
    blind ? ((which === "a") !== swapped ? "X" : "Y") : versionLabel(data?.[which].number ?? 0);
  const keyFor = (which: Which) => ((which === "a") !== swapped ? "1" : "2");
  const hear = (which: Which) => {
    setHeard(which);
    say(`Hearing ${label(which)}`);
  };
  const toggle = () => {
    if (!master) return;
    if (master.paused) void master.play().catch(() => undefined);
    else master.pause();
  };
  useShortcuts(
    "compare-versions",
    compareTitle,
    [
      {
        keys: ["1", "2"],
        label: `Hear one ${words.version} or the other`,
        run: (event) => hear((event.key === "1") !== swapped ? "a" : "b"),
      },
      { keys: ["Space"], label: "Play or pause", run: toggle },
    ],
    Boolean(data),
  );

  if (error) {
    return (
      <>
        <PageHeader title={compareTitle} />
        <Page className="gap-6">
          <Empty title="Nothing to compare" text={error.message} />
        </Page>
      </>
    );
  }
  if (!data || !project) return <p className="p-8 text-ink-3">Loading</p>;

  const choose = (which: Which, number: number) =>
    navigate({
      to: "/tracks/$trackId/compare",
      params: { trackId },
      search: {
        a: which === "a" ? number : data.a.number,
        b: which === "b" ? number : data.b.number,
      },
    });
  const startBlind = () => {
    setSwapped(Math.random() < 0.5);
    setBlind(true);
  };
  const reveal = () => {
    setBlind(false);
    setSwapped(false);
  };
  const order: Which[] = swapped ? ["b", "a"] : ["a", "b"];
  const later = data.findings.laterNumber === data.a.number ? "a" : "b";
  const duration = (side: CompareSide) => side.duration ?? 1;
  const mayRealign =
    can("upload") &&
    !project.archivedAt &&
    (data.alignment.status === "poor" ||
      data.alignment.status === "failed" ||
      data.alignment.status === "none");

  return (
    <>
      <PageHeader
        crumbs={[
          { key: "projects", link: <Link to="/projects">Projects</Link> },
          {
            key: "project",
            link: (
              <Link to="/projects/$projectId/files" params={{ projectId: data.track.projectId }}>
                {project.name}
              </Link>
            ),
          },
          {
            key: "track",
            link: (
              <Link to="/tracks/$trackId" params={{ trackId }} search={{ view: "versions" }}>
                {data.track.name}
              </Link>
            ),
          },
        ]}
        title={compareTitle}
        actions={
          <Button
            variant={blind ? "primary" : "secondary"}
            size="sm"
            onClick={blind ? reveal : startBlind}
          >
            <Icon name="eyeOff" size={14} />
            {blind ? "Reveal" : "Blind A/B"}
          </Button>
        }
      />
      <Page className="gap-6">
        <div className="flex flex-wrap items-center gap-3">
          {(["a", "b"] as const).map((which) => (
            <label key={which} className="flex items-center gap-2 text-[13px] text-ink-2">
              <Kbd>{which === "a" ? "1" : "2"}</Kbd>
              <span className="sr-only">
                {which === "a" ? `First ${words.version}` : `Second ${words.version}`}
              </span>
              <Select
                value={data[which].number}
                onChange={(e) => choose(which, Number(e.target.value))}
                className="w-44"
                disabled={blind}
              >
                {data.versions.map((v) => (
                  <option
                    key={v.number}
                    value={v.number}
                    disabled={v.number === data[which === "a" ? "b" : "a"].number}
                  >
                    {blind ? "Hidden" : `${versionLabel(v.number)} · ${v.name}`}
                  </option>
                ))}
              </Select>
            </label>
          ))}
          <AlignmentState comparison={data} />
          {mayRealign && (
            <Button
              variant="ghost"
              size="sm"
              disabled={realign.isPending}
              onClick={() => realign.mutate({ a: data.a.number, b: data.b.number })}
            >
              <Icon name="refresh" size={14} />
              Align again
            </Button>
          )}
        </div>
        {realign.error && <p className="m-0 text-[13px] text-signal">{realign.error.message}</p>}
        <div className="grid gap-6 @5xl/app:grid-cols-[minmax(0,1fr)_280px]">
          <div className="flex min-w-0 flex-col gap-3">
            {order.map((which) => {
              const side = data[which];
              const element = which === lead ? master : follower;
              const on = heard === which;
              return (
                <section
                  key={which}
                  aria-label={label(which)}
                  className={cn(
                    "rounded-panel-lg border p-2 transition-colors",
                    on ? "border-signal/50 bg-signal/[0.04]" : "border-line bg-raised/20",
                  )}
                >
                  <div className="flex items-center gap-2 px-1 pb-1 text-[13px]">
                    <button
                      type="button"
                      aria-pressed={on}
                      aria-label={`Hear ${label(which)}`}
                      onClick={() => hear(which)}
                      className={cn(
                        "flex size-7 cursor-pointer items-center justify-center rounded-full border-0",
                        on ? "bg-signal text-ground" : "bg-raised text-ink",
                      )}
                    >
                      <Kbd>{keyFor(which)}</Kbd>
                    </button>
                    <span className="font-medium text-ink">{label(which)}</span>
                    {!blind && (
                      <span className="min-w-0 truncate text-ink-3">
                        {side.name}
                        {side.notes ? ` · ${side.notes}` : ""}
                      </span>
                    )}
                    <span className="tabular ml-auto shrink-0 text-ink-3">
                      {gainLabel(gainOf(which))}
                    </span>
                  </div>
                  {element ? (
                    <Waveform
                      fileId={side.fileId}
                      media={element}
                      duration={duration(side)}
                      view="combined"
                    />
                  ) : (
                    <div className="flex h-[168px] items-center justify-center rounded-control bg-sunken/40 text-[13px] text-ink-3">
                      {side.failed
                        ? `This ${words.version} could not be prepared to play.`
                        : !side.ready
                          ? `Preparing this ${words.version} to play`
                          : null}
                    </div>
                  )}
                </section>
              );
            })}
            {failed && (
              <p className="m-0 text-[13px] text-signal">
                One of the {words.versions} could not be loaded to play.
              </p>
            )}
            <div className="flex flex-wrap items-center gap-3 px-1 text-[13px] text-ink-3">
              <button
                type="button"
                aria-label={playing ? "Pause" : "Play"}
                onClick={toggle}
                disabled={!master}
                className="flex size-9 cursor-pointer items-center justify-center rounded-full border-0 bg-ink text-ground disabled:opacity-40"
              >
                <Icon name={playing ? "pause" : "play"} size={12} />
              </button>
              <span className="tabular text-[15px] text-ink">{formatClock(time)}</span>
              <span>
                Keys 1 and 2 switch at the same {video ? "moment" : "musical position"}
                {gains.some((g) => g < 1) ? ", level-matched" : ""}.
              </span>
              {blind && (
                <span className="ml-auto text-ink-2">
                  Which is which stays hidden until you reveal.
                </span>
              )}
            </div>
            {data[lead].ready && (
              <StreamSource
                key={data[lead].fileId}
                fileId={data[lead].fileId}
                volume={leadVolume}
                onElement={setMaster}
                onFail={() => setFailed(true)}
              />
            )}
            {master && data[other].ready && (
              <FollowerSource
                key={data[other].fileId}
                fileId={data[other].fileId}
                master={master}
                volume={heard === other ? gainOf(other) : 0}
                follow={toFollower}
                onFail={() => setFailed(true)}
                onElement={setFollower}
              />
            )}
          </div>
          <aside className="flex min-w-0 flex-col gap-5">
            <AlignmentPath comparison={data} label={label} video={video} />
            <Findings
              title={`Fixed in ${label(later)}`}
              findings={data.findings.fixed}
              measured={data.findings.measured}
              none="Nothing fixed."
              fixed
            />
            <Findings
              title={`New in ${label(later)}`}
              findings={data.findings.new}
              measured={data.findings.measured}
              none="Nothing new."
            />
            <section className="flex flex-col gap-1.5">
              <h2 className="label m-0">
                Comments mapped · {data.alignment.status === "ready" ? data.comments.length : 0}
              </h2>
              <span className="text-[12px] text-ink-3">
                {data.alignment.status === "ready"
                  ? `Each comment on ${label("a")} follows the audio to its place on ${label("b")}.`
                  : `Comments stay on their own ${words.versions} until the alignment is good enough.`}
              </span>
              {data.alignment.status === "ready" && data.comments.length > 0 && (
                <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]">
                  {data.comments.map((c) => (
                    <li key={c.id} className="flex min-w-0 items-baseline gap-2">
                      <span className="tabular shrink-0 text-ink-3">
                        {formatClock(c.start)} → {formatClock(c.mapped ?? c.start)}
                      </span>
                      <span className="min-w-0 truncate text-ink-2">{c.body}</span>
                    </li>
                  ))}
                </ul>
              )}
              {!blind && (
                <Link
                  to="/files/$fileId"
                  params={{ fileId: data.b.fileId }}
                  className="text-[13px] text-ink-2 hover:text-ink"
                >
                  Open {label("b")}
                </Link>
              )}
            </section>
          </aside>
        </div>
      </Page>
    </>
  );
}

/** How well the two are known to line up, in a few words. */
function AlignmentState({ comparison }: { comparison: TrackComparison }) {
  const { status, quality } = comparison.alignment;
  const percent = quality === null ? null : Math.round(quality * 100);
  return (
    <span
      role="status"
      className={cn(
        "ml-auto flex items-center gap-2 text-[13px]",
        status === "poor" || status === "failed" ? "text-signal" : "text-ink-3",
      )}
    >
      {status === "aligning" ? (
        <>
          <span className="breathe size-2 rounded-full border border-ink-2" /> Aligning the audio
        </>
      ) : status === "ready" ? (
        <>Aligned by audio · {percent}% confidence</>
      ) : status === "poor" ? (
        <>
          <Icon name="warning" size={14} /> Alignment too poor to map comments ({percent}%)
        </>
      ) : status === "failed" ? (
        <>
          <Icon name="warning" size={14} /> The audio could not be aligned
        </>
      ) : (
        <>Not aligned yet</>
      )}
    </span>
  );
}

/** Where the same music sits in each: a straight line is the same timing. */
function AlignmentPath({
  comparison,
  label,
  video,
}: {
  comparison: TrackComparison;
  label: (which: Which) => string;
  /** A deliverable's cuts (#147): an edit moves the picture and its sound together. */
  video: boolean;
}) {
  const { points } = comparison.alignment;
  const across = comparison.a.duration ?? 1;
  const up = comparison.b.duration ?? 1;
  const line = points
    ?.map(([x, y]) => `${((x / across) * 200).toFixed(1)},${(100 - (y / up) * 100).toFixed(1)}`)
    .join(" ");
  return (
    <section className="flex flex-col gap-2">
      <h2 className="label m-0">Alignment path</h2>
      <svg
        viewBox="0 0 200 100"
        preserveAspectRatio="none"
        className="h-24 w-full rounded-control bg-sunken"
        role="img"
        aria-label={line ? "Alignment path" : "No alignment yet"}
      >
        <line
          x1={0}
          y1={100}
          x2={200}
          y2={0}
          stroke="var(--hk-line-strong)"
          strokeDasharray="3 3"
        />
        {line && (
          <polyline
            points={line}
            fill="none"
            stroke="var(--hk-ink-2)"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      <span className="text-[12px] text-ink-3">
        {label("a")} across, {label("b")} up. A straight line is the same timing; a bend is where an
        edit moved {video ? "the sound" : "the music"}.
      </span>
    </section>
  );
}

function Findings({
  title,
  findings,
  measured,
  none,
  fixed = false,
}: {
  title: string;
  findings: QaFinding[];
  measured: boolean;
  none: string;
  fixed?: boolean;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <h2 className="label m-0">
        {title} · {findings.length}
      </h2>
      {findings.map((f) => (
        <span
          key={`${f.check}-${f.channel}-${f.start}-${f.summary}`}
          className="flex items-start gap-2 text-[13px] text-ink-2"
        >
          <span className="mt-1.5">
            <SeverityDot severity={fixed ? "pass" : f.severity} />
          </span>
          <span className="min-w-0">
            {f.summary}
            {f.start !== null ? ` · ${formatClock(f.start)}` : ""}
          </span>
        </span>
      ))}
      {findings.length === 0 && (
        <span className="text-[12px] text-ink-3">{measured ? none : "Not measured yet."}</span>
      )}
    </section>
  );
}
