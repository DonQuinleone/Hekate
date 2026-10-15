import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { Avatar } from "~/components/avatar";
import { CalendarSubscribeDialog } from "~/components/calendar-subscribe";
import { Icon, type IconName } from "~/components/icons";
import { Card, Page, SectionHead } from "~/components/page";
import { usePageHeader } from "~/components/page-header";
import { NewProjectTile, ProjectCard } from "~/components/project-card";
import { Dot, type DotState, reviewDot } from "~/components/status";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import {
  activity,
  comments,
  fileById,
  NOW,
  personById,
  projectById,
  type reviews,
  tasks,
  tracks,
  variationOf,
} from "~/data";
import { cn } from "~/lib/cn";
import { ago, dueIn, formatDate } from "~/lib/format";
import { needsYou, responded, reviewOutcome } from "~/lib/reviews";
import { useViewer } from "~/viewer/context";
import { Empty, StateGate } from "~/viewer/state-gate";
import { NewProject } from "./projects.tsx";

interface Attention {
  id: string;
  icon?: IconName;
  dot?: DotState;
  title: string;
  why: string;
  when?: string;
  urgent?: boolean;
  to: string;
  params?: Record<string, string>;
  search?: Record<string, string>;
}

function Stat({
  label,
  value,
  hint,
  flag,
  to,
}: {
  label: string;
  value: number | string;
  hint?: string;
  flag?: boolean;
  to?: string;
}) {
  const body = (
    <>
      <span className="text-[13px] text-ink-3">{label}</span>
      <span
        className={cn(
          "tabular mt-1 block text-[28px] leading-[32px] font-semibold tracking-[-0.02em]",
          flag ? "text-signal" : "text-ink",
        )}
      >
        {value}
      </span>
      {hint && <span className="mt-1 block truncate text-[12px] text-ink-3">{hint}</span>}
    </>
  );
  const cls =
    "flex flex-col rounded-panel-lg border border-line bg-raised/25 px-4 py-3.5 shadow-1 transition-colors";
  return to ? (
    <Link to={to} className={cn(cls, "hover:border-edge")}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function DashboardPage() {
  const viewer = useViewer();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [calendar, setCalendar] = useState(false);
  const projects = viewer.projects();
  const mine = viewer.reviews();
  const me = (r: (typeof reviews)[number]) => viewer.reviewerIn(r);
  const person = personById(viewer.personId);
  const hour = NOW.getUTCHours() + 1;
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  usePageHeader({ title: "Home" });

  const attention: Attention[] = [
    ...mine
      .filter((r) => needsYou(r, me(r)))
      .map((r): Attention => {
        const my = me(r);
        const due = r.dueAt ? dueIn(r.dueAt) : null;
        return {
          id: r.id,
          dot: reviewDot(r.status, reviewOutcome(r)),
          title: r.title,
          why:
            r.kind === "approval"
              ? my?.permissions.decide
                ? "Your decision is asked for"
                : "Your comments are asked for"
              : "Your feedback is asked for",
          when: due?.label,
          urgent: Boolean(due && due.days < 1),
          to: "/reviews/$reviewId",
          params: { reviewId: r.id },
        };
      }),
    ...tasks
      .filter(
        (t) =>
          t.assigneeId === viewer.personId && t.status !== "done" && viewer.canSee(t.projectId),
      )
      .map((t): Attention => {
        const due = t.dueAt ? dueIn(`${t.dueAt}T23:59:00Z`) : null;
        return {
          id: t.id,
          icon: "task",
          title: t.title,
          why: `Task in ${projectById(t.projectId)?.name}`,
          when: due?.label,
          urgent: Boolean(due && due.days < 1),
          to: "/projects/$projectId/$view",
          params: { projectId: t.projectId, view: "tasks" },
          search: { task: t.id },
        };
      }),
    ...comments
      .filter(
        (c) =>
          c.assigneeId === viewer.personId &&
          !c.resolved &&
          viewer.canSee(fileById(c.fileId)?.projectId ?? ""),
      )
      .map(
        (c): Attention => ({
          id: c.id,
          icon: "comment",
          title: c.body,
          why: `Assigned by ${personById(c.authorId).name} on ${
            variationOf(c.fileId)?.track.name ?? fileById(c.fileId)?.name
          }`,
          to: "/files/$fileId",
          params: { fileId: c.fileId },
          search: { comment: c.id },
        }),
      ),
    ...tracks
      .filter((t) => viewer.canSee(t.projectId) && viewer.can(t.projectId, "upload"))
      .flatMap((t) =>
        t.versions
          .filter((v) => v.state === "failed")
          .map(
            (v): Attention => ({
              id: v.id,
              icon: "warning",
              title: `${t.name} V${v.number} could not be analysed`,
              why: "The file needs replacing",
              urgent: true,
              to: "/tracks/$trackId",
              params: { trackId: t.id },
              search: { view: "versions" },
            }),
          ),
      ),
  ];

  const open = mine.filter((r) => r.status === "open");
  const week = new Date(NOW.getTime() + 7 * 86_400_000).toISOString();
  const deadlines = [
    ...open
      .filter((r) => r.dueAt)
      .map((r) => ({
        id: r.id,
        at: r.dueAt as string,
        title: r.title,
        kind: "Review",
        project: projectById(r.projectId)?.name ?? "",
        to: `/reviews/${r.id}`,
      })),
    ...tasks
      .filter((t) => t.dueAt && t.status !== "done" && viewer.canSee(t.projectId))
      .map((t) => ({
        id: t.id,
        at: `${t.dueAt}T17:00:00Z`,
        title: t.title,
        kind: "Task",
        project: projectById(t.projectId)?.name ?? "",
        to: `/projects/${t.projectId}/tasks`,
      })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const dueThisWeek = deadlines.filter((d) => d.at <= week).length;
  const overdue = deadlines.filter((d) => dueIn(d.at).days < 0).length;
  const openComments = comments.filter(
    (c) => !c.parentId && !c.resolved && viewer.canSee(fileById(c.fileId)?.projectId ?? ""),
  ).length;
  const versionsThisWeek = tracks
    .filter((t) => viewer.canSee(t.projectId))
    .flatMap((t) => t.versions)
    .filter((v) => new Date(v.uploadedAt).getTime() > NOW.getTime() - 7 * 86_400_000).length;
  const recent = activity.filter((a) => viewer.canSee(a.projectId)).slice(0, 7);

  const row = (a: Attention) => (
    <li key={a.id}>
      <Link
        to={a.to}
        params={a.params}
        search={a.search}
        className="group flex items-center gap-3.5 rounded-panel px-3 py-2.5 transition-colors hover:bg-raised/60"
      >
        <span className="flex size-6 shrink-0 items-center justify-center">
          {a.icon ? (
            <Icon
              name={a.icon}
              size={15}
              className={a.icon === "warning" ? "text-signal" : "text-ink-3"}
            />
          ) : (
            <Dot state={a.dot ?? "in_review"} />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-medium text-ink">{a.title}</span>
          <span className="block truncate text-[13px] text-ink-3">{a.why}</span>
        </span>
        {a.when && (
          <span className={cn("tabular text-[13px]", a.urgent ? "text-signal" : "text-ink-3")}>
            {a.when}
          </span>
        )}
        <Icon
          name="chevronRight"
          size={14}
          className="text-ink-3 opacity-0 transition-opacity group-hover:opacity-100"
        />
      </Link>
    </li>
  );

  const section = (title: string, hint: string | undefined, action: ReactNode, body: ReactNode) => (
    <section className="flex flex-col gap-3">
      <SectionHead title={title} hint={hint} action={action} />
      {body}
    </section>
  );

  return (
    <StateGate
      empty={
        <Page>
          <Empty
            title="Nothing here yet"
            text="Start a project, or wait to be added to one. Reviews and tasks asked of you gather here."
            action={
              <Button variant="primary" onClick={() => setCreating(true)}>
                New project
              </Button>
            }
          />
          {creating && <NewProject onClose={() => setCreating(false)} />}
        </Page>
      }
    >
      <Page>
        <div className="flex flex-col gap-1">
          <span className="eyebrow">
            {new Intl.DateTimeFormat("en-GB", {
              weekday: "long",
              day: "numeric",
              month: "long",
            }).format(NOW)}
          </span>
          <h1 className="title">
            {greeting}, {person.name.split(" ")[0]}
          </h1>
        </div>

        {section(
          "Needs you",
          attention.length ? String(attention.length) : undefined,
          <Button variant="ghost" size="sm" asChild>
            <Link to="/inbox">Open the inbox</Link>
          </Button>,
          attention.length === 0 ? (
            <Card className="px-4 py-6 text-[14px] text-ink-3">
              You are all caught up. Reviews, tasks and comments assigned to you arrive here.
            </Card>
          ) : (
            <Card>
              <ul className="flex flex-col p-1.5">{attention.slice(0, 6).map(row)}</ul>
              {attention.length > 6 && (
                <Link
                  to="/inbox"
                  className="block border-t border-line px-4 py-2.5 text-[13px] text-ink-3 hover:text-ink"
                >
                  {attention.length - 6} more in the inbox
                </Link>
              )}
            </Card>
          ),
        )}

        <div className="grid grid-cols-2 gap-3 @3xl/app:grid-cols-4">
          <Stat
            label="In review"
            value={open.length}
            hint={`${open.filter((r) => responded(r) > 0).length} with responses`}
          />
          <Stat
            label="Due this week"
            value={dueThisWeek}
            hint={overdue ? `${overdue} overdue` : "nothing overdue"}
            flag={overdue > 0}
          />
          <Stat
            label="Open comments"
            value={openComments}
            hint={`${comments.filter((c) => c.assigneeId && !c.resolved).length} assigned`}
          />
          <Stat label="New versions" value={versionsThisWeek} hint="in the last seven days" />
        </div>

        {section(
          "Projects",
          String(projects.length),
          <Button variant="ghost" size="sm" asChild>
            <Link to="/projects">All projects</Link>
          </Button>,
          <div className="grid gap-4 @3xl/app:grid-cols-2 @6xl/app:grid-cols-3">
            {projects.slice(0, 5).map((p) => (
              <ProjectCard key={p.id} project={p} />
            ))}
            {!viewer.isGuest && <NewProjectTile onClick={() => setCreating(true)} />}
          </div>,
        )}

        <div className="grid gap-8 @5xl/app:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          {section(
            "Coming up",
            undefined,
            <Button variant="ghost" size="sm" onClick={() => setCalendar(true)}>
              <Icon name="calendar" size={14} />
              Add to your calendar
            </Button>,
            <Card>
              <ul className="flex flex-col p-1.5">
                {deadlines.slice(0, 6).map((d) => {
                  const due = dueIn(d.at);
                  return (
                    <li key={d.id}>
                      <Link
                        to={d.to}
                        className="flex items-center gap-3.5 rounded-panel px-3 py-2 transition-colors hover:bg-raised/60"
                      >
                        <span
                          className={cn(
                            "tabular flex w-11 shrink-0 flex-col items-center rounded-control border py-1 leading-none",
                            due.days < 0
                              ? "border-signal/40 text-signal"
                              : "border-line text-ink-2",
                          )}
                        >
                          <span className="text-[15px] font-medium">
                            {new Date(d.at).getUTCDate()}
                          </span>
                          <span className="mt-0.5 text-[10px] uppercase">
                            {formatDate(d.at).split(" ")[1]}
                          </span>
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[14px] text-ink">{d.title}</span>
                          <span className="block truncate text-[12px] text-ink-3">
                            {d.kind} · {d.project}
                          </span>
                        </span>
                        <span
                          className={cn(
                            "tabular text-[12px]",
                            due.days < 0 ? "text-signal" : "text-ink-3",
                          )}
                        >
                          {due.label}
                        </span>
                      </Link>
                    </li>
                  );
                })}
                {deadlines.length === 0 && (
                  <li className="px-3 py-4 text-[13px] text-ink-3">No dates ahead.</li>
                )}
              </ul>
            </Card>,
          )}
          {section(
            "Activity",
            undefined,
            undefined,
            <Card>
              <ul className="flex flex-col px-4 py-1.5">
                {recent.map((a) => (
                  <li key={a.id} className="flex items-center gap-3 py-2">
                    <Avatar personId={a.personId} size={24} />
                    <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">
                      <span className="text-ink">{personById(a.personId).name}</span> {a.text}
                    </span>
                    <span className="tabular shrink-0 text-[12px] text-ink-3">{ago(a.at)}</span>
                  </li>
                ))}
              </ul>
            </Card>,
          )}
        </div>
        {creating && (
          <Dialog title="New project" onClose={() => setCreating(false)} width="lg">
            <NewProject
              onClose={() => {
                setCreating(false);
                navigate({ to: "/projects" });
              }}
              bare
            />
          </Dialog>
        )}
        {calendar && (
          <CalendarSubscribeDialog onClose={() => setCalendar(false)} scope="your projects" />
        )}
      </Page>
    </StateGate>
  );
}
