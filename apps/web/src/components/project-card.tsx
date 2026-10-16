import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AvatarRow } from "~/components/avatar";
import { Icon, type IconName } from "~/components/icons";
import { ProjectCover } from "~/components/project-cover";
import { cn } from "~/lib/cn";
import { ago } from "~/lib/comments";
import { progress } from "~/lib/home";
import type { Project, ProjectFigures } from "~/lib/queries";

/** What a card needs: the project, its figures, and when it last moved. */
export type CardProject = Pick<Project, "id" | "name" | "profile" | "description"> &
  ProjectFigures & { updatedAt: string };

/** A project at a glance: its cover, what it is, its progress, who is in it, what is open. */
export function ProjectCard({
  project,
  waiting = 0,
  menu,
}: {
  project: CardProject;
  /** Reviews in it waiting on the viewer. */
  waiting?: number;
  /** Less frequent actions, in a menu over the cover's corner. */
  menu?: ReactNode;
}) {
  const pct = progress(project.approvedTracks, project.versionedTracks);
  const counts: { icon: IconName; n: number; label: string }[] = [
    { icon: "review", n: project.openReviews, label: "open reviews" },
    { icon: "comment", n: project.openComments, label: "open comments" },
  ];
  const card = (
    <Link
      to="/projects/$projectId"
      params={{ projectId: project.id }}
      className="group flex min-w-0 flex-col overflow-hidden rounded-panel-lg border border-line bg-raised/25 shadow-1 transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-px hover:border-edge hover:shadow-3"
    >
      <ProjectCover profile={project.profile} size="lg" />
      <span className="flex flex-col gap-3 p-4">
        <span className="flex items-start gap-3">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] font-medium text-ink">{project.name}</span>
            {project.description && (
              <span className="mt-0.5 line-clamp-2 block text-[13px] leading-[18px] text-ink-3">
                {project.description}
              </span>
            )}
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
  if (!menu) return card;
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
