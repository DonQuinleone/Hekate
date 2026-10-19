import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { FileBrowser } from "~/components/file-browser";
import { UploadProvider } from "~/components/files";
import { Icon } from "~/components/icons";
import { PageHeader } from "~/components/page-header";
import { ProjectPeople } from "~/components/project-people";
import { ProjectReviews } from "~/components/reviews";
import { Button } from "~/components/ui/button";
import { type BrowserFilters, noFilters } from "~/lib/browser";
import { formatDates } from "~/lib/locale";
import {
  type Project,
  projectFoldersQuery,
  projectQuery,
  useArchiveProject,
  useProjectCan,
  useProjectDeletion,
} from "~/lib/queries";
import { ProjectOverview } from "~/routes/overview";

/**
 * A project's pages share their frame: the trail back to the projects, the section's name as
 * the title (the project itself is in the sidebar's switcher, decision 038), and the content.
 */
export function ProjectFrame({
  projectId,
  title,
  actions,
  parent,
  children,
}: {
  projectId: string;
  title: string;
  actions?: ReactNode;
  /** A crumb between the project and the page, for a page under one of its sections. */
  parent?: (project: Project) => ReactNode;
  children: (project: Project) => ReactNode;
}) {
  const { data: project, error } = useQuery(projectQuery(projectId));
  if (error) return <p className="p-8 text-signal">{error.message}</p>;
  if (!project) return <p className="p-8 text-ink-3">Loading</p>;
  return (
    <>
      <PageHeader
        crumbs={[
          { key: "projects", link: <Link to="/projects">Projects</Link> },
          {
            key: "project",
            link: (
              <Link to="/projects/$projectId" params={{ projectId: project.id }}>
                {project.name}
              </Link>
            ),
          },
          ...(parent ? [{ key: "parent", link: parent(project) }] : []),
        ]}
        title={title}
        actions={project.archivedAt ? undefined : actions}
      />
      {project.archivedAt && <ArchivedNotice project={project} />}
      {children(project)}
    </>
  );
}

const dayFormat = formatDates({
  day: "numeric",
  month: "long",
  year: "numeric",
});

/**
 * An archived project opens as it was, read-only; those who run it can bring it back. One whose
 * deletion was confirmed says when it goes, and can be kept until then (#240).
 */
function ArchivedNotice({ project }: { project: Project }) {
  const archive = useArchiveProject();
  const { cancel } = useProjectDeletion(project.id);
  const deleteAfter = project.deletion?.deleteAfter;
  if (deleteAfter)
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-raised/40 px-5 py-2 text-[13px] text-ink-2 @3xl/app:px-10">
        <Icon name="warning" size={14} className="text-signal" />
        <span className="min-w-0 flex-1">
          To be deleted for good on {dayFormat.format(new Date(deleteAfter))}. Read-only until then.
        </span>
        {project.deletion?.mayCancel && (
          <Button
            variant="secondary"
            size="sm"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate()}
          >
            Keep it
          </Button>
        )}
      </div>
    );
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-raised/40 px-5 py-2 text-[13px] text-ink-2 @3xl/app:px-10">
      <Icon name="archive" size={14} className="text-ink-3" />
      <span className="min-w-0 flex-1">
        Archived on {dayFormat.format(new Date(project.archivedAt ?? ""))}. Everything is kept,
        read-only.
      </span>
      {project.mayArchive && (
        <Button
          variant="secondary"
          size="sm"
          disabled={archive.isPending}
          onClick={() => archive.mutate({ id: project.id, archive: false })}
        >
          Unarchive
        </Button>
      )}
    </div>
  );
}

const body =
  "fade-in mx-auto flex w-full max-w-[1360px] flex-col gap-8 px-5 py-6 @3xl/app:px-10 @3xl/app:py-8";

/** The project's first page. */
export function ProjectOverviewPage({ projectId }: { projectId: string }) {
  return (
    <ProjectFrame projectId={projectId} title="Overview">
      {(project) => (
        <div className={body}>
          <ProjectOverview project={project} />
        </div>
      )}
    </ProjectFrame>
  );
}

/** The project's files: folders, tracks among them, and everything uploaded. */
export function ProjectFilesPage({
  projectId,
  folderId = null,
  onOpenFolder = () => {},
  filters = noFilters,
  onFilter = () => {},
}: {
  projectId: string;
  /** The folder open in the file browser; null is the top of the project. */
  folderId?: string | null;
  onOpenFolder?: (folderId: string | null) => void;
  filters?: BrowserFilters;
  onFilter?: (filters: BrowserFilters) => void;
}) {
  const { data: folders } = useQuery(projectFoldersQuery(projectId));
  const can = useProjectCan(projectId);
  const folderName = folders?.find((f) => f.id === folderId)?.name;
  return (
    <ProjectFrame projectId={projectId} title="Files">
      {(project) => (
        <UploadProvider
          projectId={project.id}
          folderId={folderId}
          folderName={folderName}
          enabled={can("upload")}
        >
          <div className={body}>
            <FileBrowser
              projectId={project.id}
              folderId={folderId}
              onOpenFolder={onOpenFolder}
              filters={filters}
              onFilter={onFilter}
              tracks={project.profile !== "general"}
            />
          </div>
        </UploadProvider>
      )}
    </ProjectFrame>
  );
}

/** The project's reviews. */
export function ProjectReviewsPage({ projectId }: { projectId: string }) {
  return (
    <ProjectFrame projectId={projectId} title="Reviews">
      {(project) => (
        <div className={body}>
          <ProjectReviews projectId={project.id} />
        </div>
      )}
    </ProjectFrame>
  );
}

/** Who is in the project: members and their roles, guest reviewers, and groups. */
export function ProjectPeoplePage({ projectId }: { projectId: string }) {
  return (
    <ProjectFrame projectId={projectId} title="People">
      {(project) => (
        <div className={body}>
          <ProjectPeople projectId={project.id} />
        </div>
      )}
    </ProjectFrame>
  );
}
