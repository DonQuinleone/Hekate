import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Icon } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { categories, type Project, trackById, workflows } from "~/data";
import { cn } from "~/lib/cn";

/** One group of the list: a workflow's stages, or the stages the categories name. */
interface Group {
  label: string;
  stages: { name: string; current: boolean; note?: string }[];
}

/**
 * The stages a thread may be deferred to (#499): the project's workflow's, with the one the
 * track is at marked, then the stages the categories name that the workflow lacks (so "Noise
 * reduction" reads as the Noise category's). Nothing is typed; the builder is a link away.
 */
export function deferGroups(project: Project, trackId: string | null): Group[] {
  const workflow = workflows.find((w) => w.id === project.workflowId);
  const track = trackId ? trackById(trackId) : undefined;
  const status = track?.versions.at(-1)?.status;
  const groups: Group[] = [];
  if (workflow && workflow.stages.length > 0)
    groups.push({
      label: workflow.name,
      stages: workflow.stages.map((s) => ({ name: s.name, current: s.status === status })),
    });
  const known = new Set(groups.flatMap((g) => g.stages.map((s) => s.name.toLowerCase())));
  const named = categories.flatMap((c) =>
    c.stage && !known.has(c.stage.toLowerCase())
      ? [{ name: c.stage, current: false, note: `${c.name} category` }]
      : [],
  );
  if (named.length > 0) groups.push({ label: "Named by a category", stages: named });
  return groups;
}

export function DeferDialog({
  project,
  trackId,
  canBuild,
  onDefer,
  onClose,
}: {
  project: Project;
  trackId: string | null;
  /** Whether the viewer may open the builder, which is then a link away. */
  canBuild: boolean;
  onDefer: (stage: string) => void;
  onClose: () => void;
}) {
  const groups = deferGroups(project, trackId);
  const all = groups.flatMap((g) => g.stages);
  const [picked, setPicked] = useState<string | null>(
    all.find((s) => s.current)?.name ?? all[0]?.name ?? null,
  );
  return (
    <Dialog
      title="Defer to a stage"
      description="The comment stays open but leaves this round's list, and comes back when that stage starts."
      onClose={onClose}
      width="sm"
      footer={
        <>
          {canBuild && (
            <Link
              to="/projects/$projectId/$view"
              params={{ projectId: project.id, view: "workflow" }}
              className="mr-auto inline-flex items-center gap-1.5 text-[13px] text-ink-3 underline-offset-2 hover:text-ink hover:underline"
            >
              <Icon name="arrowRight" size={13} />
              Open the workflow
            </Link>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!picked} onClick={() => picked && onDefer(picked)}>
            Defer
          </Button>
        </>
      }
    >
      {groups.length === 0 ? (
        <p className="text-[13px] text-ink-2">
          No workflow is switched on for this project, and no category names a stage. Build one, and
          its stages are offered here.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((group) => (
            <fieldset key={group.label} className="flex min-w-0 flex-col gap-2 border-0 p-0">
              <legend className="mb-2 p-0 text-[11px] font-medium tracking-wide text-ink-3 uppercase">
                {group.label}
              </legend>
              {group.stages.map((s) => (
                <label
                  key={s.name}
                  className="flex cursor-pointer items-start gap-2.5 text-[14px] text-ink"
                >
                  <input
                    type="radio"
                    name="defer-stage"
                    className="mt-1 size-4 accent-signal"
                    checked={picked === s.name}
                    onChange={() => setPicked(s.name)}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className={cn("flex items-center gap-2", !s.current && "text-ink-2")}>
                      <span className="min-w-0 truncate">{s.name}</span>
                      {s.current && (
                        <span className="rounded-chip border border-signal/50 px-1.5 text-[11px] leading-5 text-signal">
                          Current
                        </span>
                      )}
                    </span>
                    {s.note && <span className="text-[12px] text-ink-3">{s.note}</span>}
                  </span>
                </label>
              ))}
            </fieldset>
          ))}
        </div>
      )}
    </Dialog>
  );
}
