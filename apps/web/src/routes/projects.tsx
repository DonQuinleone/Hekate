import { type ProjectProfile, profiles } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { Empty } from "~/components/empty";
import { Icon } from "~/components/icons";
import { Page } from "~/components/page";
import { PageHeader } from "~/components/page-header";
import { NewProjectTile, ProjectCard } from "~/components/project-card";
import { ProjectCover, profileIcon } from "~/components/project-cover";
import { Button } from "~/components/ui/button";
import { ChoiceCard } from "~/components/ui/choice";
import { Dialog } from "~/components/ui/dialog";
import { Input, Select, Textarea } from "~/components/ui/input";
import { ActionMenu, Dropdown } from "~/components/ui/menu";
import { cn } from "~/lib/cn";
import { ago } from "~/lib/comments";
import { progress } from "~/lib/home";
import {
  arrangeProjects,
  type ProjectShow,
  type ProjectSort,
  type ProjectView,
  projectSorts,
  sortLabels,
} from "~/lib/projects";
import {
  type ProjectWithFigures,
  projectCardsQuery,
  projectsQuery,
  templatesQuery,
  useArchiveProject,
  useCreateProject,
  workspaceSettingsQuery,
} from "~/lib/queries";

export { profileIcon };

const profileHint: Record<ProjectProfile, string> = {
  music:
    "Tracks with versions and variations, takes, scores, bars in comments, QA against a delivery profile.",
  video: "Cuts and versions, frame-accurate comments, regions on the picture.",
  general: "Folders and files of any kind. Documents and pictures as pages.",
};

/**
 * Name a project, say what it is and pick its profile; optionally start from another
 * project's roles and settings. Bare inside a dialog; a panel on a page.
 */
export function NewProject({
  onDone,
  onCreated,
  bare = false,
}: {
  onDone: () => void;
  onCreated?: (project: { id: string }) => void;
  bare?: boolean;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const { data: settings } = useQuery(workspaceSettingsQuery);
  const [chosen, setProfile] = useState<ProjectProfile | null>(null);
  // The workspace's default profile until someone picks one.
  const profile = chosen ?? settings?.defaultProfile ?? "music";
  // "project:<id>" or "template:<id>" (#240), or nothing for the defaults.
  const [startFrom, setStartFrom] = useState("");
  const { data: projects = [] } = useQuery(projectsQuery);
  const { data: saved = [] } = useQuery(templatesQuery);
  const [kind, fromId] = startFrom.split(":");
  const create = useCreateProject();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(
      {
        name,
        profile,
        ...(description.trim() ? { description } : {}),
        ...(kind === "project" && fromId ? { templateId: fromId } : {}),
        ...(kind === "template" && fromId ? { savedTemplateId: fromId } : {}),
      },
      {
        onSuccess: (project) => {
          onDone();
          onCreated?.(project);
        },
      },
    );
  };
  return (
    <form
      onSubmit={submit}
      className={cn(
        "flex flex-col gap-5",
        !bare && "rounded-panel-lg border border-line bg-raised/40 p-5 shadow-1",
      )}
    >
      <label className="flex flex-col gap-1.5 text-[14px] text-ink-2">
        Name
        <Input
          autoFocus
          required
          maxLength={120}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Autumn sessions"
        />
      </label>
      <label className="flex flex-col gap-1.5 text-[14px] text-ink-2">
        What it is
        <Textarea
          rows={2}
          maxLength={300}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="A line for the project list."
        />
      </label>
      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-2 text-[14px] text-ink-2">
          Profile, which only decides which tools appear
        </legend>
        <div className="grid gap-2 @3xl/app:grid-cols-3">
          {(Object.keys(profiles) as ProjectProfile[]).map((p) => (
            <ChoiceCard
              key={p}
              name="profile"
              value={p}
              checked={profile === p}
              onChange={() => setProfile(p)}
              title={
                <>
                  <Icon name={profileIcon[p]} />
                  {profiles[p].label}
                </>
              }
              hint={profileHint[p]}
            />
          ))}
        </div>
      </fieldset>
      {(projects.length > 0 || saved.length > 0) && (
        <label className="flex flex-col gap-1.5 text-[14px] text-ink-2">
          Start from
          <Select value={startFrom} onChange={(e) => setStartFrom(e.target.value)}>
            <option value="">The default roles and settings</option>
            {saved.length > 0 && (
              <optgroup label="Templates">
                {saved.map((t) => (
                  <option key={t.id} value={`template:${t.id}`}>
                    {t.name}
                  </option>
                ))}
              </optgroup>
            )}
            {projects.length > 0 && (
              <optgroup label="Projects">
                {projects.map((p) => (
                  <option key={p.id} value={`project:${p.id}`}>
                    {p.name}'s roles and settings
                  </option>
                ))}
              </optgroup>
            )}
          </Select>
          <span className="text-[13px] text-ink-3">
            Nothing else is copied: no files, no people.
          </span>
        </label>
      )}
      {create.error && <p className="m-0 text-[13px] text-signal">{create.error.message}</p>}
      <div className="flex items-center justify-end gap-2">
        {bare && (
          <span className="mr-auto text-[13px] text-ink-3">You become its first Producer.</span>
        )}
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" disabled={create.isPending || !name.trim()}>
          Create project
        </Button>
      </div>
    </form>
  );
}

const showLabels: Record<ProjectShow, string> = {
  all: "Active",
  mine: "Yours",
  archived: "Archived",
};

/**
 * Every project the member may see, as cards or a list: those in use, only their own, or
 * those archived. Sort, view and filter are held in the address.
 */
export function ProjectsPage({
  show = "all",
  sort = "recent",
  view = "cards",
  onChange,
  creatingFirst = false,
  onCreatingDone,
}: {
  show?: ProjectShow;
  sort?: ProjectSort;
  view?: ProjectView;
  onChange: (next: { show?: ProjectShow; sort?: ProjectSort; view?: ProjectView }) => void;
  /** Open with the form for a new project, as `?new=1` asks. */
  creatingFirst?: boolean;
  /** Called when that form closes, to take `?new=1` out of the address. */
  onCreatingDone?: () => void;
}) {
  const archived = show === "archived";
  const { data, isPending, error } = useQuery(projectCardsQuery(archived));
  const [creating, setCreatingState] = useState(creatingFirst);
  const [archiving, setArchiving] = useState<ProjectWithFigures | null>(null);
  const archive = useArchiveProject();
  // Asked again (the palette, while this page is open): open the form again.
  useEffect(() => {
    if (creatingFirst) setCreatingState(true);
  }, [creatingFirst]);
  const setCreating = (open: boolean) => {
    setCreatingState(open);
    if (!open) onCreatingDone?.();
  };
  const list = data ? arrangeProjects(data, show, sort) : [];
  const menuFor = (p: ProjectWithFigures) =>
    p.mayArchive ? (
      <ActionMenu
        label={p.name}
        actions={[
          archived
            ? {
                label: "Unarchive",
                onSelect: () => archive.mutate({ id: p.id, archive: false }),
              }
            : { label: "Archive…", onSelect: () => setArchiving(p) },
        ]}
      />
    ) : undefined;

  return (
    <>
      <PageHeader
        title="Projects"
        actions={
          <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={14} />
            New project
          </Button>
        }
      />
      <Page>
        {error && <p className="m-0 text-signal">{error.message}</p>}

        <div className="flex flex-wrap items-center gap-1">
          {(Object.keys(showLabels) as ProjectShow[]).map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={show === id}
              onClick={() => onChange({ show: id })}
              className={cn(
                "h-8 rounded-control px-3 text-[13px] transition-colors",
                show === id ? "bg-raised text-ink shadow-1" : "text-ink-3 hover:text-ink",
              )}
            >
              {showLabels[id]}
            </button>
          ))}
          <span className="tabular ml-auto hidden pr-2 text-[13px] text-ink-3 @3xl/app:inline">
            {list.length} {list.length === 1 ? "project" : "projects"}
          </span>
          <span className="ml-auto @3xl/app:ml-0">
            <Dropdown
              align="right"
              value={sortLabels[sort]}
              actions={projectSorts.map((s) => ({
                label: sortLabels[s],
                checked: s === sort,
                onSelect: () => onChange({ sort: s }),
              }))}
            />
          </span>
          <fieldset className="m-0 hidden items-center border-0 p-0 @3xl/app:flex">
            <legend className="sr-only">View</legend>
            {(
              [
                ["cards", "grid", "Cards"],
                ["list", "list", "List"],
              ] as const
            ).map(([id, icon, label]) => (
              <Button
                key={id}
                variant="ghost"
                size="icon"
                aria-label={label}
                aria-pressed={view === id}
                onClick={() => onChange({ view: id })}
                className={cn(view === id && "bg-raised text-ink")}
              >
                <Icon name={icon} size={16} />
              </Button>
            ))}
          </fieldset>
        </div>
        {isPending ? (
          <p className="m-0 text-ink-3">Loading</p>
        ) : list.length === 0 ? (
          // The filters stay above an empty list, so the archived are always a click away.
          show === "all" ? (
            <Empty
              title="No projects yet"
              text="A project holds an album, a film or a campaign: its folders, files, tracks, takes and reviews."
              action={
                <Button variant="primary" onClick={() => setCreating(true)}>
                  New project
                </Button>
              }
            />
          ) : (
            <Empty
              title={archived ? "Nothing archived" : "None of yours"}
              text={
                archived
                  ? "Archived projects keep everything, read-only."
                  : "Projects you are a member of show here."
              }
            />
          )
        ) : view === "list" ? (
          <ProjectList projects={list} menuFor={menuFor} />
        ) : (
          <div className="grid gap-4 @3xl/app:grid-cols-2 @6xl/app:grid-cols-3">
            {list.map((p) => (
              <ProjectCard
                key={p.id}
                project={{ ...p, ...p.figures, updatedAt: p.figures.lastActiveAt }}
                menu={menuFor(p)}
              />
            ))}
            {!archived && <NewProjectTile onClick={() => setCreating(true)} />}
          </div>
        )}
      </Page>
      {creating && (
        <Dialog title="New project" onClose={() => setCreating(false)} width="lg">
          <NewProject bare onDone={() => setCreating(false)} />
        </Dialog>
      )}
      {archiving && (
        <Dialog
          title="Archive this project?"
          width="sm"
          onClose={() => setArchiving(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setArchiving(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={archive.isPending}
                onClick={() =>
                  archive.mutate(
                    { id: archiving.id, archive: true },
                    { onSuccess: () => setArchiving(null) },
                  )
                }
              >
                Archive
              </Button>
            </>
          }
        >
          <p className="m-0 text-[14px] text-ink-2">
            {archiving.name} becomes read-only, its open reviews close, and it leaves everyone's
            lists. It can be unarchived.
          </p>
          {archive.error && (
            <p className="m-0 mt-3 text-[13px] text-signal">{archive.error.message}</p>
          )}
        </Dialog>
      )}
    </>
  );
}

/** The same projects as rows: denser, for many of them. */
function ProjectList({
  projects,
  menuFor,
}: {
  projects: ProjectWithFigures[];
  menuFor: (p: ProjectWithFigures) => React.ReactNode;
}) {
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      <li className="eyebrow grid grid-cols-[1fr_auto] gap-4 border-b border-line px-3 pb-2 @3xl/app:grid-cols-[1fr_96px_160px_72px_96px_32px]">
        <span>Name</span>
        <span className="hidden @3xl/app:block">Profile</span>
        <span className="hidden @3xl/app:block">Progress</span>
        <span className="hidden @3xl/app:block">Reviews</span>
        <span className="text-right">Active</span>
        <span className="hidden @3xl/app:block" />
      </li>
      {projects.map((p) => {
        const pct = progress(p.figures.approvedTracks, p.figures.versionedTracks);
        return (
          <li
            key={p.id}
            className="group relative grid grid-cols-[1fr_auto] items-center gap-4 border-b border-line px-3 transition-colors hover:bg-raised/40 @3xl/app:grid-cols-[1fr_96px_160px_72px_96px_32px]"
          >
            <Link
              to="/projects/$projectId"
              params={{ projectId: p.id }}
              className="flex min-w-0 items-center gap-3 py-row-tight text-ink after:absolute after:inset-0"
            >
              <ProjectCover profile={p.profile} size="sm" />
              <span className="min-w-0">
                <span className="block truncate text-[14px] font-medium">{p.name}</span>
                {p.description && (
                  <span className="block truncate text-[13px] text-ink-3">{p.description}</span>
                )}
              </span>
            </Link>
            <span className="hidden items-center gap-2 text-[13px] text-ink-2 @3xl/app:flex">
              <Icon name={profileIcon[p.profile]} size={14} />
              {profiles[p.profile].label}
            </span>
            <span className="tabular hidden text-[13px] text-ink-3 @3xl/app:block">
              {pct === null
                ? `${p.figures.files} file${p.figures.files === 1 ? "" : "s"}`
                : `${p.figures.approvedTracks} of ${p.figures.versionedTracks} approved`}
            </span>
            <span className="tabular hidden text-[13px] text-ink-3 @3xl/app:block">
              {p.figures.openReviews} open
            </span>
            <span className="tabular text-right text-[13px] text-ink-3">
              {ago(p.figures.lastActiveAt)}
            </span>
            <span className="relative z-10 hidden @3xl/app:block">{menuFor(p)}</span>
          </li>
        );
      })}
    </ul>
  );
}
