import { type DeferChoiceGroup, deferChoices } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { Icon } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { Chip } from "~/components/ui/chip";
import { Choice } from "~/components/ui/choice";
import { Dialog } from "~/components/ui/dialog";
import { cn } from "~/lib/cn";
import { type CommentCategory, fileStagesQuery, useProjectCan } from "~/lib/queries";

/**
 * Defer a thread to a stage (#499): one of the stages of the workflows that apply to the
 * file's track (or its project), listed by workflow with the one the track waits at marked,
 * then the stages the project's categories name. Nothing is typed; the builder is a link away
 * for whoever may open it.
 */
export function DeferDialog({
  fileId,
  projectId,
  categories,
  current,
  onDefer,
  onClose,
}: {
  fileId: string;
  projectId: string;
  categories: readonly CommentCategory[];
  /** The stage the thread waits for now, where it is already deferred. */
  current?: string | null;
  onDefer: (stage: string) => void;
  onClose: () => void;
}) {
  const { data: stages, isPending, error } = useQuery(fileStagesQuery(fileId));
  const can = useProjectCan(projectId);
  const groups = deferChoices(stages, categories, current ?? null);
  const [chosen, setChosen] = useState<string | null>(current ?? null);
  // Until a stage is picked, the one the track waits at is the offer.
  const picked =
    chosen ??
    groups.flatMap((g) => g.stages).find((s) => s.current)?.name ??
    groups[0]?.stages[0]?.name ??
    null;
  const name = useId();
  return (
    <Dialog
      title="Defer to a stage"
      description="The comment stays open but leaves this round's list, and comes back when that stage starts."
      onClose={onClose}
      width="sm"
      footer={
        <>
          {can("view_workflows") && (
            <Link
              to="/projects/$projectId/workflow"
              params={{ projectId }}
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
      {isPending ? (
        <p className="m-0 text-[13px] text-ink-3">Loading</p>
      ) : error ? (
        <p className="m-0 text-[13px] text-signal">{error.message}</p>
      ) : groups.length === 0 ? (
        <p className="m-0 text-[13px] text-ink-2">
          No workflow is switched on for this {stages?.trackId ? "track" : "project"}, and no
          category names a stage. Build one, and its stages are offered here.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((group) => (
            <StageGroup
              key={group.label}
              group={group}
              name={name}
              picked={picked}
              onPick={setChosen}
            />
          ))}
        </div>
      )}
    </Dialog>
  );
}

function StageGroup({
  group,
  name,
  picked,
  onPick,
}: {
  group: DeferChoiceGroup;
  name: string;
  picked: string | null;
  onPick: (stage: string) => void;
}) {
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
      <legend className="label mb-2 p-0">{group.label}</legend>
      {group.stages.map((s) => (
        <Choice
          key={s.name}
          type="radio"
          name={name}
          checked={picked === s.name}
          onChange={() => onPick(s.name)}
          hint={s.note}
        >
          <span className={cn("flex items-center gap-2", s.current && "text-ink")}>
            <span className="min-w-0 truncate">{s.name}</span>
            {s.current && <Chip className="border-signal/50 text-signal">Current</Chip>}
          </span>
        </Choice>
      ))}
    </fieldset>
  );
}
