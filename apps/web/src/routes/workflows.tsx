import { nodeTypes, outcomesOf, type WorkflowNode, type WorkflowSummary } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Empty } from "~/components/empty";
import { Icon } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { Input, Select } from "~/components/ui/input";
import { Switch } from "~/components/ui/toggle";
import { cn } from "~/lib/cn";
import {
  projectGroupsQuery,
  projectRolesQuery,
  projectTracksQuery,
  projectWorkflowsQuery,
  useProjectCan,
  useWorkflowMutations,
} from "~/lib/queries";
import {
  basicSteps,
  familyOf,
  familyTiles,
  type NodeField,
  newWorkflowDefinition,
  nodeLooks,
  withConfig,
  withConnector,
} from "~/lib/workflow-nodes";
import { ProjectFrame } from "~/routes/project";

const body =
  "fade-in mx-auto flex w-full max-w-[860px] flex-col gap-8 px-5 py-6 @3xl/app:px-10 @3xl/app:py-8";

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * A project's workflows (#26), as the prototype's builder shows them in its basic view: each as
 * a list of steps, what starts it and where it finishes, with who, when and what happens changed
 * in place. Seen with the workflow level of a role's access; changed by those who edit workflows.
 */
export function WorkflowsPage({ projectId }: { projectId: string }) {
  const can = useProjectCan(projectId);
  const mayEdit = can("edit_workflows");
  // As in the prototype: the builder is for those who edit workflows, and for those who run
  // the project's roles, who see what a role takes part in without changing it.
  const mayView = mayEdit || (can("manage_roles") && can("view_workflows"));
  const { data: workflows, error } = useQuery({
    ...projectWorkflowsQuery(projectId),
    enabled: mayView,
  });
  const { create } = useWorkflowMutations(projectId);
  const newWorkflow = () =>
    create.mutate({ name: "New workflow", definition: newWorkflowDefinition() });
  return (
    <ProjectFrame
      projectId={projectId}
      title="Workflows"
      parent={(project) => (
        <Link
          to="/projects/$projectId/settings"
          params={{ projectId: project.id }}
          search={{ section: "workflow" }}
        >
          Settings
        </Link>
      )}
    >
      {(project) => {
        const editing = mayEdit && !project.archivedAt;
        return (
          <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto">
            <div className={body}>
              {!mayView ? (
                <Empty
                  title="Not among what your role does"
                  text="Workflows are built by those whose role edits them."
                />
              ) : error ? (
                <p className="m-0 text-signal">{error.message}</p>
              ) : !workflows ? (
                <p className="m-0 text-ink-3">Loading</p>
              ) : workflows.length === 0 ? (
                <Empty
                  title="No workflows yet"
                  text="A workflow carries a track from one stage to the next as versions arrive: who is asked, what is checked, the status it sets, and where it finishes."
                  action={
                    editing ? (
                      <Button variant="primary" onClick={newWorkflow} disabled={create.isPending}>
                        New workflow
                      </Button>
                    ) : undefined
                  }
                />
              ) : (
                <>
                  <p className="m-0 max-w-[620px] text-[14px] text-ink-2">
                    Each workflow as a list of steps. Change who, when and what happens on changes
                    here; the steps themselves and how they connect are drawn in the advanced view.
                  </p>
                  {workflows.map((w) => (
                    <WorkflowSteps
                      key={w.id}
                      projectId={projectId}
                      workflow={w}
                      editing={editing}
                    />
                  ))}
                  {editing && (
                    <div>
                      <Button variant="secondary" onClick={newWorkflow} disabled={create.isPending}>
                        <Icon name="plus" size={14} />
                        New workflow
                      </Button>
                    </div>
                  )}
                  {create.error && <p className="m-0 text-signal">{create.error.message}</p>}
                  <p className="m-0 text-[12px] text-ink-3">
                    A track can follow a workflow of its own instead of the project's; that is set
                    from the track.
                  </p>
                </>
              )}
            </div>
          </div>
        );
      }}
    </ProjectFrame>
  );
}

/** One workflow in the basic view: switched on or not, and its steps from start to finish. */
function WorkflowSteps({
  projectId,
  workflow,
  editing,
}: {
  projectId: string;
  workflow: WorkflowSummary;
  editing: boolean;
}) {
  const { change } = useWorkflowMutations(projectId);
  const { data: tracks } = useQuery(projectTracksQuery(projectId));
  const { triggers, steps, finish } = basicSteps(workflow.definition);
  const errors = workflow.problems.filter((p) => p.level === "error");
  const track = workflow.trackId ? tracks?.find((t) => t.id === workflow.trackId) : undefined;
  const setConfig = (nodeId: string, config: Record<string, string>) =>
    change.mutate({
      id: workflow.id,
      change: (w) => ({ definition: withConfig(w.definition, nodeId, config) }),
    });
  return (
    <section className="flex flex-col gap-3" aria-labelledby={`workflow-${workflow.id}`}>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h2
            id={`workflow-${workflow.id}`}
            className="m-0 truncate text-[18px] font-medium tracking-tight text-ink"
          >
            {workflow.name}
          </h2>
          <p className="m-0 text-[13px] text-ink-3">
            {[
              workflow.active ? "Active" : "Draft",
              track ? `for ${track.name}` : null,
              count(steps.length, "step"),
              workflow.problems.length > 0 ? `${workflow.problems.length} to look at` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <Switch
          label={`${workflow.name} active`}
          checked={workflow.active}
          // One that breaks a rule cannot run until it is mended.
          disabled={!editing || (!workflow.active && errors.length > 0) || change.isPending}
          onChange={(active) => change.mutate({ id: workflow.id, change: () => ({ active }) })}
        />
      </div>
      <ol
        aria-label={`${workflow.name}: its steps`}
        className="m-0 flex list-none flex-col divide-y divide-line rounded-panel-lg border border-line bg-raised/25 p-0 shadow-1"
      >
        <li className="flex items-center gap-3 px-4 py-3">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-control bg-signal/15 text-signal">
            <Icon name="bolt" size={14} />
          </span>
          <span className="min-w-0 text-[14px] text-ink">
            When {triggers.map((t) => t.name.toLowerCase()).join(" or ") || "nothing happens"}
          </span>
        </li>
        {steps.map(({ node, loops }, i) => (
          <li key={node.id} className="flex flex-col gap-2 px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="tabular w-7 shrink-0 text-center text-[12px] text-ink-3">
                {i + 1}
              </span>
              <span
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-control",
                  familyTiles[familyOf(node.type)],
                )}
              >
                <Icon name={nodeLooks[node.type].icon} size={14} />
              </span>
              <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{node.name}</span>
              <span className="hidden shrink-0 text-[12px] text-ink-3 @3xl/app:inline">
                {nodeTypes[node.type].label}
              </span>
            </div>
            {(nodeLooks[node.type].fields.some((f) => f.id !== "message") || loops.length > 0) && (
              <div className="flex flex-wrap gap-2 @3xl/app:ml-[68px]">
                {nodeLooks[node.type].fields
                  .filter((f) => f.id !== "message")
                  .map((f) => (
                    <StepField
                      key={f.id}
                      projectId={projectId}
                      node={node}
                      field={f}
                      editing={editing}
                      onChange={(value) => setConfig(node.id, { [f.id]: value })}
                    />
                  ))}
                {loops.map((c) => (
                  <span
                    key={c.id}
                    className="flex flex-wrap items-center gap-1.5 text-[12px] whitespace-nowrap text-ink-3"
                  >
                    <span>
                      If {outcomesOf(node.type).find((o) => o.id === c.outcome)?.label ?? c.outcome}
                      , back to
                    </span>
                    <Select
                      className="w-auto"
                      size="sm"
                      aria-label={`${node.name}: if ${c.outcome}, back to`}
                      value={c.to}
                      disabled={!editing}
                      onChange={(e) =>
                        change.mutate({
                          id: workflow.id,
                          change: (w) => ({
                            definition: withConnector(w.definition, c.id, { to: e.target.value }),
                          }),
                        })
                      }
                    >
                      {steps.map((s) => (
                        <option key={s.node.id} value={s.node.id}>
                          {s.node.name}
                        </option>
                      ))}
                    </Select>
                    at most
                    <Committed
                      label={`${node.name}: times back at most`}
                      value={c.until ? String(c.until.times) : ""}
                      placeholder="3"
                      className="w-14"
                      disabled={!editing}
                      onCommit={(value) => {
                        const times = Number.parseInt(value, 10);
                        change.mutate({
                          id: workflow.id,
                          change: (w) => ({
                            definition: withConnector(w.definition, c.id, {
                              until:
                                Number.isFinite(times) && times > 0
                                  ? { times: Math.min(times, 100) }
                                  : undefined,
                            }),
                          }),
                        });
                      }}
                    />
                    times
                  </span>
                ))}
              </div>
            )}
          </li>
        ))}
        <li className="flex items-center gap-3 px-4 py-3">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-control bg-raised text-ink-2">
            <Icon name="stop" size={14} />
          </span>
          <span className="min-w-0 truncate text-[14px] text-ink">
            {finish ? `Finish: ${finish.name}` : "No finish yet"}
          </span>
          {finish?.config.status && (
            <span className="shrink-0 text-[12px] text-ink-3">sets {finish.config.status}</span>
          )}
        </li>
      </ol>
      {workflow.problems.length > 0 && (
        <ul
          aria-label={`${workflow.name}: to look at`}
          className="m-0 flex list-none flex-col gap-1 p-0"
        >
          {workflow.problems.map((p) => (
            <li
              key={`${p.nodeId ?? p.connectorId ?? ""}-${p.text}`}
              className={cn(
                "flex items-start gap-2 text-[13px]",
                p.level === "error" ? "text-signal" : "text-ink-3",
              )}
            >
              <Icon name="warning" size={14} className="mt-0.5 shrink-0" />
              {p.text}
            </li>
          ))}
        </ul>
      )}
      {change.error && <p className="m-0 text-[13px] text-signal">{change.error.message}</p>}
    </section>
  );
}

/**
 * One setting of a step: chosen from its options or the project's people, or written, as the
 * prototype has them. Written words are kept when the field is left or Return pressed.
 */
function StepField({
  projectId,
  node,
  field,
  editing,
  onChange,
}: {
  projectId: string;
  node: WorkflowNode;
  field: NodeField;
  editing: boolean;
  onChange: (value: string) => void;
}) {
  const { data: roles } = useQuery({ ...projectRolesQuery(projectId), enabled: !!field.people });
  // Groups are asked as themselves by a review; a task or a notification reaches roles only.
  const withGroups = !!field.people && (node.type === "approval" || node.type === "feedback");
  const { data: groups } = useQuery({ ...projectGroupsQuery(projectId), enabled: withGroups });
  const value = node.config[field.id] ?? "";
  const label = `${node.name}: ${field.label.toLowerCase()}`;
  const options = field.people
    ? [
        ...(field.id === "to" ? ["Everyone in the project"] : []),
        ...(roles ?? []).map((r) => r.name),
        ...(withGroups ? (groups ?? []) : []).map((g) => g.name),
      ]
    : field.options;
  return (
    <span className="flex items-center gap-1.5 text-[12px] whitespace-nowrap text-ink-3">
      {field.label}
      {options ? (
        <Select
          className="w-auto"
          size="sm"
          aria-label={label}
          value={field.people ? value : value || options[0]}
          disabled={!editing}
          onChange={(e) => onChange(e.target.value)}
        >
          {field.people && <option value="">Nobody yet</option>}
          {/* Someone named another way (a guest, several at once) stays as named. */}
          {value && !options.includes(value) && <option value={value}>{value}</option>}
          {options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      ) : (
        <Committed
          label={label}
          value={value}
          placeholder={field.placeholder}
          className="w-28"
          disabled={!editing}
          onCommit={onChange}
        />
      )}
    </span>
  );
}

/** Words kept when the field is left or Return is pressed, not at every key. */
function Committed({
  label,
  value,
  placeholder,
  className,
  disabled,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  className?: string;
  disabled: boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (draft.trim() !== value) onCommit(draft.trim());
  };
  return (
    <Input
      size="sm"
      aria-label={label}
      value={draft}
      placeholder={placeholder}
      className={className}
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") setDraft(value);
      }}
    />
  );
}
