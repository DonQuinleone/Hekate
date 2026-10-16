import { Link } from "@tanstack/react-router";
import { AvatarRow } from "~/components/avatar";
import { Icon, type IconName } from "~/components/icons";
import { latestVersion, type Project, type ProjectProfile, reviews, tasks, tracks } from "~/data";
import { cn } from "~/lib/cn";
import { ago } from "~/lib/format";
import { needsYou } from "~/lib/reviews";
import { useViewer } from "~/viewer/context";

export const profileIcon: Record<ProjectProfile, IconName> = {
  music: "music",
  video: "film",
  general: "file",
};

const hue: Record<ProjectProfile, [number, number]> = {
  music: [40, 60],
  video: [260, 290],
  general: [150, 170],
};

/** A project's cover: its own hue, lit from a corner, with the profile's mark. */
export function ProjectCover({
  project,
  className,
  size = "md",
}: {
  project: Project;
  className?: string;
  size?: "xs" | "sm" | "md" | "lg";
}) {
  const [a, b] = hue[project.profile];
  return (
    <span
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden text-ink shadow-2",
        size === "xs" && "size-6 rounded-[6px]",
        size === "sm" && "size-9 rounded-control",
        size === "md" && "size-11 rounded-panel",
        size === "lg" && "h-[88px] w-full rounded-t-panel-lg",
        className,
      )}
      style={{
        background: `radial-gradient(120% 90% at 20% 0%, oklch(0.46 0.08 ${a}), oklch(0.2 0.04 ${b}) 70%)`,
      }}
    >
      <span className="absolute inset-0 bg-[radial-gradient(60%_60%_at_80%_100%,rgb(255_255_255/0.08),transparent)]" />
      <Icon
        name={profileIcon[project.profile]}
        size={size === "lg" ? 22 : size === "md" ? 18 : size === "sm" ? 15 : 12}
        className="relative opacity-90"
      />
    </span>
  );
}

/** What a project is up to: its tracks' progress, who is in it, what is open, when it last moved. */
export function projectSummary(project: Project) {
  const its = tracks.filter((t) => t.projectId === project.id);
  const withVersion = its.filter((t) => latestVersion(t));
  const approved = withVersion.filter((t) => latestVersion(t)?.status === "Approved").length;
  const open = reviews.filter((r) => r.projectId === project.id && r.status === "open");
  const openTasks = tasks.filter((t) => t.projectId === project.id && t.status !== "done");
  const latest =
    its
      .flatMap((t) => t.versions)
      .map((v) => v.uploadedAt)
      .sort()
      .at(-1) ?? project.createdAt;
  return { tracks: its, withVersion, approved, open, openTasks, latest };
}

export function ProjectCard({ project, menu }: { project: Project; menu?: React.ReactNode }) {
  const viewer = useViewer();
  const s = projectSummary(project);
  const waiting = s.open.filter((r) => needsYou(r, viewer.reviewerIn(r))).length;
  const noun = project.profile === "music" ? "tracks" : "deliverables";
  const pct = s.withVersion.length ? Math.round((s.approved / s.withVersion.length) * 100) : 0;
  const card = (
    <Link
      to="/projects/$projectId"
      params={{ projectId: project.id }}
      className="group flex flex-col overflow-hidden rounded-panel-lg border border-line bg-raised/25 shadow-1 transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-px hover:border-edge hover:shadow-3"
    >
      <ProjectCover project={project} size="lg" />
      <span className="flex flex-col gap-3 p-4">
        <span className="flex items-start gap-3">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] font-medium text-ink">{project.name}</span>
            <span className="mt-0.5 line-clamp-2 block text-[13px] leading-[18px] text-ink-3">
              {project.description}
            </span>
          </span>
          {waiting > 0 && (
            <span className="tabular shrink-0 rounded-full bg-signal px-2 text-[12px] leading-[20px] font-medium text-ground">
              {waiting} on you
            </span>
          )}
        </span>
        <span className="flex flex-col gap-1.5">
          <span className="flex items-center justify-between text-[12px] text-ink-3">
            <span>
              {s.approved} of {s.withVersion.length} {noun} approved
            </span>
            <span className="tabular">{pct}%</span>
          </span>
          <span className="h-1 overflow-hidden rounded-full bg-raised">
            <span
              className="block h-full rounded-full bg-ink-2 transition-[width] duration-500"
              style={{ width: `${pct}%` }}
            />
          </span>
        </span>
        <span className="flex items-center gap-3 text-[12px] text-ink-3">
          <AvatarRow personIds={project.members.map((m) => m.personId)} size={20} />
          <span className="tabular flex items-center gap-1">
            <Icon name="review" size={12} /> {s.open.length}
          </span>
          <span className="tabular flex items-center gap-1">
            <Icon name="task" size={12} /> {s.openTasks.length}
          </span>
          <span className="tabular ml-auto">{ago(s.latest)}</span>
        </span>
      </span>
    </Link>
  );
  if (!menu) return card;
  // The menu sits over the cover's corner, beside the link rather than inside it.
  return (
    <div className="group relative min-w-0">
      {card}
      <div data-e2e-overlap className="absolute top-2 right-2">
        {menu}
      </div>
    </div>
  );
}

/** The dashed tile that starts a project. */
export function NewProjectTile({ onClick }: { onClick: () => void }) {
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
