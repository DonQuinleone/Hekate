import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { Avatar, AvatarRow } from "~/components/avatar";
import { Icon } from "~/components/icons";
import { Label } from "~/components/label";
import { usePageHeader } from "~/components/page-header";
import { Property } from "~/components/property";
import { Dot, reviewDot } from "~/components/status";
import { Thumb } from "~/components/thumb";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Input, Select, Textarea } from "~/components/ui/input";
import { ActionMenu } from "~/components/ui/menu";
import {
  activity,
  files as allFiles,
  deliveryProfiles,
  type File,
  folders,
  groups,
  latestVersion,
  type Project,
  personById,
  primaryFile,
  projectById,
  type Review,
  reviews,
  sessions,
  type Track,
  tasks,
  tracks,
  workflows,
} from "~/data";
import { cn } from "~/lib/cn";
import {
  fileDetails,
  folderPath,
  kindIcon,
  looseFiles,
  openCommentCount,
  tracksIn,
} from "~/lib/files";
import { ago, dueIn, formatBytes, formatDate, plural } from "~/lib/format";
import { kindCopy, responded, reviewOutcome } from "~/lib/reviews";
import { useViewer } from "~/viewer/context";
import { Empty, Refused, StateGate, useScreenState } from "~/viewer/state-gate";
import { Soon } from "./_soon.tsx";
import { ProjectSettingsRoute } from "./project-settings.tsx";
import { CoverageView, SessionsView } from "./takes.tsx";
import { WorkflowRoute } from "./workflow.tsx";

const Panel = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div className={cn("rounded-panel-lg border border-line bg-raised/25 shadow-1", className)}>
    {children}
  </div>
);

function Tabs({ project, view }: { project: Project; view: string }) {
  const viewer = useViewer();
  const tabs: { id: string; label: string; count?: number }[] = [
    { id: "overview", label: "Overview" },
    { id: "files", label: "Files" },
    { id: "board", label: "Board" },
    {
      id: "reviews",
      label: "Reviews",
      count: reviews.filter((r) => r.projectId === project.id && r.status === "open").length,
    },
    {
      id: "tasks",
      label: "Tasks",
      count: tasks.filter((t) => t.projectId === project.id && t.status !== "done").length,
    },
    { id: "people", label: "People" },
  ];
  if (project.profile === "music" && viewer.tools(project.id).has("takes"))
    tabs.push({ id: "sessions", label: "Sessions" });
  if (project.profile === "music" && viewer.tools(project.id).has("production"))
    tabs.push({ id: "production", label: "Production" });
  if (viewer.can(project.id, "manage_roles") || viewer.can(project.id, "edit_workflows"))
    tabs.push({ id: "settings", label: "Settings" });
  return (
    <div
      role="tablist"
      className="-mx-4 flex items-stretch gap-1 overflow-x-auto border-b border-line px-4 @3xl/app:-mx-6 @3xl/app:px-6"
    >
      {tabs.map((t) => (
        <Link
          key={t.id}
          role="tab"
          aria-selected={view === t.id}
          to={t.id === "overview" ? "/projects/$projectId" : "/projects/$projectId/$view"}
          params={{ projectId: project.id, view: t.id }}
          className={cn(
            "-mb-px flex h-10 shrink-0 items-center gap-1.5 border-b-2 px-2 text-[14px] font-medium transition-colors",
            view === t.id
              ? "border-ink text-ink"
              : "border-transparent text-ink-3 hover:text-ink-2",
          )}
        >
          {t.label}
          {t.count ? <span className="tabular text-[12px] text-ink-3">{t.count}</span> : null}
        </Link>
      ))}
    </div>
  );
}

/* ---------- Overview ---------- */

function Overview({ project }: { project: Project }) {
  const viewer = useViewer();
  const workflow = workflows.find((w) => w.id === project.workflowId);
  const projectTracks = tracks.filter((t) => t.projectId === project.id);
  const open = reviews.filter((r) => r.projectId === project.id && r.status === "open");
  const recent = activity.filter((a) => a.projectId === project.id).slice(0, 8);
  const profileName = { music: "Music", video: "Video", general: "General" }[project.profile];
  return (
    <div className="grid gap-10 @5xl/app:grid-cols-[minmax(0,1fr)_272px]">
      <div className="flex min-w-0 flex-col gap-8">
        <section className="flex flex-col gap-2">
          <Label>
            {project.profile === "music" ? "Tracks" : "Deliverables"} · {projectTracks.length}
          </Label>
          <ul className="-mx-2 flex flex-col">
            {projectTracks.map((t) => {
              const v = latestVersion(t);
              const stage = workflow?.stages.find((s) => s.status === v?.status);
              const next = workflow?.stages.find((s) => s.after.includes(stage?.id ?? ""));
              const waitingOn = open.find((r) => r.items.some((i) => i.trackId === t.id));
              const file = v ? primaryFile(v) : undefined;
              return (
                <li key={t.id}>
                  <Link
                    to="/tracks/$trackId"
                    params={{ trackId: t.id }}
                    className="group grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3.5 rounded-panel px-2 py-2 transition-colors hover:bg-raised/60 @3xl/app:grid-cols-[auto_minmax(0,1fr)_150px_200px_72px]"
                  >
                    {file ? (
                      <Thumb file={file} width={48} height={32} />
                    ) : (
                      <span className="flex h-8 w-12 items-center justify-center rounded-[5px] border border-dashed border-line-strong text-ink-3">
                        <Icon name="track" size={14} />
                      </span>
                    )}
                    <span className="min-w-0">
                      <span className="block truncate text-[14px] font-medium text-ink">
                        {t.name}
                      </span>
                      <span className="block truncate text-[13px] text-ink-3 @3xl/app:hidden">
                        {v
                          ? `V${v.number} · ${v.state === "pending" ? "analysing" : v.state === "failed" ? "could not be analysed" : v.status}`
                          : "No versions yet"}
                      </span>
                    </span>
                    <span className="hidden items-center gap-2 text-[13px] text-ink-2 @3xl/app:flex">
                      {v ? (
                        <>
                          <Dot
                            state={
                              v.status === "Approved"
                                ? "approved"
                                : v.state === "failed"
                                  ? "changes_requested"
                                  : v.state === "pending"
                                    ? "working"
                                    : "in_review"
                            }
                          />
                          <span className="truncate">
                            V{v.number} ·{" "}
                            {v.state === "pending"
                              ? "Analysing"
                              : v.state === "failed"
                                ? "Failed"
                                : v.status}
                          </span>
                        </>
                      ) : (
                        <span className="text-ink-3">No versions yet</span>
                      )}
                    </span>
                    <span className="hidden truncate text-[13px] text-ink-3 @3xl/app:block">
                      {waitingOn
                        ? `Waiting on ${
                            waitingOn.reviewers
                              .filter((r) => r.state !== "submitted" && r.state !== "observing")
                              .map((r) => personById(r.personId).name.split(" ")[0])
                              .join(", ") || "nobody"
                          }`
                        : next
                          ? `Next: ${next.name}`
                          : ""}
                    </span>
                    <span className="tabular text-right text-[13px] text-ink-3">
                      {v ? ago(v.uploadedAt) : ""}
                    </span>
                  </Link>
                </li>
              );
            })}
            {projectTracks.length === 0 && (
              <li className="px-2 py-4 text-[13px] text-ink-3">Nothing uploaded yet.</li>
            )}
          </ul>
        </section>
        <section className="flex flex-col gap-2">
          <Label>Activity</Label>
          <ul className="flex flex-col">
            {recent.map((a) => (
              <li key={a.id} className="flex items-center gap-3 py-2">
                <Avatar personId={a.personId} size={22} />
                <span className="min-w-0 flex-1 truncate text-[14px] text-ink-2">
                  <span className="text-ink">{personById(a.personId).name}</span> {a.text}
                </span>
                <span className="tabular shrink-0 text-[13px] text-ink-3">{ago(a.at)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <aside className="flex min-w-0 flex-col gap-6">
        <section className="flex flex-col gap-0.5">
          <Label className="mb-1.5">Properties</Label>
          <Property name="Profile">{profileName}</Property>
          <Property name="Workflow">{workflow?.name}</Property>
          {project.deliveryProfile && (
            <Property name="Delivery">
              {deliveryProfiles.find((d) => d.id === project.deliveryProfile)?.name}
            </Property>
          )}
          <Property name="People">
            <AvatarRow personIds={project.members.map((m) => m.personId)} size={20} />
          </Property>
          <Property name="Your role">{viewer.roleName(project.id) ?? "Organisation"}</Property>
        </section>
        <section className="flex flex-col gap-2">
          <Label>In review · {open.length}</Label>
          <ul className="-mx-2 flex flex-col">
            {open.map((r) => (
              <li key={r.id}>
                <Link
                  to="/reviews/$reviewId"
                  params={{ reviewId: r.id }}
                  className="flex items-center gap-2.5 rounded-control px-2 py-1.5 transition-colors hover:bg-raised/60"
                >
                  <Dot state={reviewDot(r.status, reviewOutcome(r))} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-ink">{r.title}</span>
                    <span className="block truncate text-[12px] text-ink-3">
                      {responded(r)} of {r.reviewers.length}
                      {r.dueAt && (
                        <span className={cn(dueIn(r.dueAt).days < 0 && "text-signal")}>
                          {" "}
                          · {dueIn(r.dueAt).label}
                        </span>
                      )}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
            {open.length === 0 && (
              <li className="px-2 py-2 text-[13px] text-ink-3">Nothing in review.</li>
            )}
          </ul>
        </section>
      </aside>
    </div>
  );
}

/* ---------- Files ---------- */

function TrackRow({ track }: { track: Track }) {
  const viewer = useViewer();
  const v = latestVersion(track);
  const file = v
    ? allFiles.find(
        (f) => f.id === (v.variations.find((x) => x.primary) ?? v.variations[0])?.fileId,
      )
    : undefined;
  const comments = v ? v.variations.reduce((n, x) => n + openCommentCount(x.fileId), 0) : 0;
  return (
    <li className="group grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-line px-3 last:border-b-0 hover:bg-raised/60 @3xl/app:grid-cols-[auto_minmax(0,1fr)_140px_180px_90px_32px]">
      <Icon name="track" className="text-ink-2" />
      <Link to="/tracks/$trackId" params={{ trackId: track.id }} className="min-w-0 py-2.5">
        <span className="block truncate text-[14px] font-medium text-ink">{track.name}</span>
        <span className="block truncate text-[13px] text-ink-3 @3xl/app:hidden">
          {v ? `V${v.number} · ${v.variations.map((x) => x.name).join(", ")}` : "No versions"}
        </span>
      </Link>
      <span className="hidden items-center gap-2 text-[13px] text-ink-2 @3xl/app:flex">
        {v ? (
          <>
            <Dot
              state={
                v.status === "Approved"
                  ? "approved"
                  : v.state === "failed"
                    ? "changes_requested"
                    : "in_review"
              }
            />
            {v.state === "pending" ? "Analysing" : v.state === "failed" ? "Failed" : v.status}
          </>
        ) : (
          <span className="text-ink-3">No versions</span>
        )}
      </span>
      <span className="hidden truncate text-[13px] text-ink-3 @3xl/app:block">
        {v
          ? `V${v.number} · ${v.variations.map((x) => x.name).join(", ")}`
          : "Upload the first version"}
      </span>
      <span className="tabular hidden text-[13px] text-ink-3 @3xl/app:flex @3xl/app:items-center @3xl/app:gap-1">
        {comments > 0 && (
          <>
            <Icon name="comment" size={12} /> {comments}
          </>
        )}
      </span>
      <span className="flex items-center gap-2">
        <span className="tabular text-[13px] text-ink-3 @3xl/app:hidden">
          {v ? ago(v.uploadedAt) : ""}
        </span>
        {viewer.can(track.projectId, "organise") && (
          <ActionMenu
            label={track.name}
            actions={[
              { label: "Rename", onSelect: () => {} },
              { label: "Move to…", onSelect: () => {} },
              { label: "Link a score…", onSelect: () => {} },
              ...(file ? [{ label: "Request a review", onSelect: () => {} }] : []),
              { label: "Delete…", danger: true, onSelect: () => {} },
            ]}
          />
        )}
      </span>
    </li>
  );
}

function FileRow({ file }: { file: File }) {
  const viewer = useViewer();
  const comments = openCommentCount(file.id);
  const long = useScreenState() === "long";
  return (
    <li className="group grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-line px-3 last:border-b-0 hover:bg-raised/60 @3xl/app:grid-cols-[auto_minmax(0,1fr)_140px_180px_90px_32px]">
      <Icon name={kindIcon[file.kind]} className="text-ink-3" />
      <Link to="/files/$fileId" params={{ fileId: file.id }} className="min-w-0 py-2.5">
        <span
          className={cn("block text-[14px] text-ink", long ? "line-clamp-2 break-all" : "truncate")}
        >
          {file.name}
        </span>
        <span className="block truncate text-[13px] text-ink-3 @3xl/app:hidden">
          {fileDetails(file)}
        </span>
      </Link>
      <span className="hidden items-center gap-2 text-[13px] @3xl/app:flex">
        {file.state === "pending" && (
          <>
            <span className="size-[8px] animate-pulse rounded-full border-[1.5px] border-ink-3" />{" "}
            <span className="text-ink-2">Processing</span>
          </>
        )}
        {file.state === "failed" && (
          <>
            <Icon name="warning" size={14} className="text-signal" />{" "}
            <span className="text-ink-2">Failed</span>
          </>
        )}
        {file.state === "ready" && <span className="text-ink-3">{formatBytes(file.size)}</span>}
      </span>
      <span className="hidden truncate text-[13px] text-ink-3 @3xl/app:block">
        {fileDetails(file)}
      </span>
      <span className="tabular hidden items-center gap-1 text-[13px] text-ink-3 @3xl/app:flex">
        {comments > 0 && (
          <>
            <Icon name="comment" size={12} /> {comments}
          </>
        )}
      </span>
      <span className="flex items-center gap-2">
        <span className="tabular text-[13px] text-ink-3 @3xl/app:hidden">
          {ago(file.uploadedAt)}
        </span>
        {viewer.can(file.projectId, "organise") && (
          <ActionMenu
            label={file.name}
            actions={[
              { label: "Rename", onSelect: () => {} },
              { label: "Move to…", onSelect: () => {} },
              { label: "Attach to a track…", onSelect: () => {} },
              { label: "Tags…", onSelect: () => {} },
              { label: "Pin", onSelect: () => {} },
              ...(viewer.can(file.projectId, "delete")
                ? [{ label: "Delete…", danger: true, onSelect: () => {} }]
                : []),
            ]}
          />
        )}
      </span>
    </li>
  );
}

function Files({ project, folderId }: { project: Project; folderId: string | null }) {
  const viewer = useViewer();
  const [view, setView] = useState<"list" | "grid">("list");
  const state = useScreenState();
  const path = folderPath(folderId);
  const subfolders = folders.filter((f) => f.projectId === project.id && f.parentId === folderId);
  const here = tracksIn(project.id, folderId);
  const loose = looseFiles(
    allFiles.filter((f) => f.projectId === project.id && f.folderId === folderId),
  );
  const canUpload = viewer.can(project.id, "upload");
  const uploading = state === "processing";
  const [requesting, setRequesting] = useState(false);
  const empty =
    state === "empty" || (subfolders.length === 0 && here.length === 0 && loose.length === 0);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <nav aria-label="Folder" className="flex min-w-0 items-center gap-1 text-[14px]">
          <Link
            to="/projects/$projectId/$view"
            params={{ projectId: project.id, view: "files" }}
            className={cn("no-underline", folderId ? "text-ink-3 hover:text-ink" : "text-ink")}
          >
            All files
          </Link>
          {path.map((f, i) => (
            <span key={f.id} className="flex items-center gap-1">
              <span className="text-edge">/</span>
              <Link
                to="/projects/$projectId/$view"
                params={{ projectId: project.id, view: "files" }}
                search={{ folder: f.id }}
                className={cn(
                  "truncate no-underline",
                  i === path.length - 1 ? "text-ink" : "text-ink-3 hover:text-ink",
                )}
              >
                {f.name}
              </Link>
            </span>
          ))}
        </nav>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          <button
            type="button"
            className="flex h-7 items-center gap-1.5 rounded-control px-2 text-[13px] text-ink-3 hover:bg-raised hover:text-ink"
          >
            <Icon name="filter" size={14} />
            Filter
          </button>
          <div
            role="radiogroup"
            className="flex rounded-control border border-line bg-raised/40 p-0.5"
          >
            {(["list", "grid"] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={view === v}
                aria-label={v}
                onClick={() => setView(v)}
                className={cn(
                  "flex size-6 items-center justify-center rounded-[4px]",
                  view === v ? "bg-overlay text-ink shadow-2" : "text-ink-3 hover:text-ink",
                )}
              >
                <Icon name={v} size={14} />
              </button>
            ))}
          </div>
          {viewer.can(project.id, "organise") && (
            <>
              <Button variant="ghost" size="sm">
                New folder
              </Button>
              {project.profile === "music" && (
                <Button variant="ghost" size="sm">
                  New track
                </Button>
              )}
            </>
          )}
          {canUpload && (
            <Button variant="primary" size="sm">
              <Icon name="upload" size={14} />
              Upload
            </Button>
          )}
          {viewer.can(project.id, "organise") && (
            <ActionMenu
              always
              label="more"
              actions={[
                { label: "Upload request…", onSelect: () => setRequesting(true) },
                { label: "Columns…", onSelect: () => {} },
                { label: "Select all", onSelect: () => {} },
              ]}
            />
          )}
        </div>
      </div>
      {requesting && (
        <Dialog
          title="Upload request"
          description="A link for someone outside the project to upload into a folder. They need no account."
          onClose={() => setRequesting(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setRequesting(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => setRequesting(false)}>
                Create the link
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
              Name
              <Input defaultValue="String stems" />
            </label>
            <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
              What you want
              <Textarea
                rows={2}
                defaultValue="The string stems of Maple Leaf Rag, 96 kHz, one file per section."
              />
            </label>
            <div className="grid gap-4 @md/app:grid-cols-3">
              <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                Into
                <Select defaultValue="f-day2">
                  {folders
                    .filter((f) => f.projectId === project.id)
                    .map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                </Select>
              </label>
              <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                File limit
                <Input defaultValue="5" />
              </label>
              <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                Expires
                <Input type="date" defaultValue="2026-10-20" />
              </label>
            </div>
            <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
              Password (optional)
              <Input type="password" />
            </label>
            <p className="text-[12px] text-ink-3">
              The visitor's page:{" "}
              <Link to="/u/$code" params={{ code: "r-7f3a" }} className="text-ink-2 hover:text-ink">
                open it as they would see it
              </Link>
              . What arrives is listed here with who sent it.
            </p>
          </div>
        </Dialog>
      )}
      {uploading && (
        <Panel className="p-3">
          <div className="eyebrow mb-2">Uploading · 2 of 3</div>
          {[
            { name: "The Entertainer - V1 mix.wav", pct: 100, size: "31 MB" },
            { name: "The Entertainer - V1 wet.wav", pct: 62, size: "31 MB" },
            { name: "Pine Apple Rag - V1 mix.wav", pct: 0, size: "28 MB", failed: true },
          ].map((u) => (
            <div key={u.name} className="flex items-center gap-3 py-1.5 text-[14px]">
              <Icon name="music" className="text-ink-3" />
              <span className="min-w-0 flex-1 truncate text-ink">{u.name}</span>
              {u.failed ? (
                <>
                  <span className="text-[13px] text-signal">Connection lost</span>
                  <button type="button" className="text-[13px] text-ink-2 hover:text-ink">
                    Retry
                  </button>
                </>
              ) : (
                <span className="tabular text-[13px] text-ink-3">
                  {u.pct === 100 ? "Checking" : `${u.pct}% · ${u.size}`}
                </span>
              )}
              <div className="h-1 w-24 overflow-hidden rounded-full bg-raised">
                <div
                  className={cn("h-full", u.failed ? "bg-signal" : "bg-ink-2")}
                  style={{ width: `${u.failed ? 30 : u.pct}%` }}
                />
              </div>
            </div>
          ))}
        </Panel>
      )}
      {empty ? (
        <Empty
          title={folderId ? "This folder is empty" : "Nothing here yet"}
          text={
            canUpload
              ? "Drop files anywhere on this page to upload them here, or use Upload. A track groups a piece's versions."
              : "Files appear here once someone uploads them."
          }
          action={canUpload ? <Button variant="primary">Upload</Button> : undefined}
        />
      ) : view === "list" ? (
        <>
          <div className="hidden grid-cols-[auto_minmax(0,1fr)_140px_180px_90px_32px] gap-3 px-3 @3xl/app:grid">
            <span className="w-4" />
            <Label>Name</Label>
            <Label>Status</Label>
            <Label>Details</Label>
            <Label>Notes</Label>
            <span />
          </div>
          <ul className="list-none rounded-panel-lg border border-line bg-raised/25 p-0 shadow-1">
            {subfolders.map((f) => (
              <li
                key={f.id}
                className="group grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-line px-3 last:border-b-0 hover:bg-raised/60 @3xl/app:grid-cols-[auto_minmax(0,1fr)_140px_180px_90px_32px]"
              >
                <Icon name="folder" className="text-ink-2" />
                <Link
                  to="/projects/$projectId/$view"
                  params={{ projectId: project.id, view: "files" }}
                  search={{ folder: f.id }}
                  className="min-w-0 truncate py-2.5 text-[14px] font-medium text-ink no-underline"
                >
                  {f.name}
                </Link>
                <span className="hidden text-[13px] text-ink-3 @3xl/app:block">Folder</span>
                <span className="hidden truncate text-[13px] text-ink-3 @3xl/app:block">
                  {f.id === "f-sessions"
                    ? `${sessions.filter((s) => s.projectId === project.id).length} sessions · 26 takes`
                    : plural(
                        folders.filter((x) => x.parentId === f.id).length +
                          allFiles.filter((x) => x.folderId === f.id).length,
                        "item",
                      )}
                </span>
                <span className="hidden @3xl/app:block" />
                <span>
                  {viewer.can(project.id, "organise") && (
                    <ActionMenu
                      label={f.name}
                      actions={[
                        { label: "Rename", onSelect: () => {} },
                        { label: "Move to…", onSelect: () => {} },
                        { label: "Delete…", danger: true, onSelect: () => {} },
                      ]}
                    />
                  )}
                </span>
              </li>
            ))}
            {here.map((t) => (
              <TrackRow key={t.id} track={t} />
            ))}
            {loose.map((f) => (
              <FileRow key={f.id} file={f} />
            ))}
          </ul>
        </>
      ) : (
        <ul className="grid list-none grid-cols-2 gap-3 p-0 @3xl/app:grid-cols-4">
          {[
            ...subfolders.map((f) => ({
              id: f.id,
              name: f.name,
              icon: "folder" as const,
              to: `/projects/${project.id}/files?folder=${f.id}`,
              sub: "Folder",
            })),
            ...here.map((t) => ({
              id: t.id,
              name: t.name,
              icon: "track" as const,
              to: `/tracks/${t.id}`,
              sub: latestVersion(t) ? `V${latestVersion(t)?.number}` : "No versions",
            })),
            ...loose.map((f) => ({
              id: f.id,
              name: f.name,
              icon: kindIcon[f.kind],
              to: `/files/${f.id}`,
              sub: fileDetails(f),
            })),
          ].map((item) => (
            <li key={item.id}>
              <Link
                to={item.to}
                className="flex flex-col gap-2 rounded-panel border border-line bg-raised/40 p-3 no-underline shadow-1 hover:border-edge"
              >
                <span className="flex aspect-[4/3] items-center justify-center rounded-control bg-sunken text-ink-3">
                  <Icon name={item.icon} size={22} />
                </span>
                <span className="truncate text-[14px] text-ink">{item.name}</span>
                <span className="truncate text-[13px] text-ink-3">{item.sub}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ---------- Board ---------- */

function Board({ project }: { project: Project }) {
  const workflow = workflows.find((w) => w.id === project.workflowId);
  const [mode, setMode] = useState<"board" | "timeline">("board");
  const projectTracks = tracks.filter((t) => t.projectId === project.id);
  const open = reviews.filter((r) => r.projectId === project.id && r.status === "open");
  const columns = [
    { name: "No version", category: "todo" as const },
    ...(workflow?.statuses ?? []),
  ];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="text-[13px] text-ink-3">{workflow?.name}</span>
        <div
          role="radiogroup"
          className="ml-auto flex rounded-control border border-line bg-raised/40 p-0.5"
        >
          {(["board", "timeline"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                "h-6 rounded-[4px] px-2.5 text-[13px] capitalize",
                mode === m ? "bg-overlay text-ink shadow-2" : "text-ink-3 hover:text-ink",
              )}
            >
              {m}
            </button>
          ))}
        </div>
      </div>
      {mode === "timeline" ? (
        <Timeline project={project} />
      ) : (
        <div className="-mx-4 overflow-x-auto px-4 @3xl/app:-mx-6 @3xl/app:px-6">
          <div className="flex min-w-max gap-3 pb-2">
            {columns.map((col) => {
              const cards = projectTracks.filter((t) => {
                const v = latestVersion(t);
                return col.name === "No version" ? !v : v?.status === col.name;
              });
              return (
                <div key={col.name} className="flex w-64 shrink-0 flex-col gap-2">
                  <div className="flex items-center gap-2 px-1">
                    <Dot
                      state={
                        col.category === "done"
                          ? "approved"
                          : col.category === "todo"
                            ? "invited"
                            : "in_review"
                      }
                    />
                    <span className="text-[14px] font-medium text-ink">{col.name}</span>
                    <span className="tabular text-[13px] text-ink-3">{cards.length}</span>
                  </div>
                  <div className="flex min-h-24 flex-col gap-2 rounded-panel-lg bg-sunken p-2">
                    {cards.map((t) => {
                      const v = latestVersion(t);
                      const stage = workflow?.stages.find((s) => s.status === v?.status);
                      const next = workflow?.stages.find((s) => s.after.includes(stage?.id ?? ""));
                      const r = open.find((x) => x.items.some((i) => i.trackId === t.id));
                      return (
                        <Link
                          key={t.id}
                          to="/tracks/$trackId"
                          params={{ trackId: t.id }}
                          className="flex flex-col gap-1.5 rounded-panel border border-line bg-raised/40 p-3 no-underline shadow-1 hover:border-edge"
                        >
                          <span className="flex items-baseline gap-2">
                            <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">
                              {t.name}
                            </span>
                            <span className="tabular text-[13px] text-ink-3">
                              {v ? `V${v.number}` : ""}
                            </span>
                          </span>
                          {stage && <span className="text-[13px] text-ink-2">{stage.name}</span>}
                          {r && (
                            <span className="flex items-center gap-2 text-[13px] text-ink-3">
                              <AvatarRow
                                personIds={r.reviewers
                                  .filter((x) => x.state !== "submitted")
                                  .map((x) => x.personId)}
                                size={18}
                              />
                              waiting
                              {r.dueAt && (
                                <span
                                  className={cn(
                                    "ml-auto tabular",
                                    dueIn(r.dueAt).days < 0 && "text-signal",
                                  )}
                                >
                                  {formatDate(r.dueAt)}
                                </span>
                              )}
                            </span>
                          )}
                          {!r && next && (
                            <span className="text-[13px] text-ink-3">next: {next.name}</span>
                          )}
                          {v?.state === "failed" && (
                            <span className="flex items-center gap-1 text-[13px] text-signal">
                              <Icon name="warning" size={12} /> could not be analysed
                            </span>
                          )}
                        </Link>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** A Gantt-like view from the schedule and the due dates: one row per track, its stages across the weeks. */
function Timeline({ project }: { project: Project }) {
  const workflow = workflows.find((w) => w.id === project.workflowId);
  const projectTracks = tracks.filter((t) => t.projectId === project.id);
  const days = 42;
  const start = new Date("2026-09-28T00:00:00Z");
  const x = (iso: string) =>
    ((new Date(iso).getTime() - start.getTime()) / 86_400_000 / days) * 100;
  const weeks = Array.from(
    { length: days / 7 },
    (_, i) => new Date(start.getTime() + i * 7 * 86_400_000),
  );
  const today = x("2026-10-14T21:00:00Z");
  return (
    <div className="scroll-quiet overflow-x-auto rounded-panel-lg border border-line bg-raised/20">
      <div className="min-w-[760px]">
        <div className="relative ml-[180px] flex h-8 border-b border-line text-[11px] text-ink-3">
          {weeks.map((w) => (
            <span key={w.toISOString()} className="flex-1 border-l border-line pl-1.5 leading-8">
              {formatDate(w.toISOString())}
            </span>
          ))}
        </div>
        {projectTracks.map((t, i) => {
          const v = latestVersion(t);
          const stage = workflow?.stages.find((s) => s.status === v?.status);
          const open = reviews.find(
            (r) =>
              r.projectId === project.id &&
              r.status === "open" &&
              r.items.some((x) => x.trackId === t.id),
          );
          const from = v?.uploadedAt ?? t.versions[0]?.uploadedAt;
          const to =
            open?.dueAt ??
            (from ? new Date(new Date(from).getTime() + 7 * 86_400_000).toISOString() : null);
          return (
            <div
              key={t.id}
              className="relative flex h-11 items-center border-b border-line last:border-b-0"
            >
              <Link
                to="/tracks/$trackId"
                params={{ trackId: t.id }}
                className="w-[180px] shrink-0 truncate px-3 text-[13px] text-ink hover:text-signal"
              >
                {t.name}
              </Link>
              <div className="relative h-full flex-1">
                {weeks.map((w, j) => (
                  <span
                    key={w.toISOString()}
                    className="absolute top-0 bottom-0 border-l border-line"
                    style={{ left: `${(j / weeks.length) * 100}%` }}
                  />
                ))}
                {from && to && (
                  <span
                    className={cn(
                      "absolute top-2.5 h-6 rounded-[5px] px-2 text-[12px] leading-6 text-ground",
                      v?.status === "Approved" ? "bg-ink" : i % 2 ? "bg-ink-2" : "bg-ink-3",
                    )}
                    style={{
                      left: `${Math.max(0, x(from))}%`,
                      width: `${Math.max(4, x(to) - x(from))}%`,
                    }}
                  >
                    <span className="block truncate">
                      {stage?.name ?? v?.status ?? "No version"}
                    </span>
                  </span>
                )}
                {!from && (
                  <span className="absolute top-3 left-2 text-[12px] text-ink-3">
                    Nothing scheduled
                  </span>
                )}
              </div>
            </div>
          );
        })}
        <span
          className="pointer-events-none absolute top-0 bottom-0 w-px bg-signal"
          style={{ left: `calc(180px + ${today}% * (100% - 180px) / 100)` }}
        />
      </div>
    </div>
  );
}

/* ---------- Reviews, tasks, people ---------- */

function ProjectReviews({ project }: { project: Project }) {
  const viewer = useViewer();
  const list = reviews.filter((r) => r.projectId === project.id);
  const groups: [string, Review[]][] = [
    ["Open", list.filter((r) => r.status === "open")],
    ["Finished", list.filter((r) => r.status !== "open")],
  ];
  if (list.length === 0)
    return (
      <Empty
        title="No reviews yet"
        text="Ask people to approve or give feedback on tracks and files, or share them to listen."
        action={
          viewer.can(project.id, "request_reviews") ? (
            <Button variant="primary" asChild>
              <Link to="/reviews/new" search={{ project: project.id }}>
                Request a review
              </Link>
            </Button>
          ) : undefined
        }
      />
    );
  return (
    <div className="flex flex-col gap-6">
      {groups.map(([title, rows]) =>
        rows.length === 0 ? null : (
          <section key={title} className="flex flex-col gap-2">
            <Label>
              {title} · {rows.length}
            </Label>
            <ul className="-mx-2 flex flex-col">
              {rows.map((r) => {
                const due = r.dueAt ? dueIn(r.dueAt) : null;
                return (
                  <li key={r.id}>
                    <Link
                      to="/reviews/$reviewId"
                      params={{ reviewId: r.id }}
                      className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3.5 rounded-panel px-2 py-2 transition-colors hover:bg-raised/60 @3xl/app:grid-cols-[auto_minmax(0,1fr)_120px_130px_130px]"
                    >
                      <Dot state={reviewDot(r.status, reviewOutcome(r))} />
                      <span className="min-w-0">
                        <span className="block truncate text-[14px] font-medium text-ink">
                          {r.title}
                        </span>
                        <span className="block truncate text-[13px] text-ink-3">
                          {kindCopy[r.kind]}
                          {r.order === "sequence" && ", in turn"} · {personById(r.requestedBy).name}{" "}
                          · {plural(r.items.length, "item")}
                        </span>
                      </span>
                      <span className="hidden @3xl/app:block">
                        <AvatarRow personIds={r.reviewers.map((x) => x.personId)} size={20} />
                      </span>
                      <span
                        className={cn(
                          "tabular hidden text-[13px] @3xl/app:block",
                          r.status === "open" && due && due.days < 0 ? "text-signal" : "text-ink-3",
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
          </section>
        ),
      )}
    </div>
  );
}

function ProjectTasks({ project }: { project: Project }) {
  const viewer = useViewer();
  const [filter, setFilter] = useState<"all" | "mine" | "unassigned" | "overdue" | "done">("all");
  const [creating, setCreating] = useState(false);
  const statusCopy = {
    pending: "To do",
    in_progress: "In progress",
    needs_approval: "Needs approval",
    done: "Done",
  };
  const list = tasks
    .filter((t) => t.projectId === project.id)
    .filter((t) =>
      filter === "mine"
        ? t.assigneeId === viewer.personId
        : filter === "unassigned"
          ? !t.assigneeId
          : filter === "overdue"
            ? Boolean(t.dueAt && t.status !== "done" && dueIn(`${t.dueAt}T23:59:00Z`).days < 0)
            : filter === "done"
              ? t.status === "done"
              : true,
    );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1">
        {(
          [
            ["all", "All"],
            ["mine", "Mine"],
            ["unassigned", "Unassigned"],
            ["overdue", "Overdue"],
            ["done", "Done"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={filter === id}
            onClick={() => setFilter(id)}
            className={cn(
              "h-7 rounded-control px-2.5 text-[13px] transition-colors",
              filter === id ? "bg-raised text-ink shadow-1" : "text-ink-3 hover:text-ink",
            )}
          >
            {label}
          </button>
        ))}
        <span className="ml-auto flex gap-1">
          <Button variant="ghost" size="md">
            Export
          </Button>
          {viewer.can(project.id, "comment") && (
            <Button variant="secondary" size="md" onClick={() => setCreating(true)}>
              <Icon name="plus" size={14} />
              Task
            </Button>
          )}
        </span>
      </div>
      {list.length === 0 ? (
        <Empty
          title={filter === "all" ? "No tasks yet" : "Nothing here"}
          text="Tasks come from a comment's menu, or by hand. Each has an owner, a priority and a date."
        />
      ) : (
        <ul className="-mx-2 flex flex-col">
          {list.map((t) => {
            const overdue =
              t.dueAt && t.status !== "done" && dueIn(`${t.dueAt}T23:59:00Z`).days < 0;
            const file = t.fileId ? allFiles.find((f) => f.id === t.fileId) : undefined;
            return (
              <li
                key={t.id}
                className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3.5 rounded-panel px-2 py-2 transition-colors hover:bg-raised/60 @3xl/app:grid-cols-[auto_minmax(0,1fr)_150px_130px_90px]"
              >
                <Dot
                  state={
                    t.status === "done"
                      ? "approved"
                      : t.priority === "high"
                        ? "changes_requested"
                        : "invited"
                  }
                />
                <span className="min-w-0">
                  <span
                    className={cn(
                      "block truncate text-[14px]",
                      t.status === "done" ? "text-ink-3 line-through" : "text-ink",
                    )}
                  >
                    {t.title}
                  </span>
                  <span className="block truncate text-[13px] text-ink-3">
                    {statusCopy[t.status]}
                    {t.priority === "high" && " · high priority"}
                    {file && (
                      <>
                        {" · "}
                        <Link
                          to="/files/$fileId"
                          params={{ fileId: file.id }}
                          search={t.commentId ? { comment: t.commentId } : {}}
                          className="hover:text-ink"
                        >
                          {file.name}
                        </Link>
                      </>
                    )}
                  </span>
                </span>
                <span className="hidden items-center gap-2 text-[13px] text-ink-2 @3xl/app:flex">
                  {t.assigneeId ? (
                    <>
                      <Avatar personId={t.assigneeId} size={18} />
                      {personById(t.assigneeId).name}
                    </>
                  ) : (
                    <span className="text-ink-3">Unassigned</span>
                  )}
                </span>
                <span className="hidden text-[13px] text-ink-3 @3xl/app:block">
                  {statusCopy[t.status]}
                </span>
                <span
                  className={cn(
                    "tabular text-right text-[13px]",
                    overdue ? "text-signal" : "text-ink-3",
                  )}
                >
                  {t.dueAt ? formatDate(`${t.dueAt}T12:00:00Z`) : ""}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {creating && (
        <Dialog
          title="New task"
          onClose={() => setCreating(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => setCreating(false)}>
                Add task
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
              Title
              <Input placeholder="What needs doing" />
            </label>
            <div className="grid gap-4 @md/app:grid-cols-3">
              <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                Owner
                <Select defaultValue="">
                  {[
                    { id: "", name: "Unassigned" },
                    ...project.members.map((m) => personById(m.personId)),
                  ].map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                Priority
                <Select defaultValue="normal">
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                </Select>
              </label>
              <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                Due
                <Input type="date" defaultValue="2026-10-21" />
              </label>
            </div>
            <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
              Related to
              <Select defaultValue="">
                <option value="">Nothing in particular</option>
                {tracks
                  .filter((t) => t.projectId === project.id)
                  .map((t) => (
                    <option key={t.id}>{t.name}</option>
                  ))}
              </Select>
            </label>
            <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
              Notes
              <Textarea rows={2} />
            </label>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function People({ project }: { project: Project }) {
  const viewer = useViewer();
  const manage = viewer.can(project.id, "manage_roles");
  const projectGroups = groups.filter((g) => g.projectId === project.id);
  const [dialog, setDialog] = useState<"member" | "group" | null>(null);
  const [groupId, setGroupId] = useState<string | null>(null);
  return (
    <div className="grid gap-8 @5xl/app:grid-cols-[minmax(0,1fr)_320px]">
      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Label>Members</Label>
          {manage && (
            <Button
              variant="secondary"
              size="sm"
              className="ml-auto"
              onClick={() => setDialog("member")}
            >
              Add member
            </Button>
          )}
        </div>
        <ul className="list-none rounded-panel-lg border border-line bg-raised/25 p-0 shadow-1">
          {project.members.map((m) => {
            const p = personById(m.personId);
            const role = project.roles.find((r) => r.id === m.roleId);
            return (
              <li
                key={m.personId}
                className="group flex items-center gap-3 border-b border-line px-3 py-2 last:border-b-0"
              >
                <Avatar personId={m.personId} size={28} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] text-ink">{p.name}</span>
                  <span className="block truncate text-[13px] text-ink-3">{p.email}</span>
                </span>
                {manage ? (
                  <select
                    defaultValue={m.roleId}
                    className="h-7 rounded-control border border-transparent bg-transparent text-[14px] text-ink-2 hover:border-edge"
                  >
                    {project.roles.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-[14px] text-ink-2">{role?.name}</span>
                )}
                {manage && (
                  <ActionMenu
                    label={p.name}
                    actions={[{ label: "Remove from project", danger: true, onSelect: () => {} }]}
                  />
                )}
              </li>
            );
          })}
        </ul>
      </section>
      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Label>Groups</Label>
          {viewer.can(project.id, "manage_reviewers") && (
            <Button
              variant="secondary"
              size="sm"
              className="ml-auto"
              onClick={() => {
                setGroupId(null);
                setDialog("group");
              }}
            >
              New group
            </Button>
          )}
        </div>
        <ul className="list-none rounded-panel-lg border border-line bg-raised/25 p-0 shadow-1">
          {projectGroups.map((g) => (
            <li
              key={g.id}
              className="flex items-center gap-3 border-b border-line px-3 py-2.5 last:border-b-0"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] text-ink">{g.name}</span>
                <span className="block truncate text-[13px] text-ink-3">
                  {g.personIds.map((id) => personById(id).name).join(", ")}
                </span>
              </span>
              <AvatarRow personIds={g.personIds} size={20} />
              {viewer.can(project.id, "manage_reviewers") && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setGroupId(g.id);
                    setDialog("group");
                  }}
                >
                  Edit
                </Button>
              )}
            </li>
          ))}
        </ul>
      </section>
      {dialog === "member" && (
        <Dialog
          title="Add a member to the project"
          onClose={() => setDialog(null)}
          width="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setDialog(null)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => setDialog(null)}>
                Add
              </Button>
            </>
          }
        >
          <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
            Who
            <Select defaultValue="">
              <option value="">Choose a member of the organisation</option>
              {personById("p-tomas").name}
            </Select>
          </label>
          <label className="mt-3 flex flex-col gap-1.5 text-[13px] text-ink-2">
            Role
            <Select defaultValue="r-reviewer">
              {project.roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </label>
          <p className="mt-3 text-[12px] text-ink-3">
            Someone not in the organisation yet is invited from Members first; guests join through
            reviews.
          </p>
        </Dialog>
      )}
      {dialog === "group" && (
        <Dialog
          title={groupId ? "Edit group" : "New group"}
          description="A group is one step of a review: everyone in it is asked together."
          onClose={() => setDialog(null)}
          width="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setDialog(null)}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => setDialog(null)}>
                Save
              </Button>
            </>
          }
        >
          <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
            Name
            <Input
              defaultValue={projectGroups.find((g) => g.id === groupId)?.name ?? ""}
              placeholder="Soloists"
            />
          </label>
          <div className="mt-3 flex flex-col gap-1.5 text-[13px] text-ink-2">
            People, in order
            {[...project.members.map((m) => m.personId), "p-mira"]
              .filter((v, i, a) => a.indexOf(v) === i)
              .map((id) => (
                <label key={id} className="flex items-center gap-2 text-[14px] text-ink">
                  <input
                    type="checkbox"
                    defaultChecked={projectGroups
                      .find((g) => g.id === groupId)
                      ?.personIds.includes(id)}
                  />
                  <Avatar personId={id} size={20} />
                  {personById(id).name}
                  {id === "p-mira" && <span className="text-[12px] text-ink-3">guest</span>}
                </label>
              ))}
          </div>
        </Dialog>
      )}
    </div>
  );
}

/* ---------- The page ---------- */

export function ProjectPage({
  projectId,
  view,
  folderId,
  section,
}: {
  projectId: string;
  view: string;
  folderId?: string;
  section?: string;
}) {
  const viewer = useViewer();
  const navigate = useNavigate();
  const project = projectById(projectId);
  const visible = project && viewer.canSee(projectId);
  const ownHeader = view === "settings" || view === "workflow";
  usePageHeader(
    ownHeader
      ? null
      : {
          crumbs: [{ label: "Projects", to: "/projects" }],
          title: project && visible ? project.name : "Not found",
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
    <div className="fade-in mx-auto flex max-w-[1120px] flex-col gap-6 px-4 pb-10 @3xl/app:px-6">
      <Tabs project={project} view={view} />
      <StateGate>
        {view === "overview" && <Overview project={project} />}
        {view === "files" && <Files project={project} folderId={folderId ?? null} />}
        {view === "board" && <Board project={project} />}
        {view === "reviews" && <ProjectReviews project={project} />}
        {view === "tasks" && <ProjectTasks project={project} />}
        {view === "people" && <People project={project} />}
        {view === "sessions" && <SessionsView project={project} />}
        {view === "coverage" && <CoverageView project={project} />}
        {view === "production" && <Soon title="Production" round={3} />}
      </StateGate>
    </div>
  );
}
