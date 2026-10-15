import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { Avatar, AvatarRow } from "~/components/avatar";
import { Icon, type IconName } from "~/components/icons";
import { Label } from "~/components/label";
import { Card, Page, SectionHead } from "~/components/page";
import { usePageHeader } from "~/components/page-header";
import { ProjectCover } from "~/components/project-card";
import { Property } from "~/components/property";
import { ShareDialog } from "~/components/share";
import { Dot, reviewDot } from "~/components/status";
import { Thumb } from "~/components/thumb";
import { Button } from "~/components/ui/button";
import { usePopover } from "~/components/ui/menu";
import { Switch } from "~/components/ui/toggle";
import {
  activity,
  comments,
  deliveryProfiles,
  findingsFor,
  type Project,
  personById,
  primaryFile,
  projectById,
  type Review,
  reviews,
  tasks,
  tracks,
  workflows,
} from "~/data";
import { cn } from "~/lib/cn";
import { ago, dueIn, formatDate, plural } from "~/lib/format";
import { viewLabel } from "~/lib/project-nav";
import { kindCopy, needsYou, responded, reviewOutcome } from "~/lib/reviews";
import { trackState } from "~/lib/tracks";
import { useViewer } from "~/viewer/context";
import { Empty, Refused, StateGate } from "~/viewer/state-gate";
import { ProductionView } from "./production.tsx";
import { Board } from "./project-board.tsx";
import { Files } from "./project-files.tsx";
import { People } from "./project-people.tsx";
import { ProjectSettingsRoute } from "./project-settings.tsx";
import { ProjectTasks } from "./project-tasks.tsx";
import { CoverageView } from "./takes.tsx";
import { WorkflowRoute } from "./workflow.tsx";

/* ---------- Overview ---------- */

type SectionId = "attention" | "stats" | "tracks" | "reviews" | "activity" | "properties";
const sectionNames: Record<SectionId, string> = {
  attention: "Needs attention",
  stats: "At a glance",
  tracks: "Tracks",
  reviews: "In review",
  activity: "Activity",
  properties: "Properties",
};
const defaultSections: SectionId[] = [
  "attention",
  "stats",
  "tracks",
  "reviews",
  "activity",
  "properties",
];
const OVERVIEW_KEY = "hekate.prototype.overview";

function useSections(): [SectionId[], (s: SectionId[]) => void] {
  const [sections, set] = useState<SectionId[]>(() => {
    try {
      const raw = localStorage.getItem(OVERVIEW_KEY);
      return raw ? (JSON.parse(raw) as SectionId[]) : defaultSections;
    } catch {
      return defaultSections;
    }
  });
  return [
    sections,
    (s) => {
      set(s);
      try {
        localStorage.setItem(OVERVIEW_KEY, JSON.stringify(s));
      } catch {
        // Not remembered.
      }
    },
  ];
}

/** Which sections the overview shows, and in what order: everyone's own. */
function CustomiseOverview({
  sections,
  set,
}: {
  sections: SectionId[];
  set: (s: SectionId[]) => void;
}) {
  const [open, setOpen, box] = usePopover();
  const all = defaultSections;
  const move = (id: SectionId, dir: -1 | 1) => {
    const i = sections.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= sections.length) return;
    const next = [...sections];
    [next[i], next[j]] = [next[j] as SectionId, next[i] as SectionId];
    set(next);
  };
  return (
    <div ref={box} className="relative">
      <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="sliders" size={14} />
        Customise
      </Button>
      {open && (
        <div className="rise-in absolute right-0 z-30 mt-1 w-64 rounded-panel-lg bg-overlay p-2 shadow-4">
          <Label className="px-2">Sections, in order</Label>
          <ul className="mt-1 flex flex-col">
            {[...sections, ...all.filter((id) => !sections.includes(id))].map((id) => {
              const on = sections.includes(id);
              return (
                <li
                  key={id}
                  className="flex h-8 items-center gap-1 rounded-control px-2 text-[13px] text-ink hover:bg-raised/60"
                >
                  <Switch
                    label={sectionNames[id]}
                    checked={on}
                    onChange={(v) => set(v ? [...sections, id] : sections.filter((s) => s !== id))}
                  />
                  <span className="ml-1.5 flex-1 truncate">{sectionNames[id]}</span>
                  {on && (
                    <>
                      <button
                        type="button"
                        aria-label="Move up"
                        onClick={() => move(id, -1)}
                        className="flex size-6 items-center justify-center rounded-control text-ink-3 hover:text-ink"
                      >
                        <Icon name="chevronUp" size={12} />
                      </button>
                      <button
                        type="button"
                        aria-label="Move down"
                        onClick={() => move(id, 1)}
                        className="flex size-6 items-center justify-center rounded-control text-ink-3 hover:text-ink"
                      >
                        <Icon name="chevronDown" size={12} />
                      </button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="mt-2 border-t border-line px-2 pt-2 text-[12px]">
            <button
              type="button"
              onClick={() => set(defaultSections)}
              className="text-ink-3 hover:text-ink"
            >
              Reset
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  flag,
  to,
}: {
  label: string;
  value: string | number;
  hint?: string;
  flag?: boolean;
  to?: string;
}) {
  const body = (
    <>
      <span className="text-[13px] text-ink-3">{label}</span>
      <span
        className={cn(
          "tabular mt-1 block text-[26px] leading-[30px] font-semibold tracking-[-0.02em]",
          flag ? "text-signal" : "text-ink",
        )}
      >
        {value}
      </span>
      {hint && <span className="mt-0.5 block truncate text-[12px] text-ink-3">{hint}</span>}
    </>
  );
  const cls =
    "flex flex-col rounded-panel-lg border border-line bg-raised/25 px-4 py-3 shadow-1 transition-colors";
  return to ? (
    <Link to={to} className={cn(cls, "hover:border-edge")}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

function Overview({ project }: { project: Project }) {
  const viewer = useViewer();
  const [sections, setSections] = useSections();
  const workflow = workflows.find((w) => w.id === project.workflowId);
  const projectTracks = tracks.filter((t) => t.projectId === project.id);
  const states = projectTracks.map((t) => ({ track: t, s: trackState(t, project) }));
  const open = reviews.filter((r) => r.projectId === project.id && r.status === "open");
  const recent = activity.filter((a) => a.projectId === project.id).slice(0, 8);
  const openTasks = tasks.filter((t) => t.projectId === project.id && t.status !== "done");
  const fileIds = new Set(
    projectTracks.flatMap((t) => t.versions.flatMap((v) => v.variations.map((x) => x.fileId))),
  );
  const openComments = comments.filter(
    (c) => fileIds.has(c.fileId) && !c.parentId && !c.resolved,
  ).length;
  const approved = states.filter((x) => x.s.version?.status === "Approved").length;
  const withVersion = states.filter((x) => x.s.version).length;
  const noun = project.profile === "music" ? "tracks" : "deliverables";
  const nextDue = open
    .filter((r) => r.dueAt)
    .sort((a, b) => (a.dueAt as string).localeCompare(b.dueAt as string))[0];

  const attention: {
    id: string;
    icon?: IconName;
    dot?: ReturnType<typeof reviewDot>;
    title: string;
    why: string;
    when?: string;
    urgent?: boolean;
    to: string;
    params?: Record<string, string>;
    search?: Record<string, string>;
  }[] = [
    ...open
      .filter((r) => needsYou(r, viewer.reviewerIn(r)))
      .map((r) => ({
        id: r.id,
        dot: reviewDot(r.status, reviewOutcome(r)),
        title: r.title,
        why: r.kind === "approval" ? "Your decision is asked for" : "Your feedback is asked for",
        when: r.dueAt ? dueIn(r.dueAt).label : undefined,
        urgent: Boolean(r.dueAt && dueIn(r.dueAt).days < 1),
        to: "/reviews/$reviewId",
        params: { reviewId: r.id },
      })),
    ...open
      .filter((r) => r.dueAt && dueIn(r.dueAt).days < 0 && !needsYou(r, viewer.reviewerIn(r)))
      .map((r) => ({
        id: `over-${r.id}`,
        dot: "changes_requested" as const,
        title: r.title,
        why: `Overdue, waiting on ${
          r.reviewers
            .filter((x) => x.state !== "submitted")
            .map((x) => personById(x.personId).name.split(" ")[0])
            .join(", ") || "nobody"
        }`,
        when: dueIn(r.dueAt as string).label,
        urgent: true,
        to: "/reviews/$reviewId",
        params: { reviewId: r.id },
      })),
    ...states
      .filter((x) => x.s.version?.state === "failed")
      .map((x) => ({
        id: `fail-${x.track.id}`,
        icon: "warning" as IconName,
        title: `${x.track.name} V${x.s.version?.number} could not be analysed`,
        why: "The file needs replacing",
        urgent: true,
        to: "/tracks/$trackId",
        params: { trackId: x.track.id },
        search: { view: "versions" },
      })),
    ...states
      .filter(
        (x) =>
          x.s.version &&
          findingsFor(primaryFile(x.s.version)?.id ?? "").some((f) => f.severity === "fail"),
      )
      .map((x) => ({
        id: `qa-${x.track.id}`,
        icon: "pulse" as IconName,
        title: `${x.track.name} V${x.s.version?.number} fails a delivery check`,
        why:
          findingsFor(primaryFile(x.s.version as NonNullable<typeof x.s.version>)?.id ?? "").find(
            (f) => f.severity === "fail",
          )?.summary ?? "",
        to: "/files/$fileId",
        params: { fileId: primaryFile(x.s.version as NonNullable<typeof x.s.version>)?.id ?? "" },
        search: { view: "qa" },
      })),
    ...openTasks
      .filter((t) => t.dueAt && dueIn(`${t.dueAt}T23:59:00Z`).days < 0)
      .map((t) => ({
        id: t.id,
        icon: "task" as IconName,
        title: t.title,
        why: t.assigneeId
          ? `Overdue task for ${personById(t.assigneeId).name}`
          : "Overdue and unassigned",
        when: dueIn(`${t.dueAt}T23:59:00Z`).label,
        urgent: true,
        to: "/projects/$projectId/$view",
        params: { projectId: project.id, view: "tasks" },
        search: { task: t.id },
      })),
  ];

  const render: Record<SectionId, ReactNode> = {
    attention: (
      <section className="flex flex-col gap-3">
        <SectionHead
          title="Needs attention"
          hint={attention.length ? String(attention.length) : undefined}
        />
        {attention.length === 0 ? (
          <Card className="px-4 py-5 text-[14px] text-ink-3">
            Nothing needs attention. Everything is where it should be.
          </Card>
        ) : (
          <Card>
            <ul className="flex flex-col p-1.5">
              {attention.slice(0, 5).map((a) => (
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
                          className={a.urgent ? "text-signal" : "text-ink-3"}
                        />
                      ) : (
                        <Dot state={a.dot ?? "in_review"} />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-medium text-ink">
                        {a.title}
                      </span>
                      <span className="block truncate text-[13px] text-ink-3">{a.why}</span>
                    </span>
                    {a.when && (
                      <span
                        className={cn(
                          "tabular text-[13px]",
                          a.urgent ? "text-signal" : "text-ink-3",
                        )}
                      >
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
              ))}
            </ul>
          </Card>
        )}
      </section>
    ),
    stats: (
      <div className="grid grid-cols-2 gap-3 @3xl/app:grid-cols-4">
        <Stat
          label={`${noun[0]?.toUpperCase()}${noun.slice(1)} approved`}
          value={`${approved} of ${withVersion}`}
          hint={`${projectTracks.length - withVersion} without a version`}
        />
        <Stat
          label="In review"
          value={open.length}
          hint={nextDue ? `next due ${formatDate(nextDue.dueAt as string)}` : "nothing due"}
          to={`/projects/${project.id}/reviews`}
        />
        <Stat
          label="Open comments"
          value={openComments}
          hint={`${comments.filter((c) => fileIds.has(c.fileId) && c.assigneeId && !c.resolved).length} assigned`}
        />
        <Stat
          label="Open tasks"
          value={openTasks.length}
          hint={`${openTasks.filter((t) => t.dueAt && dueIn(`${t.dueAt}T23:59:00Z`).days < 0).length} overdue`}
          flag={openTasks.some((t) => t.dueAt && dueIn(`${t.dueAt}T23:59:00Z`).days < 0)}
          to={`/projects/${project.id}/tasks`}
        />
      </div>
    ),
    tracks: (
      <section className="flex flex-col gap-3">
        <SectionHead
          title={project.profile === "music" ? "Tracks" : "Deliverables"}
          hint={String(projectTracks.length)}
          action={
            <Button variant="ghost" size="sm" asChild>
              <Link
                to="/projects/$projectId/$view"
                params={{ projectId: project.id, view: "files" }}
              >
                All files
              </Link>
            </Button>
          }
        />
        <Card>
          <ul className="flex flex-col p-1.5">
            {states.map(({ track: t, s }) => {
              const file = s.version ? primaryFile(s.version) : undefined;
              return (
                <li key={t.id}>
                  <Link
                    to={file ? "/files/$fileId" : "/tracks/$trackId"}
                    params={file ? { fileId: file.id } : { trackId: t.id }}
                    search={file ? {} : { view: "versions" }}
                    className="group grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3.5 rounded-panel px-2.5 py-2 transition-colors hover:bg-raised/60 @3xl/app:grid-cols-[auto_minmax(0,1fr)_170px_200px_80px]"
                  >
                    {file ? (
                      <Thumb file={file} width={56} height={36} />
                    ) : (
                      <span className="flex h-9 w-14 items-center justify-center rounded-[5px] border border-dashed border-line-strong text-ink-3">
                        <Icon name="track" size={14} />
                      </span>
                    )}
                    <span className="min-w-0">
                      <span className="block truncate text-[14px] font-medium text-ink">
                        {t.name}
                      </span>
                      <span className="block truncate text-[13px] text-ink-3">
                        {s.version ? `V${s.version.number}` : "No versions yet"}
                        <span className="@3xl/app:hidden"> · {s.label}</span>
                        {s.stage && (
                          <span className="hidden @3xl/app:inline"> · {s.stage.name}</span>
                        )}
                      </span>
                    </span>
                    <span className="hidden items-center gap-2 text-[13px] text-ink-2 @3xl/app:flex">
                      <Dot state={s.dot} />
                      <span className="truncate">{s.label}</span>
                    </span>
                    <span className="hidden items-center gap-2 text-[13px] text-ink-3 @3xl/app:flex">
                      {s.waitingOn.length > 0 ? (
                        <>
                          <AvatarRow personIds={s.waitingOn} size={18} max={3} />
                          <span className="truncate">waiting</span>
                        </>
                      ) : s.next ? (
                        <span className="truncate">Next: {s.next.name}</span>
                      ) : null}
                    </span>
                    <span className="tabular text-right text-[13px] text-ink-3">
                      {s.version ? ago(s.version.uploadedAt) : ""}
                    </span>
                  </Link>
                </li>
              );
            })}
            {projectTracks.length === 0 && (
              <li className="px-3 py-4 text-[13px] text-ink-3">Nothing uploaded yet.</li>
            )}
          </ul>
        </Card>
      </section>
    ),
    reviews: (
      <section className="flex flex-col gap-3">
        <SectionHead
          title="In review"
          hint={String(open.length)}
          action={
            <Button variant="ghost" size="sm" asChild>
              <Link
                to="/projects/$projectId/$view"
                params={{ projectId: project.id, view: "reviews" }}
              >
                All reviews
              </Link>
            </Button>
          }
        />
        <Card>
          <ul className="flex flex-col p-1.5">
            {open.map((r) => (
              <li key={r.id}>
                <Link
                  to="/reviews/$reviewId"
                  params={{ reviewId: r.id }}
                  className="flex items-center gap-3 rounded-panel px-2.5 py-2 transition-colors hover:bg-raised/60"
                >
                  <Dot state={reviewDot(r.status, reviewOutcome(r))} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] text-ink">{r.title}</span>
                    <span className="block truncate text-[12px] text-ink-3">
                      {kindCopy[r.kind]} · {responded(r)} of {r.reviewers.length} responded
                    </span>
                  </span>
                  <AvatarRow personIds={r.reviewers.map((x) => x.personId)} size={20} />
                  {r.dueAt && (
                    <span
                      className={cn(
                        "tabular w-20 text-right text-[12px]",
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
      </section>
    ),
    activity: (
      <section className="flex flex-col gap-3">
        <SectionHead title="Activity" />
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
        </Card>
      </section>
    ),
    properties: (
      <section className="flex flex-col gap-3">
        <SectionHead title="Properties" />
        <Card className="flex flex-col gap-0.5 px-4 py-2">
          <Property name="Profile">
            {{ music: "Music", video: "Video", general: "General" }[project.profile]}
          </Property>
          <Property name="Workflow">
            <Link
              to="/projects/$projectId/$view"
              params={{ projectId: project.id, view: "workflow" }}
              className="hover:text-signal"
            >
              {workflow?.name}
            </Link>
          </Property>
          {project.deliveryProfile && (
            <Property name="Delivery">
              {deliveryProfiles.find((d) => d.id === project.deliveryProfile)?.name}
            </Property>
          )}
          <Property name="People">
            <AvatarRow personIds={project.members.map((m) => m.personId)} size={20} />
          </Property>
          <Property name="Your role">{viewer.roleName(project.id) ?? "Organisation"}</Property>
          <Property name="Created">{formatDate(project.createdAt)}</Property>
        </Card>
      </section>
    ),
  };

  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-start gap-4">
        <ProjectCover project={project} size="md" />
        <div className="min-w-0 flex-1">
          <p className="text-[15px] leading-[22px] text-ink-2">{project.description}</p>
          <p className="mt-1 text-[13px] text-ink-3">
            {plural(projectTracks.length, project.profile === "music" ? "track" : "deliverable")} ·{" "}
            {workflow?.name} · {plural(project.members.length, "member")}
          </p>
        </div>
        <CustomiseOverview sections={sections} set={setSections} />
      </div>
      {sections.map((id) => (
        <div key={id}>{render[id]}</div>
      ))}
    </div>
  );
}

/* ---------- Reviews ---------- */

function ProjectReviews({ project }: { project: Project }) {
  const viewer = useViewer();
  const navigate = useNavigate();
  const [sharing, setSharing] = useState(false);
  const list = reviews.filter((r) => r.projectId === project.id && r.kind !== "share");
  const shares = reviews.filter((r) => r.projectId === project.id && r.kind === "share");
  const groups: [string, Review[]][] = [
    ["Open", list.filter((r) => r.status === "open")],
    ["Finished", list.filter((r) => r.status !== "open")],
  ];
  const canRequest = viewer.can(project.id, "request_reviews");
  const toolbar = (
    <div className="flex items-center gap-2">
      <span className="text-[13px] text-ink-3">
        {plural(list.length, "review")}, {plural(shares.length, "share")}
      </span>
      <span className="ml-auto flex gap-1.5">
        {canRequest && (
          <Button variant="secondary" size="md" onClick={() => setSharing(true)}>
            <Icon name="link" size={14} />
            Share
          </Button>
        )}
        {canRequest && (
          <Button
            variant="primary"
            size="md"
            onClick={() => navigate({ to: "/reviews/new", search: { project: project.id } })}
          >
            <Icon name="review" size={14} />
            Request a review
          </Button>
        )}
      </span>
    </div>
  );
  if (list.length === 0)
    return (
      <div className="flex flex-col gap-4">
        {toolbar}
        <Empty
          title="No reviews yet"
          text="Ask people to approve or give feedback on tracks and files. Sharing, for those who only need to listen, is separate."
        />
        {sharing && <ShareDialog project={project} onClose={() => setSharing(false)} />}
      </div>
    );
  return (
    <div className="flex flex-col gap-6">
      {toolbar}
      {groups.map(([title, rows]) =>
        rows.length === 0 ? null : (
          <section key={title} className="flex flex-col gap-3">
            <SectionHead title={title} hint={String(rows.length)} />
            <Card>
              <ul className="flex flex-col p-1.5">
                {rows.map((r) => {
                  const due = r.dueAt ? dueIn(r.dueAt) : null;
                  return (
                    <li key={r.id}>
                      <Link
                        to="/reviews/$reviewId"
                        params={{ reviewId: r.id }}
                        className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3.5 rounded-panel px-2.5 py-2.5 transition-colors hover:bg-raised/60 @3xl/app:grid-cols-[auto_minmax(0,1fr)_120px_130px_150px]"
                      >
                        <Dot state={reviewDot(r.status, reviewOutcome(r))} />
                        <span className="min-w-0">
                          <span className="block truncate text-[14px] font-medium text-ink">
                            {r.title}
                          </span>
                          <span className="block truncate text-[13px] text-ink-3">
                            {kindCopy[r.kind]}
                            {r.order === "sequence" && ", in turn"} ·{" "}
                            {personById(r.requestedBy).name} · {plural(r.items.length, "item")}
                          </span>
                        </span>
                        <span className="hidden @3xl/app:block">
                          <AvatarRow personIds={r.reviewers.map((x) => x.personId)} size={20} />
                        </span>
                        <span
                          className={cn(
                            "tabular hidden text-[13px] @3xl/app:block",
                            r.status === "open" && due && due.days < 0
                              ? "text-signal"
                              : "text-ink-3",
                          )}
                        >
                          {r.dueAt ? (r.status === "open" ? due?.label : formatDate(r.dueAt)) : ""}
                        </span>
                        <span className="text-right text-[13px] text-ink-2">
                          {r.status === "cancelled"
                            ? "Cancelled"
                            : r.status === "completed"
                              ? reviewOutcome(r) === "approved"
                                ? "Approved"
                                : reviewOutcome(r) === "changes_requested"
                                  ? "Changes requested"
                                  : "Finished"
                              : `${responded(r)} of ${r.reviewers.length} responded`}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </Card>
          </section>
        ),
      )}
      {shares.length > 0 && (
        <section className="flex flex-col gap-3">
          <SectionHead title="Shared" hint={String(shares.length)} />
          <Card>
            <ul className="flex flex-col p-1.5">
              {shares.map((r) => (
                <li key={r.id}>
                  <Link
                    to="/reviews/$reviewId"
                    params={{ reviewId: r.id }}
                    className="flex items-center gap-3.5 rounded-panel px-2.5 py-2.5 transition-colors hover:bg-raised/60"
                  >
                    <Icon name="link" size={14} className="text-ink-3" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] text-ink">{r.title}</span>
                      <span className="block truncate text-[13px] text-ink-3">
                        {plural(r.items.length, "item")} ·{" "}
                        {r.reviewers.filter((x) => x.state === "viewed").length} of{" "}
                        {r.reviewers.length} opened
                        {r.dueAt && ` · until ${formatDate(r.dueAt)}`}
                      </span>
                    </span>
                    <AvatarRow personIds={r.reviewers.map((x) => x.personId)} size={20} />
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}
      {sharing && <ShareDialog project={project} onClose={() => setSharing(false)} />}
    </div>
  );
}

/* ---------- The page ---------- */

export function ProjectPage({
  projectId,
  view,
  folderId,
  section,
  taskId,
  month,
  create,
}: {
  projectId: string;
  view: string;
  folderId?: string;
  section?: string;
  taskId?: string;
  create?: boolean;
  month?: string;
}) {
  const viewer = useViewer();
  const navigate = useNavigate();
  const project = projectById(projectId);
  const visible = project && viewer.canSee(projectId);
  const ownHeader = view === "settings" || view === "workflow";
  const overview = view === "overview";
  usePageHeader(
    ownHeader
      ? null
      : {
          crumbs:
            overview || !project || !visible
              ? [{ label: "Projects", to: "/projects" }]
              : [{ label: project.name, to: `/projects/${project.id}` }],
          title:
            project && visible
              ? overview
                ? project.name
                : viewLabel(project, viewer, view)
              : "Not found",
          actions: visible ? (
            <>
              {viewer.can(projectId, "request_reviews") && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => navigate({ to: "/reviews/new", search: { project: projectId } })}
                >
                  Request a review
                </Button>
              )}
              {viewer.can(projectId, "upload") && (
                <Button variant="primary" size="sm">
                  <Icon name="upload" size={14} />
                  Upload
                </Button>
              )}
            </>
          ) : undefined,
        },
  );
  if (!project || !visible) return <Refused />;
  if (view === "workflow") return <WorkflowRoute projectId={project.id} />;
  if (view === "settings") return <ProjectSettingsRoute projectId={project.id} section={section} />;
  return (
    <Page className="gap-6">
      <StateGate>
        {view === "overview" && <Overview project={project} />}
        {view === "files" && <Files project={project} folderId={folderId ?? null} />}
        {view === "board" && <Board project={project} month={month} />}
        {view === "reviews" && <ProjectReviews project={project} />}
        {view === "tasks" && <ProjectTasks project={project} taskId={taskId} create={create} />}
        {view === "people" && <People project={project} />}
        {view === "sessions" && <ProductionView project={project} section="sessions" />}
        {view === "coverage" && <CoverageView project={project} />}
        {view === "production" && <ProductionView project={project} section={section} />}
      </StateGate>
    </Page>
  );
}
