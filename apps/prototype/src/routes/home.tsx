import { Link } from "@tanstack/react-router";
import { Avatar } from "~/components/avatar";
import { Icon } from "~/components/icons";
import { Label } from "~/components/label";
import { usePageHeader } from "~/components/page-header";
import { Dot, reviewDot } from "~/components/status";
import { Button } from "~/components/ui/button";
import {
  activity,
  comments,
  fileById,
  personById,
  projectById,
  tasks,
  tracks,
  variationOf,
} from "~/data";
import { ago, dueIn, formatDate } from "~/lib/format";
import { kindCopy, needsYou, responded, reviewOutcome } from "~/lib/reviews";
import { useViewer } from "~/viewer/context";
import { Empty, StateGate } from "~/viewer/state-gate";

function Section({
  title,
  count,
  children,
  action,
}: {
  title: string;
  count?: number;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 className="m-0 text-[15px] font-medium">{title}</h2>
        {count !== undefined && (
          <span className="tabular rounded-full bg-raised px-1.5 text-[11px] leading-[18px] text-ink-2">
            {count}
          </span>
        )}
        <span className="ml-auto">{action}</span>
      </div>
      {children}
    </section>
  );
}

const Panel = ({ children }: { children: React.ReactNode }) => (
  <div className="rounded-panel-lg border border-hairline bg-surface shadow-1">{children}</div>
);

export function HomePage() {
  const viewer = useViewer();
  usePageHeader({ title: "Home" });
  const mine = viewer.reviews();
  const waiting = mine.filter((r) => needsYou(r, viewer.reviewerIn(r)));
  const myProjects = viewer.projects();
  const triage = myProjects
    .filter((p) => viewer.can(p.id, "triage"))
    .flatMap((p) =>
      comments.filter(
        (c) =>
          !c.parentId &&
          !c.resolved &&
          !c.deferredToStage &&
          !c.categoryId &&
          fileById(c.fileId)?.projectId === p.id,
      ),
    );
  const assigned = comments.filter(
    (c) =>
      c.assigneeId === viewer.personId &&
      !c.resolved &&
      viewer.canSee(fileById(c.fileId)?.projectId ?? ""),
  );
  const myTasks = tasks.filter(
    (t) => t.assigneeId === viewer.personId && t.status !== "done" && viewer.canSee(t.projectId),
  );
  const due = [
    ...mine
      .filter((r) => r.status === "open" && r.dueAt)
      .map((r) => ({
        at: r.dueAt as string,
        label: r.title,
        href: `/reviews/${r.id}`,
        kind: kindCopy[r.kind],
      })),
    ...myTasks
      .filter((t) => t.dueAt)
      .map((t) => ({
        at: `${t.dueAt}T23:59:00Z`,
        label: t.title,
        href: `/projects/${t.projectId}/tasks`,
        kind: "Task",
      })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const recent = activity.filter((a) => viewer.canSee(a.projectId)).slice(0, 8);
  const processing = tracks
    .filter((t) => viewer.canSee(t.projectId))
    .flatMap((t) =>
      t.versions.filter((v) => v.state !== "ready").map((v) => ({ track: t, version: v })),
    );

  const caughtUp =
    waiting.length === 0 && triage.length === 0 && assigned.length === 0 && myTasks.length === 0;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-6 @3xl/app:px-6">
      <StateGate
        empty={
          <Empty
            title="Nothing waiting on you"
            text="Reviews you are asked for, comments to triage and anything assigned to you will appear here."
            action={
              viewer.projects().length === 0 ? (
                <Button variant="primary" asChild>
                  <Link to="/projects">Start a project</Link>
                </Button>
              ) : undefined
            }
          />
        }
      >
        <div className="grid gap-8 @5xl/app:grid-cols-[minmax(0,1fr)_320px]">
          <div className="flex min-w-0 flex-col gap-8">
            <Section
              title="Waiting on you"
              count={waiting.length + triage.length + assigned.length + myTasks.length}
            >
              {caughtUp ? (
                <p className="m-0 rounded-panel-lg border border-hairline border-dashed px-4 py-6 text-center text-ink-3">
                  You are all caught up.
                </p>
              ) : (
                <Panel>
                  <ul className="m-0 list-none p-0">
                    {waiting.map((r) => {
                      const me = viewer.reviewerIn(r);
                      return (
                        <li
                          key={r.id}
                          className="flex items-center gap-3 border-b border-hairline-soft px-4 py-3 last:border-b-0"
                        >
                          <Dot state={reviewDot(r.status, reviewOutcome(r))} />
                          <div className="min-w-0 flex-1">
                            <Link
                              to="/reviews/$reviewId"
                              params={{ reviewId: r.id }}
                              className="block truncate text-[13px] font-medium text-ink no-underline hover:text-signal"
                            >
                              {r.title}
                            </Link>
                            <div className="truncate text-xs text-ink-3">
                              {r.kind === "approval"
                                ? me?.permissions.decide
                                  ? "Your decision"
                                  : "Follow along"
                                : "Your feedback"}{" "}
                              · {projectById(r.projectId)?.name}
                              {r.dueAt && ` · ${dueIn(r.dueAt).label}`}
                            </div>
                          </div>
                          <Button variant="secondary" size="sm" asChild>
                            <Link to="/reviews/$reviewId" params={{ reviewId: r.id }}>
                              Open
                            </Link>
                          </Button>
                        </li>
                      );
                    })}
                    {triage.length > 0 && (
                      <li className="flex items-center gap-3 border-b border-hairline-soft px-4 py-3 last:border-b-0">
                        <Icon name="comment" className="text-ink-3" />
                        <div className="min-w-0 flex-1">
                          <span className="block text-[13px] font-medium text-ink">
                            {triage.length} comments to triage
                          </span>
                          <span className="block truncate text-xs text-ink-3">
                            {[
                              ...new Set(
                                triage.map(
                                  (c) =>
                                    variationOf(c.fileId)?.track.name ?? fileById(c.fileId)?.name,
                                ),
                              ),
                            ].join(", ")}
                          </span>
                        </div>
                        <Button variant="secondary" size="sm" asChild>
                          <Link
                            to="/files/$fileId"
                            params={{ fileId: triage[0]?.fileId ?? "" }}
                            search={{ view: "triage" }}
                          >
                            Triage
                          </Link>
                        </Button>
                      </li>
                    )}
                    {assigned.map((c) => (
                      <li
                        key={c.id}
                        className="flex items-center gap-3 border-b border-hairline-soft px-4 py-3 last:border-b-0"
                      >
                        <Avatar personId={c.authorId} size={22} />
                        <div className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] text-ink">{c.body}</span>
                          <span className="block truncate text-xs text-ink-3">
                            Assigned to you by {personById(c.authorId).name} ·{" "}
                            {variationOf(c.fileId)?.track.name ?? fileById(c.fileId)?.name}
                          </span>
                        </div>
                        <Button variant="secondary" size="sm" asChild>
                          <Link
                            to="/files/$fileId"
                            params={{ fileId: c.fileId }}
                            search={{ comment: c.id }}
                          >
                            Open
                          </Link>
                        </Button>
                      </li>
                    ))}
                    {myTasks.map((t) => (
                      <li
                        key={t.id}
                        className="flex items-center gap-3 border-b border-hairline-soft px-4 py-3 last:border-b-0"
                      >
                        <span
                          className={`size-[8px] shrink-0 rounded-full border-[1.5px] ${t.priority === "high" ? "border-signal" : "border-ink-3"}`}
                          aria-hidden="true"
                        />
                        <div className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] text-ink">{t.title}</span>
                          <span className="block truncate text-xs text-ink-3">
                            Task · {projectById(t.projectId)?.name}
                            {t.dueAt && ` · ${dueIn(`${t.dueAt}T23:59:00Z`).label}`}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                </Panel>
              )}
            </Section>
            <Section title="Recent activity">
              <Panel>
                <ul className="m-0 list-none p-0">
                  {recent.map((a) => (
                    <li
                      key={a.id}
                      className="flex items-center gap-3 border-b border-hairline-soft px-4 py-2.5 last:border-b-0"
                    >
                      <Avatar personId={a.personId} size={22} />
                      <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">
                        <span className="text-ink">{personById(a.personId).name}</span> {a.text}
                        <span className="text-ink-3"> · {projectById(a.projectId)?.name}</span>
                      </span>
                      <span className="tabular shrink-0 text-xs text-ink-3">{ago(a.at)}</span>
                    </li>
                  ))}
                </ul>
              </Panel>
            </Section>
          </div>
          <div className="flex min-w-0 flex-col gap-8">
            <Section title="Due soon">
              <Panel>
                <ul className="m-0 list-none p-0">
                  {due.slice(0, 6).map((d) => {
                    const { days } = dueIn(d.at);
                    return (
                      <li
                        key={d.href + d.label}
                        className="flex items-center gap-3 border-b border-hairline-soft px-4 py-2.5 last:border-b-0"
                      >
                        <span
                          className={`tabular w-12 shrink-0 text-xs ${days < 0 ? "text-signal" : "text-ink-3"}`}
                        >
                          {formatDate(d.at)}
                        </span>
                        <Link
                          to={d.href}
                          className="min-w-0 flex-1 truncate text-[13px] text-ink no-underline hover:text-signal"
                        >
                          {d.label}
                        </Link>
                        <Label>{d.kind}</Label>
                      </li>
                    );
                  })}
                  {due.length === 0 && (
                    <li className="px-4 py-3 text-xs text-ink-3">No dates ahead.</li>
                  )}
                </ul>
              </Panel>
            </Section>
            <Section
              title="Reviews you asked for"
              count={
                mine.filter((r) => r.requestedBy === viewer.personId && r.status === "open").length
              }
            >
              <Panel>
                <ul className="m-0 list-none p-0">
                  {mine
                    .filter((r) => r.requestedBy === viewer.personId && r.status === "open")
                    .map((r) => (
                      <li
                        key={r.id}
                        className="flex items-center gap-3 border-b border-hairline-soft px-4 py-2.5 last:border-b-0"
                      >
                        <Dot state={reviewDot(r.status, reviewOutcome(r))} />
                        <Link
                          to="/reviews/$reviewId"
                          params={{ reviewId: r.id }}
                          className="min-w-0 flex-1 truncate text-[13px] text-ink no-underline hover:text-signal"
                        >
                          {r.title}
                        </Link>
                        <span className="tabular shrink-0 text-xs text-ink-3">
                          {responded(r)} of {r.reviewers.length}
                        </span>
                      </li>
                    ))}
                  {mine.filter((r) => r.requestedBy === viewer.personId && r.status === "open")
                    .length === 0 && <li className="px-4 py-3 text-xs text-ink-3">None open.</li>}
                </ul>
              </Panel>
            </Section>
            {processing.length > 0 && (
              <Section title="Processing" count={processing.length}>
                <Panel>
                  <ul className="m-0 list-none p-0">
                    {processing.map(({ track, version }) => (
                      <li
                        key={version.id}
                        className="flex items-center gap-3 border-b border-hairline-soft px-4 py-2.5 last:border-b-0"
                      >
                        {version.state === "failed" ? (
                          <Icon name="warning" className="shrink-0 text-signal" />
                        ) : (
                          <span
                            className="size-[8px] shrink-0 animate-pulse rounded-full border-[1.5px] border-ink-3"
                            aria-hidden="true"
                          />
                        )}
                        <Link
                          to="/tracks/$trackId"
                          params={{ trackId: track.id }}
                          className="min-w-0 flex-1 truncate text-[13px] text-ink no-underline hover:text-signal"
                        >
                          {track.name} V{version.number}
                        </Link>
                        <span className="shrink-0 text-xs text-ink-3">
                          {version.state === "failed" ? "could not be analysed" : "analysing"}
                        </span>
                      </li>
                    ))}
                  </ul>
                </Panel>
              </Section>
            )}
          </div>
        </div>
      </StateGate>
    </div>
  );
}
