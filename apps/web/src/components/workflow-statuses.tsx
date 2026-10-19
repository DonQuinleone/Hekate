import type { ColumnCategory, ProjectStatus, WorkflowStatus } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Icon } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { Input, Select } from "~/components/ui/input";
import { ReviewerDot, type ReviewerDotState } from "~/components/ui/status";
import { projectWorkflowStatusesQuery, useSaveWorkflowStatuses } from "~/lib/queries";

const categoryDot: Record<ColumnCategory, ReviewerDotState> = {
  todo: "invited",
  in_progress: "in_review",
  done: "approved",
};

const stepsWords = (n: number) => (n === 1 ? "Set by a step" : `Set by ${n} steps`);

/**
 * A project's statuses (#26), as the prototype's panel has them: what the board's columns are,
 * each read as to do, under way or done, and what a step may set. Those only a step sets so far
 * are listed too, and kept in the set with the first change; one a step sets stays until the
 * step no longer does.
 */
export function StatusesPanel({ projectId, editing }: { projectId: string; editing: boolean }) {
  const { data: statuses, error } = useQuery(projectWorkflowStatusesQuery(projectId));
  const save = useSaveWorkflowStatuses(projectId);
  const [name, setName] = useState("");
  const list = statuses ?? [];
  const keep = (next: WorkflowStatus[]) =>
    save.mutate(next.map(({ name, category }) => ({ name, category })));
  const taken = (n: string) => list.some((s) => s.name.toLowerCase() === n.toLowerCase());
  const add = () => {
    const next = name.trim();
    if (!next || taken(next)) return;
    keep([...list, { name: next, category: "in_progress" }]);
    setName("");
  };
  const failure = error ?? save.error;
  return (
    <div className="scroll-quiet flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-3">
      {list.map((s: ProjectStatus, i) => (
        <div
          key={s.name}
          className="flex items-center gap-2 rounded-control px-2 py-1.5 hover:bg-raised/60"
        >
          <ReviewerDot state={categoryDot[s.category]} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-[13px] text-ink">{s.name}</span>
            {s.steps > 0 && <span className="text-[11px] text-ink-3">{stepsWords(s.steps)}</span>}
          </span>
          <Select
            size="sm"
            className="w-auto"
            aria-label={`How ${s.name} reads`}
            value={s.category}
            disabled={!editing || save.isPending}
            onChange={(e) =>
              keep(
                list.map((x, j) =>
                  j === i ? { ...x, category: e.target.value as ColumnCategory } : x,
                ),
              )
            }
          >
            <option value="todo">To do</option>
            <option value="in_progress">In progress</option>
            <option value="done">Done</option>
          </Select>
          {/* One a step sets stays until the step no longer does. */}
          {editing && s.steps > 0 && <span aria-hidden="true" className="size-7 shrink-0" />}
          {editing && s.steps === 0 && (
            <Button
              variant="quiet"
              size="iconSm"
              aria-label={`Remove ${s.name}`}
              disabled={save.isPending}
              onClick={() => keep(list.filter((_, j) => j !== i))}
            >
              <Icon name="close" size={12} />
            </Button>
          )}
        </div>
      ))}
      {statuses && list.length === 0 && (
        <p className="m-0 px-2 py-1.5 text-[13px] text-ink-3">
          No statuses yet. Add the ones a track passes through, or set one on a step.
        </p>
      )}
      {editing && (
        <form
          className="mt-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New status"
            aria-label="New status"
            maxLength={60}
            className="flex-1"
          />
          <Button
            type="submit"
            variant="secondary"
            disabled={!name.trim() || taken(name.trim()) || save.isPending}
          >
            Add
          </Button>
        </form>
      )}
      {failure && <p className="m-0 px-2 text-[12px] text-signal">{failure.message}</p>}
    </div>
  );
}
