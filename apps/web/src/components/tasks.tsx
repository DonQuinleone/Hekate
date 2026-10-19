import {
  filterTasks,
  isOverdue,
  type TaskDetail,
  type TaskFilter,
  type TaskPriority,
  type TaskStatus,
  type TaskSummary,
  taskDueWords,
  taskGroupOrder,
  taskStatuses,
  taskStatusNames,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { Avatar } from "~/components/avatar";
import { Empty } from "~/components/empty";
import { Icon, type IconName } from "~/components/icons";
import { Card } from "~/components/page";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { InlineInput, Input, Select, Textarea } from "~/components/ui/input";
import { ActionMenu, Dropdown } from "~/components/ui/menu";
import { ReviewerDot, type ReviewerDotState } from "~/components/ui/status";
import { cn } from "~/lib/cn";
import { ago } from "~/lib/comments";
import { formatDates } from "~/lib/locale";
import {
  meQuery,
  projectTasksQuery,
  projectTracksQuery,
  taskQuery,
  useTaskMutations,
} from "~/lib/queries";

/** Each status by the shapes reviews use, never a traffic light (docs/brand.md). */
const statusDot: Record<TaskStatus, ReviewerDotState> = {
  pending: "invited",
  in_progress: "in_review",
  needs_approval: "submitted",
  done: "approved",
};
const priorityIcon: Record<TaskPriority, IconName> = {
  high: "arrowUp",
  normal: "list",
  low: "chevronDown",
};
const priorityName: Record<TaskPriority, string> = { high: "High", normal: "Normal", low: "Low" };

const filters: readonly [TaskFilter, string][] = [
  ["open", "Open"],
  ["mine", "Mine"],
  ["unassigned", "Unassigned"],
  ["overdue", "Overdue"],
  ["all", "All"],
];

/** A due date has no time zone: read at noon UTC, so it is the same day everywhere. */
const dayFormat = formatDates({ day: "numeric", month: "short", timeZone: "UTC" });
const fullDayFormat = formatDates({
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const timeFormat = formatDates({
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
const dayOf = (date: string) => new Date(`${date}T12:00:00Z`);

/** Today, as a date where the member is: 2026-10-19. */
const today = () => new Date().toLocaleDateString("en-CA");

/** Where a task comes from, as its list says it. */
const origin = (t: TaskSummary) =>
  t.commentId ? "From a comment" : t.fromWorkflow ? "From the workflow" : "By hand";

function StatusChoice({
  task,
  onChange,
}: {
  task: TaskSummary;
  onChange: (status: TaskStatus) => void;
}) {
  const value = (
    <span className="flex items-center gap-2">
      <ReviewerDot state={statusDot[task.status]} />
      {taskStatusNames[task.status]}
    </span>
  );
  if (!task.rights.status)
    return <span className="flex h-7 items-center px-2 text-[13px] text-ink-2">{value}</span>;
  return (
    <Dropdown
      size="sm"
      label="Status"
      value={value}
      actions={taskStatuses
        .filter((s) => s === task.status || task.rights.statusTo.includes(s))
        .map((s) => ({
          label: taskStatusNames[s],
          checked: s === task.status,
          onSelect: () => s !== task.status && onChange(s),
        }))}
    />
  );
}

/** One task, opened beside the list: the whole of it, and its record. */
function TaskPanel({
  projectId,
  taskId,
  people,
  onClose,
}: {
  projectId: string;
  taskId: string;
  people: { id: string; name: string }[];
  onClose: () => void;
}) {
  const { data: task, error } = useQuery(taskQuery(taskId));
  const { data: me } = useQuery(meQuery);
  const mutations = useTaskMutations(projectId);
  const [note, setNote] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector("[role=dialog]")) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const change = (patch: Parameters<typeof mutations.change.mutate>[0]) =>
    mutations.change.mutate(patch);
  const failure = error ?? mutations.change.error ?? mutations.note.error ?? mutations.remove.error;
  const addNote = (e: FormEvent) => {
    e.preventDefault();
    if (!task || !note.trim()) return;
    mutations.note.mutate({ id: task.id, note: note.trim() }, { onSuccess: () => setNote("") });
  };
  return (
    <aside
      aria-label={task?.title ?? "Task"}
      data-e2e-layer
      className="rise-in fixed inset-y-0 right-0 z-30 flex w-full flex-col border-l border-line bg-pane shadow-4 @3xl/app:w-[460px]"
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
        {task && (
          <>
            <span className="tabular text-[12px] text-ink-3">{task.key}</span>
            <StatusChoice task={task} onChange={(status) => change({ id: task.id, status })} />
          </>
        )}
        <span className="ml-auto flex items-center gap-1">
          {task && (
            <ActionMenu
              always
              label="the task"
              actions={[
                {
                  label: copied ? "Link copied" : "Copy link",
                  onSelect: () => {
                    void navigator.clipboard
                      ?.writeText(window.location.href)
                      .then(() => setCopied(true));
                  },
                },
                ...(task.rights.delete
                  ? [
                      "divider" as const,
                      {
                        label: "Delete",
                        danger: true,
                        onSelect: () =>
                          mutations.remove.mutate(task.id, { onSuccess: () => onClose() }),
                      },
                    ]
                  : []),
              ]}
            />
          )}
          <button
            type="button"
            aria-label="Close the task"
            onClick={onClose}
            className="flex size-8 items-center justify-center rounded-control text-ink-3 hover:bg-raised hover:text-ink"
          >
            <Icon name="close" size={14} />
          </button>
        </span>
      </div>
      <div className="scroll-quiet min-h-0 flex-1 overflow-auto">
        {failure && <p className="m-0 px-5 pt-4 text-[13px] text-signal">{failure.message}</p>}
        {!task ? (
          !error && <p className="m-0 px-5 py-5 text-[13px] text-ink-3">Loading</p>
        ) : (
          <TaskBody
            key={task.id}
            task={task}
            people={people}
            onChange={(patch) => change({ id: task.id, ...patch })}
          />
        )}
      </div>
      {task?.rights.note && (
        <form
          onSubmit={addNote}
          className="flex shrink-0 items-center gap-2 border-t border-line px-4 py-3"
        >
          {me && <Avatar id={me.user.id} name={me.user.name} size={24} />}
          <Input
            aria-label="Add a note"
            placeholder="Add a note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={4000}
          />
          <Button
            type="submit"
            variant="secondary"
            disabled={!note.trim() || mutations.note.isPending}
          >
            Add
          </Button>
        </form>
      )}
    </aside>
  );
}

function TaskBody({
  task,
  people,
  onChange,
}: {
  task: TaskDetail;
  people: { id: string; name: string }[];
  onChange: (
    patch: Partial<Omit<TaskDetail, "notes" | "assignee">> & {
      notes?: string | null;
      assigneeId?: string | null;
      status?: TaskStatus;
    },
  ) => void;
}) {
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes ?? "");
  const edit = task.rights.edit;
  const due = task.dueOn && task.status !== "done" ? taskDueWords(task.dueOn, today()) : null;
  const late = isOverdue(task, today());
  return (
    <div className="flex flex-col gap-5 px-5 py-5">
      {edit ? (
        <InlineInput
          aria-label="Title"
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() && title !== task.title && onChange({ title: title.trim() })}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          className="-mx-1 h-auto py-0.5 text-[18px] leading-[26px] font-semibold tracking-[-0.01em]"
        />
      ) : (
        <h2 className="m-0 text-[18px] leading-[26px] font-semibold tracking-[-0.01em] text-ink">
          {task.title}
        </h2>
      )}
      <div className="grid grid-cols-[96px_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5 text-[13px]">
        <span className="text-ink-3">Owner</span>
        {edit ? (
          <Dropdown
            size="sm"
            label="Owner"
            className="-ml-2 justify-self-start"
            value={
              task.assignee ? (
                <span className="flex items-center gap-2 text-ink">
                  <Avatar id={task.assignee.id} name={task.assignee.name} size={20} />
                  {task.assignee.name}
                </span>
              ) : (
                <span className="text-ink-3">Nobody yet</span>
              )
            }
            actions={[
              {
                label: "Nobody",
                checked: !task.assignee,
                onSelect: () => onChange({ assigneeId: null }),
              },
              ...people.map((p) => ({
                label: p.name,
                checked: task.assignee?.id === p.id,
                onSelect: () => onChange({ assigneeId: p.id }),
              })),
            ]}
          />
        ) : (
          <span className="flex items-center gap-2 text-ink">
            {task.assignee ? (
              <>
                <Avatar id={task.assignee.id} name={task.assignee.name} size={20} />
                {task.assignee.name}
              </>
            ) : (
              <span className="text-ink-3">Nobody yet</span>
            )}
          </span>
        )}
        <span className="text-ink-3">Priority</span>
        {edit ? (
          <Dropdown
            size="sm"
            label="Priority"
            className="-ml-2 justify-self-start"
            value={
              <span className="flex items-center gap-1.5 text-ink">
                <Icon name={priorityIcon[task.priority]} size={13} className="text-ink-3" />
                {priorityName[task.priority]}
              </span>
            }
            actions={(["high", "normal", "low"] as const).map((p) => ({
              label: priorityName[p],
              checked: task.priority === p,
              onSelect: () => onChange({ priority: p }),
            }))}
          />
        ) : (
          <span className="flex items-center gap-1.5 text-ink">
            <Icon name={priorityIcon[task.priority]} size={13} className="text-ink-3" />
            {priorityName[task.priority]}
          </span>
        )}
        <span className="text-ink-3">Due</span>
        {edit ? (
          <span className="flex items-center gap-2">
            <Input
              type="date"
              size="sm"
              aria-label="Due"
              className="w-[150px]"
              value={task.dueOn ?? ""}
              onChange={(e) => onChange({ dueOn: e.target.value || null })}
            />
            {due && <span className={late ? "text-signal" : "text-ink-3"}>{due}</span>}
          </span>
        ) : (
          <span className={late ? "text-signal" : "text-ink"}>
            {task.dueOn
              ? `${fullDayFormat.format(dayOf(task.dueOn))}${due ? ` · ${due}` : ""}`
              : "No date"}
          </span>
        )}
        {(task.track || task.file) && (
          <>
            <span className="text-ink-3">On</span>
            <span className="min-w-0">
              {task.track ? (
                <Link
                  to="/tracks/$trackId"
                  params={{ trackId: task.track.id }}
                  className="flex items-center gap-1.5 text-ink hover:text-signal"
                >
                  <Icon name="track" size={13} className="text-ink-3" />
                  <span className="truncate">{task.track.name}</span>
                </Link>
              ) : task.file ? (
                <Link
                  to="/files/$fileId"
                  params={{ fileId: task.file.id }}
                  className="flex items-center gap-1.5 text-ink hover:text-signal"
                >
                  <Icon name="file" size={13} className="text-ink-3" />
                  <span className="truncate">{task.file.name}</span>
                </Link>
              ) : null}
            </span>
          </>
        )}
      </div>
      {task.comment && (
        <div className="flex flex-col gap-1.5">
          <span className="eyebrow">From the comment</span>
          <blockquote className="m-0 rounded-panel border border-line bg-raised/30 px-3.5 py-3 text-[14px] leading-[21px] whitespace-pre-line text-ink-2">
            <span className="mb-1 block text-[12px] text-ink-3">
              {task.comment.authorName ?? "Someone"} · {ago(task.comment.createdAt)}
            </span>
            {task.comment.body}
          </blockquote>
        </div>
      )}
      {(edit || task.notes) && (
        <div className="flex flex-col gap-1.5">
          <span className="eyebrow">Notes</span>
          {edit ? (
            <Textarea
              aria-label="Notes"
              rows={3}
              maxLength={4000}
              value={notes}
              placeholder="Anything the owner should know."
              onChange={(e) => setNotes(e.target.value)}
              onBlur={() =>
                notes !== (task.notes ?? "") && onChange({ notes: notes.trim() || null })
              }
            />
          ) : (
            <p className="m-0 text-[14px] leading-[21px] whitespace-pre-line text-ink-2">
              {task.notes}
            </p>
          )}
        </div>
      )}
      {task.status === "needs_approval" && task.rights.statusTo.includes("done") && (
        <div className="flex items-center gap-2 rounded-panel border border-line bg-raised/30 px-3.5 py-3">
          <span className="text-[13px] text-ink-2">Marked done; it needs your approval.</span>
          <Button
            variant="primary"
            size="sm"
            className="ml-auto"
            onClick={() => onChange({ status: "done" })}
          >
            Approve
          </Button>
          <Button variant="ghost" size="sm" onClick={() => onChange({ status: "in_progress" })}>
            Send back
          </Button>
        </div>
      )}
      <div className="flex flex-col gap-2">
        <span className="eyebrow">Activity</span>
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
          {task.events.map((e) => (
            <li key={e.id} className="flex items-start gap-2.5 text-[13px]">
              <Avatar
                id={e.actorName ?? "workflow"}
                name={e.actorName ?? "Workflow"}
                size={20}
                className="mt-px"
              />
              <span className="min-w-0 flex-1 text-ink-2">
                <span className="text-ink">{e.actorName ?? "The workflow"}</span> {e.text}
                <span className="tabular ml-2 text-[12px] text-ink-3">
                  {timeFormat.format(new Date(e.at))}
                </span>
                {e.note && (
                  <span className="mt-1 block whitespace-pre-line text-ink">{e.note}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** A task made by hand: what needs doing, for whom, how urgent, by when and about what. */
function NewTaskDialog({
  projectId,
  people,
  onClose,
  onMade,
}: {
  projectId: string;
  people: { id: string; name: string }[];
  onClose: () => void;
  onMade: (id: string) => void;
}) {
  const { create } = useTaskMutations(projectId);
  const { data: tracks = [] } = useQuery(projectTracksQuery(projectId));
  const [title, setTitle] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [dueOn, setDueOn] = useState("");
  const [trackId, setTrackId] = useState("");
  const [notes, setNotes] = useState("");
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!title.trim()) return;
    create.mutate(
      {
        title: title.trim(),
        assigneeId: assigneeId || null,
        priority,
        dueOn: dueOn || null,
        trackId: trackId || null,
        notes: notes.trim() || null,
      },
      { onSuccess: (task) => onMade(task.id) },
    );
  };
  return (
    <Dialog
      title="New task"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => submit()}
            disabled={!title.trim() || create.isPending}
          >
            Add task
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Title" error={create.error?.message}>
          <Input
            placeholder="What needs doing"
            value={title}
            maxLength={200}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
        </Field>
        <div className="grid gap-4 @md/app:grid-cols-3">
          <Field label="Owner">
            <Select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
              <option value="">Nobody yet</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Priority">
            <Select value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
            </Select>
          </Field>
          <Field label="Due">
            <Input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
          </Field>
        </div>
        {tracks.length > 0 && (
          <Field label="About">
            <Select value={trackId} onChange={(e) => setTrackId(e.target.value)}>
              <option value="">Nothing in particular</option>
              {tracks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Notes">
          <Textarea
            rows={2}
            value={notes}
            maxLength={4000}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

/**
 * A project's tasks (#140), as the prototype has them: filtered (open, mine, unassigned,
 * overdue, all), grouped by status with what waits on a decision first, each opened beside the
 * list; made by hand, from a comment, or by the workflow; and the list as a spreadsheet.
 */
export function ProjectTasks({
  projectId,
  taskId,
  creating,
  canMake,
}: {
  projectId: string;
  taskId?: string;
  creating: boolean;
  canMake: boolean;
}) {
  const navigate = useNavigate();
  const { data, error } = useQuery(projectTasksQuery(projectId));
  const { data: me } = useQuery(meQuery);
  const [filter, setFilter] = useState<TaskFilter>("open");
  const open = (task?: string, make = false) =>
    void navigate({
      to: "/projects/$projectId/tasks",
      params: { projectId },
      search: { ...(task ? { task } : {}), ...(make ? { new: true } : {}) },
    });
  if (error) return <p className="m-0 text-signal">{error.message}</p>;
  if (!data) return <p className="m-0 text-ink-3">Loading</p>;
  const list = filterTasks(data.tasks, filter, me?.user.id ?? "", today());
  const groups = taskGroupOrder
    .map((s) => [s, list.filter((t) => t.status === s)] as const)
    .filter(([, rows]) => rows.length > 0);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-1">
        <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-1 border-0 p-0">
          <legend className="sr-only">Show</legend>
          {filters.map(([id, label]) => (
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
        </fieldset>
        <span className="ml-auto flex gap-1">
          {data.tasks.length > 0 && (
            <a
              href={`/api/projects/${projectId}/tasks.csv`}
              download
              className="flex h-9 items-center gap-1.5 rounded-control px-3 text-[13px] text-ink-2 transition-colors hover:bg-raised hover:text-ink"
            >
              <Icon name="download" size={14} />
              Export
            </a>
          )}
          {canMake && (
            <Button variant="primary" onClick={() => open(taskId, true)}>
              <Icon name="plus" size={14} />
              New task
            </Button>
          )}
        </span>
      </div>
      {list.length === 0 ? (
        <Empty
          title={data.tasks.length === 0 ? "No tasks yet" : "Nothing here"}
          text={
            data.tasks.length === 0
              ? "Make one by hand, or from a comment's menu; a workflow's task stages make their own. Each has an owner, a priority and a date."
              : "No task fits this filter. Try another, or All."
          }
          action={
            data.tasks.length === 0 && canMake ? (
              <Button variant="secondary" onClick={() => open(undefined, true)}>
                <Icon name="plus" size={14} />
                New task
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Card>
          {groups.map(([status, rows]) => (
            <section
              key={status}
              aria-label={taskStatusNames[status]}
              className="border-b border-line last:border-b-0"
            >
              <div className="flex h-9 items-center gap-2 bg-raised/20 px-4">
                <ReviewerDot state={statusDot[status]} />
                <h3 className="m-0 text-[13px] font-medium text-ink">{taskStatusNames[status]}</h3>
                <span className="tabular text-[12px] text-ink-3">{rows.length}</span>
              </div>
              <ul className="m-0 list-none p-0">
                {rows.map((t) => {
                  const late = isOverdue(t, today());
                  return (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => open(t.id)}
                        aria-current={taskId === t.id ? "true" : undefined}
                        className={cn(
                          "grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-raised/50 @3xl/app:grid-cols-[64px_20px_minmax(0,1fr)_170px_130px_90px]",
                          taskId === t.id && "bg-raised/60",
                        )}
                      >
                        <span className="tabular hidden text-[12px] text-ink-3 @3xl/app:block">
                          {t.key}
                        </span>
                        <Icon
                          name={priorityIcon[t.priority]}
                          size={13}
                          className={t.priority === "high" ? "text-signal" : "text-ink-3"}
                          aria-label={`${priorityName[t.priority]} priority`}
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
                          {(t.track || t.file) && (
                            <span className="block truncate text-[12px] text-ink-3">
                              {t.track?.name ?? t.file?.name}
                            </span>
                          )}
                        </span>
                        <span className="hidden min-w-0 items-center gap-2 text-[13px] text-ink-2 @3xl/app:flex">
                          {t.assignee ? (
                            <>
                              <Avatar id={t.assignee.id} name={t.assignee.name} size={20} />
                              <span className="truncate">{t.assignee.name}</span>
                            </>
                          ) : (
                            <span className="text-ink-3">Nobody yet</span>
                          )}
                        </span>
                        <span className="hidden text-[13px] text-ink-3 @3xl/app:block">
                          {origin(t)}
                        </span>
                        <span
                          className={cn(
                            "tabular text-right text-[13px]",
                            late ? "text-signal" : "text-ink-3",
                          )}
                        >
                          {t.dueOn ? dayFormat.format(dayOf(t.dueOn)) : ""}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </Card>
      )}
      {taskId && (
        <TaskPanel
          key={taskId}
          projectId={projectId}
          taskId={taskId}
          people={data.people}
          onClose={() => open(undefined)}
        />
      )}
      {creating && canMake && (
        <NewTaskDialog
          projectId={projectId}
          people={data.people}
          onClose={() => open(taskId)}
          onMade={(id) => open(id)}
        />
      )}
    </div>
  );
}
