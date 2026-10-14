import { type ProjectProfile, profiles } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Mark } from "~/components/brand";
import { Icon, type IconName } from "~/components/icons";
import { OrganisationName } from "~/components/organisation-name";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { cn } from "~/lib/cn";
import { projectsQuery, useCreateProject } from "~/lib/queries";

export const profileIcon: Record<ProjectProfile, IconName> = {
  music: "music",
  video: "film",
  general: "file",
};
const profileHint: Record<ProjectProfile, string> = {
  music: "Tracks with versions and variations, scores and takes. Comments anchor to bars.",
  video: "Cuts and versions. Comments anchor to frames and regions.",
  general: "Documents, images and audio. Comments anchor to pages and moments.",
};

const dateFormat = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

function NewProject({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [profile, setProfile] = useState<ProjectProfile>("music");
  const create = useCreateProject();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate({ name, profile }, { onSuccess: onDone });
  };
  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-4 rounded-panel border border-hairline bg-surface p-5"
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor="project-name" className="label">
          Name
        </label>
        <Input
          id="project-name"
          autoFocus
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Symphony No. 5"
        />
      </div>
      <fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
        <legend className="label mb-1.5">Profile</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {(Object.keys(profiles) as ProjectProfile[]).map((p) => (
            <label
              key={p}
              className={cn(
                "flex cursor-pointer flex-col gap-1.5 rounded-control border p-3",
                profile === p ? "border-ink-3 bg-raised" : "border-hairline hover:bg-raised",
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
              <span className="flex items-center gap-2 text-[13px] font-medium text-ink">
                <Icon name={profileIcon[p]} />
                {profiles[p].label}
                {profile === p && (
                  <span aria-hidden="true" className="ml-auto size-[7px] rounded-full bg-signal" />
                )}
              </span>
              <span className="text-xs leading-normal text-ink-3">{profileHint[p]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {create.error && <p className="m-0 text-xs text-signal">{create.error.message}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" disabled={create.isPending || !name.trim()}>
          Create project
        </Button>
      </div>
    </form>
  );
}

function Empty({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center gap-4 rounded-panel border border-dashed border-edge px-6 py-16 text-center">
      <Mark size={32} className="text-ink" />
      <div className="flex flex-col gap-1">
        <p className="m-0 text-[15px] font-medium">No projects yet</p>
        <p className="m-0 max-w-sm text-[13px] leading-normal text-ink-3">
          A project holds the media under review. Pick a profile for music, video or anything else.
        </p>
      </div>
      <Button variant="primary" onClick={onCreate}>
        <Icon name="plus" size={14} />
        New project
      </Button>
    </div>
  );
}

export function ProjectsPage() {
  const { data, isPending, error } = useQuery(projectsQuery);
  const [creating, setCreating] = useState(false);
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-4 py-8 sm:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <OrganisationName />
          <h1 className="m-0 text-[28px] font-medium tracking-[-0.02em]">Projects</h1>
        </div>
        {!creating && data && data.length > 0 && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={14} />
            New project
          </Button>
        )}
      </div>
      {creating && <NewProject onDone={() => setCreating(false)} />}
      {error && <p className="text-signal">{error.message}</p>}
      {isPending && <p className="text-ink-3">Loading</p>}
      {data && data.length === 0 && !creating && <Empty onCreate={() => setCreating(true)} />}
      {data && data.length > 0 && (
        <ul className="m-0 flex list-none flex-col p-0">
          <li className="label grid grid-cols-[1fr_auto] gap-4 sm:grid-cols-[1fr_120px_120px] border-b border-hairline px-2 pb-2">
            <span>Name</span>
            <span>Profile</span>
            <span className="hidden text-right sm:block">Created</span>
          </li>
          {data.map((p) => (
            <li key={p.id}>
              <Link
                to="/projects/$projectId"
                params={{ projectId: p.id }}
                className="grid h-12 grid-cols-[1fr_auto] items-center sm:grid-cols-[1fr_120px_120px] gap-4 border-b border-hairline px-2 text-ink no-underline hover:bg-surface"
              >
                <span className="truncate text-sm font-medium">{p.name}</span>
                <span className="flex items-center gap-2 text-ink-2">
                  <Icon name={profileIcon[p.profile]} />
                  {profiles[p.profile].label}
                </span>
                <span className="tabular hidden text-right text-xs text-ink-3 sm:block">
                  {dateFormat.format(new Date(p.createdAt))}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
