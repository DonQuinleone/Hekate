import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Avatar } from "~/components/avatar";
import { Icon, type IconName } from "~/components/icons";
import { Label } from "~/components/label";
import { Card } from "~/components/page";
import { Dot, type DotState } from "~/components/status";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Input, Select, Textarea } from "~/components/ui/input";
import { ActionMenu, Dropdown } from "~/components/ui/menu";
import {
  files as allFiles,
  comments,
  type Project,
  personById,
  type Task,
  tasks,
  tracks,
  variantOf,
} from "~/data";
import { cn } from "~/lib/cn";
import { ago, dueIn, formatDate, formatDateTime } from "~/lib/format";
import { useViewer } from "~/viewer/context";
import { Empty } from "~/viewer/state-gate";

type Status = Task["status"];
const statusCopy: Record<Status, string> = {
  pending: "To do",
  in_progress: "In progress",
  needs_approval: "Needs approval",
  done: "Done",
};
const statusDot: Record<Status, DotState> = {
  pending: "invited",
  in_progress: "in_review",
  needs_approval: "submitted",
  done: "approved",
};
const priorityIcon: Record<Task["priority"], IconName> = {
  high: "arrowUp",
  normal: "list",
  low: "chevronDown",
};
const key = (t: Task) => `${t.projectId === "proj-joplin" ? "JR" : "OT"}-${t.id.split("-")[1]}`;

function StatusPicker({ value, onChange }: { value: Status; onChange: (s: Status) => void }) {
  return (
    <Dropdown
      size="sm"
      value={
        <span className="flex items-center gap-2">
          <Dot state={statusDot[value]} />
          {statusCopy[value]}
        </span>
      }
      actions={(Object.keys(statusCopy) as Status[]).map((s) => ({
        label: statusCopy[s],
        checked: s === value,
        onSelect: () => onChange(s),
      }))}
    />
  );
}

/** One task, opened beside the list: the whole of it, and its record. */
function TaskPanel({
  task,
  project,
  onClose,
}: {
  task: Task;
  project: Project;
  onClose: () => void;
}) {
  const viewer = useViewer();
  const [status, setStatus] = useState<Status>(task.status);
  const file = task.fileId ? allFiles.find((f) => f.id === task.fileId) : undefined;
  const comment = task.commentId ? comments.find((c) => c.id === task.commentId) : undefined;
  const track = file ? variantOf(file.id)?.track : undefined;
  const due = task.dueAt ? dueIn(`${task.dueAt}T23:59:00Z`) : null;
  const log = [
    comment
      ? {
          at: comment.createdAt,
          personId: comment.authorId,
          text: "wrote the comment this came from",
        }
      : { at: "2026-10-12T09:00:00Z", personId: "p-alex", text: "created the task" },
    ...(task.assigneeId
      ? [
          {
            at: "2026-10-12T09:05:00Z",
            personId: "p-alex",
            text: `assigned ${personById(task.assigneeId).name}`,
          },
        ]
      : []),
    ...(task.status === "in_progress" || task.status === "needs_approval" || task.status === "done"
      ? [
          {
            at: "2026-10-13T15:20:00Z",
            personId: task.assigneeId ?? "p-alex",
            text: "started on it",
          },
        ]
      : []),
    ...(task.status === "needs_approval"
      ? [
          {
            at: "2026-10-14T11:40:00Z",
            personId: task.assigneeId ?? "p-alex",
            text: "marked it done, waiting for approval",
          },
        ]
      : []),
    ...(task.status === "done"
      ? [{ at: "2026-10-14T16:10:00Z", personId: "p-alex", text: "approved and closed it" }]
      : []),
  ];
  return (
    <aside
      aria-label={task.title}
      className="rise-in fixed inset-y-0 right-0 z-30 flex w-full flex-col border-l border-line bg-pane shadow-4 @3xl/app:w-[460px]"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
        <span className="tabular text-[12px] text-ink-3">{key(task)}</span>
        <StatusPicker value={status} onChange={setStatus} />
        <span className="ml-auto flex items-center gap-1">
          <ActionMenu
            always
            label="task"
            actions={[
              { label: "Copy link", onSelect: () => {} },
              { label: "Duplicate", onSelect: () => {} },
              "divider",
              { label: "Delete", danger: true, onSelect: onClose },
            ]}
          />
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-raised hover:text-ink"
          >
            <Icon name="close" size={14} />
          </button>
        </span>
      </div>
      <div className="scroll-quiet min-h-0 flex-1 overflow-auto">
        <div className="flex flex-col gap-5 px-5 py-5">
          <h2 className="text-[18px] leading-[26px] font-semibold tracking-[-0.01em] text-ink">
            {task.title}
          </h2>
          <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-[13px]">
            <span className="text-ink-3">Owner</span>
            <span className="flex items-center gap-2 text-ink">
              {task.assigneeId ? (
                <>
                  <Avatar personId={task.assigneeId} size={20} />
                  {personById(task.assigneeId).name}
                </>
              ) : (
                <button type="button" className="text-ink-3 hover:text-ink">
                  Assign someone
                </button>
              )}
            </span>
            <span className="text-ink-3">Priority</span>
            <span className="flex items-center gap-1.5 capitalize text-ink">
              <Icon name={priorityIcon[task.priority]} size={13} className="text-ink-3" />
              {task.priority}
            </span>
            <span className="text-ink-3">Due</span>
            <span
              className={cn(due && due.days < 0 && status !== "done" ? "text-signal" : "text-ink")}
            >
              {task.dueAt
                ? `${formatDate(`${task.dueAt}T12:00:00Z`)}${due && status !== "done" ? ` · ${due.label}` : ""}`
                : "No date"}
            </span>
            {file && (
              <>
                <span className="text-ink-3">On</span>
                <span className="min-w-0">
                  <Link
                    to="/files/$fileId"
                    params={{ fileId: file.id }}
                    search={task.commentId ? { comment: task.commentId } : {}}
                    className="flex items-center gap-1.5 text-ink hover:text-signal"
                  >
                    <Icon
                      name={
                        file.kind === "video" ? "film" : file.kind === "audio" ? "music" : "file"
                      }
                      size={13}
                      className="text-ink-3"
                    />
                    <span className="truncate">
                      {track ? `${track.name} · ${file.name}` : file.name}
                    </span>
                  </Link>
                </span>
              </>
            )}
          </div>
          {comment && (
            <div className="flex flex-col gap-1.5">
              <Label>From the comment</Label>
              <blockquote className="rounded-panel border border-line bg-raised/30 px-3.5 py-3 text-[14px] leading-[21px] text-ink-2">
                <span className="mb-1 flex items-center gap-2 text-[12px] text-ink-3">
                  <Avatar personId={comment.authorId} size={16} />
                  {personById(comment.authorId).name} · {ago(comment.createdAt)}
                </span>
                {comment.body}
              </blockquote>
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label>Notes</Label>
            <Textarea
              rows={3}
              defaultValue={
                task.priority === "high"
                  ? "Needs doing before the next round goes out; the conductor noticed it on headphones."
                  : ""
              }
              placeholder="Anything the owner should know."
            />
          </div>
          {status === "needs_approval" && viewer.can(project.id, "decide") && (
            <div className="flex items-center gap-2 rounded-panel border border-line bg-raised/30 px-3.5 py-3">
              <span className="text-[13px] text-ink-2">Marked done; needs your approval.</span>
              <Button
                variant="primary"
                size="sm"
                className="ml-auto"
                onClick={() => setStatus("done")}
              >
                Approve
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setStatus("in_progress")}>
                Send back
              </Button>
            </div>
          )}
          <div className="flex flex-col gap-2">
            <Label>Activity</Label>
            <ul className="flex flex-col gap-2.5">
              {log.map((l) => (
                <li key={l.at + l.text} className="flex items-start gap-2.5 text-[13px]">
                  <Avatar personId={l.personId} size={20} className="mt-px" />
                  <span className="min-w-0 flex-1 text-ink-2">
                    <span className="text-ink">{personById(l.personId).name}</span> {l.text}
                    <span className="tabular ml-2 text-[12px] text-ink-3">
                      {formatDateTime(l.at)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-line px-4 py-3">
        <Avatar personId={viewer.personId} size={24} />
        <Input placeholder="Add a note" className="h-9" />
      </div>
    </aside>
  );
}

export function ProjectTasks({
  project,
  taskId,
  create = false,
}: {
  project: Project;
  taskId?: string;
  create?: boolean;
}) {
  const viewer = useViewer();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<"open" | "mine" | "unassigned" | "overdue" | "all">("open");
  const [creating, setCreating] = useState(create);
  const list = tasks
    .filter((t) => t.projectId === project.id)
    .filter((t) =>
      filter === "mine"
        ? t.assigneeId === viewer.personId
        : filter === "unassigned"
          ? !t.assigneeId
          : filter === "overdue"
            ? Boolean(t.dueAt && t.status !== "done" && dueIn(`${t.dueAt}T23:59:00Z`).days < 0)
            : filter === "open"
              ? t.status !== "done"
              : true,
    );
  const groups: [Status, Task[]][] = (
    ["needs_approval", "in_progress", "pending", "done"] as Status[]
  )
    .map((s): [Status, Task[]] => [s, list.filter((t) => t.status === s)])
    .filter(([, rows]) => rows.length > 0);
  const open = (id: string | undefined) =>
    navigate({
      to: "/projects/$projectId/$view",
      params: { projectId: project.id, view: "tasks" },
      search: id ? { task: id } : {},
    });
  const current = taskId ? tasks.find((t) => t.id === taskId) : undefined;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-1">
        {(
          [
            ["open", "Open"],
            ["mine", "Mine"],
            ["unassigned", "Unassigned"],
            ["overdue", "Overdue"],
            ["all", "All"],
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
        <span className="ml-auto flex gap-1">
          <Button variant="ghost" size="md">
            Export
          </Button>
          {viewer.can(project.id, "comment") && (
            <Button variant="primary" size="md" onClick={() => setCreating(true)}>
              <Icon name="plus" size={14} />
              New task
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
        <Card>
          {groups.map(([status, rows]) => (
            <div key={status} className="border-b border-line last:border-b-0">
              <div className="flex h-9 items-center gap-2 bg-raised/20 px-4">
                <Dot state={statusDot[status]} />
                <span className="text-[13px] font-medium text-ink">{statusCopy[status]}</span>
                <span className="tabular text-[12px] text-ink-3">{rows.length}</span>
              </div>
              <ul>
                {rows.map((t) => {
                  const overdue =
                    t.dueAt && t.status !== "done" && dueIn(`${t.dueAt}T23:59:00Z`).days < 0;
                  const file = t.fileId ? allFiles.find((f) => f.id === t.fileId) : undefined;
                  return (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => open(t.id)}
                        aria-current={taskId === t.id ? "true" : undefined}
                        className={cn(
                          "grid w-full grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-raised/50 @3xl/app:grid-cols-[64px_20px_minmax(0,1fr)_150px_110px_90px]",
                          taskId === t.id && "bg-raised/60",
                        )}
                      >
                        <span className="tabular hidden text-[12px] text-ink-3 @3xl/app:block">
                          {key(t)}
                        </span>
                        <Icon
                          name={priorityIcon[t.priority]}
                          size={13}
                          className={t.priority === "high" ? "text-signal" : "text-ink-3"}
                          aria-label={`${t.priority} priority`}
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
                          {file && (
                            <span className="block truncate text-[12px] text-ink-3">
                              {variantOf(file.id)?.track.name ?? file.name}
                            </span>
                          )}
                        </span>
                        <span className="hidden items-center gap-2 text-[13px] text-ink-2 @3xl/app:flex">
                          {t.assigneeId ? (
                            <>
                              <Avatar personId={t.assigneeId} size={20} />
                              <span className="truncate">{personById(t.assigneeId).name}</span>
                            </>
                          ) : (
                            <span className="text-ink-3">Unassigned</span>
                          )}
                        </span>
                        <span className="hidden text-[13px] text-ink-3 @3xl/app:block">
                          {t.commentId ? "From a comment" : "By hand"}
                        </span>
                        <span
                          className={cn(
                            "tabular text-right text-[13px]",
                            overdue ? "text-signal" : "text-ink-3",
                          )}
                        >
                          {t.dueAt ? formatDate(`${t.dueAt}T12:00:00Z`) : ""}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </Card>
      )}
      {current && (
        <TaskPanel
          key={current.id}
          task={current}
          project={project}
          onClose={() => open(undefined)}
        />
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
              <Input placeholder="What needs doing" autoFocus />
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
