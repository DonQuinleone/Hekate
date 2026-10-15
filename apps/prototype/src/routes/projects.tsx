import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { AvatarRow } from "~/components/avatar";
import { Icon, type IconName } from "~/components/icons";
import { usePageHeader } from "~/components/page-header";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { type ProjectProfile, reviews, tracks } from "~/data";
import { cn } from "~/lib/cn";
import { formatDate } from "~/lib/format";
import { needsYou } from "~/lib/reviews";
import { useViewer } from "~/viewer/context";
import { Empty, StateGate } from "~/viewer/state-gate";

export const profileIcon: Record<ProjectProfile, IconName> = {
  music: "music",
  video: "film",
  general: "file",
};
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

function NewProject({ onClose }: { onClose: () => void }) {
  const [profile, setProfile] = useState<ProjectProfile>("music");
  return (
    <form
      className="flex flex-col gap-5 rounded-panel-lg border border-line bg-raised/40 p-5 shadow-1"
      onSubmit={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="flex items-baseline justify-between">
        <h2 className="text-[16px] font-medium">New project</h2>
        <span className="text-[13px] text-ink-3">You become its first Producer.</span>
      </div>
      <label className="flex flex-col gap-1.5 text-[14px] text-ink-2">
        Name
        <Input placeholder="Autumn sessions" />
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
      <div className="flex justify-end gap-2">
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
    <div className="fade-in mx-auto flex max-w-[1000px] flex-col gap-6 px-4 py-6 @3xl/app:px-8">
      {creating && <NewProject onClose={() => setCreating(false)} />}
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
        <ul className="-mx-2 flex flex-col">
          {mine.map((p) => {
            const waiting = reviews.filter(
              (r) => r.projectId === p.id && needsYou(r, viewer.reviewerIn(r)),
            ).length;
            const latest =
              tracks
                .filter((t) => t.projectId === p.id)
                .flatMap((t) => t.versions)
                .map((v) => v.uploadedAt)
                .sort()
                .at(-1) ?? p.createdAt;
            return (
              <li
                key={p.id}
                className="grid grid-cols-[1fr_auto] items-center gap-4 rounded-panel px-2 transition-colors hover:bg-raised/60 @3xl/app:grid-cols-[minmax(0,1fr)_120px_120px_90px]"
              >
                <Link
                  to="/projects/$projectId"
                  params={{ projectId: p.id }}
                  className="flex min-w-0 items-center gap-3.5 py-2.5"
                >
                  <span
                    className="flex size-10 shrink-0 items-center justify-center rounded-panel text-ink shadow-2"
                    style={{
                      background: `linear-gradient(145deg, oklch(0.4 0.07 ${p.profile === "music" ? 40 : p.profile === "video" ? 260 : 150}), oklch(0.22 0.04 ${p.profile === "music" ? 60 : p.profile === "video" ? 290 : 170}))`,
                    }}
                  >
                    <Icon name={profileIcon[p.profile]} size={18} />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[15px] font-medium text-ink">
                      {p.name}
                    </span>
                    <span className="block truncate text-[13px] text-ink-3">{p.description}</span>
                  </span>
                </Link>
                <span className="hidden @3xl/app:block">
                  <AvatarRow personIds={p.members.map((m) => m.personId)} />
                </span>
                <span className="hidden text-[13px] @3xl/app:block">
                  {waiting > 0 ? (
                    <span className="text-signal">{waiting} on you</span>
                  ) : (
                    <span className="text-ink-3" />
                  )}
                </span>
                <span className="tabular text-[13px] text-ink-3">{formatDate(latest)}</span>
              </li>
            );
          })}
        </ul>
      </StateGate>
    </div>
  );
}
