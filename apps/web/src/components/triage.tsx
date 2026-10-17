import { type Anchor, type TriageInput, triageQueue } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "~/lib/cn";
import { ago, passageLoop, type Thread, threadsOf } from "~/lib/comments";
import { type Loop, MIN_LOOP } from "~/lib/loop";
import {
  type Comment,
  categoriesQuery,
  commentsQuery,
  type FileDetail,
  meQuery,
  projectMembersQuery,
  useCommentMutations,
} from "~/lib/queries";
import { useShortcuts } from "~/lib/shortcuts";
import { Avatar } from "./avatar";
import { AssignDialog, anchorLabel, DeferDialog } from "./comments";
import { Empty } from "./empty";
import { Kbd } from "./kbd";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/choice";

/** What became of a thread in this sitting: acted on, or passed over for now. */
type Outcome = "done" | "skipped";

/** The passage a thread points at, looped with a little either side; none for whole-file. */
export function triageLoop(anchor: Anchor | null, duration?: number): Loop | null {
  if (anchor?.kind === "time") {
    const end = anchor.end - anchor.start >= MIN_LOOP ? anchor.end : anchor.start + 3;
    return passageLoop({ start: anchor.start, end }, duration);
  }
  if (anchor?.kind === "bar" && anchor.at !== undefined)
    return passageLoop({ start: anchor.at, end: anchor.at + 3 }, duration);
  return null;
}

/** Fixed and won't fix settle a carried thread on this version. */
const settled = (c: Comment) => c.carry?.status === "fixed" || c.carry?.status === "wont_fix";

/**
 * Triage (#132): a version's open threads one at a time, in the order they play, with the
 * passage looping and a single key for each decision. Ticking several makes the next key
 * act on all of them. The queue is taken when the view opens, so a thread decided on stays
 * in it, dimmed, until the sitting ends.
 */
export function TriageView({
  file,
  media,
  player,
  onLoop,
  onDone,
}: {
  file: FileDetail;
  media: HTMLMediaElement | null;
  /** The file's own player (or pages), which keeps playing as the queue moves. */
  player: ReactNode;
  onLoop: (loop: Loop | null) => void;
  /** Back to the file's comments. */
  onDone: () => void;
}) {
  const { data: comments } = useQuery(commentsQuery(file.id));
  const { data: categories } = useQuery(categoriesQuery(file.projectId));
  const { data: members = [] } = useQuery(projectMembersQuery(file.projectId));
  const people = members.map((m) => ({ id: m.userId, name: m.name }));
  const mutations = useCommentMutations(file.id);
  const [queue, setQueue] = useState<string[] | null>(null);
  const [index, setIndex] = useState(0);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [asking, setAsking] = useState<"defer" | "assign" | null>(null);
  const [finished, setFinished] = useState(false);

  const threads = useMemo(() => {
    const all = threadsOf(comments ?? []);
    return {
      ...all,
      byId: new Map(
        [...all.open, ...all.deferred, ...all.resolved, ...all.hidden].map((t) => [
          t.comment.id,
          t,
        ]),
      ),
    };
  }, [comments]);
  // The queue is taken once both the threads and the categories are in.
  useEffect(() => {
    if (queue || !comments || !categories) return;
    const information = new Set(
      categories.filter((c) => c.handling === "information").map((c) => c.id),
    );
    const order = triageQueue(
      threads.open.map((t) => ({
        id: t.comment.id,
        anchor: t.comment.anchor,
        resolved: settled(t.comment),
        deferredTo: t.comment.deferredTo,
        information: t.comment.categoryId !== null && information.has(t.comment.categoryId),
      })),
    );
    setQueue(order.map((t) => t.id));
  }, [queue, comments, categories, threads]);

  const list = queue ?? [];
  const current: Thread | undefined = threads.byId.get(list[index] ?? "");
  const done = list.filter((id) => outcomes[id] === "done").length;
  const duration = file.mediaInfo?.duration;

  // The passage of the thread in front plays on a loop, from its start when asked.
  // biome-ignore lint/correctness/useExhaustiveDependencies: follows the thread in front only.
  useEffect(() => {
    const loop = triageLoop(current?.comment.anchor ?? null, duration);
    onLoop(loop);
    if (media && loop) media.currentTime = loop.start;
  }, [current?.comment.id, media]);

  const targets = () => (selected.size > 0 ? [...selected] : current ? [current.comment.id] : []);
  // A decision lands after its request returns, so it reads the queue as it is then.
  const latest = useRef({ outcomes, index, list });
  latest.current = { outcomes, index, list };
  /** Move on to the next thread not yet decided, or to the summary when none is left. */
  const advance = (marked: Record<string, Outcome>) => {
    const { index: at, list: ids } = latest.current;
    const next = ids.findIndex((id, i) => i > at && !marked[id]);
    const any = next >= 0 ? next : ids.findIndex((id) => !marked[id]);
    if (any < 0) setFinished(true);
    else setIndex(any);
  };
  const mark = (ids: string[], outcome: Outcome) => {
    const marked = {
      ...latest.current.outcomes,
      ...Object.fromEntries(ids.map((id) => [id, outcome])),
    };
    latest.current.outcomes = marked;
    setOutcomes(marked);
    // Only what was decided leaves the selection; ticks made meanwhile stay.
    setSelected((s) => new Set([...s].filter((id) => !ids.includes(id))));
    advance(marked);
  };
  const decide = (change: Omit<TriageInput, "commentIds">) => {
    const ids = targets();
    if (ids.length === 0 || mutations.triage.isPending) return;
    // Marked done, and the queue moves on, only once the server has taken it; on a failure
    // the comment stays in front with the error beside it.
    mutations.triage.mutate({ commentIds: ids, ...change }, { onSuccess: () => mark(ids, "done") });
  };
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const named = (categories ?? []).slice(0, 9);
  const active = Boolean(current) && !finished && asking === null;
  useShortcuts(
    "triage",
    "Triage",
    [
      ...named.map((c, i) => ({
        keys: [String(i + 1)],
        label: `Mark as ${c.name}`,
        run: () => decide({ categoryId: c.id }),
      })),
      { keys: ["d"], label: "Defer to a stage", run: () => setAsking("defer") },
      { keys: ["a"], label: "Assign", run: () => setAsking("assign") },
      { keys: ["r"], label: "Resolve", run: () => decide({ resolved: true }) },
      { keys: ["s"], label: "Skip for now", run: () => mark(targets(), "skipped") },
      {
        keys: ["x"],
        label: "Tick or untick this comment",
        run: () => current && toggle(current.comment.id, !selected.has(current.comment.id)),
      },
      {
        keys: ["ArrowDown"],
        label: "Next comment",
        run: () => setIndex((i) => Math.min(list.length - 1, i + 1)),
      },
      {
        keys: ["ArrowUp"],
        label: "Previous comment",
        run: () => setIndex((i) => Math.max(0, i - 1)),
      },
    ],
    active,
  );

  if (!comments || !categories || !queue)
    return <p className="px-4 py-8 text-ink-3 @3xl/app:px-6">Loading</p>;

  const stages = [
    ...new Set([
      ...categories.flatMap((c) => (c.stage ? [c.stage] : [])),
      ...threads.deferred.flatMap((t) => (t.comment.deferredTo ? [t.comment.deferredTo] : [])),
    ]),
  ];
  if (list.length === 0)
    return (
      <div className="px-4 py-8 @3xl/app:px-6">
        <Empty
          title="Nothing to triage"
          text="Every open comment on this file has been categorised as information, deferred or resolved."
          action={
            <Button variant="secondary" onClick={onDone}>
              Back to the file
            </Button>
          }
        />
      </div>
    );
  if (finished)
    return (
      <TriageSummary
        fileId={file.id}
        queue={list}
        outcomes={outcomes}
        byId={threads.byId}
        categories={categories}
        onBack={() => {
          setFinished(false);
          const left = list.findIndex((id) => outcomes[id] !== "done");
          if (left >= 0) setIndex(left);
        }}
        onDone={onDone}
      />
    );

  const category = (id: string | null) => categories.find((c) => c.id === id);
  const keyButton = (k: string, label: string, onClick: () => void, on = false) => (
    <button
      key={k}
      type="button"
      onClick={onClick}
      aria-pressed={on}
      aria-keyshortcuts={k}
      className={cn(
        "flex h-9 cursor-pointer items-center gap-2 rounded-control border px-2.5 text-[13px] transition-colors",
        on
          ? "border-signal/60 bg-signal/10 text-ink"
          : "border-line bg-raised/40 text-ink-2 hover:border-edge hover:text-ink",
      )}
    >
      <Kbd>{k}</Kbd>
      {label}
    </button>
  );
  const here = current?.comment;
  return (
    <div className="fade-in flex min-h-0 flex-col @3xl/app:flex-row">
      <aside
        aria-label="Queue"
        className="flex w-full shrink-0 flex-col border-b border-line @3xl/app:w-[300px] @3xl/app:border-r @3xl/app:border-b-0"
      >
        <div className="flex h-11 shrink-0 items-center gap-2 px-3">
          <span className="label">Queue · {list.length}</span>
          {selected.size > 0 && (
            <span className="ml-auto text-[12px] text-signal">{selected.size} ticked</span>
          )}
        </div>
        <ul className="m-0 flex list-none flex-col p-0 px-1.5 pb-2">
          {list.map((id, i) => {
            const t = threads.byId.get(id);
            if (!t) return null;
            const c = t.comment;
            const outcome = outcomes[id];
            const status = c.resolvedAt
              ? "resolved"
              : c.deferredTo
                ? `deferred to ${c.deferredTo}`
                : (category(c.categoryId)?.name ?? (outcome === "skipped" ? "skipped" : null));
            return (
              <li key={id}>
                <div
                  className={cn(
                    "flex items-start gap-2 rounded-panel px-2 py-2 transition-colors",
                    i === index ? "bg-raised shadow-1" : "hover:bg-raised/50",
                    outcome === "done" && "opacity-60",
                  )}
                >
                  <Checkbox
                    aria-label={`Tick comment ${String(i + 1)}`}
                    checked={selected.has(id)}
                    onChange={(e) => toggle(id, e.target.checked)}
                    className="mt-0.5"
                  />
                  <button
                    type="button"
                    onClick={() => setIndex(i)}
                    aria-current={i === index ? "true" : undefined}
                    className="min-w-0 flex-1 cursor-pointer border-0 bg-transparent p-0 text-left"
                  >
                    <span className="flex items-center gap-2 text-[12px] text-ink-3">
                      <span className="tabular shrink-0">
                        {c.anchor ? anchorLabel(c.anchor) : "Whole file"}
                      </span>
                      <span className="min-w-0 truncate">{c.authorName ?? "Former member"}</span>
                      {status && <span className="ml-auto shrink-0 text-ink-2">{status}</span>}
                    </span>
                    <span className="line-clamp-2 text-[13px] text-ink">{c.body}</span>
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </aside>
      <section
        aria-label="Comment"
        className="flex min-w-0 flex-1 flex-col gap-5 px-4 py-5 @3xl/app:px-6"
      >
        {here && (
          <>
            <div className="flex items-center gap-3">
              <Avatar id={here.authorId ?? here.id} name={here.authorName ?? "?"} size={28} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[14px] font-medium text-ink">
                  {here.authorName ?? "Former member"}
                  {here.authorLabel && (
                    <span className="ml-2 font-normal text-ink-3">{here.authorLabel}</span>
                  )}
                </div>
                <div className="text-[12px] text-ink-3">{ago(here.createdAt)}</div>
              </div>
              <span className="tabular shrink-0 text-[13px] text-ink-3">
                {index + 1} of {list.length}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
              <span className="tabular rounded-chip bg-signal/15 px-1.5 leading-5 font-medium text-signal">
                {here.anchor ? anchorLabel(here.anchor) : "Whole file"}
              </span>
              {category(here.categoryId) && (
                <span className="rounded-chip bg-raised px-1.5 leading-5 text-ink-2">
                  {category(here.categoryId)?.name}
                </span>
              )}
              {here.assigneeName && (
                <span className="rounded-chip bg-raised px-1.5 leading-5 text-ink-2">
                  for {here.assigneeName}
                </span>
              )}
            </div>
            <p className="m-0 max-w-[640px] text-[18px] leading-[28px] text-ink">{here.body}</p>
            {current.replies.map((r) => (
              <p key={r.id} className="m-0 flex gap-2 text-[14px] text-ink-2">
                <Avatar
                  id={r.authorId ?? r.id}
                  name={r.authorName ?? "?"}
                  size={18}
                  className="mt-0.5"
                />
                <span>
                  <span className="text-ink">{r.authorName ?? "Former member"}</span> {r.body}
                </span>
              </p>
            ))}
          </>
        )}
        <div className="min-w-0">{player}</div>
        {here && (
          <div className="flex flex-col gap-3">
            <span className="label">Category</span>
            <div className="flex flex-wrap gap-1.5">
              {named.map((c, i) =>
                keyButton(
                  String(i + 1),
                  c.name,
                  () => decide({ categoryId: c.id }),
                  here.categoryId === c.id,
                ),
              )}
            </div>
            <span className="label">Then</span>
            <div className="flex flex-wrap gap-1.5">
              {keyButton("D", "Defer to a stage…", () => setAsking("defer"))}
              {keyButton("A", "Assign…", () => setAsking("assign"))}
              {keyButton("R", "Resolve", () => decide({ resolved: true }))}
              {keyButton("S", "Skip", () => mark(targets(), "skipped"))}
            </div>
            {mutations.triage.error && (
              <p role="alert" className="m-0 text-[13px] text-signal">
                {mutations.triage.error.message}
              </p>
            )}
            <p className="m-0 text-[12px] text-ink-3">
              <Kbd>↑</Kbd> <Kbd>↓</Kbd> move · <Kbd>X</Kbd> ticks · a key acts on every ticked
              comment
            </p>
          </div>
        )}
      </section>
      <aside
        aria-label="Deferred"
        className="hidden w-[260px] shrink-0 flex-col gap-4 border-l border-line p-4 @5xl/app:flex"
      >
        <span className="label">Returns when a stage starts</span>
        {stages.length === 0 && <span className="text-[12px] text-ink-3">Nothing deferred.</span>}
        {stages.map((stage) => {
          const waiting = threads.deferred.filter((t) => t.comment.deferredTo === stage);
          return (
            <div key={stage} className="flex flex-col gap-1">
              <span className="text-[13px] text-ink">
                {stage}
                <span className="tabular ml-2 text-ink-3">{waiting.length}</span>
              </span>
              {waiting.map((t) => (
                <span key={t.comment.id} className="truncate text-[12px] text-ink-3">
                  {t.comment.body}
                </span>
              ))}
              {waiting.length === 0 && (
                <span className="text-[12px] text-ink-3">Nothing deferred.</span>
              )}
            </div>
          );
        })}
        {file.variation && (
          <>
            <span className="label mt-2">Goes on to V{file.variation.versionNumber + 1}</span>
            <span className="text-[12px] text-ink-3">
              {threads.open.length + threads.deferred.length} open threads, offered for carrying
              when the next version is made.
            </span>
          </>
        )}
      </aside>
      {asking === "defer" && (
        <DeferDialog
          stages={stages}
          onDefer={(stage) => {
            setAsking(null);
            decide({ deferredTo: stage });
          }}
          onClose={() => setAsking(null)}
        />
      )}
      {asking === "assign" && (
        <AssignDialog
          people={people}
          current={selected.size > 0 ? null : (here?.assigneeId ?? null)}
          onAssign={(id) => {
            setAsking(null);
            decide({ assigneeId: id });
          }}
          onClose={() => setAsking(null)}
        />
      )}
      <span className="sr-only" aria-live="polite">
        {done} of {list.length} decided
      </span>
    </div>
  );
}

/** What a sitting decided, and each person's list to send them. */
function TriageSummary({
  fileId,
  queue,
  outcomes,
  byId,
  categories,
  onBack,
  onDone,
}: {
  fileId: string;
  queue: string[];
  outcomes: Record<string, Outcome>;
  byId: Map<string, Thread>;
  categories: { id: string; name: string }[];
  onBack: () => void;
  onDone: () => void;
}) {
  const mutations = useCommentMutations(fileId);
  const { data: me } = useQuery(meQuery);
  const [sent, setSent] = useState<Set<string>>(new Set());
  const threads = queue.flatMap((id) => {
    const t = byId.get(id);
    return t ? [t.comment] : [];
  });
  const decided = threads.filter((c) => outcomes[c.id] === "done");
  const left = queue.length - decided.length;
  const counts: [string, number][] = [
    ...categories.map((c): [string, number] => [
      c.name,
      decided.filter((t) => t.categoryId === c.id).length,
    ]),
    ["Deferred", decided.filter((t) => t.deferredTo && !t.resolvedAt).length] as [string, number],
    ["Resolved", decided.filter((t) => t.resolvedAt).length] as [string, number],
    ["Assigned", decided.filter((t) => t.assigneeId && !t.resolvedAt).length] as [string, number],
  ].filter(([, n]) => n > 0);
  // Everyone with open threads here, not only those assigned in this sitting.
  const assigned = new Map<string, { name: string; count: number }>();
  for (const t of byId.values()) {
    const c = t.comment;
    if (!c.assigneeId || c.resolvedAt || c.parentId) continue;
    const entry = assigned.get(c.assigneeId) ?? { name: c.assigneeName ?? "", count: 0 };
    entry.count += 1;
    assigned.set(c.assigneeId, entry);
  }
  return (
    <div className="fade-in mx-auto flex w-full max-w-[640px] flex-col gap-6 px-4 py-8 @3xl/app:px-6">
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-[18px] font-medium text-ink">Triage done</h2>
        <p className="m-0 text-ink-2">
          {decided.length} of {queue.length} comments decided
          {left > 0 ? `; ${String(left)} skipped or left for later.` : "."}
        </p>
      </div>
      {counts.length > 0 && (
        <dl className="m-0 flex flex-col border-t border-hairline">
          {counts.map(([term, n]) => (
            <div
              key={term}
              className="flex items-center justify-between border-b border-hairline py-2.5"
            >
              <dt className="text-[13px] text-ink-2">{term}</dt>
              <dd className="tabular m-0 text-[13px] text-ink">{n}</dd>
            </div>
          ))}
        </dl>
      )}
      {assigned.size > 0 && (
        <div className="flex flex-col gap-2">
          <span className="label">Lists to send</span>
          <ul className="m-0 flex list-none flex-col border-t border-hairline p-0">
            {[...assigned].map(([id, { name, count }]) => (
              <li key={id} className="flex items-center gap-3 border-b border-hairline py-2">
                <Avatar id={id} name={name} size={22} />
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                  {name}
                  <span className="tabular ml-2 text-ink-3">
                    {count} {count === 1 ? "comment" : "comments"}
                  </span>
                </span>
                {id === me?.user.id ? (
                  <span className="text-[13px] text-ink-3">Yours</span>
                ) : sent.has(id) ? (
                  <span className="text-[13px] text-ink-3">Sent</span>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={mutations.sendList.isPending}
                    onClick={() =>
                      mutations.sendList.mutate(id, {
                        onSuccess: () => setSent((s) => new Set(s).add(id)),
                      })
                    }
                  >
                    Send {name.split(" ")[0]} their list
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {mutations.sendList.error && (
            <p role="alert" className="m-0 text-[13px] text-signal">
              {mutations.sendList.error.message}
            </p>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={onDone}>
          Back to the file
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
