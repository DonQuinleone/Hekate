import { Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Rating } from "~/components/comments/takes";
import { Icon } from "~/components/icons";
import { Kbd, Label } from "~/components/label";
import { Page } from "~/components/page";
import { usePageHeader } from "~/components/page-header";
import { PageViewer } from "~/components/pages";
import { usePlayback } from "~/components/player/playback";
import { Waveform } from "~/components/player/waveform";
import { Dot } from "~/components/status";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Input, Select } from "~/components/ui/input";
import {
  fileById,
  type Project,
  projectById,
  sessions,
  type Take,
  takeById,
  takes,
  trackById,
  tracks,
} from "~/data";
import { cn } from "~/lib/cn";
import { formatDuration, formatLongDate, plural } from "~/lib/format";
import { useViewer } from "~/viewer/context";
import { Empty, Refused, useScreenState } from "~/viewer/state-gate";

/* ---------- Import ---------- */

function TakeImportDialog({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<0 | 1>(0);
  const state = useScreenState();
  const tree = [
    {
      session: "Day 3",
      takes: [
        "T27 (10:14:02:00) · 7 files · Maple Leaf Rag, 96%",
        "T28 (10:19:40:00) · 7 files · Maple Leaf Rag, 91%",
        "T29 (10:26:11:00) · 7 files · unplaced, 38%",
      ],
    },
    {
      session: "Day 3, afternoon",
      takes: [
        "T30 (14:02:00:00) · 6 files · Solace, 88%",
        "T31 (14:09:25:00) · 7 files · Solace, 94%",
      ],
    },
  ];
  return (
    <Dialog
      title="Import takes"
      description="Drop every session file. Takes are grouped by take number and timecode, one file per microphone and the summed mix, and matched to tracks by their audio."
      onClose={onClose}
      width="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {step === 1 && <Button variant="secondary">Undo grouping</Button>}
          <Button
            variant="primary"
            onClick={() => (step === 0 ? setStep(1) : onClose())}
            disabled={state === "processing"}
          >
            {step === 0 ? "Propose the tree" : "Import 5 takes"}
          </Button>
        </>
      }
    >
      {step === 0 ? (
        <div className="flex flex-col gap-4">
          <button
            type="button"
            onClick={() => setStep(1)}
            className="flex w-full flex-col items-center gap-2 rounded-panel-lg border border-dashed border-line-strong px-6 py-10 text-center transition-colors hover:border-edge-strong hover:bg-raised/40"
          >
            <Icon name="upload" size={20} className="text-ink-3" />
            <span className="text-[14px] text-ink">Drop the session folder here</span>
            <span className="text-[13px] text-ink-3">34 files, 2.1 GB · resumable</span>
          </button>
          <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
            File-name pattern
            <Input defaultValue="T{take} {mic}.wav" />
            <span className="text-[12px] text-ink-3">
              Used when the files carry no iXML. {"{take}"}, {"{mic}"}, {"{tc}"}, {"{session}"}.
            </span>
          </label>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {state === "processing" && (
            <div className="flex items-center gap-3 text-[13px] text-ink-2">
              <span className="breathe size-2 rounded-full border border-ink-2" /> Matching audio to
              tracks: 1,204 of 3,120 files
              <span className="ml-auto h-1 w-40 overflow-hidden rounded-full bg-raised">
                <span className="block h-full w-[38%] bg-ink-2" />
              </span>
            </div>
          )}
          {tree.map((s) => (
            <div key={s.session} className="flex flex-col gap-1">
              <span className="flex items-center gap-2 text-[14px] text-ink">
                <Icon name="folder" size={14} className="text-ink-3" />
                {s.session}
                <Input
                  defaultValue={s.session}
                  className="ml-auto h-7 w-44 text-[13px]"
                  aria-label="Session name"
                />
              </span>
              <ul className="ml-5 flex flex-col divide-y divide-line rounded-panel border border-line bg-sunken">
                {s.takes.map((t) => (
                  <li
                    key={t}
                    className={cn(
                      "flex items-center gap-3 px-3 py-1.5 text-[13px]",
                      t.includes("unplaced") ? "text-signal" : "text-ink-2",
                    )}
                  >
                    <Icon name="take" size={13} />
                    <span className="flex-1">{t}</span>
                    {t.includes("unplaced") ? (
                      <Select defaultValue="" className="h-7 w-40 text-[12px]">
                        <option value="">Choose a track</option>
                        {tracks
                          .filter((x) => x.projectId === "proj-joplin")
                          .map((x) => (
                            <option key={x.id} value={x.id}>
                              {x.name}
                            </option>
                          ))}
                      </Select>
                    ) : (
                      <button type="button" className="text-ink-3 hover:text-ink">
                        Fix
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <p className="text-[12px] text-ink-3">
            1 file left unplaced: "Room tone.wav" has no take number and matches nothing. It will
            land in the session's folder.
          </p>
        </div>
      )}
    </Dialog>
  );
}

/* ---------- Sessions (project tab) ---------- */

export function SessionsView({ project }: { project: Project }) {
  const viewer = useViewer();
  const [importing, setImporting] = useState(false);
  const state = useScreenState();
  const list = sessions.filter((s) => s.projectId === project.id);
  const canUpload = viewer.can(project.id, "upload");
  if (state === "empty" || list.length === 0)
    return (
      <>
        <Empty
          title="No sessions yet"
          text="Import a day's recordings: every take, one file per microphone, matched to the tracks by their audio."
          action={
            canUpload ? (
              <Button variant="primary" onClick={() => setImporting(true)}>
                Import takes
              </Button>
            ) : undefined
          }
        />
        {importing && <TakeImportDialog onClose={() => setImporting(false)} />}
      </>
    );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Label>Sessions · {list.length}</Label>
        <span className="ml-auto flex gap-1">
          <Button variant="ghost" size="md" asChild>
            <Link
              to="/projects/$projectId/$view"
              params={{ projectId: project.id, view: "coverage" }}
            >
              Coverage
            </Link>
          </Button>
          {canUpload && (
            <Button variant="secondary" size="md" onClick={() => setImporting(true)}>
              <Icon name="upload" size={14} />
              Import takes
            </Button>
          )}
        </span>
      </div>
      <ul className="-mx-2 flex flex-col">
        {list.map((s) => {
          const its = s.takeIds.map(takeById).filter((t): t is Take => Boolean(t));
          return (
            <li key={s.id}>
              <Link
                to="/sessions/$sessionId"
                params={{ sessionId: s.id }}
                className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3.5 rounded-panel px-2 py-2.5 transition-colors hover:bg-raised/60 @3xl/app:grid-cols-[auto_minmax(0,1fr)_160px_120px_100px]"
              >
                <span className="flex size-9 items-center justify-center rounded-panel bg-raised text-ink-2">
                  <Icon name="mic" size={16} />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-[14px] font-medium text-ink">{s.name}</span>
                  <span className="block truncate text-[13px] text-ink-3">
                    {formatLongDate(s.date)} · {s.venue}
                  </span>
                </span>
                <span className="hidden text-[13px] text-ink-3 @3xl/app:block">
                  {plural(its.length, "take")} · {its.filter((t) => t.starred).length} starred
                </span>
                <span className="hidden text-[13px] text-ink-3 @3xl/app:block">
                  {[...new Set(its.map((t) => t.trackId).filter(Boolean))].length} tracks
                </span>
                <span className="tabular text-[13px] text-ink-3">
                  {formatDuration(its.reduce((n, t) => n + t.duration, 0))}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
      {importing && <TakeImportDialog onClose={() => setImporting(false)} />}
    </div>
  );
}

/* ---------- Session ---------- */

export function SessionPage({ sessionId }: { sessionId: string }) {
  const viewer = useViewer();
  const session = sessions.find((s) => s.id === sessionId);
  const project = session ? projectById(session.projectId) : undefined;
  const allowed =
    session && project && viewer.canSee(project.id) && viewer.tools(project.id).has("takes");
  usePageHeader({
    crumbs: project
      ? [
          { label: project.name, to: `/projects/${project.id}` },
          { label: "Sessions", to: `/projects/${project.id}/sessions` },
        ]
      : [],
    title: session?.name ?? "Not found",
    actions: allowed ? <Button variant="secondary">Export CSV</Button> : undefined,
  });
  if (!session || !project || !allowed) return <Refused />;
  const list = session.takeIds.map(takeById).filter((t): t is Take => Boolean(t));
  return (
    <Page className="gap-5">
      <p className="text-[14px] text-ink-2">
        {formatLongDate(session.date)} · {session.venue} · {plural(list.length, "take")}
      </p>
      <div className="scroll-quiet -mx-4 overflow-x-auto px-4 @3xl/app:mx-0 @3xl/app:px-0">
        <table className="w-full min-w-[900px] border-collapse text-[13px]">
          <thead>
            <tr className="text-left">
              {[
                "Take",
                "Rating",
                "Track",
                "Coverage",
                "Notes",
                "Timecode",
                "Mics",
                "Used in",
                "",
              ].map((h) => (
                <th key={h} className="px-2 py-2 font-normal">
                  <Label>{h}</Label>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.map((t) => (
              <tr key={t.id} className="border-t border-line transition-colors hover:bg-raised/40">
                <td className="px-2 py-2">
                  <Link
                    to="/takes/$takeId"
                    params={{ takeId: t.id }}
                    className="tabular flex items-center gap-1.5 font-medium text-ink hover:text-signal"
                  >
                    {t.starred && (
                      <Icon name="star" size={12} className="text-signal" fill="currentColor" />
                    )}
                    T{t.number}
                    {t.lifecycle === "aborted" && (
                      <span className="text-[12px] font-normal text-ink-3">aborted</span>
                    )}
                    {t.falseStarts > 0 && (
                      <span className="text-[12px] font-normal text-ink-3">
                        {t.falseStarts} false {t.falseStarts === 1 ? "start" : "starts"}
                      </span>
                    )}
                  </Link>
                </td>
                <td className="px-2 py-2">
                  <Rating value={t.rating} />
                </td>
                <td className="px-2 py-2 text-ink-2">
                  {t.trackId ? (
                    trackById(t.trackId)?.name
                  ) : (
                    <span className="text-ink-3">unplaced</span>
                  )}
                </td>
                <td className="tabular px-2 py-2 text-ink-2">
                  {t.coverage ? (
                    `p. ${t.coverage.page} · bars ${t.coverage.barFrom}–${t.coverage.barTo}`
                  ) : (
                    <span className="text-ink-3">none</span>
                  )}
                </td>
                <td className="max-w-[260px] truncate px-2 py-2 text-ink-2">{t.notes}</td>
                <td className="tabular px-2 py-2 text-ink-3">
                  {t.timecodeIn} – {t.timecodeOut?.slice(3)}
                </td>
                <td className="tabular px-2 py-2 text-ink-3">{t.files.length - 1} + mix</td>
                <td className="tabular px-2 py-2 text-ink-3">
                  {t.usedIn
                    ?.map((u) => `V${u.versionNumber} bars ${u.barFrom}–${u.barTo}`)
                    .join(", ")}
                </td>
                <td className="px-2 py-2 text-right">
                  <span className="tabular text-ink-3">{formatDuration(t.duration)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Page>
  );
}

/* ---------- Take ---------- */

export function TakePage({ takeId }: { takeId: string }) {
  const viewer = useViewer();
  const navigate = useNavigate();
  const take = takeById(takeId);
  const session = take ? sessions.find((s) => s.id === take.sessionId) : undefined;
  const project = session ? projectById(session.projectId) : undefined;
  const track = take?.trackId ? trackById(take.trackId) : undefined;
  const allowed =
    take && project && viewer.canSee(project.id) && viewer.tools(project.id).has("takes");
  const playback = usePlayback(take?.duration ?? 1, 0);
  const [muted, setMuted] = useState<Set<number>>(new Set());
  const [solo, setSolo] = useState<number | null>(null);
  const [page, setPage] = useState(take?.coverage?.page ?? 1);
  const [sharing, setSharing] = useState(false);
  const siblings = useMemo(
    () =>
      take && session
        ? session.takeIds
            .map(takeById)
            .filter((t): t is Take => Boolean(t) && t?.trackId === take.trackId)
        : [],
    [take, session],
  );
  usePageHeader({
    crumbs:
      project && session
        ? [
            { label: project.name, to: `/projects/${project.id}` },
            { label: session.name, to: `/sessions/${session.id}` },
          ]
        : [],
    title: take ? `Take ${take.number}` : "Not found",
    actions: allowed ? (
      <Button variant="secondary" onClick={() => setSharing(true)}>
        <Icon name="comment" size={14} />
        Share to a comment
      </Button>
    ) : undefined,
  });
  if (!take || !project || !session || !allowed) return <Refused />;
  const score = track?.scoreFileId ? fileById(track.scoreFileId) : undefined;
  const lanes = take.files.length;
  return (
    <div className="fade-in flex h-full min-h-0 flex-col @3xl/app:flex-row">
      <div className="scroll-quiet flex min-w-0 flex-1 flex-col gap-4 overflow-auto p-4 @3xl/app:p-6">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[13px] text-ink-3">
          <Rating value={take.rating} />
          {take.starred && (
            <span className="flex items-center gap-1 text-signal">
              <Icon name="star" size={12} fill="currentColor" />
              starred
            </span>
          )}
          {track && (
            <Link
              to="/tracks/$trackId"
              params={{ trackId: track.id }}
              className="text-ink-2 hover:text-ink"
            >
              {track.name}
            </Link>
          )}
          {take.coverage && (
            <span className="tabular">
              p. {take.coverage.page} · bars {take.coverage.barFrom}–{take.coverage.barTo}
            </span>
          )}
          <span className="tabular">
            {take.timecodeIn} – {take.timecodeOut}
          </span>
          {take.usedIn && take.usedIn.length > 0 && (
            <span className="flex items-center gap-1.5 text-ink-2">
              <Dot state="approved" />
              in V{take.usedIn[0]?.versionNumber}
            </span>
          )}
          <span className="ml-auto flex gap-1">
            {siblings.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => navigate({ to: "/takes/$takeId", params: { takeId: t.id } })}
                className={cn(
                  "tabular h-7 rounded-control px-2 text-[12px] transition-colors",
                  t.id === take.id ? "bg-raised text-ink shadow-1" : "text-ink-3 hover:text-ink",
                )}
              >
                T{t.number}
              </button>
            ))}
          </span>
        </div>
        <div className="flex gap-2">
          <div className="flex w-28 shrink-0 flex-col justify-around py-1">
            {take.files.map((f, i) => (
              <div key={f.name} className="flex items-center gap-1 text-[12px]">
                <button
                  type="button"
                  aria-pressed={solo === i}
                  onClick={() => setSolo(solo === i ? null : i)}
                  className={cn(
                    "size-5 rounded-chip border text-[10px]",
                    solo === i
                      ? "border-signal bg-signal text-ground"
                      : "border-line text-ink-3 hover:text-ink",
                  )}
                >
                  S
                </button>
                <button
                  type="button"
                  aria-pressed={muted.has(i)}
                  onClick={() =>
                    setMuted((m) => {
                      const n = new Set(m);
                      if (n.has(i)) n.delete(i);
                      else n.add(i);
                      return n;
                    })
                  }
                  className={cn(
                    "size-5 rounded-chip border text-[10px]",
                    muted.has(i)
                      ? "border-ink-3 bg-raised text-ink"
                      : "border-line text-ink-3 hover:text-ink",
                  )}
                >
                  M
                </button>
                <span className="truncate text-ink-3">{f.channel}</span>
              </div>
            ))}
          </div>
          <div className="min-w-0 flex-1">
            <Waveform
              seed={take.seed}
              duration={take.duration}
              channels={lanes}
              playback={playback}
              split
              markers={[]}
              height={Math.max(220, lanes * 40)}
              muted={muted}
              solo={solo}
            />
          </div>
        </div>
        <div className="flex items-center gap-3 text-[13px] text-ink-3">
          <button
            type="button"
            onClick={playback.toggle}
            className="flex size-10 items-center justify-center rounded-full bg-ink text-ground shadow-2"
          >
            <Icon
              name={playback.playing ? "pause" : "play"}
              size={14}
              fill="currentColor"
              strokeWidth={0}
            />
          </button>
          <span className="tabular text-[15px] text-ink">
            {formatDuration(playback.time)}{" "}
            <span className="text-ink-3">/ {formatDuration(take.duration)}</span>
          </span>
          <button
            type="button"
            onClick={() => {
              playback.setLoop({ start: 0, end: take.duration });
              playback.setLooping(!playback.looping);
            }}
            className={cn(
              "flex h-8 items-center gap-1.5 rounded-full px-3",
              playback.looping ? "bg-signal/15 text-signal" : "hover:bg-raised hover:text-ink",
            )}
          >
            <Icon name="loop" />
            Loop
          </button>
          <span>
            Solo and mute the microphones; the summed mix is the last lane. <Kbd>1</Kbd>–
            <Kbd>{String(siblings.length)}</Kbd> switch takes.
          </span>
        </div>
        <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
          Notes
          <Input defaultValue={take.notes} />
        </label>
      </div>
      {score && take.coverage && (
        <aside className="flex w-full shrink-0 flex-col border-t border-line @3xl/app:w-[380px] @3xl/app:border-t-0 @3xl/app:border-l">
          <div className="flex h-11 items-center gap-2 px-4 text-[13px]">
            <span className="font-medium text-ink">Its place in the score</span>
            <span className="text-ink-3">
              bars {take.coverage.barFrom}–{take.coverage.barTo}
            </span>
          </div>
          <div className="min-h-0 flex-1 px-4 pb-4">
            <PageViewer
              file={score}
              page={page}
              onPage={setPage}
              markers={[]}
              selected={null}
              onSelect={() => {}}
              canDraw={false}
              compact
            />
          </div>
        </aside>
      )}
      {sharing && (
        <Dialog
          title="Share this take to a comment"
          description="The reviewers on that thread hear exactly this take, and nothing else from the sessions."
          onClose={() => setSharing(false)}
          width="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setSharing(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => setSharing(false)}>
                Share
              </Button>
            </>
          }
        >
          <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
            Thread
            <Select defaultValue="c-3">
              <option value="c-3">#3 · Can we tighten the edit into bar 17?</option>
              <option value="c-2">#2 · Lovely rubato into the trio</option>
              <option value="new">A new comment on the current version</option>
            </Select>
          </label>
          <label className="mt-3 flex flex-col gap-1.5 text-[13px] text-ink-2">
            Audition
            <Select defaultValue="bar">
              <option value="bar">At the comment's bar, looped and level-matched</option>
              <option value="whole">The whole take</option>
            </Select>
          </label>
        </Dialog>
      )}
    </div>
  );
}

/* ---------- Coverage and edit decisions ---------- */

export function CoverageView({ project }: { project: Project }) {
  const [trackId, setTrackId] = useState(
    tracks.find((t) => t.projectId === project.id && takes.some((x) => x.trackId === t.id))?.id ??
      "",
  );
  const [mode, setMode] = useState<"coverage" | "edl">("coverage");
  const state = useScreenState();
  const its = takes.filter((t) => t.trackId === trackId && t.coverage);
  const track = trackById(trackId);
  const bars = 100;
  const latest = track?.versions.at(-1);
  const used = its.flatMap((t) => (t.usedIn ?? []).map((u) => ({ take: t, ...u })));
  const covered = new Array(bars).fill(false);
  for (const t of its)
    for (let b = (t.coverage?.barFrom ?? 1) - 1; b < (t.coverage?.barTo ?? 0); b++)
      covered[b] = true;
  const gaps = covered.map((c, i) => (c ? null : i + 1)).filter((x): x is number => x !== null);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={trackId} onChange={(e) => setTrackId(e.target.value)} className="w-56">
          {tracks
            .filter((t) => t.projectId === project.id)
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
        </Select>
        <div
          role="radiogroup"
          className="flex rounded-control border border-line bg-ground/60 p-0.5"
        >
          {(["coverage", "edl"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                "h-7 rounded-[4px] px-2.5 text-[13px]",
                mode === m ? "bg-overlay text-ink shadow-2" : "text-ink-3 hover:text-ink",
              )}
            >
              {m === "coverage" ? "Take coverage" : "Edit decisions"}
            </button>
          ))}
        </div>
        <span className="ml-auto text-[13px] text-ink-3">
          {mode === "coverage"
            ? gaps.length > 0
              ? `${gaps.length} bars uncovered`
              : "Every bar is covered"
            : latest?.editDecisionList
              ? `From the EDL of V${latest.number}`
              : "No EDL imported: hand-overs cannot be checked"}
        </span>
      </div>
      {state === "empty" || its.length === 0 ? (
        <Empty
          title="No coverage entered"
          text="Takes get a page and a bar range from the take log, or by hand on the take."
        />
      ) : (
        <div className="scroll-quiet overflow-x-auto rounded-panel-lg border border-line bg-sunken p-3">
          <svg
            width={Math.max(800, bars * 9 + 120)}
            height={(mode === "coverage" ? its.length : used.length + 1) * 22 + 40}
            role="img"
            aria-label={mode === "coverage" ? "Take coverage" : "Edit decisions"}
          >
            {Array.from({ length: bars / 10 + 1 }, (_, i) => (
              <g key={String(i)}>
                <line
                  x1={120 + i * 90}
                  x2={120 + i * 90}
                  y1={0}
                  y2={1000}
                  stroke="var(--hk-line)"
                />
                <text
                  x={120 + i * 90}
                  y={12}
                  fill="var(--hk-ink-3)"
                  fontSize={10}
                  fontFamily="var(--hk-font-sans)"
                >
                  bar {i * 10 + 1}
                </text>
              </g>
            ))}
            {mode === "coverage"
              ? its.map((t, i) => (
                  <g key={t.id} transform={`translate(0, ${24 + i * 22})`}>
                    <text
                      x={0}
                      y={13}
                      fill="var(--hk-ink-2)"
                      fontSize={12}
                      fontFamily="var(--hk-font-sans)"
                    >
                      T{t.number} · {"●".repeat(t.rating)}
                    </text>
                    <rect
                      x={120 + ((t.coverage?.barFrom ?? 1) - 1) * 9}
                      y={2}
                      width={((t.coverage?.barTo ?? 1) - (t.coverage?.barFrom ?? 1) + 1) * 9}
                      height={14}
                      rx={3}
                      fill={t.usedIn?.length ? "var(--hk-ink)" : "var(--hk-ink-3)"}
                      opacity={t.usedIn?.length ? 0.9 : 0.5}
                    />
                  </g>
                ))
              : used.map((u, i) => (
                  <g key={`${u.take.id}-${String(i)}`} transform={`translate(0, ${24 + i * 22})`}>
                    <text
                      x={0}
                      y={13}
                      fill="var(--hk-ink-2)"
                      fontSize={12}
                      fontFamily="var(--hk-font-sans)"
                    >
                      T{u.take.number}
                    </text>
                    <rect
                      x={120 + (u.barFrom - 1) * 9}
                      y={2}
                      width={(u.barTo - u.barFrom + 1) * 9}
                      height={14}
                      rx={3}
                      fill="var(--hk-signal)"
                      opacity={0.85}
                    />
                    {state === "failed" && i === 1 && (
                      <text
                        x={120 + (u.barTo + 1) * 9}
                        y={13}
                        fill="var(--hk-signal)"
                        fontSize={11}
                        fontFamily="var(--hk-font-sans)"
                      >
                        hand-over does not match the take
                      </text>
                    )}
                  </g>
                ))}
            {mode === "coverage" &&
              gaps.length > 0 &&
              gaps.map((g) => (
                <rect
                  key={g}
                  x={120 + (g - 1) * 9}
                  y={20}
                  width={9}
                  height={its.length * 22 + 4}
                  fill="var(--hk-signal)"
                  opacity={0.08}
                />
              ))}
          </svg>
        </div>
      )}
      {mode === "edl" && used.length > 0 && (
        // Each edit in the version's order: the take it comes from and its bars, and what the
        // list names that is no take of this track.
        <ol
          aria-label="Edit decisions"
          className="flex flex-col rounded-panel-lg border border-line text-[13px]"
        >
          {[...used]
            .sort((a, b) => a.barFrom - b.barFrom)
            .map((u, i) => (
              <li
                key={`${u.take.id}-${String(i)}`}
                className="flex gap-4 border-b border-line px-4 py-2 last:border-b-0"
              >
                <span className="tabular w-10 font-medium text-ink">T{u.take.number}</span>
                <span className="text-ink-3">
                  bars {u.barFrom} to {u.barTo}
                </span>
              </li>
            ))}
          <li className="flex gap-4 px-4 py-2">
            <span className="w-10" />
            <span className="text-ink-3">Pick-up, bar 17.wav · not a take of this track</span>
          </li>
        </ol>
      )}
      {mode === "coverage" && gaps.length > 0 && (
        <p className="text-[13px] text-ink-3">
          Proposed: T{its[0]?.number} covers bars {gaps[0]}–{gaps.at(-1)} by its audio.{" "}
          <button type="button" className="text-ink-2 hover:text-ink">
            Accept
          </button>
        </p>
      )}
    </div>
  );
}
