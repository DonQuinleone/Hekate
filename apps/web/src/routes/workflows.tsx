import {
  nodeTypes,
  outcomesOf,
  type WorkflowDefinition,
  type WorkflowSummary,
  workflowFromYaml,
  workflowProblems,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Empty } from "~/components/empty";
import { Icon } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { Select } from "~/components/ui/input";
import { Dropdown } from "~/components/ui/menu";
import { Segmented } from "~/components/ui/segmented";
import { Switch } from "~/components/ui/toggle";
import { WorkflowCanvas } from "~/components/workflow-canvas";
import { WorkflowCode } from "~/components/workflow-code";
import { Committed, StepField } from "~/components/workflow-fields";
import { cn } from "~/lib/cn";
import {
  ApiError,
  projectTracksQuery,
  projectWorkflowsQuery,
  useProjectCan,
  useWorkflowMutations,
} from "~/lib/queries";
import { workflowTemplates } from "~/lib/workflow-code";
import {
  basicSteps,
  familyOf,
  familyTiles,
  newWorkflowDefinition,
  nodeLooks,
  withConfig,
  withConnector,
} from "~/lib/workflow-nodes";
import { ProjectFrame } from "~/routes/project";

const body =
  "fade-in mx-auto flex w-full max-w-[860px] flex-col gap-8 px-5 py-6 @3xl/app:px-10 @3xl/app:py-8";

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export type WorkflowView = "basic" | "advanced" | "code";

/** A record without one of its entries. */
const forget = <T,>(record: Record<string, T>, id: string) => {
  const { [id]: _gone, ...rest } = record;
  return rest;
};

/**
 * Changes made on the canvas (#26), kept as they are made and saved a moment after the last:
 * a drag is one save, not one per movement. A change that would stop a workflow that is switched
 * on from running is held, not sent, until it is mended or the workflow switched off.
 */
function useDrafts(projectId: string, workflows: WorkflowSummary[] | undefined) {
  const { change } = useWorkflowMutations(projectId);
  const [drafts, setDrafts] = useState<Record<string, WorkflowDefinition>>({});
  const [held, setHeld] = useState<Record<string, string>>({});
  const [refused, setRefused] = useState<string | null>(null);
  const timers = useRef<Record<string, number>>({});
  // Read when a save runs, so the callbacks below, and the flush on leaving, stay the same.
  const latest = useRef({ drafts, workflows, change });
  latest.current = { drafts, workflows, change };
  const save = useCallback((id: string) => {
    const definition = latest.current.drafts[id];
    const workflow = latest.current.workflows?.find((w) => w.id === id);
    if (!definition || !workflow) return;
    const breaks = workflowProblems(definition).find((p) => p.level === "error");
    if (workflow.active && breaks) {
      setHeld((h) => ({ ...h, [id]: breaks.text }));
      return;
    }
    setHeld((h) => forget(h, id));
    latest.current.change
      .mutateAsync({ id, change: () => ({ definition }) })
      .then(() => setDrafts((d) => (d[id] === definition ? forget(d, id) : d)))
      .catch((failure: unknown) => {
        // Refused: what is kept on the server is shown again, and why. A change made since the
        // refused one began is kept, to be saved in its turn, unless someone else's change came
        // first: then it was made over a workflow that is no more, and goes too.
        const overtaken = failure instanceof ApiError && failure.code === "conflict";
        setDrafts((d) => (overtaken || d[id] === definition ? forget(d, id) : d));
        setRefused(failure instanceof Error ? failure.message : "That change was refused");
      });
  }, []);
  const edit = useCallback(
    (id: string, fn: (flow: WorkflowDefinition) => WorkflowDefinition) => {
      setRefused(null);
      setDrafts((d) => {
        const base = d[id] ?? latest.current.workflows?.find((w) => w.id === id)?.definition;
        return base ? { ...d, [id]: fn(base) } : d;
      });
      window.clearTimeout(timers.current[id]);
      timers.current[id] = window.setTimeout(() => save(id), 600);
    },
    [save],
  );
  // Leaving the canvas keeps what was changed on it.
  useEffect(
    () => () => {
      for (const [id, timer] of Object.entries(timers.current)) {
        window.clearTimeout(timer);
        save(id);
      }
    },
    [save],
  );
  const shown = useMemo(
    () =>
      workflows?.map((w) => {
        const definition = drafts[w.id];
        return definition ? { ...w, definition, problems: workflowProblems(definition) } : w;
      }),
    [workflows, drafts],
  );
  return { shown, edit, held, refused };
}

/**
 * A project's workflows (#26), as the prototype's builder shows them: drawn on a canvas (the
 * advanced view), or each as a list of steps with who, when and what happens changed in place
 * (the basic view), or each as its file (the code view, #145). Built by those who edit
 * workflows; seen by those who run the project's roles.
 */
export function WorkflowsPage({
  projectId,
  view = "advanced",
}: {
  projectId: string;
  view?: WorkflowView;
}) {
  const can = useProjectCan(projectId);
  const navigate = useNavigate();
  const mayEdit = can("edit_workflows");
  // As in the prototype: the builder is for those who edit workflows, and for those who run
  // the project's roles, who see what a role takes part in without changing it.
  const mayView = mayEdit || (can("manage_roles") && can("view_workflows"));
  const { data: workflows, error } = useQuery({
    ...projectWorkflowsQuery(projectId),
    enabled: mayView,
  });
  const { create } = useWorkflowMutations(projectId);
  const [focus, setFocus] = useState<string | null>(null);
  const drafts = useDrafts(projectId, workflows);
  const newWorkflow = () =>
    create.mutate(
      { name: "New workflow", definition: newWorkflowDefinition() },
      { onSuccess: (made) => setFocus(made.id) },
    );
  const fromTemplate = (text: string) => {
    const read = workflowFromYaml(text);
    if (read.ok)
      create.mutate(
        { name: read.name, definition: read.definition },
        { onSuccess: (made) => setFocus(made.id) },
      );
  };
  const setView = (next: WorkflowView, flowId?: string) => {
    if (flowId) setFocus(flowId);
    void navigate({
      to: "/projects/$projectId/workflow",
      params: { projectId },
      search: next === "advanced" ? {} : { view: next },
      replace: true,
    });
  };
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
      actions={
        mayView && workflows && workflows.length > 0 ? (
          <Segmented
            label="View"
            value={view}
            options={[
              { value: "basic", label: "Basic" },
              { value: "advanced", label: "Advanced" },
              { value: "code", label: "Code" },
            ]}
            onChange={(next) => setView(next)}
          />
        ) : undefined
      }
    >
      {(project) => {
        const editing = mayEdit && !project.archivedAt;
        const shown = drafts.shown;
        if (mayView && !error && workflows && workflows.length > 0 && view === "code")
          return (
            <WorkflowCode
              projectId={projectId}
              workflows={workflows}
              editing={editing}
              focus={focus}
            />
          );
        if (mayView && !error && shown && shown.length > 0 && view === "advanced")
          return (
            <div className="flex h-full min-h-0 flex-col">
              {(Object.keys(drafts.held).length > 0 || drafts.refused || create.error) && (
                <div
                  role="status"
                  className="flex flex-col gap-0.5 border-b border-line bg-raised/40 px-5 py-2 text-[13px] text-ink-2"
                >
                  {Object.entries(drafts.held).map(([id, why]) => (
                    <span key={id}>
                      Not saved: {shown.find((w) => w.id === id)?.name} is switched on, and this
                      change would stop it running. {why}
                    </span>
                  ))}
                  {drafts.refused && <span className="text-signal">{drafts.refused}</span>}
                  {create.error && <span className="text-signal">{create.error.message}</span>}
                </div>
              )}
              <WorkflowCanvas
                projectId={projectId}
                workflows={shown}
                editing={editing}
                focus={focus}
                onEdit={drafts.edit}
                onNew={newWorkflow}
              />
            </div>
          );
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
                      <div className="flex flex-wrap items-center justify-center gap-2">
                        <Button variant="primary" onClick={newWorkflow} disabled={create.isPending}>
                          New workflow
                        </Button>
                        <Dropdown
                          value="From a template"
                          actions={workflowTemplates.map((t) => ({
                            label: t.name,
                            onSelect: () => fromTemplate(t.text),
                          }))}
                        />
                      </div>
                    ) : undefined
                  }
                />
              ) : (
                <>
                  <p className="m-0 max-w-[620px] text-[14px] text-ink-2">
                    Each workflow as a list of steps. Change who, when and what happens on changes;
                    the advanced view holds the same workflow as a graph for anything beyond that.
                  </p>
                  {workflows.map((w) => (
                    <WorkflowSteps
                      key={w.id}
                      projectId={projectId}
                      workflow={w}
                      editing={editing}
                      onAdvanced={() => setView("advanced", w.id)}
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
  onAdvanced,
}: {
  projectId: string;
  workflow: WorkflowSummary;
  editing: boolean;
  onAdvanced: () => void;
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
        <Button variant="secondary" size="md" onClick={onAdvanced}>
          Open in the advanced view
        </Button>
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
