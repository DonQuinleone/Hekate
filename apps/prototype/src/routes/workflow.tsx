import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "~/components/icons";
import { Kbd, Label } from "~/components/label";
import { usePageHeader } from "~/components/page-header";
import { Button } from "~/components/ui/button";
import { Input, Select } from "~/components/ui/input";
import { ActionMenu, Dropdown } from "~/components/ui/menu";
import { Switch } from "~/components/ui/toggle";
import {
  type Connector,
  customRules,
  eventTypes,
  type Flow,
  type FlowNode,
  flowOrder,
  flowProblems,
  flowsFor,
  isLoop,
  NODE_H,
  NODE_W,
  type NodeType,
  outcomesOf,
  type Problem,
  type Project,
  personById,
  projectById,
  projectPacks,
  qaRules,
  rulePacks,
  toYaml,
  triggersOf,
  typeMeta,
  workflows,
} from "~/data";
import { cn } from "~/lib/cn";
import { inField } from "~/lib/dom";
import { useViewer } from "~/viewer/context";
import { Refused } from "~/viewer/state-gate";

/* ---------- Geometry ---------- */

const BAND_GAP = 180;
const PORT_STEP = 18;

interface Pt {
  x: number;
  y: number;
}

const portY = (n: FlowNode, i: number, k: number) =>
  n.y + NODE_H / 2 + (i - (k - 1) / 2) * PORT_STEP;

function outPort(n: FlowNode, outcome: string): Pt {
  const outs = outcomesOf(n);
  const i = Math.max(
    0,
    outs.findIndex((o) => o.id === outcome),
  );
  return { x: n.x + NODE_W, y: portY(n, i, outs.length) };
}

const inPort = (n: FlowNode): Pt => ({ x: n.x, y: n.y + NODE_H / 2 });

/** A forward connector curves; a loop goes right, drops below the flow, and comes back in from the left. */
function connectorPath(a: Pt, b: Pt, loop: boolean, floor: number): string {
  if (!loop && b.x >= a.x + 48) {
    const dx = Math.max(60, (b.x - a.x) / 2);
    return `M${a.x},${a.y} C${a.x + dx},${a.y} ${b.x - dx},${b.y} ${b.x},${b.y}`;
  }
  const r = 12;
  const x1 = a.x + 28;
  const x2 = b.x - 28;
  return [
    `M${a.x},${a.y}`,
    `H${x1 - r} Q${x1},${a.y} ${x1},${a.y + r}`,
    `V${floor - r} Q${x1},${floor} ${x1 - r},${floor}`,
    `H${x2 + r} Q${x2},${floor} ${x2},${floor - r}`,
    `V${b.y + r} Q${x2},${b.y} ${x2 + r},${b.y}`,
    `H${b.x}`,
  ].join(" ");
}

/** Where a connector's label sits: the middle of a curve, the bottom run of a loop. */
function labelAt(a: Pt, b: Pt, loop: boolean, floor: number): Pt {
  if (!loop && b.x >= a.x + 48) return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  return { x: (a.x + 28 + b.x - 28) / 2, y: floor };
}

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function boundsOf(nodes: { x: number; y: number }[]): Bounds {
  if (nodes.length === 0) return { minX: 0, minY: 0, maxX: NODE_W, maxY: NODE_H };
  return {
    minX: Math.min(...nodes.map((n) => n.x)),
    minY: Math.min(...nodes.map((n) => n.y)),
    maxX: Math.max(...nodes.map((n) => n.x)) + NODE_W,
    maxY: Math.max(...nodes.map((n) => n.y)) + NODE_H,
  };
}

/* ---------- Node families: a colour and a shape each, and an icon per kind (#512) ---------- */

type Family = "start" | "qa" | "review" | "task" | "wait" | "status" | "notify" | "finish";

/** The families in the order a workflow reads, left to right, each with its kinds in order. */
const familyOrder: Family[] = [
  "start",
  "qa",
  "review",
  "task",
  "wait",
  "status",
  "notify",
  "finish",
];

export const familyKinds: Record<Family, NodeType[]> = {
  start: ["upload", "manual", "recorded", "folder", "review"],
  qa: ["checks"],
  review: ["feedback", "approval"],
  task: ["task"],
  wait: [
    "wait",
    "decision",
    "submitted",
    "comment",
    "resolved",
    "task_done",
    "due",
    "opened",
    "download",
    "mention",
  ],
  status: ["status", "move"],
  notify: ["notify", "share"],
  finish: ["finish"],
};

export const familyOf = (t: NodeType): Family =>
  familyOrder.find((f) => familyKinds[f].includes(t)) ?? "wait";

const eventShape = "rounded-l-full rounded-r-panel pl-4";
const slanted = "rounded-panel [clip-path:polygon(10px_0,100%_0,calc(100%-10px)_100%,0_100%)] pl-5";

export const families: Record<
  Family,
  { label: string; hint: string; shape: string; tile: string; swatch: string }
> = {
  start: {
    label: "Start",
    hint: "What begins the workflow",
    shape: eventShape,
    tile: "bg-node-event/15 text-node-event",
    swatch: "rounded-l-full rounded-r-[3px] bg-node-event/70",
  },
  qa: {
    label: "QA",
    hint: "Check the version against the project's QA rules",
    shape: "rounded-control border-t-[3px] border-t-node-qa",
    tile: "bg-node-qa/15 text-node-qa",
    swatch: "rounded-[2px] border-t-[3px] border-t-node-qa bg-node-qa/30",
  },
  review: {
    label: "Review",
    hint: "Ask people to approve, or for their comments",
    shape: "rounded-panel-lg border-l-[3px] border-l-node-review",
    tile: "bg-node-review/15 text-node-review",
    swatch: "rounded-[3px] border-l-[3px] border-l-node-review bg-node-review/30",
  },
  task: {
    label: "Task",
    hint: "Someone does a piece of work",
    shape: "rounded-control",
    tile: "bg-node-work/15 text-node-work",
    swatch: "rounded-[2px] bg-node-work/60",
  },
  wait: {
    label: "Wait",
    hint: "Pause, or wait for something to happen",
    shape: slanted,
    tile: "bg-node-wait/15 text-node-wait",
    swatch: "rounded-l-full rounded-r-[3px] bg-node-wait/60",
  },
  status: {
    label: "Status",
    hint: "Change where the item stands, or where it is filed",
    shape: slanted,
    tile: "bg-node-flow/15 text-node-flow",
    swatch: "[clip-path:polygon(4px_0,100%_0,calc(100%-4px)_100%,0_100%)] bg-node-flow/60",
  },
  notify: {
    label: "Notify",
    hint: "Tell people, or send them a link",
    shape: "rounded-full pl-4",
    tile: "bg-node-comm/15 text-node-comm",
    swatch: "rounded-full bg-node-comm/60",
  },
  finish: {
    label: "Finish",
    hint: "End the workflow, with a final status",
    shape: "rounded-r-full rounded-l-panel pr-4",
    tile: "bg-ink text-ground",
    swatch: "rounded-r-full rounded-l-[3px] bg-ink/70",
  },
};

/** A node's shape: an event keeps the D of a start, whatever its family. */
const shapeOf = (t: NodeType) => (t in eventTypes ? eventShape : families[familyOf(t)].shape);

export function Legend({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={cn("flex flex-wrap gap-x-4 gap-y-1.5", compact ? "text-[11px]" : "text-[12px]")}
    >
      {familyOrder.map((f) => (
        <span key={f} className="flex items-center gap-1.5 text-ink-3" title={families[f].hint}>
          <span className={cn("inline-block h-2.5 w-4", families[f].swatch)} />
          {families[f].label}
        </span>
      ))}
    </div>
  );
}

/** A kind's icon in its family's colour, wherever kinds are shown or offered. */
function KindTile({ type, size = "md" }: { type: NodeType; size?: "sm" | "md" | "lg" }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-control",
        size === "lg" ? "size-8" : size === "md" ? "size-7" : "size-5 rounded-[4px]",
        families[familyOf(type)].tile,
      )}
    >
      <Icon
        name={typeMeta(type).icon as IconName}
        size={size === "lg" ? 16 : size === "md" ? 14 : 12}
      />
    </span>
  );
}

/** What a node is beside its name: its kind, and for a status, the status it sets. */
const kindLine = (n: FlowNode) =>
  (n.type === "status" || n.type === "finish") && n.config.status
    ? `${typeMeta(n.type).label}: ${n.config.status}`
    : typeMeta(n.type).label;

/* ---------- Pieces ---------- */

type Selection = { kind: "node"; id: string } | { kind: "connector"; id: string } | null;

interface Menu {
  x: number;
  y: number;
  target:
    | { kind: "canvas"; world: Pt; flowId: string }
    | { kind: "node"; id: string }
    | { kind: "connector"; id: string };
}

interface Linking {
  from: string;
  outcome: string;
  at: Pt;
}

interface Walk {
  flowId: string;
  at: string | null;
  nodes: string[];
  connectors: string[];
  log: string[];
}

function Node({
  node,
  selected,
  walked,
  current,
  trigger,
  problem,
  onPointerDown,
  onPortDown,
  onContextMenu,
}: {
  node: FlowNode;
  selected: boolean;
  walked: boolean;
  current: boolean;
  trigger: boolean;
  problem?: Problem;
  onPointerDown: (e: React.PointerEvent) => void;
  onPortDown: (outcome: string, e: React.PointerEvent) => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const outs = outcomesOf(node);
  const subtitle =
    node.kind === "event"
      ? trigger
        ? "Starts here"
        : "Waits for it"
      : [node.config.who ?? node.config.to, node.config.due ? `${node.config.due} d` : null]
          .filter(Boolean)
          .join(" · ") || kindLine(node);
  return (
    <div
      data-node={node.id}
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
      className={cn(
        "absolute flex cursor-grab touch-none items-center gap-3 border bg-overlay px-3 shadow-3 transition-[box-shadow,border-color] select-none",
        shapeOf(node.type),
        selected
          ? "border-signal shadow-[0_0_0_3px_var(--hk-signal-line),var(--hk-shadow-3)]"
          : walked
            ? "border-ink-3"
            : "border-line hover:border-line-strong",
        current && "ring-2 ring-signal/60",
      )}
      style={{ left: node.x, top: node.y, width: NODE_W, height: NODE_H }}
    >
      <KindTile type={node.type} size="lg" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-ink">{node.name}</span>
        <span className="block truncate text-[11px] text-ink-3">{subtitle}</span>
      </span>
      {problem && (
        <span
          title={problem.text}
          className={cn(
            "absolute -top-2 -right-2 flex size-5 items-center justify-center rounded-full border border-ground text-[11px]",
            problem.level === "error" ? "bg-signal text-ground" : "bg-raised text-ink-2",
          )}
        >
          !
        </span>
      )}
      {outs.map((o, i) => (
        <span
          key={o.id}
          className="absolute flex items-center"
          style={{ left: NODE_W - 7, top: portY(node, i, outs.length) - node.y - 7 }}
        >
          <button
            type="button"
            aria-label={`Connect from ${node.name}${o.label ? `: ${o.label}` : ""}`}
            onPointerDown={(e) => {
              e.stopPropagation();
              onPortDown(o.id, e);
            }}
            className="size-3.5 cursor-crosshair rounded-full border-2 border-ink-3 bg-overlay transition-colors hover:border-signal hover:bg-signal"
          />
          {o.label && (
            <span className="pointer-events-none ml-2 -translate-y-[10px] text-[11px] whitespace-nowrap text-ink-3">
              {o.label}
            </span>
          )}
        </span>
      ))}
      {node.kind === "action" && (
        <span
          className="absolute size-3.5 rounded-full border-2 border-ink-3 bg-overlay"
          style={{ left: -7, top: NODE_H / 2 - 7 }}
        />
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-[12px] text-ink-3">
      {label}
      {children}
    </label>
  );
}

function PanelHead({
  title,
  hint,
  onClose,
  children,
}: {
  title: string;
  hint?: string;
  onClose?: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-2 border-b border-line px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-medium text-ink">{title}</div>
        {hint && <div className="text-[12px] text-ink-3">{hint}</div>}
      </div>
      {children}
      {onClose && (
        <Button variant="quiet" size="iconSm" aria-label="Close" onClick={onClose}>
          <Icon name="close" size={14} />
        </Button>
      )}
    </div>
  );
}

/* ---------- The page ---------- */

type Mode = "basic" | "advanced" | "code";
type Panel = "picker" | "statuses" | "walk" | null;

export function WorkflowPage({ project }: { project: Project }) {
  const [flows, setFlows] = useState<Flow[]>(() => flowsFor(project.id));
  const [mode, setMode] = useState<Mode>("advanced");
  const [selection, setSelection] = useState<Selection>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [linking, setLinking] = useState<Linking | null>(null);
  const [walk, setWalk] = useState<Walk | null>(null);
  const [pan, setPan] = useState<Pt>({ x: 80, y: 80 });
  const [zoom, setZoom] = useState(0.85);
  const [toast, setToast] = useState<string | null>(null);
  const [addAt, setAddAt] = useState<{ flowId: string; world: Pt; from?: Selection } | null>(null);
  const [statuses, setStatuses] = useState(
    () => workflows.find((w) => w.projectId === project.id)?.statuses ?? [],
  );
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<
    | { kind: "pan"; start: Pt; origin: Pt }
    | { kind: "node"; id: string; flowId: string; start: Pt; origin: Pt; moved: boolean }
    | null
  >(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  usePageHeader({
    crumbs: [
      { label: project.name, to: `/projects/${project.id}` },
      { label: "Settings", to: `/projects/${project.id}/settings?section=workflow` },
    ],
    title: "Workflows",
    actions: (
      <div className="flex items-center gap-2">
        <div
          role="tablist"
          aria-label="View"
          className="flex h-8 items-center rounded-control border border-line bg-raised/40 p-0.5"
        >
          {(
            [
              ["basic", "Basic"],
              ["advanced", "Advanced"],
              ["code", "Code"],
            ] as [Mode, string][]
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                "h-7 rounded-[7px] px-2.5 text-[13px] transition-colors",
                mode === m ? "bg-raised text-ink shadow-1" : "text-ink-3 hover:text-ink",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <Button variant="secondary" size="sm" onClick={() => newFlow()}>
          <Icon name="plus" size={13} />
          <span className="hidden @3xl/app:inline">New workflow</span>
        </Button>
      </div>
    ),
    revision: mode,
  });

  /* Bands: every workflow of the project on one canvas, one above the other. */
  const bands = useMemo(() => {
    let y = 0;
    return flows.map((f) => {
      const b = boundsOf(f.nodes);
      const height = b.maxY - b.minY;
      const band = { flow: f, offsetY: y - b.minY, bounds: b, top: y, height };
      y += height + BAND_GAP;
      return band;
    });
  }, [flows]);
  const bandOf = (flowId: string) => bands.find((b) => b.flow.id === flowId);
  const world = (flowId: string, n: FlowNode): FlowNode => ({
    ...n,
    y: n.y + (bandOf(flowId)?.offsetY ?? 0),
  });
  const everything = useMemo(
    () =>
      bands.flatMap((b) =>
        b.flow.nodes.map((n) => ({ ...n, y: n.y + b.offsetY, flowId: b.flow.id })),
      ),
    [bands],
  );
  const worldBounds = useMemo(() => boundsOf(everything), [everything]);
  const problemsByFlow = useMemo(
    () => Object.fromEntries(flows.map((f) => [f.id, flowProblems(f)])),
    [flows],
  );
  const allProblems = Object.values(problemsByFlow).flat();

  /* Editing */
  const updateFlow = (flowId: string, fn: (f: Flow) => Flow) =>
    setFlows((list) => list.map((f) => (f.id === flowId ? fn(f) : f)));
  const flowOfNode = (nodeId: string) => flows.find((f) => f.nodes.some((n) => n.id === nodeId));
  const flowOfConnector = (id: string) => flows.find((f) => f.connectors.some((c) => c.id === id));
  const selectedNode =
    selection?.kind === "node"
      ? flows.flatMap((f) => f.nodes).find((n) => n.id === selection.id)
      : undefined;
  const selectedConnector =
    selection?.kind === "connector"
      ? flows.flatMap((f) => f.connectors).find((c) => c.id === selection.id)
      : undefined;

  const uid = () => Math.random().toString(36).slice(2, 7);

  const addNode = (flowId: string, type: NodeType, at: Pt, from?: Selection) => {
    const meta = typeMeta(type);
    // Never a second start (#514): an event with nothing before it, where the workflow has its
    // start, is refused and said.
    const target = flows.find((f) => f.id === flowId);
    if (meta.kind === "event" && from?.kind !== "node" && target && triggersOf(target).length) {
      setToast(
        familyOf(type) === "start"
          ? "This workflow has its start: switch it on there, or begin a new workflow."
          : "A wait follows a step: drop it on a step's output, or add it after one.",
      );
      return;
    }
    const band = bandOf(flowId);
    const id = `n-${uid()}`;
    const node: FlowNode = {
      id,
      kind: meta.kind,
      type,
      name: meta.label,
      x: Math.round(at.x / 10) * 10,
      y: Math.round((at.y - (band?.offsetY ?? 0)) / 10) * 10,
      config: {},
    };
    updateFlow(flowId, (f) => {
      const connectors = [...f.connectors];
      if (from?.kind === "node") {
        const source = f.nodes.find((n) => n.id === from.id);
        if (source) {
          const outs = outcomesOf(source);
          const free = outs.find(
            (o) => !connectors.some((c) => c.from === source.id && c.outcome === o.id),
          );
          const outcome = free ?? outs[0];
          if (outcome)
            connectors.push({ id: `c-${uid()}`, from: source.id, outcome: outcome.id, to: id });
        }
      }
      return { ...f, nodes: [...f.nodes, node], connectors };
    });
    setSelection({ kind: "node", id });
    setPanel(null);
    setAddAt(null);
  };

  const connect = (flowId: string, from: string, outcome: string, to: string) => {
    if (from === to) return;
    updateFlow(flowId, (f) =>
      f.connectors.some((c) => c.from === from && c.outcome === outcome && c.to === to)
        ? f
        : { ...f, connectors: [...f.connectors, { id: `c-${uid()}`, from, outcome, to }] },
    );
  };

  const removeNode = (id: string) => {
    const f = flowOfNode(id);
    if (!f) return;
    updateFlow(f.id, (x) => ({
      ...x,
      nodes: x.nodes.filter((n) => n.id !== id),
      connectors: x.connectors.filter((c) => c.from !== id && c.to !== id),
    }));
    setSelection(null);
  };

  const removeConnector = (id: string) => {
    const f = flowOfConnector(id);
    if (!f) return;
    updateFlow(f.id, (x) => ({ ...x, connectors: x.connectors.filter((c) => c.id !== id) }));
    setSelection(null);
  };

  const duplicateNode = (id: string) => {
    const f = flowOfNode(id);
    const n = f?.nodes.find((x) => x.id === id);
    if (!f || !n) return;
    const copy = { ...n, id: `n-${uid()}`, name: `${n.name} (copy)`, x: n.x + 40, y: n.y + 80 };
    updateFlow(f.id, (x) => ({ ...x, nodes: [...x.nodes, copy] }));
    setSelection({ kind: "node", id: copy.id });
  };

  /** A new workflow (#514), begun at the start chosen for it, placed and selected. */
  const newFlow = (start: NodeType = "upload") => {
    const id = `wf-${uid()}`;
    const kind = typeMeta(start).kind === "event" ? start : "upload";
    const flow: Flow = {
      id,
      projectId: project.id,
      name: "New workflow",
      active: false,
      groups: [],
      nodes: [
        {
          id: `${id}-start`,
          kind: "event",
          type: kind,
          name: typeMeta(kind).label,
          x: 0,
          y: 0,
          config: {},
        },
        {
          id: `${id}-end`,
          kind: "action",
          type: "finish",
          name: "Finish",
          x: 640,
          y: 0,
          config: {},
        },
      ],
      connectors: [],
    };
    setFlows((list) => [...list, flow]);
    setSelection({ kind: "node", id: `${id}-start` });
    setPanel(null);
    setAddAt(null);
    setToast("New workflow added below; wire its start to what should happen.");
    requestAnimationFrame(() => jumpTo(id));
  };

  /* The view */
  const toWorld = useCallback(
    (client: Pt): Pt => {
      const rect = canvas.current?.getBoundingClientRect();
      if (!rect) return client;
      return { x: (client.x - rect.left - pan.x) / zoom, y: (client.y - rect.top - pan.y) / zoom };
    },
    [pan, zoom],
  );

  const fitTo = (b: Bounds, maxZoom = 1) => {
    const rect = canvas.current?.getBoundingClientRect();
    if (!rect) return;
    const pad = 72;
    const z = Math.min(
      maxZoom,
      (rect.width - pad * 2) / (b.maxX - b.minX + 240),
      (rect.height - pad * 2) / (b.maxY - b.minY + 120),
    );
    const zz = Math.max(0.3, z);
    setZoom(zz);
    setPan({
      x: (rect.width - (b.maxX - b.minX + 240) * zz) / 2 - (b.minX - 120) * zz,
      y: (rect.height - (b.maxY - b.minY + 120) * zz) / 2 - (b.minY - 60) * zz,
    });
  };
  const fitAll = () => fitTo(worldBounds, 1);
  /** Lands on a workflow at a readable size, its start at the left; the rest is a pan away. */
  const jumpTo = (flowId: string) => {
    const b = bandOf(flowId);
    const rect = canvas.current?.getBoundingClientRect();
    if (!b || !rect) return;
    const z = 0.8;
    const height = (b.bounds.maxY - b.bounds.minY + 120) * z;
    setZoom(z);
    setPan({
      x: 56 - b.bounds.minX * z,
      y: Math.max(72, (rect.height - height) / 2 + 48) - (b.bounds.minY + b.offsetY) * z,
    });
  };
  const zoomBy = (factor: number, around?: Pt) => {
    const rect = canvas.current?.getBoundingClientRect();
    const centre = around ?? (rect ? { x: rect.width / 2, y: rect.height / 2 } : { x: 0, y: 0 });
    const next = Math.min(2, Math.max(0.25, zoom * factor));
    const wx = (centre.x - pan.x) / zoom;
    const wy = (centre.y - pan.y) / zoom;
    setZoom(next);
    setPan({ x: centre.x - wx * next, y: centre.y - wy * next });
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: the first fit happens once the canvas has a size.
  useEffect(() => {
    if (mode === "advanced") requestAnimationFrame(() => jumpTo(flows[0]?.id ?? ""));
  }, [mode]);

  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      const rect = canvas.current?.getBoundingClientRect();
      if (!rect) return;
      zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, { x: e.clientX - rect.left, y: e.clientY - rect.top });
    } else {
      setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
    }
  };

  const onCanvasPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    setMenu(null);
    drag.current = { kind: "pan", start: { x: e.clientX, y: e.clientY }, origin: pan };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onNodePointerDown = (flowId: string, id: string, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setMenu(null);
    const n = flows.find((f) => f.id === flowId)?.nodes.find((x) => x.id === id);
    if (!n) return;
    drag.current = {
      kind: "node",
      id,
      flowId,
      start: { x: e.clientX, y: e.clientY },
      origin: { x: n.x, y: n.y },
      moved: false,
    };
    canvas.current?.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (linking) {
      setLinking({ ...linking, at: toWorld({ x: e.clientX, y: e.clientY }) });
      return;
    }
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.start.x;
    const dy = e.clientY - d.start.y;
    if (d.kind === "pan") setPan({ x: d.origin.x + dx, y: d.origin.y + dy });
    else {
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      updateFlow(d.flowId, (f) => ({
        ...f,
        nodes: f.nodes.map((n) =>
          n.id === d.id ? { ...n, x: d.origin.x + dx / zoom, y: d.origin.y + dy / zoom } : n,
        ),
      }));
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (linking) {
      const el = (e.target as HTMLElement).closest?.("[data-node]") as HTMLElement | null;
      const to = el?.dataset.node;
      const f = flowOfNode(linking.from);
      if (to && f?.nodes.some((n) => n.id === to)) connect(f.id, linking.from, linking.outcome, to);
      else if (f) {
        setAddAt({ flowId: f.id, world: linking.at, from: { kind: "node", id: linking.from } });
        setPanel("picker");
      }
      setLinking(null);
      return;
    }
    const d = drag.current;
    drag.current = null;
    if (d?.kind === "node") {
      if (!d.moved) {
        setSelection({ kind: "node", id: d.id });
        setPanel(null);
      } else
        updateFlow(d.flowId, (f) => ({
          ...f,
          nodes: f.nodes.map((n) =>
            n.id === d.id
              ? { ...n, x: Math.round(n.x / 10) * 10, y: Math.round(n.y / 10) * 10 }
              : n,
          ),
        }));
    } else if (d?.kind === "pan") {
      const moved = Math.abs(e.clientX - d.start.x) + Math.abs(e.clientY - d.start.y) > 3;
      if (!moved) setSelection(null);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (inField(e)) return;
      if (e.key === "Escape") {
        setMenu(null);
        setLinking(null);
        setPanel(null);
        setSelection(null);
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selection) {
        e.preventDefault();
        if (selection.kind === "node") removeNode(selection.id);
        else removeConnector(selection.id);
      }
      if (e.key === "f") fitAll();
      if (e.key === "+" || e.key === "=") zoomBy(1.15);
      if (e.key === "-") zoomBy(1 / 1.15);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  /* The walk-through */
  const startWalk = (flowId: string) => {
    const f = flows.find((x) => x.id === flowId);
    const t = f ? triggersOf(f)[0] : undefined;
    if (!f || !t) return;
    setWalk({ flowId, at: t.id, nodes: [t.id], connectors: [], log: [`${t.name}.`] });
    setPanel("walk");
    setSelection(null);
  };
  const advance = (outcome: string) => {
    if (!walk?.at) return;
    const f = flows.find((x) => x.id === walk.flowId);
    const c = f?.connectors.find((x) => x.from === walk.at && x.outcome === outcome);
    const nextNode = c ? f?.nodes.find((n) => n.id === c.to) : undefined;
    const from = f?.nodes.find((n) => n.id === walk.at);
    const o = from ? outcomesOf(from).find((x) => x.id === outcome) : undefined;
    if (!c || !nextNode) {
      setWalk({
        ...walk,
        at: null,
        log: [...walk.log, `${o?.label || "Then"}: nothing follows, the item stops here.`],
      });
      return;
    }
    setWalk({
      ...walk,
      at: nextNode.id,
      nodes: [...walk.nodes, nextNode.id],
      connectors: [...walk.connectors, c.id],
      log: [
        ...walk.log,
        `${o?.label ? `${o.label[0]?.toUpperCase()}${o.label.slice(1)}` : "Then"}: ${nextNode.name}${nextNode.config.status ? ` (status ${nextNode.config.status})` : ""}.`,
      ],
    });
  };

  /* Right-click menus */
  const menuItems = (
    m: Menu,
  ): ({ label: string; danger?: boolean; onSelect: () => void } | "divider")[] => {
    if (m.target.kind === "canvas") {
      const t = m.target;
      return [
        {
          label: "Add a node here",
          onSelect: () => {
            setAddAt({ flowId: t.flowId, world: t.world });
            setPanel("picker");
          },
        },
        { label: "Fit to window", onSelect: fitAll },
        { label: "Zoom to 100%", onSelect: () => setZoom(1) },
        "divider",
        { label: "Walk an item through", onSelect: () => startWalk(t.flowId) },
        { label: "New workflow", onSelect: () => newFlow() },
      ];
    }
    if (m.target.kind === "node") {
      const id = m.target.id;
      const f = flowOfNode(id);
      const n = f?.nodes.find((x) => x.id === id);
      return [
        {
          label: "Edit",
          onSelect: () => {
            setSelection({ kind: "node", id });
            setPanel(null);
          },
        },
        {
          label: "Add what follows",
          onSelect: () => {
            if (!f || !n) return;
            setAddAt({
              flowId: f.id,
              world: { x: n.x + NODE_W + 92, y: n.y + (bandOf(f.id)?.offsetY ?? 0) },
              from: { kind: "node", id },
            });
            setPanel("picker");
          },
        },
        { label: "Duplicate", onSelect: () => duplicateNode(id) },
        "divider",
        { label: "Delete", danger: true, onSelect: () => removeNode(id) },
      ];
    }
    const id = m.target.id;
    return [
      {
        label: "Edit the connector",
        onSelect: () => {
          setSelection({ kind: "connector", id });
          setPanel(null);
        },
      },
      {
        label: "Add a condition",
        onSelect: () => {
          setSelection({ kind: "connector", id });
          setPanel(null);
        },
      },
      "divider",
      { label: "Remove", danger: true, onSelect: () => removeConnector(id) },
    ];
  };

  /* ---------- Render ---------- */

  const inspectorOpen = panel !== null || selection !== null;

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {mode === "basic" && (
        <BasicView
          flows={flows}
          problems={problemsByFlow}
          onChange={updateFlow}
          onAdvanced={(id) => {
            setMode("advanced");
            requestAnimationFrame(() => jumpTo(id));
          }}
          onNew={() => newFlow()}
        />
      )}
      {mode === "code" && <CodeView flows={flows} onToast={setToast} />}
      {mode === "advanced" && (
        <div className="flex min-h-0 flex-1">
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            {/* Toolbar */}
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2 @3xl/app:px-4">
              <div className="scroll-quiet flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
                {flows.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => jumpTo(f.id)}
                    className="flex h-7 shrink-0 items-center gap-1.5 rounded-control border border-line px-2.5 text-[13px] text-ink-2 transition-colors hover:border-edge hover:text-ink"
                  >
                    <span
                      className={cn("size-1.5 rounded-full", f.active ? "bg-ok" : "bg-ink-3")}
                    />
                    {f.name}
                    {problemsByFlow[f.id]?.some((p) => p.level === "error") && (
                      <span className="text-signal">!</span>
                    )}
                  </button>
                ))}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant={panel === "statuses" ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setPanel(panel === "statuses" ? null : "statuses")}
                >
                  Statuses
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    startWalk(
                      selectedNode
                        ? (flowOfNode(selectedNode.id)?.id ?? flows[0]?.id ?? "")
                        : (flows[0]?.id ?? ""),
                    )
                  }
                >
                  <Icon name="play" size={13} />
                  <span className="hidden @3xl/app:inline">Walk through</span>
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    const target = selectedNode ? flowOfNode(selectedNode.id) : flows[0];
                    if (!target) return;
                    const at = selectedNode
                      ? {
                          x: selectedNode.x + NODE_W + 92,
                          y: selectedNode.y + (bandOf(target.id)?.offsetY ?? 0),
                        }
                      : toWorld({
                          x:
                            (canvas.current?.getBoundingClientRect().left ?? 0) +
                            (canvas.current?.clientWidth ?? 0) / 2,
                          y:
                            (canvas.current?.getBoundingClientRect().top ?? 0) +
                            (canvas.current?.clientHeight ?? 0) / 2,
                        });
                    setAddAt({
                      flowId: target.id,
                      world: at,
                      from: selectedNode ? { kind: "node", id: selectedNode.id } : undefined,
                    });
                    setPanel("picker");
                  }}
                >
                  <Icon name="plus" size={13} />
                  Node
                </Button>
              </div>
            </div>

            {/* Canvas */}
            <div
              ref={canvas}
              onPointerDown={onCanvasPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onWheel={onWheel}
              onContextMenu={(e) => {
                e.preventDefault();
                const rect = canvas.current?.getBoundingClientRect();
                const w = toWorld({ x: e.clientX, y: e.clientY });
                const band =
                  bands.find((b) => w.y >= b.top - 80 && w.y <= b.top + b.height + 80) ?? bands[0];
                if (!band) return;
                setMenu({
                  x: e.clientX - (rect?.left ?? 0),
                  y: e.clientY - (rect?.top ?? 0),
                  target: { kind: "canvas", world: w, flowId: band.flow.id },
                });
              }}
              className={cn(
                "relative min-h-0 flex-1 touch-none overflow-hidden bg-canvas/40",
                drag.current?.kind === "pan" ? "cursor-grabbing" : "cursor-grab",
              )}
              style={{
                backgroundImage: "radial-gradient(var(--hk-line-strong) 1px, transparent 1px)",
                backgroundSize: `${22 * zoom}px ${22 * zoom}px`,
                backgroundPosition: `${pan.x}px ${pan.y}px`,
              }}
            >
              <div
                className="absolute top-0 left-0"
                style={{
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  transformOrigin: "0 0",
                }}
              >
                {/* Band frames and headings */}
                {bands.map((b) => (
                  <div key={b.flow.id}>
                    <div
                      className="pointer-events-none absolute flex w-max items-end gap-2 whitespace-nowrap"
                      style={{ left: b.bounds.minX, top: b.top - 48 }}
                    >
                      <span className="text-[18px] font-medium tracking-tight text-ink">
                        {b.flow.name}
                      </span>
                      <span
                        className={cn("mb-1 text-[12px]", b.flow.active ? "text-ok" : "text-ink-3")}
                      >
                        {b.flow.active ? "active" : "draft"}
                      </span>
                      {problemsByFlow[b.flow.id]?.length ? (
                        <span className="mb-1 text-[12px] text-ink-3">
                          · {problemsByFlow[b.flow.id]?.length} to look at
                        </span>
                      ) : null}
                    </div>
                    {b.flow.groups.map((g) => {
                      const members = b.flow.nodes.filter((n) => n.groupId === g.id);
                      if (members.length === 0) return null;
                      const gb = boundsOf(members);
                      return (
                        <div
                          key={g.id}
                          className="pointer-events-none absolute rounded-panel-lg border border-dashed border-line"
                          style={{
                            left: gb.minX - 20,
                            top: gb.minY + b.offsetY - 34,
                            width: gb.maxX - gb.minX + 40 + 120,
                            height: gb.maxY - gb.minY + 54,
                          }}
                        >
                          <span className="absolute top-2 left-3 text-[11px] tracking-wide text-ink-3 uppercase">
                            {g.name}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                ))}

                {/* Connectors */}
                <svg
                  aria-hidden="true"
                  className="pointer-events-none absolute top-0 left-0 overflow-visible"
                  width={1}
                  height={1}
                >
                  {bands.map((b) => {
                    const floorBase = b.bounds.maxY + b.offsetY + 36;
                    let lane = 0;
                    return b.flow.connectors.map((c) => {
                      const from = b.flow.nodes.find((n) => n.id === c.from);
                      const to = b.flow.nodes.find((n) => n.id === c.to);
                      if (!from || !to) return null;
                      const loop = isLoop(b.flow, c);
                      const a = outPort(world(b.flow.id, from), c.outcome);
                      const z = inPort(world(b.flow.id, to));
                      const floor = floorBase + (loop ? lane++ * 18 : 0);
                      const d = connectorPath(a, z, loop, floor);
                      const selected = selection?.kind === "connector" && selection.id === c.id;
                      const walked = walk?.connectors.includes(c.id);
                      const label = c.condition || c.until;
                      const lp = labelAt(a, z, loop, floor);
                      return (
                        <g key={c.id}>
                          <path
                            d={d}
                            fill="none"
                            strokeWidth={14}
                            stroke="transparent"
                            className="pointer-events-auto cursor-pointer"
                            onPointerDown={(e) => {
                              e.stopPropagation();
                              setSelection({ kind: "connector", id: c.id });
                              setPanel(null);
                            }}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              const rect = canvas.current?.getBoundingClientRect();
                              setMenu({
                                x: e.clientX - (rect?.left ?? 0),
                                y: e.clientY - (rect?.top ?? 0),
                                target: { kind: "connector", id: c.id },
                              });
                            }}
                          />
                          <path
                            d={d}
                            fill="none"
                            strokeWidth={selected || walked ? 2.5 : 1.5}
                            className={cn(
                              "transition-[stroke]",
                              selected
                                ? "stroke-signal"
                                : walked
                                  ? "stroke-ink"
                                  : loop
                                    ? "stroke-ink-3/70"
                                    : "stroke-ink-3",
                            )}
                            strokeDasharray={c.condition ? "6 4" : undefined}
                          />
                          <circle
                            cx={z.x}
                            cy={z.y}
                            r={3}
                            className={selected ? "fill-signal" : "fill-ink-3"}
                          />
                          {label && (
                            <foreignObject x={lp.x - 90} y={lp.y - 11} width={180} height={22}>
                              <div className="flex justify-center">
                                <span className="max-w-full truncate rounded-chip border border-line bg-overlay px-1.5 text-[11px] leading-5 text-ink-2">
                                  {label}
                                </span>
                              </div>
                            </foreignObject>
                          )}
                        </g>
                      );
                    });
                  })}
                  {linking &&
                    (() => {
                      const f = flowOfNode(linking.from);
                      const from = f?.nodes.find((n) => n.id === linking.from);
                      if (!f || !from) return null;
                      const a = outPort(world(f.id, from), linking.outcome);
                      return (
                        <path
                          d={connectorPath(a, linking.at, false, 0)}
                          fill="none"
                          strokeWidth={1.5}
                          strokeDasharray="4 4"
                          className="stroke-signal"
                        />
                      );
                    })()}
                </svg>

                {/* Nodes */}
                {bands.map((b) =>
                  b.flow.nodes.map((n) => (
                    <Node
                      key={n.id}
                      node={world(b.flow.id, n)}
                      selected={selection?.kind === "node" && selection.id === n.id}
                      walked={Boolean(walk?.nodes.includes(n.id))}
                      current={walk?.at === n.id}
                      trigger={n.kind === "event" && !b.flow.connectors.some((c) => c.to === n.id)}
                      problem={problemsByFlow[b.flow.id]?.find((p) => p.nodeId === n.id)}
                      onPointerDown={(e) => onNodePointerDown(b.flow.id, n.id, e)}
                      onPortDown={(outcome, e) => {
                        setLinking({
                          from: n.id,
                          outcome,
                          at: toWorld({ x: e.clientX, y: e.clientY }),
                        });
                        canvas.current?.setPointerCapture(e.pointerId);
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const rect = canvas.current?.getBoundingClientRect();
                        setMenu({
                          x: e.clientX - (rect?.left ?? 0),
                          y: e.clientY - (rect?.top ?? 0),
                          target: { kind: "node", id: n.id },
                        });
                      }}
                    />
                  )),
                )}
              </div>

              {/* Zoom controls */}
              <div className="absolute bottom-3 left-3 flex items-center gap-0.5 rounded-control border border-line bg-overlay p-0.5 shadow-2">
                <Button
                  variant="quiet"
                  size="iconSm"
                  aria-label="Zoom out"
                  onClick={() => zoomBy(1 / 1.15)}
                >
                  <Icon name="zoomOut" size={14} />
                </Button>
                <button
                  type="button"
                  onClick={() => setZoom(1)}
                  className="tabular h-7 min-w-11 px-1 text-[12px] text-ink-2 hover:text-ink"
                >
                  {Math.round(zoom * 100)}%
                </button>
                <Button
                  variant="quiet"
                  size="iconSm"
                  aria-label="Zoom in"
                  onClick={() => zoomBy(1.15)}
                >
                  <Icon name="zoomIn" size={14} />
                </Button>
                <span className="mx-0.5 h-4 w-px bg-line" />
                <Button variant="quiet" size="sm" onClick={fitAll} title="Fit (f)">
                  Fit
                </Button>
                <span className="mx-0.5 h-4 w-px bg-line" />
                <Button
                  variant="quiet"
                  size="sm"
                  title="Tidy up (Shift T)"
                  onClick={() =>
                    setToast(
                      "Tidied: every step in columns by the order a run reaches it, the main line straight, branches below, loops underneath, nothing overlapping. Undo puts it back.",
                    )
                  }
                >
                  Tidy up
                </Button>
              </div>
              <div className="pointer-events-none absolute top-3 left-3 hidden rounded-control border border-line bg-overlay/90 px-2.5 py-1.5 @3xl/app:block">
                <Legend compact />
              </div>
              <div className="pointer-events-none absolute bottom-3 left-1/2 hidden -translate-x-1/2 items-center gap-3 text-[11px] text-ink-3 @3xl/app:flex">
                <span>Drag to pan</span>
                <span className="flex items-center gap-1">
                  <Kbd>ctrl</Kbd> scroll to zoom
                </span>
                <span>Right-click for more</span>
                <span>Drag a port to connect</span>
              </div>

              {/* Minimap */}
              <Minimap
                bounds={worldBounds}
                nodes={everything}
                pan={pan}
                zoom={zoom}
                size={
                  canvas.current
                    ? { w: canvas.current.clientWidth, h: canvas.current.clientHeight }
                    : null
                }
                onJump={(p) => setPan(p)}
              />

              {/* Context menu */}
              {menu && (
                <div
                  role="menu"
                  className="rise-in absolute z-30 flex min-w-48 flex-col rounded-panel bg-overlay p-1 shadow-4"
                  style={{
                    left: Math.min(menu.x, (canvas.current?.clientWidth ?? 400) - 200),
                    top: Math.min(menu.y, (canvas.current?.clientHeight ?? 400) - 220),
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  {menuItems(menu).map((item, i) =>
                    item === "divider" ? (
                      <div key={`d${i}`} className="mx-2 my-1 h-px bg-line" />
                    ) : (
                      <button
                        key={item.label}
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMenu(null);
                          item.onSelect();
                        }}
                        className={cn(
                          "flex h-8 items-center rounded-control px-2.5 text-left text-[13px] transition-colors hover:bg-raised",
                          item.danger ? "text-signal" : "text-ink",
                        )}
                      >
                        {item.label}
                      </button>
                    ),
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Inspector */}
          {inspectorOpen && (
            <aside className="absolute inset-y-0 right-0 z-20 flex w-full flex-col border-l border-line bg-pane shadow-4 @3xl/app:static @3xl/app:w-[340px] @3xl/app:shadow-none">
              {panel === "picker" && (
                <Picker
                  hasStart={(() => {
                    const f = flows.find((x) => x.id === (addAt?.flowId ?? flows[0]?.id));
                    return f ? triggersOf(f).length > 0 : false;
                  })()}
                  from={addAt?.from?.id}
                  onNew={newFlow}
                  onPick={(type) => {
                    const target = addAt ?? { flowId: flows[0]?.id ?? "", world: { x: 0, y: 0 } };
                    addNode(target.flowId, type, target.world, target.from);
                  }}
                  onClose={() => {
                    setPanel(null);
                    setAddAt(null);
                  }}
                />
              )}
              {panel === "statuses" && (
                <StatusesPanel
                  statuses={statuses}
                  onChange={setStatuses}
                  onClose={() => setPanel(null)}
                />
              )}
              {panel === "walk" && walk && (
                <WalkPanel
                  walk={walk}
                  flow={flows.find((f) => f.id === walk.flowId)}
                  onAdvance={advance}
                  onRestart={() => startWalk(walk.flowId)}
                  onClose={() => {
                    setWalk(null);
                    setPanel(null);
                  }}
                />
              )}
              {panel === null && selectedNode && (
                <NodeInspector
                  project={project}
                  node={selectedNode}
                  flow={flowOfNode(selectedNode.id)}
                  statuses={statuses.map((s) => s.name)}
                  problems={allProblems.filter((p) => p.nodeId === selectedNode.id)}
                  onChange={(patch) => {
                    const f = flowOfNode(selectedNode.id);
                    if (f)
                      updateFlow(f.id, (x) => ({
                        ...x,
                        nodes: x.nodes.map((n) =>
                          n.id === selectedNode.id ? { ...n, ...patch } : n,
                        ),
                      }));
                  }}
                  onAddAfter={(outcome) => {
                    const f = flowOfNode(selectedNode.id);
                    if (!f) return;
                    setAddAt({
                      flowId: f.id,
                      world: {
                        x: selectedNode.x + NODE_W + 92,
                        y:
                          selectedNode.y +
                          (bandOf(f.id)?.offsetY ?? 0) +
                          (outcomesOf(selectedNode).findIndex((o) => o.id === outcome) - 1) * 100,
                      },
                      from: { kind: "node", id: selectedNode.id },
                    });
                    setPanel("picker");
                  }}
                  onConnect={(outcome, to) => {
                    const f = flowOfNode(selectedNode.id);
                    if (f) connect(f.id, selectedNode.id, outcome, to);
                  }}
                  onSelectConnector={(id) => setSelection({ kind: "connector", id })}
                  onDelete={() => removeNode(selectedNode.id)}
                  onClose={() => setSelection(null)}
                />
              )}
              {panel === null && selectedConnector && (
                <ConnectorInspector
                  connector={selectedConnector}
                  flow={flowOfConnector(selectedConnector.id)}
                  onChange={(patch) => {
                    const f = flowOfConnector(selectedConnector.id);
                    if (f)
                      updateFlow(f.id, (x) => ({
                        ...x,
                        connectors: x.connectors.map((c) =>
                          c.id === selectedConnector.id ? { ...c, ...patch } : c,
                        ),
                      }));
                  }}
                  onDelete={() => removeConnector(selectedConnector.id)}
                  onClose={() => setSelection(null)}
                />
              )}
            </aside>
          )}
        </div>
      )}

      {toast && (
        <div className="rise-in pointer-events-none absolute bottom-5 left-1/2 z-40 -translate-x-1/2 rounded-panel bg-overlay px-4 py-2 text-[13px] text-ink shadow-4">
          {toast}
        </div>
      )}
      {!inspectorOpen && mode === "advanced" && allProblems.length > 0 && (
        <button
          type="button"
          onClick={() => {
            const p = allProblems[0];
            if (p?.nodeId) setSelection({ kind: "node", id: p.nodeId });
            else if (p?.connectorId) setSelection({ kind: "connector", id: p.connectorId });
          }}
          className="absolute top-14 right-3 z-10 flex items-center gap-2 rounded-panel border border-line bg-overlay px-3 py-1.5 text-[12px] text-ink-2 shadow-3 transition-colors hover:text-ink"
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              allProblems.some((p) => p.level === "error") ? "bg-signal" : "bg-ink-3",
            )}
          />
          {allProblems.length} {allProblems.length === 1 ? "thing" : "things"} to look at
        </button>
      )}
    </div>
  );
}

/* ---------- Minimap ---------- */

function Minimap({
  bounds,
  nodes,
  pan,
  zoom,
  size,
  onJump,
}: {
  bounds: Bounds;
  nodes: { x: number; y: number; kind: "event" | "action" }[];
  pan: Pt;
  zoom: number;
  size: { w: number; h: number } | null;
  onJump: (p: Pt) => void;
}) {
  const W = 160;
  const H = 96;
  const bw = bounds.maxX - bounds.minX + 200;
  const bh = bounds.maxY - bounds.minY + 200;
  const s = Math.min(W / bw, H / bh);
  const ox = (W - bw * s) / 2 - (bounds.minX - 100) * s;
  const oy = (H - bh * s) / 2 - (bounds.minY - 100) * s;
  const view = size
    ? {
        x: (-pan.x / zoom) * s + ox,
        y: (-pan.y / zoom) * s + oy,
        w: (size.w / zoom) * s,
        h: (size.h / zoom) * s,
      }
    : null;
  return (
    <svg
      role="img"
      aria-label="Map of the canvas"
      width={W}
      height={H}
      className="absolute right-3 bottom-3 hidden rounded-panel border border-line bg-overlay/90 shadow-2 @3xl/app:block"
      onPointerDown={(e) => {
        e.stopPropagation();
        if (!size) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const wx = (e.clientX - rect.left - ox) / s;
        const wy = (e.clientY - rect.top - oy) / s;
        onJump({ x: size.w / 2 - wx * zoom, y: size.h / 2 - wy * zoom });
      }}
    >
      {nodes.map((n, i) => (
        <rect
          key={i}
          x={n.x * s + ox}
          y={n.y * s + oy}
          width={NODE_W * s}
          height={NODE_H * s}
          rx={2}
          className={n.kind === "event" ? "fill-signal/70" : "fill-ink-3/70"}
        />
      ))}
      {view && (
        <rect
          x={view.x}
          y={view.y}
          width={view.w}
          height={view.h}
          className="fill-ink/5 stroke-ink/40"
          strokeWidth={1}
        />
      )}
    </svg>
  );
}

/* ---------- Panels ---------- */

function Picker({
  hasStart,
  from,
  onPick,
  onNew,
  onClose,
}: {
  /** Whether the workflow has its start: a start kind then begins a new workflow (#514). */
  hasStart: boolean;
  from?: string;
  onPick: (t: NodeType) => void;
  onNew: (start: NodeType) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const hit = (s: string) => s.toLowerCase().includes(q.trim().toLowerCase());
  return (
    <>
      <PanelHead
        title="What happens next?"
        hint={from ? "Pick a node; it is wired from the selected one." : "Pick a node to add."}
        onClose={onClose}
      />
      <div className="flex flex-col gap-3 px-3 pt-3">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search nodes"
          autoFocus
        />
        <Legend compact />
      </div>
      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto p-2">
        {familyOrder.map((g) => {
          const items = familyKinds[g].filter(
            (t) => hit(typeMeta(t).label) || hit(typeMeta(t).hint),
          );
          if (items.length === 0) return null;
          const begins = g === "start" && hasStart;
          return (
            <div key={g} className="mb-2">
              <Label className="block px-2 pt-2 pb-1">
                {begins ? "New workflow" : families[g].label}
              </Label>
              {begins && (
                <div className="px-2 pb-1 text-[12px] text-ink-3">
                  This workflow has its start; one of these begins another.
                </div>
              )}
              {items.map((t) => {
                const waits = !from && hasStart && g === "wait" && t in eventTypes;
                return (
                  <button
                    key={t}
                    type="button"
                    disabled={waits}
                    title={waits ? "Follows a step: select one first" : undefined}
                    onClick={() => (begins ? onNew(t) : onPick(t))}
                    className="flex w-full items-center gap-3 rounded-control px-2 py-1.5 text-left transition-colors enabled:hover:bg-raised disabled:opacity-50"
                  >
                    <KindTile type={t} />
                    <span className="min-w-0">
                      <span className="block truncate text-[13px] text-ink">
                        {typeMeta(t).label}
                      </span>
                      <span className="block truncate text-[12px] text-ink-3">
                        {typeMeta(t).hint}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </>
  );
}

function StatusesPanel({
  statuses,
  onChange,
  onClose,
}: {
  statuses: { name: string; category: "todo" | "in_progress" | "done" }[];
  onChange: (s: { name: string; category: "todo" | "in_progress" | "done" }[]) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  return (
    <>
      <PanelHead
        title="Statuses"
        hint="What the board's columns are; a node sets one."
        onClose={onClose}
      />
      <div className="scroll-quiet flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-3">
        {statuses.map((s, i) => (
          <div
            key={s.name}
            className="flex items-center gap-2 rounded-control px-2 py-1.5 hover:bg-raised/60"
          >
            <span
              className={cn(
                "size-2 rounded-full",
                s.category === "done"
                  ? "bg-ok"
                  : s.category === "in_progress"
                    ? "bg-signal"
                    : "bg-ink-3",
              )}
            />
            <span className="flex-1 text-[13px] text-ink">{s.name}</span>
            <Select
              value={s.category}
              aria-label={`Category of ${s.name}`}
              className="h-7 w-28 text-[12px]"
              onChange={(e) =>
                onChange(
                  statuses.map((x, j) =>
                    j === i ? { ...x, category: e.target.value as typeof x.category } : x,
                  ),
                )
              }
            >
              <option value="todo">To do</option>
              <option value="in_progress">In progress</option>
              <option value="done">Done</option>
            </Select>
            <Button
              variant="quiet"
              size="iconSm"
              aria-label={`Remove ${s.name}`}
              onClick={() => onChange(statuses.filter((_, j) => j !== i))}
            >
              <Icon name="close" size={12} />
            </Button>
          </div>
        ))}
        <form
          className="mt-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            onChange([...statuses, { name: name.trim(), category: "in_progress" }]);
            setName("");
          }}
        >
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New status"
            className="flex-1"
          />
          <Button type="submit" variant="secondary">
            Add
          </Button>
        </form>
      </div>
    </>
  );
}

function WalkPanel({
  walk,
  flow,
  onAdvance,
  onRestart,
  onClose,
}: {
  walk: Walk;
  flow?: Flow;
  onAdvance: (outcome: string) => void;
  onRestart: () => void;
  onClose: () => void;
}) {
  const at = flow?.nodes.find((n) => n.id === walk.at);
  const outs = at ? outcomesOf(at) : [];
  return (
    <>
      <PanelHead title="Walk an item through" hint={flow?.name} onClose={onClose} />
      <div className="scroll-quiet flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <ol className="flex flex-col gap-1.5 text-[13px] text-ink-2">
          {walk.log.map((l, i) => (
            <li key={i} className="flex gap-2">
              <span className="tabular w-4 shrink-0 text-ink-3">{i + 1}</span>
              <span className={i === walk.log.length - 1 ? "text-ink" : undefined}>{l}</span>
            </li>
          ))}
        </ol>
        {at ? (
          outs.length === 0 ? (
            <p className="text-[13px] text-ink-3">The item is finished here.</p>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label>What happens at “{at.name}”?</Label>
              {outs.map((o) => (
                <Button key={o.id} variant="secondary" onClick={() => onAdvance(o.id)}>
                  {o.label
                    ? o.label[0]?.toUpperCase() + o.label.slice(1)
                    : at.kind === "event"
                      ? "It happens"
                      : "It is done"}
                </Button>
              ))}
            </div>
          )
        ) : (
          <p className="text-[13px] text-ink-3">The walk ended.</p>
        )}
        <Button variant="ghost" size="sm" onClick={onRestart} className="self-start">
          Start again
        </Button>
      </div>
    </>
  );
}

function NodeInspector({
  project,
  node,
  flow,
  statuses,
  problems,
  onChange,
  onAddAfter,
  onConnect,
  onSelectConnector,
  onDelete,
  onClose,
}: {
  project: Project;
  node: FlowNode;
  flow?: Flow;
  statuses: string[];
  problems: Problem[];
  onChange: (patch: Partial<FlowNode>) => void;
  onAddAfter: (outcome: string) => void;
  onConnect: (outcome: string, to: string) => void;
  onSelectConnector: (id: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const meta = typeMeta(node.type);
  const outs = outcomesOf(node);
  const isTrigger = node.kind === "event" && !flow?.connectors.some((c) => c.to === node.id);
  // The one start (#514): what else starts the workflow is set on it.
  const isStart = flow ? triggersOf(flow)[0]?.id === node.id : false;
  const uploadRules = useMemo(
    () =>
      [
        ...qaRules,
        ...rulePacks
          .filter((pk) => (projectPacks[project.id] ?? []).includes(pk.id))
          .flatMap((pk) => pk.rules),
        ...customRules,
      ].filter((r) => r.onUpload && r.on),
    [project.id],
  );
  const [doorRules, setDoorRules] = useState<Record<string, "warn" | "refuse" | "off">>(() =>
    Object.fromEntries(uploadRules.map((r) => [r.id, r.severity === "fail" ? "refuse" : "warn"])),
  );
  return (
    <>
      <PanelHead
        title={node.name}
        hint={`${node.kind === "event" ? (isTrigger ? "Event, starts the workflow" : "Event, waited for") : "Action"} · ${meta.label}`}
        onClose={onClose}
      >
        <ActionMenu
          always
          label="this step"
          actions={[{ label: "Delete", danger: true, onSelect: onDelete }]}
        />
      </PanelHead>
      <div className="scroll-quiet flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {problems.map((p) => (
          <p
            key={p.text}
            className={cn(
              "rounded-panel border px-3 py-2 text-[12px]",
              p.level === "error"
                ? "border-signal/40 bg-signal/10 text-ink"
                : "border-line bg-raised/40 text-ink-2",
            )}
          >
            {p.text}
          </p>
        ))}
        <Field label="Name">
          <Input value={node.name} onChange={(e) => onChange({ name: e.target.value })} />
        </Field>
        {isStart && (
          <div className="flex flex-col gap-2">
            <Label>Starts when</Label>
            {familyKinds.start.map((t) => {
              const own = t === node.type;
              const on =
                own ||
                (node.config.triggers ?? "")
                  .split(",")
                  .map((x) => x.trim())
                  .includes(t);
              return (
                <div key={t} className="flex items-center justify-between gap-3 text-[13px]">
                  <span className="flex min-w-0 items-center gap-2 text-ink">
                    <KindTile type={t} size="sm" />
                    <span className="truncate">{typeMeta(t).label}</span>
                  </span>
                  <Switch
                    label={typeMeta(t).label}
                    checked={on}
                    disabled={own}
                    onChange={(next) => {
                      const rest = (node.config.triggers ?? "")
                        .split(",")
                        .map((x) => x.trim())
                        .filter((x) => x && x !== t);
                      onChange({
                        config: {
                          ...node.config,
                          triggers: [...rest, ...(next ? [t] : [])].join(", "),
                        },
                      });
                    }}
                  />
                </div>
              );
            })}
            <div className="text-[12px] text-ink-3">
              A workflow has one start. Switch on anything else that should start it here; a
              different path is a workflow of its own (New workflow, in the page header).
            </div>
          </div>
        )}
        {meta.fields.map((f) => (
          <Field key={f.id} label={f.label}>
            {f.id === "status" && statuses.length ? (
              <Select
                value={node.config[f.id] ?? ""}
                onChange={(e) => onChange({ config: { ...node.config, [f.id]: e.target.value } })}
              >
                <option value="">None</option>
                {statuses.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </Select>
            ) : f.options ? (
              <Select
                value={node.config[f.id] ?? f.options[0]}
                onChange={(e) => onChange({ config: { ...node.config, [f.id]: e.target.value } })}
              >
                {f.options.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </Select>
            ) : (
              <Input
                value={node.config[f.id] ?? ""}
                onChange={(e) => onChange({ config: { ...node.config, [f.id]: e.target.value } })}
              />
            )}
          </Field>
        ))}
        {["approval", "feedback", "task", "checks", "wait"].includes(node.type) && (
          <Field label="Assign new comments to">
            <Select
              value={node.config.assign ?? ""}
              onChange={(e) => onChange({ config: { ...node.config, assign: e.target.value } })}
            >
              <option value="">Track or project default</option>
              <option value="nobody">Nobody</option>
              <optgroup label="Whoever holds the role">
                {project.roles.map((r) => (
                  <option key={r.id} value={`role:${r.id}`}>
                    {r.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Members">
                {project.members.map((m) => (
                  <option key={m.personId} value={`member:${m.personId}`}>
                    {personById(m.personId).name}
                  </option>
                ))}
              </optgroup>
            </Select>
            <span className="text-[11px]">
              Whoever a comment opened while the track waits here is for.
            </span>
          </Field>
        )}
        {flow && flow.groups.length > 0 && (
          <Field label="Stage">
            <Select
              value={node.groupId ?? ""}
              onChange={(e) => onChange({ groupId: e.target.value || undefined })}
            >
              <option value="">None</option>
              {flow.groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {node.type === "upload" && (
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between">
              <Label>At the door</Label>
              <span className="text-[12px] text-ink-3">from the QA rules marked on upload</span>
            </div>
            <div className="flex flex-col divide-y divide-line rounded-panel border border-line">
              {uploadRules.map((r) => (
                <div key={r.id} className="flex items-center gap-2 px-2.5 py-1.5">
                  <span className="min-w-0 flex-1 truncate text-[12px] text-ink">{r.name}</span>
                  <Select
                    value={doorRules[r.id] ?? "warn"}
                    aria-label={`${r.name} on upload`}
                    className="h-7 w-[92px] text-[12px]"
                    onChange={(e) =>
                      setDoorRules({
                        ...doorRules,
                        [r.id]: e.target.value as "warn" | "refuse" | "off",
                      })
                    }
                  >
                    <option value="off">Off</option>
                    <option value="warn">Warn</option>
                    <option value="refuse">Refuse</option>
                  </Select>
                </div>
              ))}
            </div>
          </div>
        )}
        {outs.length > 0 && (
          <div className="flex flex-col gap-2">
            <Label>Then</Label>
            <div className="flex flex-col gap-1.5">
              {outs.map((o) => {
                const links =
                  flow?.connectors.filter((c) => c.from === node.id && c.outcome === o.id) ?? [];
                const others = flow?.nodes.filter((n) => n.id !== node.id) ?? [];
                return (
                  <div key={o.id} className="rounded-panel border border-line px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[12px] text-ink-3">
                        {o.label
                          ? `When ${o.label}`
                          : node.kind === "event"
                            ? "When it happens"
                            : "When done"}
                      </span>
                      <Dropdown
                        size="sm"
                        align="right"
                        value={
                          <span className="flex items-center gap-1">
                            <Icon name="plus" size={12} />
                            Add
                          </span>
                        }
                        actions={[
                          { label: "A new node…", onSelect: () => onAddAfter(o.id) },
                          "divider",
                          ...others.map((n) => ({
                            label: n.name,
                            icon: <KindTile type={n.type} size="sm" />,
                            hint: kindLine(n),
                            onSelect: () => onConnect(o.id, n.id),
                          })),
                        ]}
                      />
                    </div>
                    {links.length === 0 ? (
                      <div className="mt-1 text-[13px] text-ink-3">Nothing yet</div>
                    ) : (
                      <ul className="mt-1 flex flex-col gap-1">
                        {links.map((c) => {
                          const to = flow?.nodes.find((n) => n.id === c.to);
                          const loop = flow ? isLoop(flow, c) : false;
                          return (
                            <li key={c.id}>
                              <button
                                type="button"
                                onClick={() => onSelectConnector(c.id)}
                                className="flex w-full items-center gap-2 rounded-control px-1.5 py-1 text-left text-[13px] text-ink transition-colors hover:bg-raised"
                              >
                                <Icon
                                  name={loop ? "repeat" : "arrowRight"}
                                  size={13}
                                  className="text-ink-3"
                                />
                                {to && <KindTile type={to.type} size="sm" />}
                                <span className="min-w-0 flex-1 truncate">{to?.name}</span>
                                {(c.condition || c.until) && (
                                  <span className="max-w-[45%] truncate text-[11px] text-ink-3">
                                    {c.condition ?? c.until}
                                  </span>
                                )}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

const conditionChoices = [
  "if the file is audio",
  "if the file is video",
  "if the file is a document",
  "if the file is a picture",
  "if the file is tagged Final",
  "if a guest decided",
  "if a member decided",
];

function ConnectorInspector({
  connector,
  flow,
  onChange,
  onDelete,
  onClose,
}: {
  connector: Connector;
  flow?: Flow;
  onChange: (patch: Partial<Connector>) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const from = flow?.nodes.find((n) => n.id === connector.from);
  const to = flow?.nodes.find((n) => n.id === connector.to);
  const loop = flow ? isLoop(flow, connector) : false;
  const outs = from ? outcomesOf(from) : [];
  return (
    <>
      <PanelHead
        title={loop ? "Loop" : "Connector"}
        hint={`${from?.name} → ${to?.name}`}
        onClose={onClose}
      >
        <ActionMenu
          always
          label="this connection"
          actions={[{ label: "Remove", danger: true, onSelect: onDelete }]}
        />
      </PanelHead>
      <div className="flex flex-col gap-4 p-4">
        {outs.length > 1 && (
          <Field label={`Leaves “${from?.name}” when`}>
            <Select
              value={connector.outcome}
              onChange={(e) => onChange({ outcome: e.target.value })}
            >
              {outs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Only if">
          {/* What the model can test (decision 116): the file's kind, a tag, who decided. */}
          <Select
            value={connector.condition ?? ""}
            onChange={(e) => onChange({ condition: e.target.value || undefined })}
          >
            <option value="">Always</option>
            {connector.condition && !conditionChoices.includes(connector.condition) && (
              <option>{connector.condition}</option>
            )}
            {conditionChoices.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </Select>
        </Field>
        {loop && (
          <Field label="Way out of the loop: at most, in times">
            <Input
              value={/\d+/.exec(connector.until ?? "")?.[0] ?? ""}
              placeholder="3"
              inputMode="numeric"
              onChange={(e) =>
                onChange({ until: e.target.value ? `at most ${e.target.value} times` : undefined })
              }
            />
          </Field>
        )}
        <p className="text-[12px] text-ink-3">
          {loop
            ? "This connector goes back to an earlier node, so the item loops. Give it a bound or a condition that stops it."
            : "A condition narrows when the item takes this connector; without one it always does, for this outcome."}
        </p>
      </div>
    </>
  );
}

/* ---------- The basic view ---------- */

function BasicView({
  flows,
  problems,
  onChange,
  onAdvanced,
  onNew,
}: {
  flows: Flow[];
  problems: Record<string, Problem[]>;
  onChange: (flowId: string, fn: (f: Flow) => Flow) => void;
  onAdvanced: (flowId: string) => void;
  onNew: () => void;
}) {
  return (
    <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto">
      <div className="fade-in mx-auto flex w-full max-w-[860px] flex-col gap-8 px-5 py-6 @3xl/app:px-10 @3xl/app:py-8">
        <p className="max-w-[620px] text-[14px] text-ink-2">
          Each workflow as a list of steps. Change who, when and what happens on changes; the
          advanced view holds the same workflow as a graph for anything beyond that.
        </p>
        {flows.map((f) => {
          const ord = flowOrder(f);
          const nodes = ord
            .map((id) => f.nodes.find((n) => n.id === id))
            .filter((n): n is FlowNode => Boolean(n));
          const triggers = triggersOf(f);
          const steps = nodes.filter((n) => n.kind === "action" && n.type !== "finish");
          const finish = nodes.find((n) => n.type === "finish");
          const patch = (id: string, config: Record<string, string>) =>
            onChange(f.id, (x) => ({
              ...x,
              nodes: x.nodes.map((n) =>
                n.id === id ? { ...n, config: { ...n.config, ...config } } : n,
              ),
            }));
          return (
            <section key={f.id} className="flex flex-col gap-3">
              <div className="flex items-end gap-3">
                <div className="min-w-0 flex-1">
                  <h2 className="text-[18px] font-medium tracking-tight text-ink">{f.name}</h2>
                  <p className="text-[13px] text-ink-3">
                    {f.active ? "Active" : "Draft"} · {steps.length} steps
                    {problems[f.id]?.length ? ` · ${problems[f.id]?.length} to look at` : ""}
                  </p>
                </div>
                <Switch
                  label={`${f.name} active`}
                  checked={f.active}
                  onChange={(v) => onChange(f.id, (x) => ({ ...x, active: v }))}
                />
                <Button variant="secondary" size="md" onClick={() => onAdvanced(f.id)}>
                  Open in the advanced view
                </Button>
              </div>
              <div className="flex flex-col divide-y divide-line rounded-panel-lg border border-line bg-raised/25 shadow-1">
                <div className="flex items-center gap-3 px-4 py-3">
                  <span className="flex size-7 items-center justify-center rounded-control bg-signal/15 text-signal">
                    <Icon name="bolt" size={14} />
                  </span>
                  <span className="text-[14px] text-ink">
                    When{" "}
                    {triggers.map((t) => t.name.toLowerCase()).join(" or ") || "nothing happens"}
                  </span>
                </div>
                {steps.map((n, i) => {
                  const meta = typeMeta(n.type);
                  const loops = f.connectors.filter((c) => c.from === n.id && isLoop(f, c));
                  return (
                    <div key={n.id} className="flex flex-col gap-2 px-4 py-3">
                      <div className="flex items-center gap-3">
                        <span className="tabular w-7 text-center text-[12px] text-ink-3">
                          {i + 1}
                        </span>
                        <KindTile type={n.type} />
                        <span className="min-w-0 flex-1 truncate text-[14px] text-ink">
                          {n.name}
                        </span>
                        <span className="text-[12px] text-ink-3">{meta.label}</span>
                      </div>
                      <div className="ml-[68px] flex flex-wrap gap-2">
                        {meta.fields
                          .filter((fl) => fl.id !== "message")
                          .map((fl) => (
                            <label
                              key={fl.id}
                              className="flex items-center gap-1.5 text-[12px] text-ink-3"
                            >
                              {fl.label}
                              {fl.options ? (
                                <Select
                                  value={n.config[fl.id] ?? fl.options[0]}
                                  className="h-7 text-[12px]"
                                  onChange={(e) => patch(n.id, { [fl.id]: e.target.value })}
                                >
                                  {fl.options.map((o) => (
                                    <option key={o}>{o}</option>
                                  ))}
                                </Select>
                              ) : (
                                <Input
                                  value={n.config[fl.id] ?? ""}
                                  className="h-7 w-28 text-[12px]"
                                  onChange={(e) => patch(n.id, { [fl.id]: e.target.value })}
                                />
                              )}
                            </label>
                          ))}
                        {loops.map((c) => {
                          const o = outcomesOf(n).find((x) => x.id === c.outcome);
                          return (
                            <label
                              key={c.id}
                              className="flex items-center gap-1.5 text-[12px] text-ink-3"
                            >
                              If {o?.label}, back to
                              <Select
                                value={c.to}
                                className="h-7 text-[12px]"
                                onChange={(e) =>
                                  onChange(f.id, (x) => ({
                                    ...x,
                                    connectors: x.connectors.map((cc) =>
                                      cc.id === c.id ? { ...cc, to: e.target.value } : cc,
                                    ),
                                  }))
                                }
                              >
                                {steps.map((s) => (
                                  <option key={s.id} value={s.id}>
                                    {s.name}
                                  </option>
                                ))}
                              </Select>
                              at most
                              <Input
                                value={/\d+/.exec(c.until ?? "")?.[0] ?? ""}
                                placeholder="3"
                                inputMode="numeric"
                                className="h-7 w-14 text-[12px]"
                                onChange={(e) =>
                                  onChange(f.id, (x) => ({
                                    ...x,
                                    connectors: x.connectors.map((cc) =>
                                      cc.id === c.id
                                        ? {
                                            ...cc,
                                            until: e.target.value
                                              ? `at most ${e.target.value} times`
                                              : undefined,
                                          }
                                        : cc,
                                    ),
                                  }))
                                }
                              />
                              times
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
                <div className="flex items-center gap-3 px-4 py-3">
                  <span className="flex size-7 items-center justify-center rounded-control bg-raised text-ink-2">
                    <Icon name="stop" size={14} />
                  </span>
                  <span className="text-[14px] text-ink">
                    {finish ? `Finish: ${finish.name}` : "No finish yet"}
                  </span>
                  {finish?.config.status && (
                    <span className="text-[12px] text-ink-3">sets {finish.config.status}</span>
                  )}
                </div>
              </div>
              {(problems[f.id]?.length ?? 0) > 0 && (
                <ul className="m-0 flex list-none flex-col gap-1 p-0">
                  {problems[f.id]?.map((p) => (
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
            </section>
          );
        })}
        <div>
          <Button variant="secondary" onClick={onNew}>
            <Icon name="plus" size={14} />
            New workflow
          </Button>
        </div>
        <p className="text-[12px] text-ink-3">
          A track can follow a workflow of its own instead of the project's; that is set from the
          track.
        </p>
      </div>
    </div>
  );
}

/* ---------- As code ---------- */

function CodeView({ flows, onToast }: { flows: Flow[]; onToast: (t: string) => void }) {
  const [flowId, setFlowId] = useState(flows[0]?.id ?? "");
  const flow = flows.find((f) => f.id === flowId) ?? flows[0];
  const yaml = flow ? toYaml(flow) : "";
  const [text, setText] = useState(yaml);
  useEffect(() => setText(yaml), [yaml]);
  const dirty = text !== yaml;
  return (
    <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto">
      <div className="fade-in mx-auto flex w-full max-w-[960px] flex-col gap-4 px-5 py-6 @3xl/app:px-10 @3xl/app:py-8">
        <div className="flex flex-wrap items-center gap-2">
          <div role="tablist" className="flex items-center gap-1">
            {flows.map((f) => (
              <button
                key={f.id}
                type="button"
                role="tab"
                aria-selected={f.id === flow?.id}
                onClick={() => setFlowId(f.id)}
                className={cn(
                  "h-8 rounded-control px-2.5 text-[13px] transition-colors",
                  f.id === flow?.id ? "bg-raised text-ink shadow-1" : "text-ink-3 hover:text-ink",
                )}
              >
                {f.name}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                navigator.clipboard?.writeText(text).catch(() => {});
                onToast("Copied.");
              }}
            >
              <Icon name="copy" size={13} />
              Copy
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const blob = new Blob([text], { type: "text/yaml" });
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = `${(flow?.name ?? "workflow").toLowerCase().replace(/\s+/g, "-")}.workflow.yaml`;
                a.click();
                URL.revokeObjectURL(a.href);
                onToast(`Saved ${a.download}.`);
              }}
            >
              <Icon name="download" size={13} />
              Download
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                onToast(
                  "Read a workflow file, or start from a template (Simple approval, Conductor first, Parallel stakeholders): what applying it changes, and its problems with their lines, show before anything is saved.",
                )
              }
            >
              <Icon name="upload" size={13} />
              Import
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!dirty}
              onClick={() =>
                onToast(`Applied to ${flow?.name}: ${text.split("\n").length} lines, no problems.`)
              }
            >
              Apply
            </Button>
          </div>
        </div>
        <p className="text-[13px] text-ink-3">
          The whole workflow as a file: keep it in a repository, share it between projects, or hand
          it to another instance. Changes made here are checked, then applied when you choose; the
          canvas and this file always show the same workflow.
        </p>
        <div className="relative rounded-panel-lg border border-line bg-canvas/60 font-mono text-[12.5px] leading-[1.6]">
          <pre
            aria-hidden="true"
            className="pointer-events-none m-0 min-h-[520px] overflow-hidden px-4 py-3 font-mono break-words whitespace-pre-wrap"
          >
            {highlightYaml(text)}
          </pre>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            aria-label="Workflow as code"
            className="absolute inset-0 h-full w-full resize-none bg-transparent px-4 py-3 font-mono text-[12.5px] leading-[1.6] break-words whitespace-pre-wrap text-transparent caret-ink focus:outline-none"
          />
        </div>
      </div>
    </div>
  );
}

/** YAML, coloured by what each piece is: keys in ink, strings violet, numbers green, booleans signal, comments quiet. */
function highlightYaml(text: string): ReactNode[] {
  const value = (v: string): ReactNode => {
    const t = v.trim();
    if (!t) return null;
    if (t.startsWith("#")) return <span className="text-ink-3">{v}</span>;
    if (/^(true|false|null)$/.test(t)) return <span className="text-node-event">{v}</span>;
    if (/^-?\d+(\.\d+)?$/.test(t) || /^\[.*\]$/.test(t))
      return <span className="text-node-work">{v}</span>;
    if (/^["'].*["']$/.test(t)) return <span className="text-node-comm">{v}</span>;
    return <span className="text-ink-2">{v}</span>;
  };
  return text.split("\n").map((line, i) => {
    const m = line.match(/^(\s*-?\s*)([\w.-]+)(:)(\s.*|$)/);
    const comment = line.trim().startsWith("#");
    return (
      <span key={`${i}-${line.length}`} className="block min-h-[1.6em]">
        {comment ? (
          <span className="text-ink-3">{line}</span>
        ) : m ? (
          <>
            <span className="text-ink-3">{m[1]}</span>
            <span className="text-ink">{m[2]}</span>
            <span className="text-ink-3">{m[3]}</span>
            {value(m[4] ?? "")}
          </>
        ) : (
          <span className="text-ink-2">{line}</span>
        )}
      </span>
    );
  });
}

export function WorkflowRoute({ projectId }: { projectId: string }) {
  const viewer = useViewer();
  const project = projectById(projectId);
  if (!project || !viewer.canSee(projectId)) return <Refused />;
  if (!viewer.can(projectId, "edit_workflows") && !viewer.can(projectId, "manage_roles"))
    return (
      <Refused
        title="Not for your role"
        text="Editing workflows needs the permission in a project role. Ask whoever runs the project."
      />
    );
  return <WorkflowPage project={project} />;
}
