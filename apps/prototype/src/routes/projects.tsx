import { useState } from "react";
import { Icon } from "~/components/icons";
import { Page } from "~/components/page";
import { usePageHeader } from "~/components/page-header";
import { NewProjectTile, ProjectCard, profileIcon } from "~/components/project-card";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Input, Textarea } from "~/components/ui/input";
import type { ProjectProfile } from "~/data";
import { cn } from "~/lib/cn";
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

export function ProjectsPage() {
  const viewer = useViewer();
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState<"active" | "archived">("active");
  const mine = viewer.projects();
  const canCreate = !viewer.isGuest;
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
        <div className="flex items-center gap-1">
          {(
            [
              ["active", "Active"],
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
          <span className="ml-auto text-[13px] text-ink-3">
            {mine.length} {mine.length === 1 ? "project" : "projects"}
          </span>
        </div>
        {filter === "archived" ? (
          <Empty title="Nothing archived" text="Archived projects keep everything, read-only." />
        ) : (
          <div className="grid gap-4 @3xl/app:grid-cols-2 @6xl/app:grid-cols-3">
            {mine.map((p) => (
              <ProjectCard key={p.id} project={p} />
            ))}
            {canCreate && <NewProjectTile onClick={() => setCreating(true)} />}
          </div>
        )}
      </StateGate>
      {creating && (
        <Dialog title="New project" onClose={() => setCreating(false)} width="lg">
          <NewProject onClose={() => setCreating(false)} bare />
        </Dialog>
      )}
    </Page>
  );
}
