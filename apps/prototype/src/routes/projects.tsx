import { useState } from "react";
import { Icon } from "~/components/icons";
import { Page } from "~/components/page";
import { usePageHeader } from "~/components/page-header";
import {
  NewProjectTile,
  ProjectCard,
  ProjectCover,
  profileIcon,
  projectSummary,
} from "~/components/project-card";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Input, Select, Textarea } from "~/components/ui/input";
import { ActionMenu, Dropdown } from "~/components/ui/menu";
import type { Project, ProjectProfile } from "~/data";
import { projects as allProjects } from "~/data";
import { cn } from "~/lib/cn";
import { ago } from "~/lib/format";
import { useViewer } from "~/viewer/context";
import { Empty, StateGate } from "~/viewer/state-gate";

const profileCopy: Record<ProjectProfile, { label: string; hint: string }> = {
  music: {
    label: "Music",
    hint: "Tracks with versions and variations, takes, scores, bars in comments, QA against a delivery profile.",
  },
  video: {
    label: "Video",
    hint: "Deliverables with cuts and renditions, frame-accurate comments, timecode, broadcast checks.",
  },
  general: {
    label: "General",
    hint: "Folders and files of any kind with simple version chains. Documents and pictures as pages.",
  },
};

/** The new project form; `bare` leaves out its own frame when it sits in a dialog. */
export function NewProject({ onClose, bare = false }: { onClose: () => void; bare?: boolean }) {
  const viewer = useViewer();
  const [profile, setProfile] = useState<ProjectProfile>("music");
  return (
    <form
      className={cn(
        "flex flex-col gap-5",
        !bare && "rounded-panel-lg border border-line bg-raised/40 p-5 shadow-1",
      )}
      onSubmit={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {!bare && (
        <div className="flex items-baseline justify-between">
          <h2 className="text-[16px] font-medium">New project</h2>
          <span className="text-[13px] text-ink-3">You become its first Producer.</span>
        </div>
      )}
      <label className="flex flex-col gap-1.5 text-[14px] text-ink-2">
        Name
        <Input placeholder="Autumn sessions" autoFocus />
      </label>
      <label className="flex flex-col gap-1.5 text-[14px] text-ink-2">
        What it is
        <Textarea rows={2} placeholder="A line for the project list." />
      </label>
      <fieldset className="flex flex-col gap-2 border-0 p-0">
        <legend className="mb-2 text-[14px] text-ink-2">
          Profile, which only decides which tools appear
        </legend>
        <div className="grid gap-2 @3xl/app:grid-cols-3">
          {(Object.keys(profileCopy) as ProjectProfile[]).map((p) => (
            <label
              key={p}
              className={cn(
                "flex cursor-pointer flex-col gap-1 rounded-panel border p-3 text-[14px]",
                profile === p
                  ? "border-signal/60 bg-signal/10 text-ink"
                  : "border-line text-ink-2 hover:border-edge",
              )}
            >
              <input
                type="radio"
                name="profile"
                value={p}
                checked={profile === p}
                onChange={() => setProfile(p)}
                className="sr-only"
              />
              <span className="flex items-center gap-2 font-medium">
                <Icon name={profileIcon[p]} />
                {profileCopy[p].label}
              </span>
              <span className="text-[13px] text-ink-3">{profileCopy[p].hint}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex flex-col gap-1.5 text-[14px] text-ink-2">
        Start from
        <Select defaultValue="">
          <option value="">The default roles and settings</option>
          <optgroup label="Templates">
            <option value="template:recital">Solo recital</option>
          </optgroup>
          <optgroup label="Projects">
            {viewer.projects().map((p) => (
              <option key={p.id} value={`project:${p.id}`}>
                {p.name}'s roles and settings
              </option>
            ))}
          </optgroup>
        </Select>
        <span className="text-[13px] text-ink-3">Nothing else is copied: no files, no people.</span>
      </label>
      <div className="flex items-center justify-end gap-2">
        {bare && (
          <span className="mr-auto text-[13px] text-ink-3">You become its first Producer.</span>
        )}
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" type="submit">
          Create project
        </Button>
      </div>
    </form>
  );
}

const sortLabels = { recent: "Recently active", name: "Name", newest: "Newest" } as const;
type Sort = keyof typeof sortLabels;

export function ProjectsPage({ create = false }: { create?: boolean }) {
  const viewer = useViewer();
  const [creating, setCreating] = useState(create);
  const [filter, setFilter] = useState<"active" | "mine" | "archived">("active");
  const [sort, setSort] = useState<Sort>("recent");
  const [view, setView] = useState<"cards" | "list">("cards");
  const [archiving, setArchiving] = useState<Project | null>(null);
  const canCreate = !viewer.isGuest;
  const shown = (
    filter === "archived"
      ? allProjects.filter((p) => p.archived && viewer.canSee(p.id))
      : filter === "mine"
        ? viewer.projects().filter((p) => p.members.some((m) => m.personId === viewer.personId))
        : viewer.projects()
  ).sort((a, b) =>
    sort === "name"
      ? a.name.localeCompare(b.name)
      : sort === "newest"
        ? b.createdAt.localeCompare(a.createdAt)
        : projectSummary(b).latest.localeCompare(projectSummary(a).latest),
  );
  // Archiving belongs to whoever runs the project: its roles and members.
  const menuFor = (p: Project) =>
    viewer.can(p.id, "manage_roles") ? (
      <ActionMenu
        label={p.name}
        actions={[
          filter === "archived"
            ? { label: "Unarchive", onSelect: () => {} }
            : { label: "Archive…", onSelect: () => setArchiving(p) },
        ]}
      />
    ) : undefined;
  usePageHeader({
    title: "Projects",
    actions: canCreate ? (
      <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
        <Icon name="plus" size={14} />
        New project
      </Button>
    ) : undefined,
  });
  return (
    <Page>
      <StateGate
        empty={
          <Empty
            title="No projects yet"
            text="A project holds an album, a film or a campaign: its folders, files, tracks, takes and reviews."
            action={
              <Button variant="primary" onClick={() => setCreating(true)}>
                New project
              </Button>
            }
          />
        }
      >
        <div className="flex flex-wrap items-center gap-1">
          {(
            [
              ["active", "Active"],
              ["mine", "Yours"],
              ["archived", "Archived"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
              className={cn(
                "h-8 rounded-control px-3 text-[13px] transition-colors",
                filter === id ? "bg-raised text-ink shadow-1" : "text-ink-3 hover:text-ink",
              )}
            >
              {label}
            </button>
          ))}
          <span className="tabular ml-auto hidden pr-2 text-[13px] text-ink-3 @3xl/app:inline">
            {shown.length} {shown.length === 1 ? "project" : "projects"}
          </span>
          <span className="ml-auto @3xl/app:ml-0">
            <Dropdown
              align="right"
              value={sortLabels[sort]}
              actions={(Object.keys(sortLabels) as Sort[]).map((s) => ({
                label: sortLabels[s],
                checked: s === sort,
                onSelect: () => setSort(s),
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
                onClick={() => setView(id)}
                className={cn(view === id && "bg-raised text-ink")}
              >
                <Icon name={icon} size={16} />
              </Button>
            ))}
          </fieldset>
        </div>
        {shown.length === 0 ? (
          filter === "archived" ? (
            <Empty title="Nothing archived" text="Archived projects keep everything, read-only." />
          ) : (
            <Empty title="None of yours" text="Projects you are a member of show here." />
          )
        ) : view === "list" ? (
          <ul className="m-0 flex list-none flex-col p-0">
            {shown.map((p) => (
              <li
                key={p.id}
                className="group relative flex items-center gap-3 border-b border-line px-3 py-2.5 hover:bg-raised/40"
              >
                <ProjectCover project={p} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium text-ink">{p.name}</span>
                  <span className="block truncate text-[13px] text-ink-3">{p.description}</span>
                </span>
                <span className="tabular text-[13px] text-ink-3">
                  {ago(projectSummary(p).latest)}
                </span>
                {menuFor(p)}
              </li>
            ))}
          </ul>
        ) : (
          <div className="grid gap-4 @3xl/app:grid-cols-2 @6xl/app:grid-cols-3">
            {shown.map((p) => (
              <ProjectCard key={p.id} project={p} menu={menuFor(p)} />
            ))}
            {canCreate && filter !== "archived" && (
              <NewProjectTile onClick={() => setCreating(true)} />
            )}
          </div>
        )}
      </StateGate>
      {creating && (
        <Dialog title="New project" onClose={() => setCreating(false)} width="lg">
          <NewProject onClose={() => setCreating(false)} bare />
        </Dialog>
      )}
      {archiving && (
        <Dialog title="Archive this project?" onClose={() => setArchiving(null)} width="sm">
          <p className="text-[14px] text-ink-2">
            {archiving.name} becomes read-only, its open reviews close, and it leaves everyone's
            lists. It can be unarchived.
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setArchiving(null)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => setArchiving(null)}>
              Archive
            </Button>
          </div>
        </Dialog>
      )}
    </Page>
  );
}
