import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { Avatar } from "~/components/avatar";
import { DeferDialog } from "~/components/comments/defer-dialog";
import { Icon } from "~/components/icons";
import { Kbd, Label } from "~/components/label";
import { usePageHeader } from "~/components/page-header";
import { usePlayback } from "~/components/player/playback";
import { Waveform } from "~/components/player/waveform";
import { Button } from "~/components/ui/button";
import { Select } from "~/components/ui/input";
import {
  type Comment,
  categories,
  comments,
  type File,
  people,
  personById,
  projectById,
  variantOf,
  workflows,
} from "~/data";
import { cn } from "~/lib/cn";
import { inField } from "~/lib/dom";
import { ago, formatAnchor, formatReference } from "~/lib/format";
import { useViewer } from "~/viewer/context";
import { Empty, Refused, useScreenState } from "~/viewer/state-gate";

type Decision = {
  categoryId?: string;
  deferred?: string;
  assigneeId?: string;
  resolved?: boolean;
  skipped?: boolean;
};

/** The queue of a version's open comments, one at a time, with the passage playing and single keys for each decision. */
export function TriagePage({ file }: { file: File }) {
  const _viewer = useViewer();
  const navigate = useNavigate();
  const state = useScreenState();
  const project = projectById(file.projectId);
  const inTrack = variantOf(file.id);
  const workflow = workflows.find((w) => w.id === project?.workflowId);
  const queue = useMemo(
    () =>
      comments
        .filter((c) => c.fileId === file.id && !c.parentId && !c.resolved)
        .sort(
          (a, b) =>
            (a.anchor.kind === "time" ? a.anchor.start : 9e9) -
            (b.anchor.kind === "time" ? b.anchor.start : 9e9),
        ),
    [file.id],
  );
  const [index, setIndex] = useState(0);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assigning, setAssigning] = useState(false);
  const [deferring, setDeferring] = useState(false);
  const [finished, setFinished] = useState(false);
  const current = queue[index];
  const playback = usePlayback(
    file.media.duration,
    current?.anchor.kind === "time" ? current.anchor.start : 0,
  );
  const done = queue.filter((c) => decisions[c.id] && !decisions[c.id]?.skipped).length;

  usePageHeader({
    crumbs: [
      ...(project ? [{ label: project.name, to: `/projects/${project.id}` }] : []),
      ...(inTrack ? [{ label: inTrack.track.name, to: `/tracks/${inTrack.track.id}` }] : []),
    ],
    title: "Triage",
    actions: (
      <>
        <span className="tabular text-[13px] text-ink-3">
          {done} of {queue.length}
        </span>
        <Button variant="secondary" onClick={() => setFinished(true)}>
          Done
        </Button>
      </>
    ),
    revision: String(done),
  });

  const decide = (patch: Decision) => {
    if (!current) return;
    const ids = selected.size > 0 ? [...selected] : [current.id];
    setDecisions((d) =>
      Object.fromEntries([...Object.entries(d), ...ids.map((id) => [id, { ...d[id], ...patch }])]),
    );
    setSelected(new Set());
    const marked = new Set([...Object.keys(decisions), ...ids]);
    const next = queue.findIndex((c, i) => i > index && !marked.has(c.id));
    const any = next >= 0 ? next : queue.findIndex((c) => !marked.has(c.id));
    if (any < 0) setFinished(true);
    else setIndex(any);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: the loop follows the current comment only.
  useEffect(() => {
    if (!current) return;
    const at = current.anchor.kind === "time" ? current.anchor.start : 0;
    const end = current.anchor.kind === "time" && current.anchor.end ? current.anchor.end : at + 4;
    playback.setLoop({ start: Math.max(0, at - 1), end: end + 1 });
    playback.setLooping(true);
    playback.seek(Math.max(0, at - 1));
  }, [current?.id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (inField(e) || e.metaKey || e.ctrlKey || finished || assigning || deferring) return;
      const n = Number(e.key);
      if (n >= 1 && n <= categories.length) decide({ categoryId: categories[n - 1]?.id });
      // j, k and l stay with the player, as everywhere else.
      else if (e.key === "d") setDeferring(true);
      else if (e.key === "r") decide({ resolved: true });
      else if (e.key === "s") decide({ skipped: true });
      else if (e.key === "a") setAssigning(true);
      else if (e.key === "x" && current)
        setSelected((s) => {
          const n = new Set(s);
          if (n.has(current.id)) n.delete(current.id);
          else n.add(current.id);
          return n;
        });
      else if (e.key === "ArrowDown") setIndex((i) => Math.min(queue.length - 1, i + 1));
      else if (e.key === "ArrowUp") setIndex((i) => Math.max(0, i - 1));
      else if (e.key === " ") {
        e.preventDefault();
        playback.toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!project) return <Refused />;
  if (queue.length === 0 || state === "empty")
    return (
      <div className="p-8">
        <Empty
          title="Nothing to triage"
          text="Every open comment on this version has been categorised, deferred, assigned or resolved."
          action={
            <Button variant="secondary" asChild>
              <Link to="/files/$fileId" params={{ fileId: file.id }}>
                Back to the recording
              </Link>
            </Button>
          }
        />
      </div>
    );
  if (finished)
    return (
      <TriageSummary
        queue={queue}
        decisions={decisions}
        onBack={() => setFinished(false)}
        onDone={() => navigate({ to: "/files/$fileId", params: { fileId: file.id } })}
      />
    );
  const returning = comments.filter(
    (c) => c.fileId === file.id && c.deferredToStage && !c.resolved,
  );
  const key = (k: string, label: string, onClick: () => void, on = false) => (
    <button
      key={k + label}
      type="button"
      onClick={onClick}
      className={cn(
        "flex h-9 items-center gap-2 rounded-control border px-2.5 text-[13px] transition-colors",
        on
          ? "border-signal/60 bg-signal/10 text-ink"
          : "border-line bg-raised/40 text-ink-2 hover:border-edge hover:text-ink",
      )}
    >
      <Kbd>{k}</Kbd>
      {label}
    </button>
  );
  return (
    <div className="fade-in flex h-full min-h-0 flex-col @3xl/app:flex-row">
      <aside className="scroll-quiet flex w-full shrink-0 flex-col overflow-auto border-b border-line @3xl/app:w-[300px] @3xl/app:border-r @3xl/app:border-b-0">
        <div className="flex h-11 shrink-0 items-center gap-2 px-3">
          <Label>Queue · {queue.length}</Label>
          {selected.size > 0 && (
            <span className="ml-auto text-[12px] text-signal">{selected.size} selected</span>
          )}
        </div>
        <ul className="flex flex-col px-1.5 pb-2">
          {queue.map((c, i) => {
            const d = decisions[c.id];
            return (
              <li key={c.id}>
                <div
                  className={cn(
                    "flex items-start gap-2 rounded-panel px-2 py-2 transition-colors",
                    i === index ? "bg-raised shadow-1" : "hover:bg-raised/50",
                    d && !d.skipped && "opacity-50",
                  )}
                >
                  <input
                    type="checkbox"
                    aria-label={`Select comment ${i + 1}`}
                    checked={selected.has(c.id)}
                    onChange={(e) =>
                      setSelected((s) => {
                        const n = new Set(s);
                        if (e.target.checked) n.add(c.id);
                        else n.delete(c.id);
                        return n;
                      })
                    }
                    className="mt-1"
                  />
                  <button
                    type="button"
                    onClick={() => setIndex(i)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="flex items-center gap-2 text-[12px] text-ink-3">
                      <span className="tabular">
                        {c.anchor.kind === "time" ? formatAnchor(c.anchor) : "whole"}
                      </span>
                      <span className="truncate">{personById(c.authorId).name.split(" ")[0]}</span>
                      {d?.categoryId && (
                        <span className="ml-auto text-ink-2">
                          {categories.find((x) => x.id === d.categoryId)?.name}
                        </span>
                      )}
                      {d?.deferred && <span className="ml-auto text-ink-2">deferred</span>}
                      {d?.resolved && <span className="ml-auto text-ink-2">resolved</span>}
                    </span>
                    <span className="line-clamp-2 text-[13px] text-ink">{c.body}</span>
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </aside>
      <div className="scroll-quiet flex min-h-0 min-w-0 flex-1 flex-col gap-5 overflow-auto p-4 @3xl/app:p-6">
        {current && (
          <>
            <div className="flex items-center gap-3">
              <Avatar personId={current.authorId} size={28} />
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-medium text-ink">
                  {personById(current.authorId).name}
                </div>
                <div className="text-[12px] text-ink-3">{ago(current.createdAt)}</div>
              </div>
              <span className="tabular text-[13px] text-ink-3">
                {index + 1} of {queue.length}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {current.anchor.kind !== "whole" && (
                <span className="tabular rounded-chip bg-signal/15 px-1.5 text-[12px] leading-5 font-medium text-signal">
                  {formatAnchor(current.anchor)}
                </span>
              )}
              {current.reference && (
                <span className="rounded-chip bg-raised px-1.5 text-[12px] leading-5 text-ink-2">
                  {formatReference(current.reference, project.references)}
                </span>
              )}
              {current.channel && (
                <span className="rounded-chip bg-raised px-1.5 text-[12px] leading-5 text-ink-3">
                  {current.channel}
                </span>
              )}
            </div>
            <p className="max-w-[640px] text-[18px] leading-[28px] text-ink">{current.body}</p>
            {comments
              .filter((r) => r.parentId === current.id)
              .map((r) => (
                <p key={r.id} className="flex gap-2 text-[14px] text-ink-2">
                  <Avatar personId={r.authorId} size={18} className="mt-0.5" />
                  <span>
                    <span className="text-ink">{personById(r.authorId).name}</span> {r.body}
                  </span>
                </p>
              ))}
            <div className="rounded-panel bg-sunken/60 p-2">
              <Waveform
                seed={file.seed}
                duration={file.media.duration}
                channels={file.media.channels ?? 2}
                playback={playback}
                split={false}
                markers={[]}
                height={120}
              />
              <div className="mt-1 flex items-center gap-2 px-1 text-[12px] text-ink-3">
                <button
                  type="button"
                  onClick={playback.toggle}
                  className="flex size-7 items-center justify-center rounded-full bg-ink text-ground"
                >
                  <Icon
                    name={playback.playing ? "pause" : "play"}
                    size={10}
                    fill="currentColor"
                    strokeWidth={0}
                  />
                </button>
                Looping the passage with a second either side · <Kbd>Space</Kbd>
              </div>
            </div>
            <div className="flex flex-col gap-3">
              <Label>Category</Label>
              <div className="flex flex-wrap gap-1.5">
                {categories.map((c, i) =>
                  key(
                    String(i + 1),
                    c.name,
                    () => decide({ categoryId: c.id }),
                    decisions[current.id]?.categoryId === c.id,
                  ),
                )}
              </div>
              <Label>Then</Label>
              <div className="flex flex-wrap gap-1.5">
                {key("D", "Defer to a stage…", () => setDeferring(true))}
                {key("A", "Assign…", () => setAssigning(true))}
                {key("R", "Resolve", () => decide({ resolved: true }))}
                {key("S", "Skip", () => decide({ skipped: true }))}
              </div>
              {deferring && (
                <DeferDialog
                  project={project}
                  trackId={inTrack?.track.id ?? null}
                  canBuild
                  onDefer={(stage) => {
                    decide({ deferred: stage });
                    setDeferring(false);
                  }}
                  onClose={() => setDeferring(false)}
                />
              )}
              {assigning && (
                <div className="rise-in flex items-center gap-2">
                  <Select
                    autoFocus
                    defaultValue=""
                    className="w-56"
                    onChange={(e) => {
                      if (e.target.value) decide({ assigneeId: e.target.value });
                      setAssigning(false);
                    }}
                  >
                    <option value="">Assign to…</option>
                    {people.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </Select>
                  <Button variant="ghost" size="sm" onClick={() => setAssigning(false)}>
                    Cancel
                  </Button>
                </div>
              )}
              <p className="text-[12px] text-ink-3">
                <Kbd>↑</Kbd> <Kbd>↓</Kbd> move · <Kbd>X</Kbd> ticks · a key acts on every ticked
                comment
              </p>
            </div>
          </>
        )}
      </div>
      <aside className="scroll-quiet hidden w-[260px] shrink-0 flex-col gap-4 overflow-auto border-l border-line p-4 @5xl/app:flex">
        <Label>Returns when a stage starts</Label>
        {(workflow?.stages ?? [])
          .filter((s) => s.kind === "task")
          .map((s) => {
            const list = [
              ...returning.filter((c) => c.deferredToStage === s.name),
              ...queue.filter(
                (c) => decisions[c.id]?.deferred && decisions[c.id]?.deferred === s.name,
              ),
            ];
            return (
              <div key={s.id} className="flex flex-col gap-1">
                <span className="text-[13px] text-ink">
                  {s.name}
                  <span className="tabular ml-2 text-ink-3">{list.length}</span>
                </span>
                {list.map((c) => (
                  <span key={c.id} className="truncate text-[12px] text-ink-3">
                    {c.body}
                  </span>
                ))}
                {list.length === 0 && (
                  <span className="text-[12px] text-ink-3">Nothing deferred.</span>
                )}
              </div>
            );
          })}
        {inTrack && (
          <>
            <Label className="mt-2">Goes on to V{inTrack.version.number + 1}</Label>
            <span className="text-[12px] text-ink-3">
              {queue.filter((c) => !decisions[c.id]?.resolved).length} open threads, offered for
              carrying when the next version is made.
            </span>
          </>
        )}
      </aside>
    </div>
  );
}

/** What a sitting decided, and each person's list to send them. */
function TriageSummary({
  queue,
  decisions,
  onBack,
  onDone,
}: {
  queue: Comment[];
  decisions: Record<string, Decision>;
  onBack: () => void;
  onDone: () => void;
}) {
  const [sent, setSent] = useState<Set<string>>(new Set());
  const decided = queue.filter((c) => decisions[c.id] && !decisions[c.id]?.skipped);
  const left = queue.length - decided.length;
  const counts: [string, number][] = [
    ...categories.map((c): [string, number] => [
      c.name,
      decided.filter((d) => decisions[d.id]?.categoryId === c.id).length,
    ]),
    ["Deferred", decided.filter((d) => decisions[d.id]?.deferred).length] as [string, number],
    ["Resolved", decided.filter((d) => decisions[d.id]?.resolved).length] as [string, number],
    ["Assigned", decided.filter((d) => decisions[d.id]?.assigneeId).length] as [string, number],
  ].filter(([, n]) => n > 0);
  const assigned = new Map<string, number>();
  for (const c of decided) {
    const who = decisions[c.id]?.assigneeId;
    if (who) assigned.set(who, (assigned.get(who) ?? 0) + 1);
  }
  return (
    <div className="fade-in mx-auto flex w-full max-w-[640px] flex-col gap-6 px-4 py-8 @3xl/app:px-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-[18px] font-medium text-ink">Triage done</h2>
        <p className="text-ink-2">
          {decided.length} of {queue.length} comments decided
          {left > 0 ? `; ${left} skipped or left for later.` : "."}
        </p>
      </div>
      {counts.length > 0 && (
        <dl className="flex flex-col border-t border-line">
          {counts.map(([term, n]) => (
            <div
              key={term}
              className="flex items-center justify-between border-b border-line py-2.5"
            >
              <dt className="text-[13px] text-ink-2">{term}</dt>
              <dd className="tabular text-[13px] text-ink">{n}</dd>
            </div>
          ))}
        </dl>
      )}
      {assigned.size > 0 && (
        <div className="flex flex-col gap-2">
          <Label>Lists to send</Label>
          <ul className="flex flex-col border-t border-line">
            {[...assigned].map(([id, count]) => {
              const name = personById(id).name;
              return (
                <li key={id} className="flex items-center gap-3 border-b border-line py-2">
                  <Avatar personId={id} size={22} />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                    {name}
                    <span className="tabular ml-2 text-ink-3">
                      {count} {count === 1 ? "comment" : "comments"}
                    </span>
                  </span>
                  {sent.has(id) ? (
                    <span className="text-[13px] text-ink-3">Sent</span>
                  ) : (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setSent((s) => new Set(s).add(id))}
                    >
                      Send {name.split(" ")[0]} their list
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={onDone}>
          Back to the recording
        </Button>
        {left > 0 && (
          <Button variant="ghost" onClick={onBack}>
            Back to the queue
          </Button>
        )}
      </div>
    </div>
  );
}

export type { Comment };
