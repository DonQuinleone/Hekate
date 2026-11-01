import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { ActivityRow, Section, Stat } from "~/components/dashboard";
import { Empty } from "~/components/empty";
import { Icon } from "~/components/icons";
import { NeedsYouDot } from "~/components/needs-you";
import { Card, Page } from "~/components/page";
import { PageHeader } from "~/components/page-header";
import { ProjectCard } from "~/components/project-card";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Failed } from "~/components/ui/states";
import { cn } from "~/lib/cn";
import { type Attention, attentionFor, deadlinesOf, dueIn, figures, greeting } from "~/lib/home";
import { dateFormats, formatDates } from "~/lib/locale";
import { homeQuery, type MyReview, meQuery, myReviewsQuery } from "~/lib/queries";
import { NewProject } from "~/routes/projects";

/** Shown on the page at most; the rest wait in the reviews list. */
const ATTENTION_SHOWN = 6;

/** Today: the weekday and the date, or the ISO date alone, which a weekday reads oddly before. */
const today = (now: number) =>
  formatDates(
    dateFormats().dateFormat === "iso"
      ? { day: "numeric", month: "long", year: "numeric" }
      : { weekday: "long", day: "numeric", month: "long" },
  ).format(now);
const monthFormat = formatDates({ month: "short" });

const rowClass =
  "group flex items-center gap-3.5 rounded-panel px-3 py-row-tight transition-colors hover:bg-raised/60 focus-visible:bg-raised/60";

function AttentionRow({ item }: { item: Attention }) {
  const body = (
    <>
      <span className="flex size-6 shrink-0 items-center justify-center">
        {item.kind === "failed" ? (
          <Icon name="warning" size={15} className="text-signal" />
        ) : (
          // Every review here is the viewer's turn: the mark of what needs a person.
          <NeedsYouDot />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-medium text-ink">{item.title}</span>
        <span className="block truncate text-[13px] text-ink-3">{item.why}</span>
        {/* On a phone the due date goes under the title, so neither line loses its words. */}
        {item.when && (
          <span
            className={cn(
              "tabular block truncate text-[13px] @3xl/app:hidden",
              item.urgent ? "text-signal" : "text-ink-3",
            )}
          >
            {item.when}
          </span>
        )}
      </span>
      {item.when && (
        <span
          className={cn(
            "tabular hidden shrink-0 text-[13px] @3xl/app:block",
            item.urgent ? "text-signal" : "text-ink-3",
          )}
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
                className="flex items-center gap-3.5 rounded-panel px-3 py-row-snug transition-colors hover:bg-raised/60"
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
function HomeSkeleton() {
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
    content = (
      <Failed
        what="Home"
        error={error}
        retry={() => Promise.all([home.refetch(), mine.refetch()])}
      />
    );
  } else if (!home.data || !mine.data) {
    content = <HomeSkeleton />;
  } else if (home.data.projects.length === 0 && mine.data.length === 0) {
    content = (
      <Empty
        title="No projects yet"
        text="Use New project to start one, or wait to be added to one. Reviews asked of you gather here."
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
          <Stat label="In review" value={f.inReview} hint="open reviews you take part in" />
          <Stat
            label="Due in 7 days"
            value={f.dueSoon}
            hint={f.overdue ? `and ${f.overdue} overdue` : "nothing overdue"}
            flag={f.overdue > 0}
          />
          <Stat label="Open comments" value={f.openComments} hint="across your projects" />
          <Stat label="New versions" value={f.newVersions} hint="in the last seven days" />
        </div>

        <Section
          title="Projects"
          hint={String(home.data.projects.length)}
          action={
            <span className="flex items-center gap-1">
              <Button variant="ghost" size="sm" onClick={() => setCreating(true)}>
                <Icon name="plus" size={14} />
                New project
              </Button>
              <Button variant="ghost" size="sm" asChild>
                <Link to="/projects">All projects</Link>
              </Button>
            </span>
          }
        >
          <div className="grid gap-4 @3xl/app:grid-cols-2 @6xl/app:grid-cols-3">
            {home.data.projects.slice(0, 6).map((p) => (
              <ProjectCard key={p.id} project={p} waiting={waitingBy.get(p.id) ?? 0} />
            ))}
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
          <span className="eyebrow">{today(now)}</span>
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
