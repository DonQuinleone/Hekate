import {
  type DeliveryProfileId,
  deliveryProfiles,
  type OverviewSection,
  overviewSections,
  profiles,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AvatarRow } from "~/components/avatar";
import { ActivityRow, Section, Stat } from "~/components/dashboard";
import { Empty } from "~/components/empty";
import { Icon } from "~/components/icons";
import { Card } from "~/components/page";
import { ProjectCover } from "~/components/project-cover";
import { Property } from "~/components/property";
import { reviewState } from "~/components/reviews";
import { Button } from "~/components/ui/button";
import { usePopover } from "~/components/ui/menu";
import { StatusDot } from "~/components/ui/status";
import { Switch } from "~/components/ui/toggle";
import { cn } from "~/lib/cn";
import { ago } from "~/lib/comments";
import { dueIn } from "~/lib/home";
import {
  moveSection,
  type OverviewAttention,
  overviewAttention,
  sectionNames,
  sectionsOf,
  trackStateCopy,
} from "~/lib/overview";
import {
  myReviewsQuery,
  type ProjectOverview as OverviewData,
  type Project,
  projectOverviewQuery,
  projectReviewsQuery,
  useOverviewLayout,
  useProjectCan,
} from "~/lib/queries";

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const ATTENTION_SHOWN = 5;

const rowClass =
  "group flex items-center gap-3.5 rounded-panel px-3 py-2.5 transition-colors hover:bg-raised/60 focus-visible:bg-raised/60";

/** Which sections the overview shows, and in what order: each person's own. */
function Customise({
  sections,
  names,
  onChange,
}: {
  sections: OverviewSection[];
  names: Record<OverviewSection, string>;
  onChange: (sections: OverviewSection[]) => void;
}) {
  const [open, setOpen, box] = usePopover();
  const listed = [...sections, ...overviewSections.filter((id) => !sections.includes(id))];
  return (
    <div ref={box} className="relative shrink-0">
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
      >
        <Icon name="sliders" size={14} />
        Customise
      </Button>
      {open && (
        <div
          role="dialog"
          aria-label="Customise the overview"
          data-e2e-overlap
          className="rise-in absolute right-0 z-30 mt-1 w-64 rounded-panel-lg bg-overlay p-2 shadow-4"
        >
          <p className="eyebrow m-0 px-2 text-ink-2">Sections, in order</p>
          <ul className="m-0 mt-1 flex list-none flex-col p-0">
            {listed.map((id) => {
              const on = sections.includes(id);
              return (
                <li
                  key={id}
                  className="flex h-8 items-center gap-1 rounded-control px-2 text-[13px] text-ink"
                >
                  <Switch
                    label={names[id]}
                    checked={on}
                    onChange={(v) =>
                      onChange(v ? [...sections, id] : sections.filter((s) => s !== id))
                    }
                  />
                  <span className="ml-1.5 min-w-0 flex-1 truncate">{names[id]}</span>
                  {on && (
                    <>
                      <button
                        type="button"
                        aria-label={`Move ${names[id]} up`}
                        onClick={() => onChange(moveSection(sections, id, -1))}
                        className="flex size-6 items-center justify-center rounded-control text-ink-2 hover:bg-raised hover:text-ink"
                      >
                        <Icon name="chevronUp" size={12} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Move ${names[id]} down`}
                        onClick={() => onChange(moveSection(sections, id, 1))}
                        className="flex size-6 items-center justify-center rounded-control text-ink-2 hover:bg-raised hover:text-ink"
                      >
                        <Icon name="chevronDown" size={12} />
                      </button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="mt-2 border-t border-line px-2 pt-2">
            <button
              type="button"
              onClick={() => onChange([...overviewSections])}
              className="text-[12px] text-ink-2 hover:text-ink"
            >
              Reset
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function AttentionRow({ item }: { item: OverviewAttention }) {
  const body = (
    <>
      <span className="flex size-6 shrink-0 items-center justify-center">
        {item.kind === "failed" ? (
          <Icon name="warning" size={15} className="text-signal" />
        ) : item.kind === "qa" ? (
          <Icon name="pulse" size={15} className="text-ink-3" />
        ) : item.kind === "overdue" ? (
          <StatusDot state="changes_requested" />
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
      {item.kind === "review" || item.kind === "overdue" ? (
        <Link to="/reviews/$reviewId" params={{ reviewId: item.targetId }} className={rowClass}>
          {body}
        </Link>
      ) : (
        <Link
          to="/files/$fileId"
          params={{ fileId: item.targetId }}
          search={item.kind === "qa" ? { view: "qa" } : {}}
          className={rowClass}
        >
          {body}
        </Link>
      )}
    </li>
  );
}

/**
 * A project's first page: what needs attention, its figures, where each track stands, what is
 * in review, what has happened and its properties. Each person orders and hides the sections.
 */
export function ProjectOverview({ project }: { project: Project }) {
  const overview = useQuery(projectOverviewQuery(project.id));
  const mine = useQuery(myReviewsQuery);
  const reviews = useQuery(projectReviewsQuery(project.id));
  const layout = useOverviewLayout(project.id);
  const can = useProjectCan(project.id);
  const noun = project.profile === "video" ? "Deliverables" : "Tracks";
  const names = sectionNames(noun);

  if (overview.error) return <p className="m-0 text-signal">{overview.error.message}</p>;
  if (!overview.data) return <p className="m-0 text-ink-3">Loading</p>;
  const o: OverviewData = overview.data;
  const f = o.figures;
  const sections = sectionsOf(o.layout).filter(
    // A general project has no tracks to list.
    (s) => !(s === "tracks" && project.profile === "general"),
  );
  const attention = overviewAttention(o, mine.data ?? [], project.id);
  const open = (reviews.data ?? []).filter((r) => r.status === "open");
  const empty = f.files === 0 && f.tracks === 0;

  const render: Record<OverviewSection, ReactNode> = {
    attention: (
      <Section
        title={names.attention}
        hint={attention.length ? String(attention.length) : undefined}
      >
        {attention.length === 0 ? (
          <Card className="px-4 py-5 text-[14px] text-ink-3">
            Nothing needs attention. Everything is where it should be.
          </Card>
        ) : (
          <Card>
            <ul className="m-0 flex list-none flex-col p-1.5">
              {attention.slice(0, ATTENTION_SHOWN).map((a) => (
                <AttentionRow key={a.id} item={a} />
              ))}
            </ul>
          </Card>
        )}
      </Section>
    ),
    stats: (
      <section
        aria-label={names.stats}
        className={cn(
          "grid grid-cols-2 gap-3",
          f.openComments === null ? "@3xl/app:grid-cols-3" : "@3xl/app:grid-cols-4",
        )}
      >
        {project.profile === "general" ? (
          <Stat label="Files" value={f.files} hint={`${f.processing} processing`} />
        ) : (
          <Stat
            label={`${noun} approved`}
            value={`${f.approvedTracks} of ${f.versionedTracks}`}
            hint={`${f.tracks - f.versionedTracks} without a version`}
          />
        )}
        <Stat
          label="In review"
          value={f.openReviews}
          hint={
            f.nextDueAt ? `next due ${dateFormat.format(new Date(f.nextDueAt))}` : "nothing due"
          }
        />
        {f.openComments !== null && (
          <Stat label="Open comments" value={f.openComments} hint="threads not yet resolved" />
        )}
        <Stat
          label="Processing"
          value={f.processing}
          hint={f.processing ? "uploads being prepared" : "everything is ready"}
        />
      </section>
    ),
    tracks: (
      <Section
        title={noun}
        hint={String(o.tracks.length)}
        action={
          <Button variant="ghost" size="sm" asChild>
            <Link to="/projects/$projectId/files" params={{ projectId: project.id }}>
              All files
            </Link>
          </Button>
        }
      >
        <Card>
          <ul className="m-0 flex list-none flex-col p-1.5">
            {o.tracks.map((t) => {
              const copy = trackStateCopy[t.state];
              const inner = (
                <>
                  <span className="flex h-9 w-12 shrink-0 items-center justify-center rounded-[5px] border border-line-strong text-ink-3">
                    <Icon name="track" size={14} />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[14px] font-medium text-ink">
                      {t.name}
                    </span>
                    <span className="block truncate text-[13px] text-ink-3">
                      {t.version ? `V${t.version.number}` : "No versions yet"}
                      {t.version && <span className="@3xl/app:hidden"> · {copy.label}</span>}
                    </span>
                  </span>
                  <span className="hidden items-center gap-2 text-[13px] text-ink-2 @3xl/app:flex">
                    {copy.dot && <StatusDot state={copy.dot} />}
                    <span className="truncate">{copy.label}</span>
                  </span>
                  <span className="hidden items-center gap-2 text-[13px] text-ink-3 @3xl/app:flex">
                    {t.waitingOn.length > 0 && (
                      <>
                        <AvatarRow people={t.waitingOn} size={18} max={3} />
                        <span className="truncate">waiting</span>
                      </>
                    )}
                  </span>
                  <span className="tabular text-right text-[13px] text-ink-3">
                    {t.version ? ago(t.version.createdAt) : ""}
                  </span>
                </>
              );
              const cls =
                "grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3.5 rounded-panel px-2.5 py-2 transition-colors hover:bg-raised/60 @3xl/app:grid-cols-[auto_minmax(0,1fr)_170px_160px_96px]";
              return (
                <li key={t.id}>
                  {t.version?.fileId ? (
                    <Link to="/files/$fileId" params={{ fileId: t.version.fileId }} className={cls}>
                      {inner}
                    </Link>
                  ) : (
                    <Link to="/tracks/$trackId" params={{ trackId: t.id }} className={cls}>
                      {inner}
                    </Link>
                  )}
                </li>
              );
            })}
            {o.tracks.length === 0 && (
              <li className="px-3 py-4 text-[13px] text-ink-3">
                No {noun.toLowerCase()} yet. Make one from the files page.
              </li>
            )}
          </ul>
        </Card>
      </Section>
    ),
    reviews: (
      <Section
        title={names.reviews}
        hint={String(open.length)}
        action={
          <Button variant="ghost" size="sm" asChild>
            <Link to="/projects/$projectId/reviews" params={{ projectId: project.id }}>
              All reviews
            </Link>
          </Button>
        }
      >
        <Card>
          <ul className="m-0 flex list-none flex-col p-1.5">
            {open.map((r) => (
              <li key={r.id}>
                <Link
                  to="/reviews/$reviewId"
                  params={{ reviewId: r.id }}
                  className="flex items-center gap-3 rounded-panel px-2.5 py-2 transition-colors hover:bg-raised/60"
                >
                  <StatusDot state={reviewState(r)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] text-ink">{r.title}</span>
                    <span className="block truncate text-[12px] text-ink-3">
                      {r.kind === "approval" ? "Approval" : "Feedback"} · {r.submitted} of{" "}
                      {r.reviewers} responded
                    </span>
                  </span>
                  {r.dueAt && (
                    <span
                      className={cn(
                        "tabular shrink-0 text-right text-[12px]",
                        dueIn(r.dueAt).days < 0 ? "text-signal" : "text-ink-3",
                      )}
                    >
                      {dueIn(r.dueAt).label}
                    </span>
                  )}
                </Link>
              </li>
            ))}
            {open.length === 0 && (
              <li className="px-3 py-4 text-[13px] text-ink-3">Nothing in review.</li>
            )}
          </ul>
        </Card>
      </Section>
    ),
    activity: (
      <Section title={names.activity}>
        <Card>
          {o.activity.length === 0 ? (
            <p className="m-0 px-4 py-5 text-[14px] text-ink-3">Nothing has happened yet.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col p-1.5">
              {o.activity.map((a) => (
                <ActivityRow key={a.id} a={a} />
              ))}
            </ul>
          )}
        </Card>
      </Section>
    ),
    properties: (
      <Section title={names.properties}>
        <Card className="px-4 py-2">
          <dl className="m-0 flex flex-col">
            <Property name="Profile">{profiles[project.profile].label}</Property>
            {o.deliveryProfile && (
              <Property name="Delivery">
                {deliveryProfiles[o.deliveryProfile as DeliveryProfileId]?.label ??
                  o.deliveryProfile}
              </Property>
            )}
            <Property name="People">
              <span className="flex items-center gap-2">
                <AvatarRow people={f.faces} total={f.members} size={20} />
                <span className="text-ink-3">{plural(f.members, "member")}</span>
              </span>
            </Property>
            {o.role && <Property name="Your role">{o.role}</Property>}
            {o.createdAt && (
              <Property name="Created">{dateFormat.format(new Date(o.createdAt))}</Property>
            )}
          </dl>
        </Card>
      </Section>
    ),
  };

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-start gap-4">
        <ProjectCover profile={project.profile} size="md" />
        <div className="min-w-0 flex-1">
          {project.description && (
            <p className="m-0 text-[15px] leading-[22px] text-ink-2">{project.description}</p>
          )}
          <p className="m-0 mt-1 text-[13px] text-ink-3">
            {project.profile === "general"
              ? plural(f.files, "file")
              : plural(f.tracks, noun === "Tracks" ? "track" : "deliverable")}{" "}
            · {plural(f.members, "member")}
          </p>
        </div>
        <Customise sections={sections} names={names} onChange={(s) => layout.mutate(s)} />
      </div>
      {empty ? (
        <Empty
          title="Nothing here yet"
          text={
            can("upload")
              ? "Upload recordings, cuts, scores or documents to start, then ask for a review."
              : "Files arrive here as the project's members upload them."
          }
          action={
            can("upload") ? (
              <Button variant="primary" asChild>
                <Link to="/projects/$projectId/files" params={{ projectId: project.id }}>
                  <Icon name="upload" size={14} />
                  Upload files
                </Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        sections.map((id) => <div key={id}>{render[id]}</div>)
      )}
    </div>
  );
}
