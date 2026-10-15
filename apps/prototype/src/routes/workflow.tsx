import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "~/components/icons";
import { Label } from "~/components/label";
import { usePageHeader } from "~/components/page-header";
import { Dot } from "~/components/status";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Input, Select, Textarea } from "~/components/ui/input";
import { Dropdown } from "~/components/ui/menu";
import { Switch } from "~/components/ui/toggle";
import {
  customRules,
  type Graph,
  type GraphEdge,
  type GraphNode,
  graphFor,
  type NodeKind,
  type Project,
  projectById,
  projectPacks,
  qaRules,
  rulePacks,
  tracks,
  workflows,
} from "~/data";
import { cn } from "~/lib/cn";
import { useViewer } from "~/viewer/context";
import { Refused } from "~/viewer/state-gate";

/* ---------- Geometry ---------- */

const COL = 236;
const ROW = 112;
const NODE_W = 188;
const NODE_H = 56;
const PAD_X = 48;
const PAD_Y = 40;

const posOf = (n: GraphNode) => ({ x: PAD_X + n.col * COL, y: PAD_Y + n.row * ROW });
const outputAt = (n: GraphNode, outputId: string) => {
  const p = posOf(n);
  const i = Math.max(
    0,
    n.outputs.findIndex((o) => o.id === outputId),
  );
  const k = n.outputs.length || 1;
  return { x: p.x + NODE_W, y: p.y + (NODE_H * (i + 1)) / (k + 1) };
};
const inputAt = (n: GraphNode) => {
  const p = posOf(n);
  return { x: p.x, y: p.y + NODE_H / 2 };
};

/** Forward edges curve; an edge that goes back loops under the rows it crosses. */
function edgePath(from: { x: number; y: number }, to: { x: number; y: number }, floor: number) {
  if (to.x > from.x + 30) {
    const c = Math.max(48, (to.x - from.x) / 2);
    return `M${from.x},${from.y} C${from.x + c},${from.y} ${to.x - c},${to.y} ${to.x},${to.y}`;
  }
  const r = 12;
  return [
    `M${from.x},${from.y}`,
    `H${from.x + 24 - r}`,
    `q${r},0 ${r},${r}`,
    `V${floor - r}`,
    `q0,${r} -${r},${r}`,
    `H${to.x - 28 + r}`,
    `q-${r},0 -${r},-${r}`,
    `V${to.y + r}`,
    `q0,-${r} ${r},-${r}`,
    `H${to.x}`,
  ].join(" ");
}

/* ---------- Kinds ---------- */

const kindMeta: Record<NodeKind, { icon: IconName; label: string; hint: string }> = {
  event: {
    icon: "bolt",
    label: "Event",
    hint: "Something that happens: a trigger at the start, or a wait in the flow",
  },
  approval: { icon: "review", label: "Approval", hint: "Each reviewer records a decision" },
  feedback: { icon: "comment", label: "Feedback", hint: "Comments, then submitted" },
  task: { icon: "task", label: "Task", hint: "Someone does the work" },
  condition: { icon: "split", label: "Condition", hint: "Branch on what happened" },
  notify: { icon: "bell", label: "Notify", hint: "Tell someone, then carry on" },
  status: { icon: "flag", label: "Set status", hint: "Mark the item and stop" },
  end: { icon: "stop", label: "End", hint: "Stop here" },
};

/** Everything a person can do, as something the workflow can start on or wait for. */
const events: { id: string; label: string; hint: string }[] = [
  { id: "upload", label: "A version is uploaded", hint: "Checked at the door by the upload rules" },
  { id: "folder", label: "A file lands in a folder", hint: "Any file, or a chosen folder" },
  { id: "manual", label: "Started by hand", hint: "From the track or the board" },
  { id: "review", label: "A review is requested", hint: "Of any kind, or one kind" },
  { id: "decision", label: "A decision is recorded", hint: "Approved or changes requested" },
  { id: "feedback", label: "Feedback is submitted", hint: "By everyone, or anyone" },
  { id: "comment", label: "A comment is posted", hint: "Any, or one category" },
  { id: "resolved", label: "Every comment is resolved", hint: "On the version" },
  { id: "task", label: "A task is done", hint: "Any task on the item" },
  { id: "due", label: "A due date passes", hint: "Of the stage, or of a review" },
  { id: "opened", label: "A share is opened", hint: "By anyone it was sent to" },
  { id: "download", label: "A download happens", hint: "Of the proxy or the original" },
  { id: "mention", label: "Someone is mentioned", hint: "In a comment" },
];

const picker: {
  group: string;
  items: { kind: NodeKind; event?: string; label: string; hint: string }[];
}[] = [
  {
    group: "Review",
    items: [
      { kind: "approval", label: "Approval", hint: kindMeta.approval.hint },
      { kind: "feedback", label: "Feedback", hint: kindMeta.feedback.hint },
    ],
  },
  { group: "Work", items: [{ kind: "task", label: "Task", hint: kindMeta.task.hint }] },
  {
    group: "Flow",
    items: [
      { kind: "condition", label: "Condition", hint: kindMeta.condition.hint },
      { kind: "notify", label: "Notify", hint: kindMeta.notify.hint },
    ],
  },
  {
    group: "Events: wait until",
    items: events.map((e) => ({
      kind: "event" as NodeKind,
      event: e.id,
      label: e.label,
      hint: e.hint,
    })),
  },
  { group: "Finish", items: [{ kind: "status", label: "Set status", hint: kindMeta.status.hint }] },
];

const templates = [
  { id: "simple", name: "Simple approval", hint: "One approval, then approved or back to editing" },
  {
    id: "conductor",
    name: "Conductor first",
    hint: "Feedback, triage, edit, approval, with a loop",
  },
  {
    id: "parallel",
    name: "Parallel stakeholders",
    hint: "Several feedback rounds at once, then lock",
  },
];

interface UploadRule {
  id: string;
  name: string;
  hint: string;
  source?: string;
  action: "off" | "warn" | "refuse";
}

/* ---------- Simulation ---------- */

interface Run {
  current: string | null;
  nodes: string[];
  edges: string[];
  decision: "all" | "some" | "none" | null;
  log: string[];
}

function Node({
  node,
  selected,
  ran,
  current,
  trigger,
  onSelect,
}: {
  node: GraphNode;
  selected: boolean;
  ran: boolean;
  current: boolean;
  trigger: boolean;
  onSelect: () => void;
}) {
  const p = posOf(node);
  const meta = kindMeta[node.kind];
  const start = trigger;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`${node.name}, ${meta.label}`}
      className={cn(
        "absolute flex h-14 w-[188px] items-center gap-2.5 border px-3 text-left transition-[border-color,box-shadow,background-color] duration-150",
        start ? "rounded-l-full rounded-r-panel" : "rounded-panel",
        current
          ? "border-signal bg-[color-mix(in_oklab,var(--hk-signal)_14%,var(--hk-raised))] shadow-[0_0_0_4px_var(--hk-signal-line)]"
          : ran
            ? "border-signal/50 bg-raised shadow-2"
            : selected
              ? "border-ink-3 bg-overlay shadow-3"
              : "border-line-strong bg-raised shadow-2 hover:border-edge-strong",
      )}
      style={{ left: p.x, top: p.y }}
    >
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-full",
          current || node.kind === "event" ? "bg-signal text-ground" : "bg-ground/60 text-ink-2",
        )}
      >
        <Icon name={meta.icon} size={13} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-ink">{node.name}</span>
        <span className="block truncate text-[11px] text-ink-3">
          {meta.label}
          {node.detail ? ` · ${node.detail}` : ""}
        </span>
      </span>
      {ran && (
        <span className="absolute -right-1.5 -bottom-1.5 flex size-4 items-center justify-center rounded-full bg-signal text-ground shadow-2">
          <Icon name="check" size={9} />
        </span>
      )}
      {!start && (
        <span
          aria-hidden="true"
          className="absolute top-1/2 -left-[5px] h-3 w-[5px] -translate-y-1/2 rounded-l-[2px] bg-edge-strong"
        />
      )}
    </button>
  );
}

/** The canvas: stages joined by edges, conditions that branch, loops that go back. */
export function WorkflowPage({ project }: { project: Project }) {
  const viewer = useViewer();
  const canEdit = viewer.can(project.id, "edit_workflows");
  const workflow = workflows.find((w) => w.id === project.workflowId);
  const initial = graphFor(project.workflowId);
  const [graph, setGraph] = useState<Graph>(
    initial ?? { workflowId: project.workflowId, nodes: [], edges: [] },
  );
  const [statuses, setStatuses] = useState(workflow?.statuses ?? []);
  const [selected, setSelected] = useState<string | null>(graph.nodes[1]?.id ?? null);
  const [adding, setAdding] = useState<{ from: string; output: string } | null>(null);
  const [tab, setTab] = useState<"builder" | "statuses" | "overrides">("builder");
  const [run, setRun] = useState<Run | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [activated, setActivated] = useState(false);
  const [zoom, setZoom] = useState<number | null>(null);
  const allRules: Omit<UploadRule, "action">[] = [
    ...qaRules.map((r) => ({
      id: r.id,
      name: r.name,
      hint: r.hint,
      source: undefined as string | undefined,
    })),
    ...rulePacks
      .filter((pk) => (projectPacks[project.id] ?? []).includes(pk.id))
      .flatMap((pk) =>
        pk.rules.map((r) => ({ id: r.id, name: r.name, hint: r.hint, source: pk.name })),
      ),
    ...customRules.map((r) => ({ id: r.id, name: r.name, hint: r.hint, source: "Custom" })),
  ];
  const [uploadRules, setUploadRules] = useState<UploadRule[]>(() =>
    allRules
      .filter(
        (r) =>
          [...qaRules, ...rulePacks.flatMap((pk) => pk.rules), ...customRules].find(
            (x) => x.id === r.id,
          )?.onUpload,
      )
      .map((r) => ({
        ...r,
        action: r.id === "tp" || r.id === "corrupt" || r.id === "src" ? "refuse" : "warn",
      })),
  );
  const canvas = useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = useState({ w: 900, h: 500 });
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries)
        setCanvasSize({ w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);
  const cols = Math.max(0, ...graph.nodes.map((n) => n.col)) + 1;
  const rows = Math.max(0, ...graph.nodes.map((n) => n.row)) + 1;
  const width = PAD_X * 2 + (cols - 1) * COL + NODE_W + 80;
  const floor = PAD_Y + (rows - 1) * ROW + NODE_H + 36;
  const height = floor + 48;
  const fit = Math.min(
    1,
    Math.max(0.62, Math.min((canvasSize.w - 24) / width, (canvasSize.h - 24) / height)),
  );
  const scale = zoom ?? fit;
  const current = selected ? byId.get(selected) : undefined;
  const dangling = graph.nodes.flatMap((n) =>
    n.outputs
      .filter((o) => !graph.edges.some((e) => e.from === n.id && e.output === o.id))
      .map((o) => ({ node: n, output: o })),
  );
  const hasIncoming = (id: string) => graph.edges.some((e) => e.to === id);
  const isTrigger = (n: GraphNode) => n.kind === "event" && !hasIncoming(n.id);
  const unreachable = graph.nodes.filter((n) => !isTrigger(n) && !hasIncoming(n.id));
  const name = workflow?.name ?? "Workflow";

  const update = (id: string, patch: Partial<GraphNode>) =>
    setGraph((g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) }));
  const removeNode = (id: string) => {
    setGraph((g) => ({
      nodes: g.nodes.filter((n) => n.id !== id),
      edges: g.edges.filter((e) => e.from !== id && e.to !== id),
      workflowId: g.workflowId,
    }));
    setSelected(null);
  };
  const addNode = (kind: NodeKind, event?: string) => {
    const from = adding ? byId.get(adding.from) : current;
    const id = `n-${Date.now().toString(36)}`;
    const col = from ? from.col + 1 : 0;
    const row = from
      ? from.row +
        (adding && from.outputs.length > 1
          ? from.outputs.findIndex((o) => o.id === adding.output) - 1
          : 0)
      : 0;
    const taken = graph.nodes.some((n) => n.col === col && n.row === row);
    const node: GraphNode = {
      id,
      kind,
      name:
        kind === "event"
          ? (events.find((e) => e.id === event)?.label ?? "Event")
          : kindMeta[kind].label,
      detail:
        kind === "task"
          ? "Choose who"
          : kind === "approval" || kind === "feedback"
            ? "Choose reviewers"
            : kind === "event"
              ? "wait until it happens"
              : undefined,
      col,
      row: taken ? rows : Math.max(0, row),
      outputs:
        kind === "condition"
          ? [
              { id: "a", label: "all approved" },
              { id: "b", label: "else" },
            ]
          : kind === "status"
            ? []
            : [{ id: "out" }],
      config: kind === "event" ? { event: event ?? "manual" } : {},
    };
    setGraph((g) => ({
      ...g,
      nodes: [...g.nodes, node],
      edges:
        from && adding
          ? [...g.edges, { id: `e-${id}`, from: from.id, output: adding.output, to: id }]
          : g.edges,
    }));
    setAdding(null);
    setSelected(id);
  };
  const connect = (from: string, output: string, to: string) =>
    setGraph((g) => ({
      ...g,
      edges: [
        ...g.edges.filter((e) => !(e.from === from && e.output === output)),
        { id: `e-${from}-${output}-${to}`, from, output, to },
      ],
    }));

  /* The run: one item through the workflow, the person choosing each outcome. */
  const startRun = () => {
    const start = graph.nodes.find((n) => isTrigger(n));
    if (!start) return;
    setRun({
      current: start.id,
      nodes: [start.id],
      edges: [],
      decision: null,
      log: ["A version arrives"],
    });
    setSelected(start.id);
  };
  const advance = (r: Run, output: string, note: string): Run => {
    const node = r.current ? byId.get(r.current) : undefined;
    if (!node) return r;
    const edge = graph.edges.find((e) => e.from === node.id && e.output === output);
    if (!edge)
      return {
        ...r,
        current: null,
        log: [...r.log, note, "Nothing follows: the workflow ends here"],
      };
    const next = byId.get(edge.to);
    let out: Run = {
      ...r,
      current: edge.to,
      nodes: [...r.nodes, edge.to],
      edges: [...r.edges, edge.id],
      log: [...r.log, note],
    };
    if (next?.kind === "condition") {
      const pick =
        next.outputs.find((o) =>
          (o.label ?? "").includes(
            r.decision === "all" ? "all" : r.decision === "some" ? "some" : "else",
          ),
        ) ?? next.outputs.at(-1);
      if (pick)
        out = advance(
          { ...out, log: [...out.log, `${next.name}: took “${pick.label}”`] },
          pick.id,
          "",
        );
    } else if (next?.kind === "notify") {
      out = advance(
        { ...out, log: [...out.log, `${next.name}: sent to ${next.config?.to ?? "them"}`] },
        "out",
        "",
      );
    } else if (next?.kind === "status") {
      out = { ...out, current: null, log: [...out.log, `Status set to ${next.name}; finished`] };
    }
    return out;
  };
  const runNode = run?.current ? byId.get(run.current) : undefined;
  const outcomes = (
    n: GraphNode,
  ): { label: string; output: string; decision?: Run["decision"] }[] => {
    if (n.kind === "event") return [{ label: "It happens", output: "out" }];
    if (n.kind === "approval")
      return [
        { label: "Everyone approves", output: "out", decision: "all" },
        { label: "Some approve", output: "out", decision: "some" },
        { label: "Changes requested", output: "out", decision: "none" },
      ];
    if (n.kind === "feedback") return [{ label: "Feedback submitted", output: "out" }];
    if (n.kind === "task") return [{ label: "Done", output: "out" }];
    return n.outputs.map((o) => ({ label: o.label ?? "Next", output: o.id }));
  };

  usePageHeader({
    crumbs: [
      { label: project.name, to: `/projects/${project.id}` },
      { label: "Settings", to: `/projects/${project.id}/settings` },
    ],
    title: name,
    actions: canEdit ? (
      <>
        <Button variant="ghost" onClick={() => (run ? setRun(null) : startRun())}>
          <Icon name="play" size={12} fill="currentColor" strokeWidth={0} />
          {run ? "Stop the run" : "Run it"}
        </Button>
        <Button
          variant="primary"
          onClick={() => setActivated(true)}
          disabled={unreachable.length > 0}
        >
          {activated ? "Active" : "Activate"}
        </Button>
      </>
    ) : undefined,
    revision: `${run ? "run" : ""}-${activated}-${unreachable.length}`,
  });
  if (!workflow) return <Refused />;

  const field = (label: string, control: ReactNode, hint?: string) => (
    <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
      {label}
      {control}
      {hint && <span className="text-[12px] text-ink-3">{hint}</span>}
    </label>
  );

  const inspector = run ? (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Label>Running one item</Label>
        <button
          type="button"
          onClick={() => setRun(null)}
          className="ml-auto text-[12px] text-ink-3 hover:text-ink"
        >
          Stop
        </button>
      </div>
      {runNode ? (
        <>
          <p className="text-[14px] text-ink">
            <span className="font-medium">{runNode.name}</span>
            <span className="block text-[13px] text-ink-3">
              {runNode.kind === "task"
                ? `${runNode.detail ?? "Someone"} works on it; status ${runNode.config?.status ?? "unchanged"}.`
                : runNode.kind === "approval" || runNode.kind === "feedback"
                  ? `${runNode.detail ?? "Reviewers"} are asked; status ${runNode.config?.status ?? "unchanged"}.`
                  : kindMeta[runNode.kind].hint}
            </span>
          </p>
          <div className="flex flex-col gap-1.5">
            {outcomes(runNode).map((o) => {
              const edge = graph.edges.find((e) => e.from === runNode.id && e.output === o.output);
              const next = edge ? byId.get(edge.to) : undefined;
              return (
                <Button
                  key={o.label}
                  variant="secondary"
                  size="md"
                  className="justify-between"
                  onClick={() =>
                    setRun((r) =>
                      r
                        ? advance(
                            { ...r, decision: o.decision ?? r.decision },
                            o.output,
                            `${runNode.name}: ${o.label.toLowerCase()}`,
                          )
                        : r,
                    )
                  }
                >
                  {o.label}
                  <span className="text-[12px] text-ink-3">
                    {next ? `→ ${next.name}` : "→ end"}
                  </span>
                </Button>
              );
            })}
          </div>
        </>
      ) : (
        <p className="flex items-center gap-2 text-[14px] text-ink">
          <Dot state="approved" /> Finished.
        </p>
      )}
      <div className="flex flex-col gap-1 border-t border-line pt-3">
        <Label>What happened</Label>
        <ol className="flex flex-col gap-1 text-[12px] text-ink-2">
          {run.log.filter(Boolean).map((l, i) => (
            <li key={`${String(i)}-${l}`} className="flex gap-2">
              <span className="tabular text-ink-3">{i + 1}.</span>
              {l}
            </li>
          ))}
        </ol>
      </div>
      <p className="text-[12px] text-ink-3">
        Nothing is sent while running. Conditions and notifications take their own course.
      </p>
    </div>
  ) : adding ? (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Label>What happens next?</Label>
        <button
          type="button"
          onClick={() => setAdding(null)}
          className="ml-auto text-[12px] text-ink-3 hover:text-ink"
        >
          Cancel
        </button>
      </div>
      <p className="text-[12px] text-ink-3">
        After {byId.get(adding.from)?.name}
        {(byId.get(adding.from)?.outputs.length ?? 0) > 1
          ? ` (${byId.get(adding.from)?.outputs.find((o) => o.id === adding.output)?.label})`
          : ""}
        .
      </p>
      {picker.map((g) => (
        <div key={g.group} className="flex flex-col gap-1">
          <span className="eyebrow text-[12px]">{g.group}</span>
          {g.items.map((it) => (
            <button
              key={`${it.kind}-${it.event ?? ""}`}
              type="button"
              onClick={() => addNode(it.kind, it.event)}
              className="flex items-center gap-3 rounded-control px-2 py-1.5 text-left transition-colors hover:bg-raised"
            >
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-ground/60 text-ink-2">
                <Icon name={kindMeta[it.kind].icon} size={13} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] text-ink">{it.label}</span>
                <span className="block truncate text-[12px] text-ink-3">{it.hint}</span>
              </span>
            </button>
          ))}
        </div>
      ))}
      <div className="flex flex-col gap-1 border-t border-line pt-3">
        <span className="eyebrow text-[12px]">Or join an existing stage</span>
        <Select
          defaultValue=""
          onChange={(e) => {
            if (e.target.value) {
              connect(adding.from, adding.output, e.target.value);
              setAdding(null);
            }
          }}
        >
          <option value="">Choose a stage</option>
          {graph.nodes
            .filter((n) => !isTrigger(n) && n.id !== adding.from)
            .map((n) => (
              <option key={n.id} value={n.id}>
                {n.name}
              </option>
            ))}
        </Select>
        <span className="text-[12px] text-ink-3">Joining an earlier stage makes a loop.</span>
      </div>
    </div>
  ) : current ? (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-full bg-ground/60 text-ink-2">
          <Icon name={kindMeta[current.kind].icon} size={13} />
        </span>
        <Label>{kindMeta[current.kind].label}</Label>
        {canEdit && !isTrigger(current) && (
          <button
            type="button"
            onClick={() => removeNode(current.id)}
            className="ml-auto text-[12px] text-ink-3 hover:text-signal"
          >
            Delete
          </button>
        )}
      </div>
      {current.kind === "event" ? (
        <>
          {field(
            isTrigger(current) ? "Starts when" : "Waits until",
            <Select
              value={current.config?.event ?? "manual"}
              onChange={(e) =>
                update(current.id, {
                  config: { ...current.config, event: e.target.value },
                  name: events.find((x) => x.id === e.target.value)?.label ?? current.name,
                })
              }
              disabled={!canEdit}
            >
              {events.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </Select>,
            isTrigger(current)
              ? "A trigger: nothing comes before it."
              : "The item holds here until it happens, then carries on.",
          )}
          {current.config?.event === "upload" && (
            <div className="flex flex-col gap-2 text-[13px] text-ink-2">
              At the door
              <ul className="flex flex-col divide-y divide-line rounded-panel border border-line bg-ground/40">
                {uploadRules.map((r) => (
                  <li key={r.id} className="flex items-center gap-2 px-2.5 py-1.5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-ink">{r.name}</span>
                      {r.source && (
                        <span className="block truncate text-[11px] text-ink-3">{r.source}</span>
                      )}
                    </span>
                    <Select
                      value={r.action}
                      onChange={(e) =>
                        setUploadRules(
                          uploadRules.map((x) =>
                            x.id === r.id
                              ? { ...x, action: e.target.value as UploadRule["action"] }
                              : x,
                          ),
                        )
                      }
                      className="h-7 w-[108px] text-[12px]"
                      disabled={!canEdit}
                    >
                      <option value="off">Off</option>
                      <option value="warn">Warn</option>
                      <option value="refuse">Refuse</option>
                    </Select>
                    {canEdit && (
                      <button
                        type="button"
                        aria-label={`Remove ${r.name}`}
                        onClick={() => setUploadRules(uploadRules.filter((x) => x.id !== r.id))}
                        className="text-ink-3 hover:text-signal"
                      >
                        <Icon name="close" size={11} />
                      </button>
                    )}
                  </li>
                ))}
                {uploadRules.length === 0 && (
                  <li className="px-2.5 py-2 text-[12px] text-ink-3">
                    Nothing is checked at the door.
                  </li>
                )}
              </ul>
              {canEdit && (
                <Dropdown
                  value={
                    <span className="flex items-center gap-1.5">
                      <Icon name="plus" size={12} />
                      Add a rule
                    </span>
                  }
                  actions={allRules
                    .filter((r) => !uploadRules.some((u) => u.id === r.id))
                    .map((r) => ({
                      label: r.name,
                      hint: r.source,
                      onSelect: () => setUploadRules([...uploadRules, { ...r, action: "warn" }]),
                    }))}
                />
              )}
              <span className="text-[12px] text-ink-3">
                A refused file never enters; a producer can let it through. The rules themselves
                live in{" "}
                <Link
                  to="/projects/$projectId/$view"
                  params={{ projectId: project.id, view: "settings" }}
                  search={{ section: "qa" }}
                  className="text-ink-2 hover:text-ink"
                >
                  QA rules
                </Link>
                .
              </span>
            </div>
          )}
          {current.config?.event === "due" &&
            field(
              "Days after the stage starts",
              <Input defaultValue="5" className="w-16 text-center" disabled={!canEdit} />,
            )}
          {(current.config?.event === "comment" || current.config?.event === "review") &&
            field(
              "Of which kind",
              <Select defaultValue="any" disabled={!canEdit}>
                <option value="any">Any</option>
                {current.config?.event === "comment" ? (
                  <>
                    <option value="noise">Noise</option>
                    <option value="edit">Edit</option>
                    <option value="balance">Balance</option>
                  </>
                ) : (
                  <>
                    <option value="approval">Approval</option>
                    <option value="feedback">Feedback</option>
                  </>
                )}
              </Select>,
            )}
          {isTrigger(current) &&
            field(
              "Applies to",
              <Select defaultValue="all" disabled={!canEdit}>
                <option value="all">Every track</option>
                <option value="new">New tracks only</option>
              </Select>,
            )}
        </>
      ) : (
        field(
          "Name",
          <Input
            value={current.name}
            onChange={(e) => update(current.id, { name: e.target.value })}
            disabled={!canEdit}
          />,
        )
      )}
      {(current.kind === "approval" || current.kind === "feedback" || current.kind === "task") && (
        <>
          {field(
            current.kind === "task" ? "Who does it" : "Who is asked",
            <Input
              value={current.detail ?? ""}
              onChange={(e) => update(current.id, { detail: e.target.value })}
              disabled={!canEdit}
            />,
            "A role, a group, people or guests.",
          )}
          {current.kind !== "task" &&
            field(
              "Order",
              <Select
                value={current.config?.order ?? "parallel"}
                onChange={(e) =>
                  update(current.id, { config: { ...current.config, order: e.target.value } })
                }
                disabled={!canEdit}
              >
                <option value="parallel">All at once</option>
                <option value="sequence">In turn</option>
              </Select>,
            )}
          {current.kind === "approval" &&
            field(
              "Approved when",
              <Select
                value={current.config?.rule ?? "all"}
                onChange={(e) =>
                  update(current.id, { config: { ...current.config, rule: e.target.value } })
                }
                disabled={!canEdit}
              >
                <option value="all">Everyone approves</option>
                <option value="any">Any one approves</option>
                <option value="quorum">A share approves</option>
              </Select>,
            )}
          {field(
            "Sets the status",
            <Select
              value={current.config?.status ?? ""}
              onChange={(e) =>
                update(current.id, { config: { ...current.config, status: e.target.value } })
              }
              disabled={!canEdit}
            >
              <option value="">Leave as is</option>
              {statuses.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </Select>,
          )}
          {field(
            "Due",
            <span className="flex items-center gap-2">
              <Input
                value={current.config?.due ?? "5"}
                onChange={(e) =>
                  update(current.id, { config: { ...current.config, due: e.target.value } })
                }
                className="w-16 text-center"
                disabled={!canEdit}
              />
              <span className="text-ink-3">days after it starts</span>
            </span>,
          )}
          <div className="flex flex-col gap-2 text-[13px] text-ink-2">
            On entering
            {[
              "Tell the participants in the app",
              "Mail the participants",
              "Tell the producer when it ends",
            ].map((n, i) => (
              <span key={n} className="flex items-center justify-between text-ink">
                {n}
                <Switch label={n} checked={i < 2} onChange={() => {}} />
              </span>
            ))}
          </div>
        </>
      )}
      {current.kind === "condition" && (
        <>
          {field(
            "Based on",
            <Select defaultValue="decisions" disabled={!canEdit}>
              <option value="decisions">The decisions of the approval before</option>
              <option value="qa">The QA result</option>
              <option value="comments">Whether comments are open</option>
            </Select>,
          )}
          <div className="flex flex-col gap-1.5 text-[13px] text-ink-2">
            Branches, tried in order
            {current.outputs.map((o, i) => (
              <span key={o.id} className="flex items-center gap-2">
                <span className="tabular w-4 text-ink-3">{i + 1}</span>
                <Input
                  value={o.label ?? ""}
                  onChange={(e) =>
                    update(current.id, {
                      outputs: current.outputs.map((x) =>
                        x.id === o.id ? { ...x, label: e.target.value } : x,
                      ),
                    })
                  }
                  className="h-8"
                  disabled={!canEdit}
                />
                <Select
                  defaultValue={
                    o.label?.includes("all") ? "all" : o.label?.includes("some") ? "some" : "else"
                  }
                  className="h-8 w-36 text-[12px]"
                  disabled={!canEdit}
                >
                  <option value="all">all approved</option>
                  <option value="some">some approved</option>
                  <option value="none">none approved</option>
                  <option value="else">otherwise</option>
                </Select>
                {canEdit && current.outputs.length > 2 && (
                  <button
                    type="button"
                    aria-label="Remove branch"
                    onClick={() =>
                      update(current.id, { outputs: current.outputs.filter((x) => x.id !== o.id) })
                    }
                    className="text-ink-3 hover:text-signal"
                  >
                    <Icon name="close" size={12} />
                  </button>
                )}
              </span>
            ))}
            {canEdit && (
              <Button
                variant="ghost"
                size="sm"
                className="self-start"
                onClick={() =>
                  update(current.id, {
                    outputs: [
                      ...current.outputs,
                      { id: `o-${current.outputs.length}`, label: "another case" },
                    ],
                  })
                }
              >
                <Icon name="plus" size={12} />
                Add a branch
              </Button>
            )}
            <span className="text-[12px] text-ink-3">
              The last branch catches whatever the others do not.
            </span>
          </div>
        </>
      )}
      {current.kind === "notify" && (
        <>
          {field(
            "Who",
            <Select
              value={current.config?.to ?? "Producer"}
              onChange={(e) =>
                update(current.id, { config: { ...current.config, to: e.target.value } })
              }
              disabled={!canEdit}
            >
              {["Producer", "Engineer", "Editor", "The reviewers", "Everyone in the project"].map(
                (w) => (
                  <option key={w}>{w}</option>
                ),
              )}
            </Select>,
          )}
          <div className="flex flex-col gap-1.5 text-[13px] text-ink-2">
            How
            <div className="flex flex-wrap gap-1.5">
              {["In the app", "Mail", "Slack"].map((c, i) => (
                <button
                  key={c}
                  type="button"
                  aria-pressed={i < 2}
                  className={cn(
                    "h-7 rounded-chip border px-2.5 text-[13px]",
                    i < 2
                      ? "border-edge bg-raised text-ink"
                      : "border-line text-ink-3 hover:text-ink",
                  )}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
          {field(
            "Message",
            <Textarea
              rows={3}
              defaultValue="{{track}} came back from {{stage}}: {{decisions}}. Please decide how to proceed."
              disabled={!canEdit}
            />,
            "Fields in braces are filled in when it is sent.",
          )}
        </>
      )}
      {current.kind === "status" && (
        <>
          {field(
            "Status",
            <Select
              value={current.name}
              onChange={(e) => update(current.id, { name: e.target.value })}
              disabled={!canEdit}
            >
              {statuses.map((s) => (
                <option key={s.name} value={s.name}>
                  {s.name}
                </option>
              ))}
            </Select>,
          )}
          <span className="flex items-center justify-between text-[13px] text-ink">
            Ends the workflow
            <Switch label="Ends the workflow" checked onChange={() => {}} />
          </span>
        </>
      )}
      {current.outputs.length > 0 && (
        <div className="flex flex-col gap-1 border-t border-line pt-3 text-[13px] text-ink-2">
          Then
          {current.outputs.map((o) => {
            const edge = graph.edges.find((e) => e.from === current.id && e.output === o.id);
            const next = edge ? byId.get(edge.to) : undefined;
            return (
              <span key={o.id} className="flex items-center gap-2 text-ink">
                {o.label && <span className="text-[12px] text-ink-3">{o.label}:</span>}
                <span className="min-w-0 flex-1 truncate">{next ? next.name : "nothing yet"}</span>
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => setAdding({ from: current.id, output: o.id })}
                    className="text-[12px] text-ink-3 hover:text-ink"
                  >
                    {next ? "Change" : "Add"}
                  </button>
                )}
              </span>
            );
          })}
        </div>
      )}
    </div>
  ) : (
    <p className="text-[13px] text-ink-3">Choose a stage on the canvas, or press a + to add one.</p>
  );

  return (
    <div className="fade-in flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2 @3xl/app:px-6">
        <div role="tablist" className="flex gap-1">
          {(
            [
              ["builder", "Builder"],
              ["statuses", "Statuses"],
              ["overrides", "Per track"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={cn(
                "h-8 rounded-control px-2.5 text-[13px] transition-colors",
                tab === id ? "bg-raised text-ink shadow-1" : "text-ink-3 hover:text-ink",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === "builder" && canEdit && (
          <div className="ml-auto flex items-center gap-1">
            <Button variant="ghost" size="md" onClick={() => setTemplatesOpen(true)}>
              Templates
            </Button>
            <Dropdown
              value="Duplicate from"
              align="right"
              actions={workflows
                .filter((w) => w.id !== workflow.id)
                .map((w) => ({
                  label: `${projectById(w.projectId)?.name}: ${w.name}`,
                  onSelect: () => setGraph(graphFor(w.id) ?? graph),
                }))}
            />
            <Button
              variant="secondary"
              size="md"
              onClick={() =>
                setAdding({
                  from: current?.id ?? graph.nodes[0]?.id ?? "",
                  output: current?.outputs[0]?.id ?? "out",
                })
              }
            >
              <Icon name="plus" size={14} />
              Stage
            </Button>
          </div>
        )}
      </div>
      {tab === "builder" && (
        <div className="flex min-h-0 flex-1 flex-col @3xl/app:flex-row">
          <div
            ref={canvas}
            className="scroll-quiet relative min-h-[360px] flex-1 overflow-auto bg-[radial-gradient(circle_at_1px_1px,var(--hk-line)_1px,transparent_0)] bg-[length:24px_24px]"
          >
            <div style={{ width: width * scale, height: height * scale }}>
              <div
                className="relative"
                style={{ width, height, transform: `scale(${scale})`, transformOrigin: "0 0" }}
              >
                <svg
                  width={width}
                  height={height}
                  className="absolute inset-0"
                  role="img"
                  aria-label="Workflow"
                >
                  <defs>
                    <marker
                      id="arrow"
                      viewBox="0 0 10 10"
                      refX="9"
                      refY="5"
                      markerWidth="7"
                      markerHeight="7"
                      orient="auto-start-reverse"
                    >
                      <path d="M0,0 L10,5 L0,10 z" fill="var(--hk-edge-strong)" />
                    </marker>
                    <marker
                      id="arrow-hot"
                      viewBox="0 0 10 10"
                      refX="9"
                      refY="5"
                      markerWidth="7"
                      markerHeight="7"
                      orient="auto-start-reverse"
                    >
                      <path d="M0,0 L10,5 L0,10 z" fill="var(--hk-signal)" />
                    </marker>
                    <marker
                      id="arrow-sel"
                      viewBox="0 0 10 10"
                      refX="9"
                      refY="5"
                      markerWidth="7"
                      markerHeight="7"
                      orient="auto-start-reverse"
                    >
                      <path d="M0,0 L10,5 L0,10 z" fill="var(--hk-ink-3)" />
                    </marker>
                  </defs>
                  {graph.edges.map((e: GraphEdge) => {
                    const from = byId.get(e.from);
                    const to = byId.get(e.to);
                    if (!from || !to) return null;
                    const a = outputAt(from, e.output);
                    const b = inputAt(to);
                    const hot = run?.edges.includes(e.id);
                    const sel = selected === e.from || selected === e.to;
                    const d = edgePath(a, b, floor + Math.max(0, from.row - to.row) * 0);
                    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
                    return (
                      <g key={e.id}>
                        <path
                          d={d}
                          fill="none"
                          stroke={
                            hot
                              ? "var(--hk-signal)"
                              : sel
                                ? "var(--hk-ink-3)"
                                : "var(--hk-edge-strong)"
                          }
                          strokeWidth={hot ? 2 : 1.5}
                          markerEnd={
                            hot ? "url(#arrow-hot)" : sel ? "url(#arrow-sel)" : "url(#arrow)"
                          }
                          className="transition-[stroke] duration-200"
                        />
                        {hot && b.x > a.x + 30 && (
                          <g transform={`translate(${mid.x}, ${mid.y - 10})`}>
                            <rect
                              x={-22}
                              y={-9}
                              width={44}
                              height={18}
                              rx={9}
                              fill="var(--hk-overlay)"
                              stroke="var(--hk-signal-line)"
                            />
                            <text
                              x={0}
                              y={4}
                              textAnchor="middle"
                              fontSize={10}
                              fill="var(--hk-ink-2)"
                              fontFamily="var(--hk-font-sans)"
                            >
                              1 item
                            </text>
                          </g>
                        )}
                      </g>
                    );
                  })}
                  {graph.nodes.map((n) =>
                    n.outputs.map((o) => {
                      const p = outputAt(n, o.id);
                      return (
                        <g key={`${n.id}-${o.id}`}>
                          <circle
                            cx={p.x}
                            cy={p.y}
                            r={4}
                            fill="var(--hk-raised)"
                            stroke="var(--hk-edge-strong)"
                            strokeWidth={1.5}
                          />
                          {o.label && n.outputs.length > 1 && (
                            <text
                              x={p.x + 9}
                              y={p.y + 3.5}
                              fontSize={10}
                              fill="var(--hk-ink-3)"
                              fontFamily="var(--hk-font-sans)"
                            >
                              {o.label}
                            </text>
                          )}
                        </g>
                      );
                    }),
                  )}
                </svg>
                {graph.nodes.map((n) => (
                  <Node
                    key={n.id}
                    node={n}
                    selected={selected === n.id}
                    ran={Boolean(run?.nodes.includes(n.id))}
                    current={run?.current === n.id}
                    trigger={isTrigger(n)}
                    onSelect={() => setSelected(n.id)}
                  />
                ))}
                {canEdit &&
                  !run &&
                  dangling.map(({ node, output }) => {
                    const p = outputAt(node, output.id);
                    return (
                      <button
                        key={`${node.id}-${output.id}`}
                        type="button"
                        aria-label={`Add after ${node.name}`}
                        onClick={() => {
                          setSelected(node.id);
                          setAdding({ from: node.id, output: output.id });
                        }}
                        className="absolute flex items-center text-ink-3 hover:text-ink"
                        style={{ left: p.x + 4, top: p.y - 11 }}
                      >
                        <span className="h-px w-5 bg-edge-strong" />
                        <span
                          className={cn(
                            "flex size-[22px] items-center justify-center rounded-[5px] border border-dashed border-edge-strong bg-raised transition-colors hover:border-ink-3",
                            adding?.from === node.id &&
                              adding.output === output.id &&
                              "border-signal text-signal",
                          )}
                        >
                          <Icon name="plus" size={11} />
                        </span>
                      </button>
                    );
                  })}
              </div>
            </div>
            <div className="absolute bottom-3 left-3 flex items-center gap-0.5 rounded-control bg-overlay p-0.5 shadow-3">
              <button
                type="button"
                aria-label="Zoom out"
                onClick={() => setZoom(Math.max(0.4, scale - 0.1))}
                className="flex size-7 items-center justify-center rounded-[4px] text-ink-2 hover:bg-raised hover:text-ink"
              >
                <Icon name="zoomOut" size={14} />
              </button>
              <button
                type="button"
                onClick={() => setZoom(null)}
                className="tabular h-7 rounded-[4px] px-2 text-[12px] text-ink-2 hover:bg-raised hover:text-ink"
              >
                {zoom === null ? "Fit" : `${Math.round(scale * 100)}%`}
              </button>
              <button
                type="button"
                aria-label="Zoom in"
                onClick={() => setZoom(Math.min(1.5, scale + 0.1))}
                className="flex size-7 items-center justify-center rounded-[4px] text-ink-2 hover:bg-raised hover:text-ink"
              >
                <Icon name="zoomIn" size={14} />
              </button>
              <span className="mx-1 h-4 w-px bg-line" />
              <button
                type="button"
                className="h-7 rounded-[4px] px-2 text-[12px] text-ink-2 hover:bg-raised hover:text-ink"
              >
                Tidy up
              </button>
            </div>
            <div
              className="pointer-events-none absolute right-3 bottom-3 hidden rounded-control border border-line bg-overlay/90 p-1.5 shadow-3 @3xl/app:block"
              aria-hidden="true"
            >
              <svg
                width={Math.round(width * 0.07)}
                height={Math.round(height * 0.07)}
                role="img"
                aria-label="Map of the canvas"
              >
                {graph.nodes.map((n) => {
                  const p = posOf(n);
                  return (
                    <rect
                      key={n.id}
                      x={p.x * 0.07}
                      y={p.y * 0.07}
                      width={NODE_W * 0.07}
                      height={NODE_H * 0.07}
                      rx={1.5}
                      fill={run?.nodes.includes(n.id) ? "var(--hk-signal)" : "var(--hk-ink-3)"}
                      opacity={0.8}
                    />
                  );
                })}
              </svg>
            </div>
            {unreachable.length > 0 && !run && (
              <div className="absolute top-3 left-3 flex items-center gap-1.5 rounded-control bg-overlay px-2.5 py-1.5 text-[12px] text-signal shadow-3">
                <Icon name="warning" size={12} /> {unreachable.length}{" "}
                {unreachable.length === 1 ? "stage is" : "stages are"} not reached by anything
              </div>
            )}
          </div>
          <aside className="scroll-quiet flex w-full shrink-0 flex-col overflow-auto border-t border-line p-4 @3xl/app:w-[320px] @3xl/app:border-t-0 @3xl/app:border-l">
            {inspector}
          </aside>
        </div>
      )}
      {tab === "statuses" && (
        <div className="scroll-quiet min-h-0 flex-1 overflow-auto p-4 @3xl/app:p-6">
          <div className="flex max-w-[720px] flex-col gap-4">
            <p className="text-[14px] text-ink-2">
              The statuses a track can be in. Stages set them; the board groups by them.
            </p>
            <ul className="flex flex-col divide-y divide-line rounded-panel-lg border border-line bg-raised/25">
              {statuses.map((s, i) => (
                <li key={s.name} className="flex items-center gap-4 px-4 py-2.5">
                  <Dot
                    state={
                      s.category === "done"
                        ? "approved"
                        : s.category === "todo"
                          ? "invited"
                          : "in_review"
                    }
                  />
                  <Input
                    value={s.name}
                    onChange={(e) =>
                      setStatuses(
                        statuses.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                      )
                    }
                    className="h-8 max-w-[260px]"
                    disabled={!canEdit}
                  />
                  <Select
                    value={s.category}
                    onChange={(e) =>
                      setStatuses(
                        statuses.map((x, j) =>
                          j === i ? { ...x, category: e.target.value as typeof s.category } : x,
                        ),
                      )
                    }
                    className="h-8 w-36 text-[13px]"
                    disabled={!canEdit}
                  >
                    <option value="todo">To do</option>
                    <option value="in_progress">In progress</option>
                    <option value="done">Done</option>
                  </Select>
                  <span className="ml-auto text-[12px] text-ink-3">
                    {
                      graph.nodes.filter(
                        (n) =>
                          n.config?.status === s.name || (n.kind === "status" && n.name === s.name),
                      ).length
                    }{" "}
                    stages set it
                  </span>
                  {canEdit && (
                    <button
                      type="button"
                      aria-label={`Remove ${s.name}`}
                      onClick={() => setStatuses(statuses.filter((_, j) => j !== i))}
                      className="text-ink-3 hover:text-signal"
                    >
                      <Icon name="close" size={12} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {canEdit && (
              <Button
                variant="secondary"
                size="md"
                className="self-start"
                onClick={() =>
                  setStatuses([...statuses, { name: "New status", category: "in_progress" }])
                }
              >
                <Icon name="plus" size={14} />
                Status
              </Button>
            )}
          </div>
        </div>
      )}
      {tab === "overrides" && (
        <div className="scroll-quiet min-h-0 flex-1 overflow-auto p-4 @3xl/app:p-6">
          <div className="flex max-w-[720px] flex-col gap-4">
            <p className="text-[14px] text-ink-2">
              Every track follows the project's workflow unless it is given its own.
            </p>
            <ul className="flex flex-col divide-y divide-line rounded-panel-lg border border-line bg-raised/25">
              {tracks
                .filter((t) => t.projectId === project.id)
                .map((t, i) => (
                  <li key={t.id} className="flex items-center gap-4 px-4 py-3">
                    <Link
                      to="/tracks/$trackId"
                      params={{ trackId: t.id }}
                      search={{ view: "versions" }}
                      className="min-w-0 flex-1 truncate text-[14px] text-ink hover:text-signal"
                    >
                      {t.name}
                    </Link>
                    <span className="text-[13px] text-ink-3">
                      {i === 2 ? "Own workflow: Simple approval" : "Project workflow"}
                    </span>
                    {canEdit && (
                      <Button variant="ghost" size="sm">
                        {i === 2 ? "Edit" : "Override"}
                      </Button>
                    )}
                  </li>
                ))}
            </ul>
          </div>
        </div>
      )}
      {templatesOpen && (
        <Dialog
          title="Start from a template"
          description="Replaces the stages on the canvas; nothing is saved until you activate."
          onClose={() => setTemplatesOpen(false)}
          width="sm"
        >
          <ul className="flex flex-col gap-1">
            {templates.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  onClick={() => {
                    setTemplatesOpen(false);
                    if (t.id === "conductor") setGraph(graphFor("wf-joplin") ?? graph);
                    if (t.id === "parallel") setGraph(graphFor("wf-titles") ?? graph);
                    if (t.id === "simple")
                      setGraph({
                        workflowId: graph.workflowId,
                        nodes: [
                          {
                            id: "s0",
                            kind: "event",
                            name: "A version is uploaded",
                            config: { event: "upload" },
                            col: 0,
                            row: 0,
                            outputs: [{ id: "out" }],
                          },
                          {
                            id: "s1",
                            kind: "approval",
                            name: "Approval",
                            detail: "Producer, everyone",
                            col: 1,
                            row: 0,
                            outputs: [{ id: "out" }],
                            config: { rule: "all", status: statuses.at(-1)?.name ?? "" },
                          },
                          {
                            id: "s2",
                            kind: "condition",
                            name: "Decision",
                            col: 2,
                            row: 0,
                            outputs: [
                              { id: "a", label: "all approved" },
                              { id: "b", label: "else" },
                            ],
                          },
                          {
                            id: "s3",
                            kind: "status",
                            name: statuses.at(-1)?.name ?? "Approved",
                            col: 3,
                            row: 0,
                            outputs: [],
                          },
                          {
                            id: "s4",
                            kind: "task",
                            name: "Back to editing",
                            detail: "Engineer",
                            col: 3,
                            row: 1,
                            outputs: [{ id: "out" }],
                            config: { status: statuses[0]?.name ?? "" },
                          },
                        ],
                        edges: [
                          { id: "x1", from: "s0", output: "out", to: "s1" },
                          { id: "x2", from: "s1", output: "out", to: "s2" },
                          { id: "x3", from: "s2", output: "a", to: "s3" },
                          { id: "x4", from: "s2", output: "b", to: "s4" },
                          { id: "x5", from: "s4", output: "out", to: "s1" },
                        ],
                      });
                  }}
                  className="flex w-full flex-col rounded-panel px-3 py-2.5 text-left transition-colors hover:bg-raised"
                >
                  <span className="text-[14px] text-ink">{t.name}</span>
                  <span className="text-[13px] text-ink-3">{t.hint}</span>
                </button>
              </li>
            ))}
          </ul>
        </Dialog>
      )}
      {activated && (
        <div className="rise-in absolute right-4 bottom-4 z-30 flex items-center gap-2 rounded-panel bg-overlay px-3 py-2 text-[13px] text-ink shadow-3">
          <Dot state="approved" /> Workflow active for {project.name}
          <button
            type="button"
            onClick={() => setActivated(false)}
            className="ml-2 text-ink-3 hover:text-ink"
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      )}
    </div>
  );
}

export function WorkflowRoute({ projectId }: { projectId: string }) {
  const viewer = useViewer();
  const project = projectById(projectId);
  if (!project || !viewer.canSee(projectId)) return <Refused />;
  if (!viewer.can(projectId, "edit_workflows") && !viewer.can(projectId, "manage_roles"))
    return (
      <Refused
        title="Not for your role"
        text="Workflows are edited by whoever may edit workflows in this project."
      />
    );
  return <WorkflowPage project={project} />;
}
