import type { WorkflowDefinition } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Select } from "~/components/ui/input";
import { projectsQuery, projectWorkflowsQuery } from "~/lib/queries";

const stepsWords = (n: number) => (n === 1 ? "1 step" : `${n} steps`);

/**
 * A workflow copied from another project of the workspace (#26), as the issue asks: chosen from
 * those the member may see there, and made here as this project's own, to change as it needs.
 * Who it names (roles, groups) is kept as named; a name this project lacks shows as such.
 */
export function CopyWorkflowDialog({
  projectId,
  pending,
  onCopy,
  onClose,
}: {
  projectId: string;
  pending: boolean;
  onCopy: (name: string, definition: WorkflowDefinition) => void;
  onClose: () => void;
}) {
  const { data: projects } = useQuery(projectsQuery);
  const others = (projects ?? []).filter((p) => p.id !== projectId);
  const [from, setFrom] = useState("");
  const source = from || others[0]?.id || "";
  const { data: workflows, error } = useQuery({
    ...projectWorkflowsQuery(source),
    enabled: source !== "",
    retry: false,
  });
  return (
    <Dialog
      title="Copy a workflow from another project"
      description="It is made here as this project's own, switched off, to change as this project needs."
      onClose={onClose}
      width="sm"
      footer={
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        {projects && others.length === 0 ? (
          <p className="m-0 text-[13px] text-ink-3">There is no other project to copy from.</p>
        ) : (
          <>
            <Select
              aria-label="Project to copy from"
              value={source}
              onChange={(e) => setFrom(e.target.value)}
            >
              {others.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
            {error ? (
              <p className="m-0 text-[13px] text-ink-3">
                Your role in that project does not show its workflows.
              </p>
            ) : workflows && workflows.length === 0 ? (
              <p className="m-0 text-[13px] text-ink-3">That project has no workflows yet.</p>
            ) : (
              <ul className="m-0 flex list-none flex-col p-0">
                {(workflows ?? []).map((w) => (
                  <li
                    key={w.id}
                    className="flex min-h-11 items-center gap-3 border-b border-line last:border-b-0"
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[14px] text-ink">{w.name}</span>
                      <span className="text-[12px] text-ink-3">
                        {stepsWords(w.definition.nodes.length)}
                        {w.trackId ? ", a track's own" : ""}
                      </span>
                    </span>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={pending}
                      aria-label={`Copy ${w.name}`}
                      onClick={() => onCopy(w.name, w.definition)}
                    >
                      Copy
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
