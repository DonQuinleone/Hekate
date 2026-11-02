import type { ColumnCategory, ProjectStatus, WorkflowStatus } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ActionMenu } from "~/components/ui/menu";
import { ReviewerDot, type ReviewerDotState } from "~/components/ui/status";
import { projectWorkflowStatusesQuery, useSaveWorkflowStatuses } from "~/lib/queries";

const categoryDot: Record<ColumnCategory, ReviewerDotState> = {
  todo: "invited",
  in_progress: "in_review",
  done: "approved",
};

const categories: { id: ColumnCategory; label: string }[] = [
  { id: "todo", label: "To do" },
  { id: "in_progress", label: "In progress" },
  { id: "done", label: "Done" },
];

/** What a status's line says (#678): nothing for the usual one step, more where it adds something. */
export function setByWords(steps: number): string | null {
  if (steps === 0) return "Unused: no step sets it";
  return steps === 1 ? null : `Set by ${steps} steps`;
}

/**
 * A project's statuses (#26), as the prototype's panel has them: what the board's columns are,
 * grouped by how each reads (to do, in progress, done) and moved between them from its menu,
 * with what a step may set. Those only a step sets so far are listed too, and kept in the set
 * with the first change; one a step sets stays until the step no longer does. Removing one acts
 * at once and offers Undo (#544).
 */
export function StatusesPanel({ projectId, editing }: { projectId: string; editing: boolean }) {
  const { data: statuses, error } = useQuery(projectWorkflowStatusesQuery(projectId));
  const save = useSaveWorkflowStatuses(projectId);
  const [name, setName] = useState("");
  const [removed, setRemoved] = useState<{ name: string; before: WorkflowStatus[] } | null>(null);
  const list = statuses ?? [];
  const keep = (next: WorkflowStatus[]) =>
    save.mutate(next.map(({ name, category }) => ({ name, category })));
  const taken = (n: string) => list.some((s) => s.name.toLowerCase() === n.toLowerCase());
  const add = () => {
    const next = name.trim();
    if (!next || taken(next)) return;
    setRemoved(null);
    keep([...list, { name: next, category: "in_progress" }]);
    setName("");
  };
  const move = (status: ProjectStatus, category: ColumnCategory) => {
    setRemoved(null);
    keep(list.map((x) => (x.name === status.name ? { ...x, category } : x)));
  };
  const remove = (status: ProjectStatus) => {
    setRemoved({ name: status.name, before: list });
    keep(list.filter((x) => x.name !== status.name));
  };
  const failure = error ?? save.error;
  return (
    <div className="scroll-quiet flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
      {categories.map((category) => {
        const here = list.filter((s) => s.category === category.id);
        if (here.length === 0) return null;
        return (
          <section key={category.id} aria-label={category.label} className="flex flex-col">
            <h3 className="label m-0 px-2 pb-1">{category.label}</h3>
            {here.map((s) => {
              const line = setByWords(s.steps);
              return (
                <div
                  key={s.name}
                  className="flex min-h-9 items-center gap-2 rounded-control px-2 py-1 hover:bg-raised/60"
                >
                  <ReviewerDot state={categoryDot[s.category]} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[13px] text-ink">{s.name}</span>
                    {line && <span className="text-[12px] text-ink-3">{line}</span>}
                  </span>
                  {editing && (
                    <ActionMenu
                      always
                      label={s.name}
                      actions={[
                        ...categories.map((c) => ({
                          label: `Move to ${c.label}`,
                          checked: c.id === s.category,
                          disabled: c.id === s.category || save.isPending,
                          onSelect: () => move(s, c.id),
                        })),
                        "divider" as const,
                        // One a step sets stays until the step no longer does.
                        s.steps > 0
                          ? {
                              label: "Remove",
                              hint: "A step sets it: change the step first",
                              disabled: true,
                              onSelect: () => {},
                            }
                          : {
                              label: "Remove",
                              danger: true,
                              disabled: save.isPending,
                              onSelect: () => remove(s),
                            },
                      ]}
                    />
                  )}
                </div>
              );
            })}
          </section>
        );
      })}
      {statuses && list.length === 0 && (
        <p className="m-0 px-2 py-1.5 text-[13px] text-ink-3">
          No statuses yet. Add the ones an item passes through, or set one on a step.
        </p>
      )}
      {removed && (
        <div
          role="status"
          className="flex items-center gap-2 rounded-control border border-line bg-raised/40 py-1 pr-1 pl-3 text-[13px] text-ink-2"
        >
          <span className="min-w-0 flex-1 truncate">Removed “{removed.name}”</span>
          <Button
            variant="ghost"
            size="sm"
            disabled={save.isPending}
            onClick={() => {
              keep(removed.before);
              setRemoved(null);
            }}
          >
            Undo
          </Button>
        </div>
      )}
      {editing && (
        <form
          className="mt-1 flex gap-2"
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
