import { type ProjectProfile, profiles } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { Empty } from "~/components/empty";
import { Icon } from "~/components/icons";
import { NeedsYou } from "~/components/needs-you";
import { Page } from "~/components/page";
import { PageHeader } from "~/components/page-header";
import { ProjectCard } from "~/components/project-card";
import { ProjectCover, profileIcon } from "~/components/project-cover";
import { Button } from "~/components/ui/button";
import { ChoiceCard } from "~/components/ui/choice";
import { Dialog } from "~/components/ui/dialog";
import { FilterTabs } from "~/components/ui/filter-tabs";
import { Input, Select, Textarea } from "~/components/ui/input";
import { ActionMenu, Dropdown } from "~/components/ui/menu";
import { Segmented } from "~/components/ui/segmented";
import { Failed, Loading } from "~/components/ui/states";
import { cn } from "~/lib/cn";
import { ago } from "~/lib/comments";
import { progressLine } from "~/lib/home";
import {
  arrangeProjects,
  type ProjectShow,
  type ProjectSort,
  type ProjectView,
  projectSorts,
  showLabels,
  sortLabels,
} from "~/lib/projects";
import {
  myReviewsQuery,
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
    "Tracks with versions and variants, takes, scores, bars in comments, QA against a delivery profile.",
  video:
    "Deliverables with cuts and renditions, frame-accurate comments, timecode, regions on the picture, broadcast checks.",
  general:
    "Folders and files of any kind with simple version chains. Documents and pictures as pages.",
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
          <span className="mr-auto text-[13px] text-ink-3">You become its first owner.</span>
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

/**
 * Every project the member may see, as cards or a list: those in use, those they own, or
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
  const { data, isPending, error, refetch } = useQuery(projectCardsQuery(archived));
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
  // Reviews in each project waiting on the viewer, as Home's cards count them.
  const { data: mine = [] } = useQuery(myReviewsQuery);
  const waitingBy = new Map<string, number>();
  for (const r of mine)
    if (r.yourTurn && r.status === "open")
      waitingBy.set(r.projectId, (waitingBy.get(r.projectId) ?? 0) + 1);
  // An empty list offers New project itself; the header's would be a second (#549).
  const emptyOffersNew = !isPending && !error && show === "all" && list.length === 0;
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
          emptyOffersNew ? undefined : (
            <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
              <Icon name="plus" size={14} />
              New project
            </Button>
          )
        }
      />
      <Page>
        {error && <Failed what="Your projects" error={error} retry={refetch} />}

        <div className="flex flex-wrap items-center gap-1">
          <FilterTabs
            label="Show"
            value={show}
            options={(Object.keys(showLabels) as ProjectShow[]).map((id) => ({
              value: id,
              label: showLabels[id],
              count: show === id && data ? list.length : undefined,
            }))}
            onChange={(id) => onChange({ show: id })}
          />
          <span className="ml-auto">
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
          <Segmented
            label="View"
            value={view}
            options={[
              { value: "cards", label: "Cards", icon: <Icon name="grid" size={15} /> },
              { value: "list", label: "List", icon: <Icon name="list" size={15} /> },
            ]}
            onChange={(next) => onChange({ view: next })}
          />
        </div>
        {isPending ? (
          <Loading />
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
              title={archived ? "Nothing archived" : "None owned by you"}
              text={
                archived
                  ? "Archived projects keep everything, read-only."
                  : "Projects you start, or are made an owner of, show here."
              }
            />
          )
        ) : view === "list" ? (
          <ProjectList projects={list} menuFor={menuFor} waitingBy={waitingBy} />
        ) : (
          <div className="grid gap-4 @3xl/app:grid-cols-2 @6xl/app:grid-cols-3">
            {list.map((p) => (
              <ProjectCard
                key={p.id}
                project={{ ...p, ...p.figures, updatedAt: p.figures.lastActiveAt }}
                waiting={waitingBy.get(p.id) ?? 0}
                menu={menuFor(p)}
              />
            ))}
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

/**
 * The same projects as rows: denser, for many of them. The cover already says the profile, so
 * no column repeats it; progress is a music or video project's, of its tracks or deliverables.
 */
function ProjectList({
  projects,
  menuFor,
  waitingBy,
}: {
  projects: ProjectWithFigures[];
  menuFor: (p: ProjectWithFigures) => React.ReactNode;
  waitingBy: Map<string, number>;
}) {
  const columns =
    "grid-cols-[minmax(0,1fr)_auto] @3xl/app:grid-cols-[minmax(0,1fr)_180px_88px_112px_32px]";
  return (
    <ul className="m-0 flex list-none flex-col p-0">
      <li className={cn("eyebrow grid gap-4 border-b border-line px-3 pb-2", columns)}>
        <span>Name</span>
        <span className="hidden @3xl/app:block">Progress</span>
        <span className="hidden @3xl/app:block">Open</span>
        <span className="text-right">Last activity</span>
        <span className="hidden @3xl/app:block" />
      </li>
      {projects.map((p) => {
        const waiting = waitingBy.get(p.id) ?? 0;
        return (
          <li
            key={p.id}
            className={cn(
              "group relative grid items-center gap-4 border-b border-line px-3 transition-colors hover:bg-raised/40",
              columns,
            )}
          >
            <Link
              to="/projects/$projectId"
              params={{ projectId: p.id }}
              className="flex min-w-0 items-center gap-3 py-row-tight text-ink after:absolute after:inset-0"
            >
              <ProjectCover profile={p.profile} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-[14px] font-medium">{p.name}</span>
                  {waiting > 0 && <NeedsYou count={waiting} />}
                </span>
                {p.description && (
                  <span className="block truncate text-[13px] text-ink-3">{p.description}</span>
                )}
              </span>
            </Link>
            <span className="tabular hidden truncate text-[13px] text-ink-3 @3xl/app:block">
              {p.profile === "general" ? "" : progressLine(p.figures, p.profile)}
            </span>
            <span className="tabular hidden items-center gap-3 text-[13px] text-ink-3 @3xl/app:flex">
              <span
                title={`${p.figures.openReviews} open reviews`}
                className="flex items-center gap-1"
              >
                <Icon name="review" size={12} />
                {p.figures.openReviews}
              </span>
              <span
                title={`${p.figures.openComments} open comments`}
                className="flex items-center gap-1"
              >
                <Icon name="comment" size={12} />
                {p.figures.openComments}
              </span>
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
