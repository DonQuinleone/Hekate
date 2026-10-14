import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { Avatar, AvatarRow } from "~/components/avatar";
import { Icon } from "~/components/icons";
import { Label } from "~/components/label";
import { usePageHeader } from "~/components/page-header";
import { Dot, reviewDot } from "~/components/status";
import { Button } from "~/components/ui/button";
import { ActionMenu } from "~/components/ui/menu";
import {
  activity,
  files as allFiles,
  type File,
  folders,
  groups,
  latestVersion,
  type Project,
  personById,
  projectById,
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

const Panel = ({ children, className }: { children: ReactNode; className?: string }) => (
  <div className={cn("rounded-panel-lg border border-hairline bg-surface shadow-1", className)}>
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
      className="-mb-px flex items-stretch gap-0.5 overflow-x-auto border-b border-hairline"
    >
      {tabs.map((t) => (
        <Link
          key={t.id}
          role="tab"
          aria-selected={view === t.id}
          to={t.id === "overview" ? "/projects/$projectId" : "/projects/$projectId/$view"}
          params={{ projectId: project.id, view: t.id }}
          className={cn(
            "flex h-10 shrink-0 items-center gap-1.5 border-b px-2.5 text-[13px] font-medium no-underline",
            view === t.id
              ? "border-ink text-ink"
              : "border-transparent text-ink-3 hover:text-ink-2",
          )}
        >
          {t.label}
          {t.count ? (
            <span className="tabular rounded-full bg-raised px-1.5 text-[11px] leading-[18px] text-ink-2">
              {t.count}
            </span>
          ) : null}
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
  const due = open
    .filter((r) => r.dueAt)
    .sort((a, b) => (a.dueAt ?? "").localeCompare(b.dueAt ?? ""));
  const recent = activity.filter((a) => a.projectId === project.id).slice(0, 8);
  const openTasks = tasks.filter((t) => t.projectId === project.id && t.status !== "done");
  return (
    <div className="grid gap-8 @5xl/app:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex min-w-0 flex-col gap-8">
        <section className="flex flex-col gap-2">
          <div className="flex items-baseline gap-2">
            <h2 className="m-0 text-[15px] font-medium">Where things stand</h2>
            <span className="text-xs text-ink-3">{workflow?.name}</span>
          </div>
          <Panel>
            <ul className="m-0 list-none p-0">
              {projectTracks.map((t) => {
                const v = latestVersion(t);
                const stage = workflow?.stages.find((s) => s.status === v?.status);
                const next = workflow?.stages.find((s) => s.after.includes(stage?.id ?? ""));
                const waitingOn = open.find((r) => r.items.some((i) => i.trackId === t.id));
                return (
                  <li
                    key={t.id}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-hairline-soft px-4 py-2.5 last:border-b-0 @3xl/app:grid-cols-[minmax(0,1fr)_150px_200px_120px]"
                  >
                    <Link
                      to="/tracks/$trackId"
                      params={{ trackId: t.id }}
                      className="min-w-0 truncate text-[13px] font-medium text-ink no-underline hover:text-signal"
                    >
                      {t.name}
                      <span className="tabular ml-2 text-xs text-ink-3">
                        {v ? `V${v.number}` : "no versions"}
                      </span>
                    </Link>
                    <span className="flex items-center gap-2 text-xs text-ink-2">
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
                          {v.state === "pending"
                            ? "Analysing"
                            : v.state === "failed"
                              ? "Could not be analysed"
                              : v.status}
                        </>
                      ) : (
                        <span className="text-ink-3">Upload the first version</span>
                      )}
                    </span>
                    <span className="hidden truncate text-xs text-ink-3 @3xl/app:block">
                      {waitingOn
                        ? `waiting on ${
                            waitingOn.reviewers
                              .filter((r) => r.state !== "submitted" && r.state !== "observing")
                              .map((r) => personById(r.personId).name.split(" ")[0])
                              .join(", ") || "nobody"
                          }`
                        : next
                          ? `next: ${next.name}`
                          : ""}
                    </span>
                    <span className="hidden text-right text-xs text-ink-3 @3xl/app:block">
                      {v ? ago(v.uploadedAt) : ""}
                    </span>
                  </li>
                );
              })}
              {projectTracks.length === 0 && (
                <li className="px-4 py-4 text-xs text-ink-3">No tracks yet.</li>
              )}
            </ul>
          </Panel>
        </section>
        <section className="flex flex-col gap-2">
          <h2 className="m-0 text-[15px] font-medium">Recent activity</h2>
          <Panel>
            <ul className="m-0 list-none p-0">
              {recent.map((a) => (
                <li
                  key={a.id}
                  className="flex items-center gap-3 border-b border-hairline-soft px-4 py-2.5 last:border-b-0"
                >
                  <Avatar personId={a.personId} size={22} />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">
                    <span className="text-ink">{personById(a.personId).name}</span> {a.text}
                  </span>
                  <span className="tabular shrink-0 text-xs text-ink-3">{ago(a.at)}</span>
                </li>
              ))}
            </ul>
          </Panel>
        </section>
      </div>
      <div className="flex min-w-0 flex-col gap-8">
        <section className="flex flex-col gap-2">
          <h2 className="m-0 text-[15px] font-medium">In review</h2>
          <Panel>
            <ul className="m-0 list-none p-0">
              {open.map((r) => (
                <li key={r.id} className="border-b border-hairline-soft px-4 py-3 last:border-b-0">
                  <div className="flex items-center gap-2">
                    <Dot state={reviewDot(r.status, reviewOutcome(r))} />
                    <Link
                      to="/reviews/$reviewId"
                      params={{ reviewId: r.id }}
                      className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink no-underline hover:text-signal"
                    >
                      {r.title}
                    </Link>
                    {r.dueAt && (
                      <span className={cn("label", dueIn(r.dueAt).days < 0 && "text-signal")}>
                        due {formatDate(r.dueAt)}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-ink-3">
                    <span>
                      {kindCopy[r.kind]}
                      {r.kind === "approval" && `, ${r.rule === "any" ? "any one" : "everyone"}`}
                    </span>
                    <span className="ml-auto">
                      {responded(r)} of {r.reviewers.length} responded
                    </span>
                  </div>
                  <div className="mt-1.5 flex h-1 overflow-hidden rounded-full bg-raised">
                    <div
                      className="bg-ink-3"
                      style={{
                        width: `${(responded(r) / Math.max(1, r.reviewers.length)) * 100}%`,
                      }}
                    />
                  </div>
                </li>
              ))}
              {open.length === 0 && (
                <li className="px-4 py-3 text-xs text-ink-3">Nothing in review.</li>
              )}
            </ul>
          </Panel>
        </section>
        <section className="flex flex-col gap-2">
          <h2 className="m-0 text-[15px] font-medium">Due soon</h2>
          <Panel>
            <ul className="m-0 list-none p-0">
              {[
                ...due.map((r) => ({ at: r.dueAt as string, label: r.title, kind: "Review" })),
                ...openTasks
                  .filter((t) => t.dueAt)
                  .map((t) => ({ at: `${t.dueAt}T23:59:00Z`, label: t.title, kind: "Task" })),
              ]
                .sort((a, b) => a.at.localeCompare(b.at))
                .slice(0, 6)
                .map((d) => (
                  <li
                    key={d.label}
                    className="flex items-center gap-3 border-b border-hairline-soft px-4 py-2.5 last:border-b-0"
                  >
                    <span
                      className={cn(
                        "tabular w-12 shrink-0 text-xs",
                        dueIn(d.at).days < 0 ? "text-signal" : "text-ink-3",
                      )}
                    >
                      {formatDate(d.at)}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{d.label}</span>
                    <Label>{d.kind}</Label>
                  </li>
                ))}
            </ul>
          </Panel>
        </section>
        {viewer.can(project.id, "upload") && (
          <section className="flex flex-col gap-2">
            <h2 className="m-0 text-[15px] font-medium">Processing</h2>
            <Panel>
              <ul className="m-0 list-none p-0">
                {projectTracks
                  .flatMap((t) =>
                    t.versions.filter((v) => v.state !== "ready").map((v) => ({ t, v })),
                  )
                  .map(({ t, v }) => (
                    <li
                      key={v.id}
                      className="flex items-center gap-3 border-b border-hairline-soft px-4 py-2.5 last:border-b-0"
                    >
                      {v.state === "failed" ? (
                        <Icon name="warning" className="text-signal" />
                      ) : (
                        <span className="size-[8px] animate-pulse rounded-full border-[1.5px] border-ink-3" />
                      )}
                      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                        {t.name} V{v.number}
                      </span>
                      <span className="text-xs text-ink-3">
                        {v.state === "failed" ? "could not be analysed" : "analysing"}
                      </span>
                    </li>
                  ))}
                {projectTracks.every((t) => t.versions.every((v) => v.state === "ready")) && (
                  <li className="px-4 py-3 text-xs text-ink-3">Nothing processing.</li>
                )}
              </ul>
            </Panel>
          </section>
        )}
      </div>
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
    <li className="group grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-hairline-soft px-3 last:border-b-0 hover:bg-raised/50 @3xl/app:grid-cols-[auto_minmax(0,1fr)_140px_180px_90px_32px]">
      <Icon name="track" className="text-ink-2" />
      <Link
        to="/tracks/$trackId"
        params={{ trackId: track.id }}
        className="min-w-0 py-2.5 no-underline"
      >
        <span className="block truncate text-[13px] font-medium text-ink">{track.name}</span>
        <span className="block truncate text-xs text-ink-3 @3xl/app:hidden">
          {v ? `V${v.number} · ${v.variations.map((x) => x.name).join(", ")}` : "No versions"}
        </span>
      </Link>
      <span className="hidden items-center gap-2 text-xs text-ink-2 @3xl/app:flex">
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
      <span className="hidden truncate text-xs text-ink-3 @3xl/app:block">
        {v
          ? `V${v.number} · ${v.variations.map((x) => x.name).join(", ")}`
          : "Upload the first version"}
      </span>
      <span className="tabular hidden text-xs text-ink-3 @3xl/app:flex @3xl/app:items-center @3xl/app:gap-1">
        {comments > 0 && (
          <>
            <Icon name="comment" size={12} /> {comments}
          </>
        )}
      </span>
      <span className="flex items-center gap-2">
        <span className="tabular text-xs text-ink-3 @3xl/app:hidden">
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
    <li className="group grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-hairline-soft px-3 last:border-b-0 hover:bg-raised/50 @3xl/app:grid-cols-[auto_minmax(0,1fr)_140px_180px_90px_32px]">
      <Icon name={kindIcon[file.kind]} className="text-ink-3" />
      <Link
        to="/files/$fileId"
        params={{ fileId: file.id }}
        className="min-w-0 py-2.5 no-underline"
      >
        <span
          className={cn("block text-[13px] text-ink", long ? "line-clamp-2 break-all" : "truncate")}
        >
          {file.name}
        </span>
        <span className="block truncate text-xs text-ink-3 @3xl/app:hidden">
          {fileDetails(file)}
        </span>
      </Link>
      <span className="hidden items-center gap-2 text-xs @3xl/app:flex">
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
      <span className="hidden truncate text-xs text-ink-3 @3xl/app:block">{fileDetails(file)}</span>
      <span className="tabular hidden items-center gap-1 text-xs text-ink-3 @3xl/app:flex">
        {comments > 0 && (
          <>
            <Icon name="comment" size={12} /> {comments}
          </>
        )}
      </span>
      <span className="flex items-center gap-2">
        <span className="tabular text-xs text-ink-3 @3xl/app:hidden">{ago(file.uploadedAt)}</span>
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
  const empty =
    state === "empty" || (subfolders.length === 0 && here.length === 0 && loose.length === 0);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <nav aria-label="Folder" className="flex min-w-0 items-center gap-1 text-[13px]">
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
            className="flex h-7 items-center gap-1.5 rounded-control px-2 text-xs text-ink-3 hover:bg-raised hover:text-ink"
          >
            <Icon name="filter" size={14} />
            Filter
          </button>
          <div
            role="radiogroup"
            className="flex rounded-control border border-hairline bg-surface p-0.5"
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
        </div>
      </div>
      {uploading && (
        <Panel className="p-3">
          <div className="label mb-2">Uploading · 2 of 3</div>
          {[
            { name: "The Entertainer - V1 mix.wav", pct: 100, size: "31 MB" },
            { name: "The Entertainer - V1 wet.wav", pct: 62, size: "31 MB" },
            { name: "Pine Apple Rag - V1 mix.wav", pct: 0, size: "28 MB", failed: true },
          ].map((u) => (
            <div key={u.name} className="flex items-center gap-3 py-1.5 text-[13px]">
              <Icon name="music" className="text-ink-3" />
              <span className="min-w-0 flex-1 truncate text-ink">{u.name}</span>
              {u.failed ? (
                <>
                  <span className="text-xs text-signal">Connection lost</span>
                  <button type="button" className="text-xs text-ink-2 hover:text-ink">
                    Retry
                  </button>
                </>
              ) : (
                <span className="tabular text-xs text-ink-3">
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
          <ul className="m-0 list-none rounded-panel-lg border border-hairline bg-surface p-0 shadow-1">
            {subfolders.map((f) => (
              <li
                key={f.id}
                className="group grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-hairline-soft px-3 last:border-b-0 hover:bg-raised/50 @3xl/app:grid-cols-[auto_minmax(0,1fr)_140px_180px_90px_32px]"
              >
                <Icon name="folder" className="text-ink-2" />
                <Link
                  to="/projects/$projectId/$view"
                  params={{ projectId: project.id, view: "files" }}
                  search={{ folder: f.id }}
                  className="min-w-0 truncate py-2.5 text-[13px] font-medium text-ink no-underline"
                >
                  {f.name}
                </Link>
                <span className="hidden text-xs text-ink-3 @3xl/app:block">Folder</span>
                <span className="hidden truncate text-xs text-ink-3 @3xl/app:block">
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
        <ul className="m-0 grid list-none grid-cols-2 gap-3 p-0 @3xl/app:grid-cols-4">
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
                className="flex flex-col gap-2 rounded-panel border border-hairline bg-surface p-3 no-underline shadow-1 hover:border-edge"
              >
                <span className="flex aspect-[4/3] items-center justify-center rounded-control bg-sunken text-ink-3">
                  <Icon name={item.icon} size={22} />
                </span>
                <span className="truncate text-[13px] text-ink">{item.name}</span>
                <span className="truncate text-xs text-ink-3">{item.sub}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {canUpload && !empty && (
        <p className="m-0 text-center text-xs text-ink-3">
          Drop files anywhere on this page to upload them here.
        </p>
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
        <span className="text-xs text-ink-3">
          {workflow?.name}: each card is where a track stands, who it waits on and what comes next.
        </span>
        <div
          role="radiogroup"
          className="ml-auto flex rounded-control border border-hairline bg-surface p-0.5"
        >
          {(["board", "timeline"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                "h-6 rounded-[4px] px-2.5 text-xs capitalize",
                mode === m ? "bg-overlay text-ink shadow-2" : "text-ink-3 hover:text-ink",
              )}
            >
              {m}
            </button>
          ))}
        </div>
      </div>
      {mode === "timeline" ? (
        <Soon title="Timeline" round={2} />
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
                    <span className="text-[13px] font-medium text-ink">{col.name}</span>
                    <span className="tabular text-xs text-ink-3">{cards.length}</span>
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
                          className="flex flex-col gap-1.5 rounded-panel border border-hairline bg-surface p-3 no-underline shadow-1 hover:border-edge"
                        >
                          <span className="flex items-baseline gap-2">
                            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
                              {t.name}
                            </span>
                            <span className="tabular text-xs text-ink-3">
                              {v ? `V${v.number}` : ""}
                            </span>
                          </span>
                          {stage && <span className="text-xs text-ink-2">{stage.name}</span>}
                          {r && (
                            <span className="flex items-center gap-2 text-xs text-ink-3">
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
                            <span className="text-xs text-ink-3">next: {next.name}</span>
                          )}
                          {v?.state === "failed" && (
                            <span className="flex items-center gap-1 text-xs text-signal">
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

/* ---------- Reviews, tasks, people ---------- */

function ProjectReviews({ project }: { project: Project }) {
  const viewer = useViewer();
  const list = reviews.filter((r) => r.projectId === project.id);
  return (
    <div className="flex flex-col gap-3">
      {list.length === 0 ? (
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
      ) : (
        <ul className="m-0 list-none rounded-panel-lg border border-hairline bg-surface p-0 shadow-1">
          {list.map((r) => (
            <li
              key={r.id}
              className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-hairline-soft px-4 py-3 last:border-b-0 @3xl/app:grid-cols-[auto_minmax(0,1fr)_150px_140px_110px]"
            >
              <Dot state={reviewDot(r.status, reviewOutcome(r))} />
              <div className="min-w-0">
                <Link
                  to="/reviews/$reviewId"
                  params={{ reviewId: r.id }}
                  className="block truncate text-[13px] font-medium text-ink no-underline hover:text-signal"
                >
                  {r.title}
                </Link>
                <div className="truncate text-xs text-ink-3">
                  {kindCopy[r.kind]}
                  {r.order === "sequence" && ", in turn"} · asked by{" "}
                  {personById(r.requestedBy).name} · {r.items.length}{" "}
                  {r.items.length === 1 ? "item" : "items"}
                </div>
              </div>
              <span className="hidden @3xl/app:block">
                <AvatarRow personIds={r.reviewers.map((x) => x.personId)} />
              </span>
              <span className="tabular hidden text-xs text-ink-3 @3xl/app:block">
                {r.dueAt ? `due ${formatDate(r.dueAt)}` : ""}
              </span>
              <span className="text-right text-xs text-ink-2">
                {r.status === "cancelled"
                  ? "Cancelled"
                  : r.status === "completed"
                    ? "Finished"
                    : `${responded(r)} of ${r.reviewers.length}`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ProjectTasks({ project }: { project: Project }) {
  const list = tasks.filter((t) => t.projectId === project.id);
  const statusCopy = {
    pending: "To do",
    in_progress: "In progress",
    needs_approval: "Needs approval",
    done: "Done",
  };
  return (
    <ul className="m-0 list-none rounded-panel-lg border border-hairline bg-surface p-0 shadow-1">
      {list.map((t) => (
        <li
          key={t.id}
          className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 border-b border-hairline-soft px-4 py-2.5 last:border-b-0 @3xl/app:grid-cols-[auto_minmax(0,1fr)_140px_130px_90px]"
        >
          <span
            className={cn(
              "size-[8px] rounded-full",
              t.status === "done"
                ? "bg-ink"
                : t.priority === "high"
                  ? "border-[1.5px] border-signal"
                  : "border-[1.5px] border-ink-3",
            )}
          />
          <span
            className={cn(
              "min-w-0 truncate text-[13px]",
              t.status === "done" ? "text-ink-3 line-through" : "text-ink",
            )}
          >
            {t.title}
          </span>
          <span className="hidden items-center gap-2 text-xs text-ink-2 @3xl/app:flex">
            {t.assigneeId ? (
              <>
                <Avatar personId={t.assigneeId} size={18} />
                {personById(t.assigneeId).name}
              </>
            ) : (
              <span className="text-ink-3">Unassigned</span>
            )}
          </span>
          <span className="hidden text-xs text-ink-3 @3xl/app:block">{statusCopy[t.status]}</span>
          <span
            className={cn(
              "tabular text-xs",
              t.dueAt && t.status !== "done" && dueIn(`${t.dueAt}T23:59:00Z`).days < 0
                ? "text-signal"
                : "text-ink-3",
            )}
          >
            {t.dueAt ? formatDate(`${t.dueAt}T12:00:00Z`) : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

function People({ project }: { project: Project }) {
  const viewer = useViewer();
  const manage = viewer.can(project.id, "manage_roles");
  const projectGroups = groups.filter((g) => g.projectId === project.id);
  return (
    <div className="grid gap-8 @5xl/app:grid-cols-[minmax(0,1fr)_320px]">
      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h2 className="m-0 text-[15px] font-medium">Members</h2>
          {manage && (
            <Button variant="secondary" size="sm" className="ml-auto">
              Add member
            </Button>
          )}
        </div>
        <ul className="m-0 list-none rounded-panel-lg border border-hairline bg-surface p-0 shadow-1">
          {project.members.map((m) => {
            const p = personById(m.personId);
            const role = project.roles.find((r) => r.id === m.roleId);
            return (
              <li
                key={m.personId}
                className="group flex items-center gap-3 border-b border-hairline-soft px-3 py-2 last:border-b-0"
              >
                <Avatar personId={m.personId} size={28} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-ink">{p.name}</span>
                  <span className="block truncate text-xs text-ink-3">{p.email}</span>
                </span>
                {manage ? (
                  <select
                    defaultValue={m.roleId}
                    className="h-7 rounded-control border border-transparent bg-transparent text-[13px] text-ink-2 hover:border-edge"
                  >
                    {project.roles.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-[13px] text-ink-2">{role?.name}</span>
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
        <p className="m-0 text-xs text-ink-3">
          Organisation owners and admins can do everything here without a role. Roles and their
          permissions are set in Settings.
        </p>
      </section>
      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h2 className="m-0 text-[15px] font-medium">Groups</h2>
          {viewer.can(project.id, "manage_reviewers") && (
            <Button variant="secondary" size="sm" className="ml-auto">
              New group
            </Button>
          )}
        </div>
        <ul className="m-0 list-none rounded-panel-lg border border-hairline bg-surface p-0 shadow-1">
          {projectGroups.map((g) => (
            <li
              key={g.id}
              className="flex items-center gap-3 border-b border-hairline-soft px-3 py-2.5 last:border-b-0"
            >
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] text-ink">{g.name}</span>
                <span className="block truncate text-xs text-ink-3">
                  {g.personIds.map((id) => personById(id).name).join(", ")}
                </span>
              </span>
              <AvatarRow personIds={g.personIds} size={20} />
            </li>
          ))}
        </ul>
        <p className="m-0 text-xs text-ink-3">
          A group is one step of a review: everyone in it is asked together.
        </p>
      </section>
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
  usePageHeader({
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
  });
  if (!project || !visible) return <Refused />;
  void section;
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-4 @3xl/app:px-6">
      <Tabs project={project} view={view} />
      <StateGate>
        {view === "overview" && <Overview project={project} />}
        {view === "files" && <Files project={project} folderId={folderId ?? null} />}
        {view === "board" && <Board project={project} />}
        {view === "reviews" && <ProjectReviews project={project} />}
        {view === "tasks" && <ProjectTasks project={project} />}
        {view === "people" && <People project={project} />}
        {view === "sessions" && <Soon title="Sessions and takes" round={2} />}
        {view === "production" && <Soon title="Production" round={3} />}
        {view === "settings" && <Soon title="Project settings" round={2} />}
      </StateGate>
    </div>
  );
}
