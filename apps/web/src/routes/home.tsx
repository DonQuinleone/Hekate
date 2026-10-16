import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { Avatar, AvatarRow } from "~/components/avatar";
import { Empty } from "~/components/empty";
import { Icon, type IconName } from "~/components/icons";
import { Card, Page, SectionHead } from "~/components/page";
import { PageHeader } from "~/components/page-header";
import { ProjectCover } from "~/components/project-cover";
import { reviewState } from "~/components/reviews";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { StatusDot } from "~/components/ui/status";
import { cn } from "~/lib/cn";
import { ago } from "~/lib/comments";
import {
  type Attention,
  activityText,
  attentionFor,
  deadlinesOf,
  dueIn,
  figures,
  greeting,
  progress,
} from "~/lib/home";
import {
  type HomeActivity,
  type HomeProject,
  homeQuery,
  type MyReview,
  meQuery,
  myReviewsQuery,
} from "~/lib/queries";
import { NewProject } from "~/routes/projects";

/** Shown on the page at most; the rest wait in the reviews list. */
const ATTENTION_SHOWN = 6;

const dayFormat = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
});
const monthFormat = new Intl.DateTimeFormat("en-GB", { month: "short" });

function Stat({
  label,
  value,
  hint,
  flag = false,
}: {
  label: string;
  value: number;
  hint: string;
  flag?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col rounded-panel-lg border border-line bg-raised/25 px-4 py-3.5 shadow-1">
      <span className="truncate text-[13px] text-ink-3">{label}</span>
      <span
        className={cn(
          "tabular mt-1 block text-[28px] leading-[32px] font-semibold tracking-[-0.02em]",
          flag ? "text-signal" : "text-ink",
        )}
      >
        {value}
      </span>
      <span className="mt-1 block truncate text-[12px] text-ink-3">{hint}</span>
    </div>
  );
}

function Section({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-3">
      <SectionHead title={title} hint={hint} action={action} />
      {children}
    </section>
  );
}

const rowClass =
  "group flex items-center gap-3.5 rounded-panel px-3 py-2.5 transition-colors hover:bg-raised/60 focus-visible:bg-raised/60";

function AttentionRow({ item }: { item: Attention }) {
  const body = (
    <>
      <span className="flex size-6 shrink-0 items-center justify-center">
        {item.kind === "failed" ? (
          <Icon name="warning" size={15} className="text-signal" />
        ) : (
          item.review && <StatusDot state={reviewState(item.review)} />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-medium text-ink">{item.title}</span>
        <span className="block truncate text-[13px] text-ink-3">{item.why}</span>
      </span>
      {item.when && (
        <span
          className={cn("tabular shrink-0 text-[13px]", item.urgent ? "text-signal" : "text-ink-3")}
        >
          {item.when}
        </span>
      )}
      <Icon
        name="chevronRight"
        size={14}
        className="shrink-0 text-ink-3 opacity-0 transition-opacity group-hover:opacity-100"
      />
    </>
  );
  return (
    <li>
      {item.kind === "review" ? (
        <Link to="/reviews/$reviewId" params={{ reviewId: item.targetId }} className={rowClass}>
          {body}
        </Link>
      ) : (
        <Link to="/files/$fileId" params={{ fileId: item.targetId }} className={rowClass}>
          {body}
        </Link>
      )}
    </li>
  );
}

function ProjectCard({ project, waiting }: { project: HomeProject; waiting: number }) {
  const pct = progress(project.approvedTracks, project.versionedTracks);
  const counts: { icon: IconName; n: number; label: string }[] = [
    { icon: "review", n: project.openReviews, label: "open reviews" },
    { icon: "comment", n: project.openComments, label: "open comments" },
  ];
  return (
    <Link
      to="/projects/$projectId"
      params={{ projectId: project.id }}
      className="group flex min-w-0 flex-col overflow-hidden rounded-panel-lg border border-line bg-raised/25 shadow-1 transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-px hover:border-edge hover:shadow-3"
    >
      <ProjectCover profile={project.profile} size="lg" />
      <span className="flex flex-col gap-3 p-4">
        <span className="flex items-start gap-3">
          <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-ink">
            {project.name}
          </span>
          {waiting > 0 && (
            <span className="tabular shrink-0 rounded-full bg-signal px-2 text-[12px] leading-[20px] font-medium text-ground">
              {waiting} on you
            </span>
          )}
        </span>
        <span className="flex flex-col gap-1.5">
          <span className="flex items-center justify-between gap-3 text-[12px] text-ink-3">
            <span className="truncate">
              {pct === null
                ? `${project.files} file${project.files === 1 ? "" : "s"}`
                : `${project.approvedTracks} of ${project.versionedTracks} tracks approved`}
            </span>
            {pct !== null && <span className="tabular">{pct}%</span>}
          </span>
          <span className={cn("h-1 overflow-hidden rounded-full", pct !== null && "bg-raised")}>
            {pct !== null && (
              <span
                className="block h-full rounded-full bg-ink-2 transition-[width] duration-500"
                style={{ width: `${pct}%` }}
              />
            )}
          </span>
        </span>
        <span className="flex items-center gap-3 text-[12px] text-ink-3">
          {project.members > 0 && (
            <AvatarRow people={project.faces} total={project.members} size={20} />
          )}
          {counts.map((c) => (
            <span
              key={c.icon}
              className="tabular flex items-center gap-1"
              title={`${c.n} ${c.label}`}
            >
              <Icon name={c.icon} size={12} /> {c.n}
            </span>
          ))}
          <span className="tabular ml-auto truncate">{ago(project.updatedAt)}</span>
        </span>
      </span>
    </Link>
  );
}

function NewProjectTile({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-[200px] flex-col items-center justify-center gap-2 rounded-panel-lg border border-dashed border-line-strong text-ink-3 transition-colors hover:border-edge-strong hover:text-ink"
    >
      <span className="flex size-9 items-center justify-center rounded-full border border-line-strong">
        <Icon name="plus" size={16} />
      </span>
      <span className="text-[13px]">New project</span>
    </button>
  );
}

function ActivityRow({ a }: { a: HomeActivity }) {
  const body = (
    <>
      {a.who ? (
        <Avatar id={a.who.id} name={a.who.name} size={24} />
      ) : (
        <span className="flex size-6 shrink-0 items-center justify-center text-ink-3">
          <Icon name="review" size={14} />
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">
        {a.who && <span className="text-ink">{a.who.name} </span>}
        {activityText(a)}
      </span>
      <span className="tabular shrink-0 text-[12px] text-ink-3">{ago(a.at)}</span>
    </>
  );
  const cls =
    "flex items-center gap-3 rounded-panel px-3 py-2 transition-colors hover:bg-raised/60";
  return (
    <li>
      {a.kind === "comment" ? (
        <Link to="/files/$fileId" params={{ fileId: a.fileId }} className={cls}>
          {body}
        </Link>
      ) : a.kind === "version" ? (
        <Link to="/tracks/$trackId" params={{ trackId: a.trackId }} className={cls}>
          {body}
        </Link>
      ) : (
        <Link to="/reviews/$reviewId" params={{ reviewId: a.reviewId }} className={cls}>
          {body}
        </Link>
      )}
    </li>
  );
}

function ComingUp({ reviews, now }: { reviews: MyReview[]; now: number }) {
  const deadlines = deadlinesOf(reviews);
  return (
    <Card>
      <ul className="flex flex-col p-1.5">
        {deadlines.slice(0, 6).map((d) => {
          const due = dueIn(d.at, now);
          const date = new Date(d.at);
          return (
            <li key={d.id}>
              <Link
                to="/reviews/$reviewId"
                params={{ reviewId: d.id }}
                className="flex items-center gap-3.5 rounded-panel px-3 py-2 transition-colors hover:bg-raised/60"
              >
                <span
                  className={cn(
                    "tabular flex w-11 shrink-0 flex-col items-center rounded-control border py-1 leading-none",
                    due.days < 0 ? "border-signal/40 text-signal" : "border-line text-ink-2",
                  )}
                >
                  <span className="text-[15px] font-medium">{date.getDate()}</span>
                  <span className="mt-0.5 text-[10px] uppercase">{monthFormat.format(date)}</span>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] text-ink">{d.title}</span>
                  <span className="block truncate text-[12px] text-ink-3">
                    Review · {d.project}
                  </span>
                </span>
                <span
                  className={cn(
                    "tabular shrink-0 text-[12px]",
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
          <li className="px-3 py-4 text-[13px] text-ink-3">
            No dates ahead. Reviews with a due date appear here.
          </li>
        )}
      </ul>
    </Card>
  );
}

/** Placeholders in the page's shape while its figures arrive, so nothing jumps. */
function Loading() {
  const block = "animate-pulse rounded-panel-lg bg-raised/40";
  return (
    <div role="status" aria-busy="true" aria-label="Loading" className="flex flex-col gap-8">
      <div className={cn(block, "h-[124px]")} />
      <div className="grid grid-cols-2 gap-3 @3xl/app:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={cn(block, "h-[98px]")} />
        ))}
      </div>
      <div className="grid gap-4 @3xl/app:grid-cols-2 @6xl/app:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className={cn(block, "h-[200px]")} />
        ))}
      </div>
    </div>
  );
}

/**
 * Home: what waits on you, the figures that matter this week, your projects, what is coming
 * and what has happened. It answers "what do I do next" without opening a project.
 */
export function HomePage() {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const me = useQuery(meQuery).data;
  const home = useQuery(homeQuery);
  const mine = useQuery(myReviewsQuery);
  const now = Date.now();
  const first = me?.user.name.split(/\s+/)[0];
  const error = home.error ?? mine.error;

  const create = (
    <Dialog title="New project" onClose={() => setCreating(false)} width="lg">
      <NewProject
        bare
        onDone={() => setCreating(false)}
        onCreated={(p) =>
          void navigate({ to: "/projects/$projectId", params: { projectId: p.id } })
        }
      />
    </Dialog>
  );

  let content: ReactNode;
  if (error) {
    content = <p className="m-0 text-signal">{error.message}</p>;
  } else if (!home.data || !mine.data) {
    content = <Loading />;
  } else if (home.data.projects.length === 0 && mine.data.length === 0) {
    content = (
      <Empty
        title="Nothing here yet"
        text="Start a project, or wait to be added to one. Reviews asked of you gather here."
        action={
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={14} />
            New project
          </Button>
        }
      />
    );
  } else {
    const reviews = mine.data;
    const attention = attentionFor(reviews, home.data.failed, now);
    const f = figures(reviews, home.data, now);
    const waitingBy = new Map<string, number>();
    for (const r of reviews)
      if (r.yourTurn && r.status === "open")
        waitingBy.set(r.projectId, (waitingBy.get(r.projectId) ?? 0) + 1);
    content = (
      <>
        <Section
          title="Needs you"
          hint={attention.length ? String(attention.length) : undefined}
          action={
            <Button variant="ghost" size="sm" asChild>
              <Link to="/inbox">Open the inbox</Link>
            </Button>
          }
        >
          {attention.length === 0 ? (
            <Card className="px-4 py-6 text-[14px] text-ink-3">
              You are all caught up. Reviews asked of you, and files that need replacing, arrive
              here.
            </Card>
          ) : (
            <Card>
              <ul className="flex flex-col p-1.5">
                {attention.slice(0, ATTENTION_SHOWN).map((a) => (
                  <AttentionRow key={a.id} item={a} />
                ))}
              </ul>
              {attention.length > ATTENTION_SHOWN && (
                <Link
                  to="/inbox"
                  className="block border-t border-line px-4 py-2.5 text-[13px] text-ink-3 hover:text-ink"
                >
                  {attention.length - ATTENTION_SHOWN} more in the inbox
                </Link>
              )}
            </Card>
          )}
        </Section>

        <div className="grid grid-cols-2 gap-3 @3xl/app:grid-cols-4">
          <Stat
            label="In review"
            value={f.inReview}
            hint={f.yourTurn ? `${f.yourTurn} waiting on you` : "none waiting on you"}
          />
          <Stat
            label="Due this week"
            value={f.dueThisWeek}
            hint={f.overdue ? `${f.overdue} overdue` : "nothing overdue"}
            flag={f.overdue > 0}
          />
          <Stat label="Open comments" value={f.openComments} hint="across your projects" />
          <Stat label="New versions" value={f.newVersions} hint="in the last seven days" />
        </div>

        <Section
          title="Projects"
          hint={String(home.data.projects.length)}
          action={
            <Button variant="ghost" size="sm" asChild>
              <Link to="/projects">All projects</Link>
            </Button>
          }
        >
          <div className="grid gap-4 @3xl/app:grid-cols-2 @6xl/app:grid-cols-3">
            {home.data.projects.slice(0, 5).map((p) => (
              <ProjectCard key={p.id} project={p} waiting={waitingBy.get(p.id) ?? 0} />
            ))}
            <NewProjectTile onClick={() => setCreating(true)} />
          </div>
        </Section>

        <div className="grid gap-8 @5xl/app:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <Section title="Coming up">
            <ComingUp reviews={reviews} now={now} />
          </Section>
          <Section title="Activity">
            <Card>
              <ul className="flex flex-col p-1.5">
                {home.data.activity.map((a) => (
                  <ActivityRow key={a.id} a={a} />
                ))}
                {home.data.activity.length === 0 && (
                  <li className="px-3 py-4 text-[13px] text-ink-3">
                    Nothing yet. Comments, versions and reviews appear here as they happen.
                  </li>
                )}
              </ul>
            </Card>
          </Section>
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Home" />
      <Page>
        <div className="flex flex-col gap-1">
          <span className="eyebrow">{dayFormat.format(now)}</span>
          <p className="title m-0">
            {greeting(new Date(now).getHours())}
            {first ? `, ${first}` : ""}
          </p>
        </div>
        {content}
      </Page>
      {creating && create}
    </>
  );
}
