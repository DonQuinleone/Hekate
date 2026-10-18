import {
  completeNode,
  flowShape,
  type NodeType,
  nodeTypes,
  outcomesOf,
  startRun,
  triggersOf,
  type WorkflowCondition,
  type WorkflowConnector,
  type WorkflowContext,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowProblem,
  type WorkflowRun,
  type WorkflowSummary,
} from "@hekate/shared";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "~/components/icons";
import { Kbd } from "~/components/kbd";
import { Button } from "~/components/ui/button";
import { Input, Select } from "~/components/ui/input";
import { Dropdown } from "~/components/ui/menu";
import { Committed, StepField } from "~/components/workflow-fields";
import { cn } from "~/lib/cn";
import { useShortcuts } from "~/lib/shortcuts";
import {
  BAND_GAP,
  type Bounds,
  boundsOf,
  conditionText,
  connectorPath,
  type Family,
  familyOf,
  familyTiles,
  inPort,
  labelAt,
  NODE_H,
  NODE_W,
  nodeLooks,
  outcomeWords,
  outPort,
  type Pt,
  pickerGroups,
  portTop,
  walkLine,
  withConfig,
  withCopy,
  withLink,
  withNode,
  withNodeChange,
  withoutConnector,
  withoutNode,
} from "~/lib/workflow-nodes";

/* ---------- Families: a shape each, as the prototype draws them ---------- */

const families: Record<Family, { label: string; hint: string; shape: string; swatch: string }> = {
  event: {
    label: "Event",
    hint: "Something happens; a D-shape, in the signal colour",
    shape: "rounded-l-full rounded-r-panel pl-4",
    swatch: "rounded-l-full rounded-r-[3px] bg-node-event/70",
  },
  review: {
    label: "Review",
    hint: "People decide or comment; a card with a blue edge",
    shape: "rounded-panel-lg border-l-[3px] border-l-node-review",
    swatch: "rounded-[3px] border-l-[3px] border-l-node-review bg-node-review/30",
  },
  work: {
    label: "Work",
    hint: "Something gets done; a square-cornered card, green",
    shape: "rounded-control",
    swatch: "rounded-[2px] bg-node-work/60",
  },
  comm: {
    label: "Message",
    hint: "Someone is told or sent a link; a pill, violet",
    shape: "rounded-full pl-4",
    swatch: "rounded-full bg-node-comm/60",
  },
  flow: {
    label: "Flow",
    hint: "Wait, set a status, move; a slanted card, teal",
    shape: "rounded-panel [clip-path:polygon(10px_0,100%_0,calc(100%-10px)_100%,0_100%)] pl-5",
    swatch: "[clip-path:polygon(4px_0,100%_0,calc(100%-4px)_100%,0_100%)] bg-node-flow/60",
  },
  finish: {
    label: "Finish",
    hint: "The end; the mirror of the event, in ink",
    shape: "rounded-r-full rounded-l-panel pr-4",
    swatch: "rounded-r-full rounded-l-[3px] bg-ink/70",
  },
};

/** The families, each with its shape and colour, as a key to the canvas. */
export function Legend({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={cn("flex flex-wrap gap-x-4 gap-y-1.5", compact ? "text-[11px]" : "text-[12px]")}
    >
      {(Object.keys(families) as Family[]).map((f) => (
        <span key={f} className="flex items-center gap-1.5 text-ink-3" title={families[f].hint}>
          <span className={cn("inline-block h-2.5 w-4", families[f].swatch)} />
          {families[f].label}
        </span>
      ))}
    </div>
  );
}

const eyebrow = "text-[11px] font-medium tracking-wide text-ink-3 uppercase";

/** What is chosen: a node or a connector, of a workflow (ids are only unique within one). */
type Selection = { kind: "node" | "connector"; id: string; flowId: string } | null;

interface Menu {
  x: number;
  y: number;
  target:
    | { kind: "canvas"; world: Pt; flowId: string }
    | { kind: "node"; id: string; flowId: string }
    | { kind: "connector"; id: string; flowId: string };
}

interface Linking {
  flowId: string;
  from: string;
  outcome: string;
  at: Pt;
}

interface AddAt {
  flowId: string;
  /** In the workflow's own coordinates. */
  at: Pt;
  from?: string;
}

type MenuItem = { label: string; danger?: boolean; onSelect: () => void } | "divider";

type ItemKind = WorkflowContext["item"]["kind"];

/** An item walked through a workflow by the engine itself, as a run would take it. */
interface Walk {
  flowId: string;
  kind: ItemKind;
  run: WorkflowRun | null;
  /** The nodes it has reached. */
  reached: string[];
  log: string[];
  /** Why it cannot walk: the workflow breaks a rule. */
  refused?: string;
}

/**
 * The builder's advanced view (#26), as the prototype draws it: every workflow of the project on
 * one canvas, one above the other, that pans and zooms, with a map of it; nodes in families of
 * shape and colour, connected by dragging from an outcome's port; right-click menus on the
 * canvas, a node and a connector; an inspector for what is selected, and what each workflow
 * breaks counted and shown on its node. Each change is handed to `onEdit`, which keeps it.
 */
export function WorkflowCanvas({
  projectId,
  workflows,
  editing,
  focus,
  onEdit,
  onNew,
}: {
  projectId: string;
  workflows: WorkflowSummary[];
  editing: boolean;
  /** A workflow to land on, once it is there (a new one, say). */
  focus?: string | null;
  onEdit: (id: string, change: (flow: WorkflowDefinition) => WorkflowDefinition) => void;
  onNew: () => void;
}) {
  const [selection, setSelection] = useState<Selection>(null);
  const [picking, setPicking] = useState<AddAt | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [linking, setLinking] = useState<Linking | null>(null);
  const [pan, setPan] = useState<Pt>({ x: 80, y: 80 });
  const [zoom, setZoom] = useState(0.85);
  const [panning, setPanning] = useState(false);
  const [walk, setWalk] = useState<Walk | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const drag = useRef<
    | { kind: "pan"; start: Pt; origin: Pt }
    | { kind: "node"; id: string; flowId: string; start: Pt; origin: Pt; moved: boolean }
    | null
  >(null);

  /* Bands: every workflow on one canvas, one above the other. */
  const bands = useMemo(() => {
    let y = 0;
    return workflows.map((w) => {
      const b = boundsOf(w.definition.nodes);
      const height = b.maxY - b.minY;
      const band = { flow: w, offsetY: y - b.minY, bounds: b, top: y, height };
      y += height + BAND_GAP;
      return band;
    });
  }, [workflows]);
  const bandOf = (flowId: string) => bands.find((b) => b.flow.id === flowId);
  const placed = (flowId: string, n: WorkflowNode): WorkflowNode => ({
    ...n,
    y: n.y + (bandOf(flowId)?.offsetY ?? 0),
  });
  const everything = useMemo(
    () =>
      bands.flatMap((b) =>
        b.flow.definition.nodes.map((n) => ({
          x: n.x,
          y: n.y + b.offsetY,
          event: nodeTypes[n.type].kind === "event",
        })),
      ),
    [bands],
  );
  const worldBounds = useMemo(() => boundsOf(everything), [everything]);
  const allProblems = workflows.flatMap((w) => w.problems.map((p) => ({ ...p, flowId: w.id })));
  const flowById = (flowId: string) => workflows.find((w) => w.id === flowId);
  const selectedFlow = selection ? flowById(selection.flowId) : undefined;
  const selectedNode =
    selection?.kind === "node"
      ? selectedFlow?.definition.nodes.find((n) => n.id === selection.id)
      : undefined;
  const selectedConnector =
    selection?.kind === "connector"
      ? selectedFlow?.definition.connectors.find((c) => c.id === selection.id)
      : undefined;

  /* Editing: each change to the workflow it was made in. */
  const edit = (flowId: string, change: (flow: WorkflowDefinition) => WorkflowDefinition) => {
    if (editing && flowById(flowId)) onEdit(flowId, change);
  };
  const addNode = (type: NodeType) => {
    const target = picking ?? { flowId: workflows[0]?.id ?? "", at: { x: 0, y: 0 } };
    if (!editing || !target.flowId) return;
    const id = `n-${Math.random().toString(36).slice(2, 8)}`;
    edit(target.flowId, (f) => withNode(f, type, target.at, target.from, id));
    setSelection({ kind: "node", id, flowId: target.flowId });
    setPicking(null);
  };
  const removeNode = (flowId: string, id: string) => {
    edit(flowId, (f) => withoutNode(f, id));
    setSelection(null);
  };
  const removeConnector = (flowId: string, id: string) => {
    edit(flowId, (f) => withoutConnector(f, id));
    setSelection(null);
  };
  const duplicateNode = (flowId: string, id: string) => {
    const copy = `n-${Math.random().toString(36).slice(2, 8)}`;
    edit(flowId, (f) => withCopy(f, id, copy));
    setSelection({ kind: "node", id: copy, flowId });
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
  const fitTo = (b: Bounds) => {
    const rect = canvas.current?.getBoundingClientRect();
    if (!rect) return;
    const pad = 72;
    const z = Math.max(
      0.3,
      Math.min(
        1,
        (rect.width - pad * 2) / (b.maxX - b.minX + 240),
        (rect.height - pad * 2) / (b.maxY - b.minY + 120),
      ),
    );
    setZoom(z);
    setPan({
      x: (rect.width - (b.maxX - b.minX + 240) * z) / 2 - (b.minX - 120) * z,
      y: (rect.height - (b.maxY - b.minY + 120) * z) / 2 - (b.minY - 60) * z,
    });
  };
  const fitAll = () => fitTo(worldBounds);
  /**
   * Lands on a workflow at a readable size, its heading near the top and its start at the left;
   * the rest is a pan away.
   */
  const jumpTo = (flowId: string) => {
    const b = bandOf(flowId);
    const rect = canvas.current?.getBoundingClientRect();
    if (!b || !rect) return;
    const z = rect.width < 640 ? 0.6 : 0.8;
    setZoom(z);
    setPan({ x: 56 - b.bounds.minX * z, y: 120 - (b.bounds.minY + b.offsetY) * z });
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

  // The first view lands on the first workflow, once the canvas has a size; a new one when it
  // arrives.
  const landed = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: lands once per workflow asked for.
  useEffect(() => {
    const target = focus && bandOf(focus) ? focus : landed.current ? null : workflows[0]?.id;
    if (!target || landed.current === target) return;
    landed.current = target;
    requestAnimationFrame(() => jumpTo(target));
  }, [focus, bands]);

  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      const rect = canvas.current?.getBoundingClientRect();
      if (!rect) return;
      zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, { x: e.clientX - rect.left, y: e.clientY - rect.top });
    } else setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }));
  };

  const onCanvasPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    setMenu(null);
    drag.current = { kind: "pan", start: { x: e.clientX, y: e.clientY }, origin: pan };
    setPanning(true);
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onNodePointerDown = (flowId: string, id: string, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setMenu(null);
    const n = workflows.find((w) => w.id === flowId)?.definition.nodes.find((x) => x.id === id);
    if (!n) return;
    drag.current = {
      kind: "node",
      id,
      flowId,
      start: { x: e.clientX, y: e.clientY },
      origin: { x: n.x, y: n.y },
      moved: false,
    };
    canvas.current?.setPointerCapture?.(e.pointerId);
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
    else if (editing) {
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      if (d.moved)
        onEdit(d.flowId, (f) =>
          withNodeChange(f, d.id, {
            x: Math.round((d.origin.x + dx / zoom) / 10) * 10,
            y: Math.round((d.origin.y + dy / zoom) / 10) * 10,
          }),
        );
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    setPanning(false);
    if (linking) {
      // The canvas holds the pointer while a connector is drawn, so the event is the canvas's:
      // what lies under the pointer is found by where it is.
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const el = under?.closest("[data-node]") as HTMLElement | null;
      const to = el?.dataset.flow === linking.flowId ? el.dataset.node : undefined;
      if (to) edit(linking.flowId, (f) => withLink(f, linking.from, linking.outcome, to));
      else
        setPicking({
          flowId: linking.flowId,
          at: { x: linking.at.x, y: linking.at.y - (bandOf(linking.flowId)?.offsetY ?? 0) },
          from: linking.from,
        });
      setLinking(null);
      return;
    }
    const d = drag.current;
    drag.current = null;
    if (d?.kind === "node" && !d.moved) {
      setSelection({ kind: "node", id: d.id, flowId: d.flowId });
      setPicking(null);
    } else if (d?.kind === "pan") {
      const moved = Math.abs(e.clientX - d.start.x) + Math.abs(e.clientY - d.start.y) > 3;
      if (!moved) setSelection(null);
    }
  };

  useShortcuts("workflow-canvas", "Workflow builder", [
    {
      keys: ["Escape"],
      label: "Close the menu or the inspector",
      run: () => {
        setMenu(null);
        setLinking(null);
        setPicking(null);
        setSelection(null);
      },
    },
    {
      keys: ["Delete", "Backspace"],
      label: "Delete what is selected",
      run: () => {
        if (!selection || !editing) return;
        if (selection.kind === "node") removeNode(selection.flowId, selection.id);
        else removeConnector(selection.flowId, selection.id);
      },
    },
    { keys: ["f"], label: "Fit the canvas to the window", run: fitAll },
    { keys: ["+", "="], label: "Zoom in", run: () => zoomBy(1.15) },
    { keys: ["-"], label: "Zoom out", run: () => zoomBy(1 / 1.15) },
  ]);

  /** Where to add what follows a node: to its right, beside the outcome it leaves by. */
  const besides = (n: WorkflowNode, outcome?: string): Pt => {
    const outs = outcomesOf(n.type);
    const i = outcome ? outs.findIndex((o) => o.id === outcome) : 0;
    return { x: n.x + NODE_W + 92, y: n.y + (outcome ? (i - 1) * 100 : 0) };
  };
  const openPicker = () => {
    const w = selectedNode ? selectedFlow : workflows[0];
    if (!w) return;
    if (selectedNode)
      setPicking({ flowId: w.id, at: besides(selectedNode), from: selectedNode.id });
    else {
      const rect = canvas.current?.getBoundingClientRect();
      const centre = toWorld({
        x: (rect?.left ?? 0) + (rect?.width ?? 0) / 2,
        y: (rect?.top ?? 0) + (rect?.height ?? 0) / 2,
      });
      setPicking({
        flowId: w.id,
        at: { x: centre.x, y: centre.y - (bandOf(w.id)?.offsetY ?? 0) },
      });
    }
    setSelection(null);
  };

  /* Right-click menus */
  const menuItems = (m: Menu): MenuItem[] => {
    if (m.target.kind === "canvas") {
      const t = m.target;
      return [
        ...(editing
          ? [
              {
                label: "Add a node here",
                onSelect: () =>
                  setPicking({
                    flowId: t.flowId,
                    at: { x: t.world.x, y: t.world.y - (bandOf(t.flowId)?.offsetY ?? 0) },
                  }),
              },
            ]
          : []),
        { label: "Fit to window", onSelect: fitAll },
        { label: "Zoom to 100%", onSelect: () => setZoom(1) },
        "divider" as const,
        { label: "Walk an item through", onSelect: () => startWalk(t.flowId) },
        ...(editing ? ["divider" as const, { label: "New workflow", onSelect: onNew }] : []),
      ];
    }
    if (m.target.kind === "node") {
      const { id, flowId } = m.target;
      const n = flowById(flowId)?.definition.nodes.find((x) => x.id === id);
      return [
        {
          label: editing ? "Edit" : "Look closer",
          onSelect: () => setSelection({ kind: "node", id, flowId }),
        },
        ...(editing && n
          ? [
              {
                label: "Add what follows",
                onSelect: () => setPicking({ flowId, at: besides(n), from: id }),
              },
              { label: "Duplicate", onSelect: () => duplicateNode(flowId, id) },
              "divider" as const,
              { label: "Delete", danger: true, onSelect: () => removeNode(flowId, id) },
            ]
          : []),
      ];
    }
    const { id, flowId } = m.target;
    return [
      {
        label: editing ? "Edit the connector" : "Look closer",
        onSelect: () => setSelection({ kind: "connector", id, flowId }),
      },
      ...(editing
        ? [
            {
              label: "Add a condition",
              onSelect: () => setSelection({ kind: "connector", id, flowId }),
            },
            "divider" as const,
            { label: "Remove", danger: true, onSelect: () => removeConnector(flowId, id) },
          ]
        : []),
    ];
  };
  const openMenu = (e: React.MouseEvent, target: Menu["target"]) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = canvas.current?.getBoundingClientRect();
    setMenu({ x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0), target });
  };

  /* The walk-through: the engine's own steps, with the outcome chosen at each. */
  const startWalk = (flowId: string, kind: ItemKind = walk?.kind ?? "audio") => {
    const flow = flowById(flowId)?.definition;
    const trigger = flow ? triggersOf(flow)[0] : undefined;
    setPicking(null);
    setSelection(null);
    if (!flow || !trigger) {
      setWalk({ flowId, kind, run: null, reached: [], log: [], refused: "Nothing starts it." });
      return;
    }
    try {
      const { run, effects } = startRun(flow, trigger.id, { item: { kind, tags: [] } });
      setWalk({
        flowId,
        kind,
        run,
        reached: [trigger.id, ...effects.flatMap((e) => ("nodeId" in e ? [e.nodeId] : []))],
        log: [`${trigger.name}.`, ...effects.flatMap((e) => walkLine(flow, e) ?? [])],
      });
    } catch (failure) {
      setWalk({
        flowId,
        kind,
        run: null,
        reached: [],
        log: [],
        refused: failure instanceof Error ? failure.message : "It cannot run.",
      });
    }
  };
  const advance = (nodeId: string, outcome: string) => {
    const flow = walk ? flowById(walk.flowId)?.definition : undefined;
    const node = flow?.nodes.find((n) => n.id === nodeId);
    if (!walk?.run || !flow || !node) return;
    try {
      const { run, effects } = completeNode(flow, walk.run, nodeId, outcome, {
        item: { kind: walk.kind, tags: [] },
      });
      setWalk({
        ...walk,
        run,
        reached: [...walk.reached, ...effects.flatMap((e) => ("nodeId" in e ? [e.nodeId] : []))],
        log: [
          ...walk.log,
          `${outcomeWords(node.type, outcome)} at “${node.name}”.`,
          ...effects.flatMap((e) => walkLine(flow, e) ?? []),
        ],
      });
    } catch (failure) {
      // The workflow changed under the walk: it starts again from the new one.
      setWalk({ ...walk, run: null, refused: failure instanceof Error ? failure.message : "" });
    }
  };
  const walked = (flowId: string) => (walk?.flowId === flowId ? walk : null);

  const inspectorOpen = picking !== null || selection !== null || walk !== null;

  return (
    <div className="relative flex min-h-0 flex-1">
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Toolbar */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2 @3xl/app:px-4">
          <div className="scroll-quiet flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
            {workflows.map((w) => (
              <button
                key={w.id}
                type="button"
                onClick={() => jumpTo(w.id)}
                className="flex h-7 shrink-0 items-center gap-1.5 rounded-control border border-line px-2.5 text-[13px] text-ink-2 transition-colors hover:border-edge hover:text-ink"
              >
                <span className={cn("size-1.5 rounded-full", w.active ? "bg-ok" : "bg-ink-3")} />
                {w.name}
                {w.problems.some((p) => p.level === "error") && (
                  <span className="text-signal">
                    !<span className="sr-only">, breaks a rule</span>
                  </span>
                )}
              </button>
            ))}
            {editing && (
              <Button variant="ghost" size="sm" onClick={onNew} className="shrink-0">
                <Icon name="plus" size={13} />
                <span className="hidden @3xl/app:inline">Workflow</span>
                <span className="sr-only @3xl/app:hidden">New workflow</span>
              </Button>
            )}
          </div>
          <Button
            variant={walk ? "secondary" : "ghost"}
            size="sm"
            className="shrink-0"
            onClick={() =>
              walk ? setWalk(null) : startWalk(selection?.flowId ?? workflows[0]?.id ?? "")
            }
          >
            <Icon name="play" size={13} />
            <span className="hidden @3xl/app:inline">Walk through</span>
            <span className="sr-only @3xl/app:hidden">Walk an item through</span>
          </Button>
          {editing && (
            <Button variant="primary" size="sm" onClick={openPicker} className="shrink-0">
              <Icon name="plus" size={13} />
              Node
            </Button>
          )}
        </div>

        {/* Canvas */}
        <div
          ref={canvas}
          role="application"
          aria-label="Workflow canvas"
          onPointerDown={onCanvasPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onWheel={onWheel}
          onContextMenu={(e) => {
            const w = toWorld({ x: e.clientX, y: e.clientY });
            const band =
              bands.find((b) => w.y >= b.top - 80 && w.y <= b.top + b.height + 80) ?? bands[0];
            if (band) openMenu(e, { kind: "canvas", world: w, flowId: band.flow.id });
          }}
          className={cn(
            "relative min-h-0 flex-1 touch-none overflow-hidden bg-canvas/40",
            panning ? "cursor-grabbing" : "cursor-grab",
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
            {/* Each workflow's heading, and its stages */}
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
                  {b.flow.problems.length > 0 && (
                    <span className="mb-1 text-[12px] text-ink-3">
                      · {b.flow.problems.length} to look at
                    </span>
                  )}
                </div>
                {b.flow.definition.groups.map((g) => {
                  const members = b.flow.definition.nodes.filter((n) => n.groupId === g.id);
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
                      <span className={cn("absolute top-2 left-3", eyebrow)}>{g.name}</span>
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
                const { loops } = flowShape(b.flow.definition);
                let lane = 0;
                return b.flow.definition.connectors.map((c) => {
                  const from = b.flow.definition.nodes.find((n) => n.id === c.from);
                  const to = b.flow.definition.nodes.find((n) => n.id === c.to);
                  if (!from || !to) return null;
                  const loop = loops.has(c.id);
                  const a = outPort(placed(b.flow.id, from), c.outcome);
                  const z = inPort(placed(b.flow.id, to));
                  const floor = floorBase + (loop ? lane++ * 18 : 0);
                  const d = connectorPath(a, z, loop, floor);
                  const selected =
                    selection?.kind === "connector" &&
                    selection.flowId === b.flow.id &&
                    selection.id === c.id;
                  const taken = (walked(b.flow.id)?.run?.taken[c.id] ?? 0) > 0;
                  const label = conditionText(c);
                  const lp = labelAt(a, z, loop, floor);
                  return (
                    <g key={c.id}>
                      {/* The wide, unseen line under each connector is what a pointer picks it by; its
                          inspector is reached from its node's for keyboards. */}
                      {/* biome-ignore lint/a11y/noStaticElementInteractions: see above. */}
                      <path
                        d={d}
                        fill="none"
                        strokeWidth={14}
                        stroke="transparent"
                        className="pointer-events-auto cursor-pointer"
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          setSelection({ kind: "connector", id: c.id, flowId: b.flow.id });
                          setPicking(null);
                        }}
                        onContextMenu={(e) =>
                          openMenu(e, { kind: "connector", id: c.id, flowId: b.flow.id })
                        }
                      />
                      <path
                        d={d}
                        fill="none"
                        strokeWidth={selected || taken ? 2.5 : 1.5}
                        className={cn(
                          "transition-[stroke]",
                          selected
                            ? "stroke-signal"
                            : taken
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
                  const w = flowById(linking.flowId);
                  const from = w?.definition.nodes.find((n) => n.id === linking.from);
                  if (!w || !from) return null;
                  return (
                    <path
                      d={connectorPath(
                        outPort(placed(w.id, from), linking.outcome),
                        linking.at,
                        false,
                        0,
                      )}
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
              b.flow.definition.nodes.map((n) => (
                <CanvasNode
                  key={n.id}
                  flowId={b.flow.id}
                  node={placed(b.flow.id, n)}
                  selected={
                    selection?.kind === "node" &&
                    selection.flowId === b.flow.id &&
                    selection.id === n.id
                  }
                  walked={Boolean(walked(b.flow.id)?.reached.includes(n.id))}
                  current={Boolean(walked(b.flow.id)?.run?.active.includes(n.id))}
                  trigger={triggersOf(b.flow.definition).some((t) => t.id === n.id)}
                  problem={b.flow.problems.find((p) => p.nodeId === n.id)}
                  editing={editing}
                  onPointerDown={(e) => onNodePointerDown(b.flow.id, n.id, e)}
                  onPortDown={(outcome, e) => {
                    if (!editing) return;
                    setLinking({
                      flowId: b.flow.id,
                      from: n.id,
                      outcome,
                      at: toWorld({ x: e.clientX, y: e.clientY }),
                    });
                    canvas.current?.setPointerCapture?.(e.pointerId);
                  }}
                  onSelect={() => setSelection({ kind: "node", id: n.id, flowId: b.flow.id })}
                  onContextMenu={(e) => openMenu(e, { kind: "node", id: n.id, flowId: b.flow.id })}
                />
              )),
            )}
          </div>

          {/* Zoom */}
          <div className="absolute bottom-3 left-3 flex items-center gap-0.5 rounded-control border border-line bg-overlay p-0.5 shadow-2">
            <Button
              variant="quiet"
              size="iconSm"
              aria-label="Zoom out"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => zoomBy(1 / 1.15)}
            >
              <Icon name="zoomOut" size={14} />
            </Button>
            <button
              type="button"
              aria-label="Zoom to 100%"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setZoom(1)}
              className="tabular h-7 min-w-11 px-1 text-[12px] text-ink-2 hover:text-ink"
            >
              {Math.round(zoom * 100)}%
            </button>
            <Button
              variant="quiet"
              size="iconSm"
              aria-label="Zoom in"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => zoomBy(1.15)}
            >
              <Icon name="zoomIn" size={14} />
            </Button>
            <span className="mx-0.5 h-4 w-px bg-line" />
            <Button
              variant="quiet"
              size="sm"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={fitAll}
              title="Fit (f)"
            >
              Fit
            </Button>
          </div>
          <div className="pointer-events-none absolute top-3 left-3 hidden rounded-control border border-line bg-overlay/90 px-2.5 py-1.5 @3xl/app:block">
            <Legend compact />
          </div>
          <div className="pointer-events-none absolute bottom-3 left-1/2 hidden -translate-x-1/2 items-center gap-3 text-[11px] text-ink-3 @5xl/app:flex">
            <span>Drag to pan</span>
            <span className="flex items-center gap-1">
              <Kbd>ctrl</Kbd> scroll to zoom
            </span>
            <span>Right-click for more</span>
            {editing && <span>Drag a port to connect</span>}
          </div>

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
            onJump={setPan}
          />

          {menu && (
            <div
              role="menu"
              className="rise-in absolute z-30 flex min-w-48 flex-col rounded-panel bg-overlay p-1 shadow-4"
              style={{
                left: Math.max(4, Math.min(menu.x, (canvas.current?.clientWidth ?? 400) - 200)),
                top: Math.max(4, Math.min(menu.y, (canvas.current?.clientHeight ?? 400) - 220)),
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              {menuItems(menu).map((item, i) =>
                item === "divider" ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a divider has nothing else to go by.
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

      {inspectorOpen && (
        <aside
          aria-label="Inspector"
          // On a phone it covers the canvas and its toolbar, on purpose.
          data-e2e-overlap
          className="absolute inset-y-0 right-0 z-20 flex w-full flex-col border-l border-line bg-pane shadow-4 @3xl/app:static @3xl/app:w-[340px] @3xl/app:shadow-none"
        >
          {picking && <Picker onPick={addNode} onClose={() => setPicking(null)} />}
          {!picking && !selection && walk && (
            <WalkPanel
              walk={walk}
              flow={flowById(walk.flowId)}
              onAdvance={advance}
              onKind={(kind) => startWalk(walk.flowId, kind)}
              onRestart={() => startWalk(walk.flowId)}
              onClose={() => setWalk(null)}
            />
          )}
          {!picking && selection && selectedNode && (
            <NodeInspector
              projectId={projectId}
              node={selectedNode}
              flow={selectedFlow}
              editing={editing}
              onChange={(change) =>
                edit(selection.flowId, (f) => withNodeChange(f, selectedNode.id, change))
              }
              onConfig={(config) =>
                edit(selection.flowId, (f) => withConfig(f, selectedNode.id, config))
              }
              onAddAfter={(outcome) =>
                setPicking({
                  flowId: selection.flowId,
                  at: besides(selectedNode, outcome),
                  from: selectedNode.id,
                })
              }
              onConnect={(outcome, to) =>
                edit(selection.flowId, (f) => withLink(f, selectedNode.id, outcome, to))
              }
              onSelectConnector={(id) =>
                setSelection({ kind: "connector", id, flowId: selection.flowId })
              }
              onDelete={() => removeNode(selection.flowId, selectedNode.id)}
              onClose={() => setSelection(null)}
            />
          )}
          {!picking && selection && selectedConnector && (
            <ConnectorInspector
              connector={selectedConnector}
              flow={selectedFlow?.definition}
              editing={editing}
              onChange={(change) =>
                edit(selection.flowId, (f) => ({
                  ...f,
                  connectors: f.connectors.map((c) => {
                    if (c.id !== selectedConnector.id) return c;
                    const next = { ...c, ...change };
                    if ("condition" in change && !change.condition) delete next.condition;
                    if ("until" in change && !change.until) delete next.until;
                    return next;
                  }),
                }))
              }
              onDelete={() => removeConnector(selection.flowId, selectedConnector.id)}
              onClose={() => setSelection(null)}
            />
          )}
        </aside>
      )}

      {!inspectorOpen && allProblems.length > 0 && (
        <button
          type="button"
          onClick={() => {
            const p = allProblems[0];
            if (p?.nodeId) setSelection({ kind: "node", id: p.nodeId, flowId: p.flowId });
            else if (p?.connectorId)
              setSelection({ kind: "connector", id: p.connectorId, flowId: p.flowId });
            if (p) jumpTo(p.flowId);
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

/** One node on the canvas: its family's shape, what it is, its ports, and what it breaks. */
function CanvasNode({
  flowId,
  node,
  selected,
  walked,
  current,
  trigger,
  problem,
  editing,
  onPointerDown,
  onPortDown,
  onSelect,
  onContextMenu,
}: {
  flowId: string;
  node: WorkflowNode;
  selected: boolean;
  /** Reached by the item being walked through, and waited on by it now. */
  walked: boolean;
  current: boolean;
  trigger: boolean;
  problem?: WorkflowProblem;
  editing: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onPortDown: (outcome: string, e: React.PointerEvent) => void;
  onSelect: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const info = nodeTypes[node.type];
  const outs = outcomesOf(node.type);
  const family = familyOf(node.type);
  const subtitle =
    info.kind === "event"
      ? trigger
        ? "Starts here"
        : "Waits for it"
      : [node.config.who ?? node.config.to, node.config.due ? `${node.config.due} d` : null]
          .filter(Boolean)
          .join(" · ") || info.label;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dragged by pointer; its own button below is what the keyboard reaches.
    <div
      data-node={node.id}
      data-flow={flowId}
      data-e2e-overlap
      onPointerDown={onPointerDown}
      onContextMenu={onContextMenu}
      className={cn(
        "absolute flex touch-none items-center border bg-overlay px-3 shadow-3 transition-[box-shadow,border-color] select-none",
        editing ? "cursor-grab" : "cursor-pointer",
        families[family].shape,
        selected
          ? "border-signal shadow-[0_0_0_3px_var(--hk-signal-line),var(--hk-shadow-3)]"
          : walked
            ? "border-ink-3"
            : "border-line hover:border-line-strong",
        current && "ring-2 ring-signal/60",
      )}
      style={{ left: node.x, top: node.y, width: NODE_W, height: NODE_H }}
    >
      <button
        type="button"
        aria-label={`${node.name}, ${info.label}${problem ? `: ${problem.text}` : ""}`}
        aria-pressed={selected}
        // From the keyboard; a pointer selects on letting go without dragging.
        onClick={(e) => {
          if (e.detail === 0) onSelect();
        }}
        className="flex min-w-0 flex-1 cursor-[inherit] items-center gap-3 rounded-control text-left"
      >
        <span
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-control",
            familyTiles[family],
          )}
        >
          <Icon name={nodeLooks[node.type].icon} size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink">{node.name}</span>
          <span className="block truncate text-[11px] text-ink-3">{subtitle}</span>
        </span>
      </button>
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
          style={{ left: NODE_W - 7, top: portTop(node.type, i) - 7 }}
        >
          {/* A handle to drag a connector from; the inspector's Then list does the same for a
              keyboard, so the handle is hidden from assistive technology. */}
          <span
            aria-hidden="true"
            data-port={o.id}
            title={`Connect from ${node.name}${o.label ? `: ${o.label}` : ""}`}
            onPointerDown={(e) => {
              e.stopPropagation();
              onPortDown(o.id, e);
            }}
            className={cn(
              "size-3.5 rounded-full border-2 border-ink-3 bg-overlay transition-colors",
              editing && "cursor-crosshair hover:border-signal hover:bg-signal",
            )}
          />
          {o.label && (
            <span className="pointer-events-none ml-2 -translate-y-[10px] text-[11px] whitespace-nowrap text-ink-3">
              {o.label}
            </span>
          )}
        </span>
      ))}
      {info.kind === "action" && (
        <span
          className="absolute size-3.5 rounded-full border-2 border-ink-3 bg-overlay"
          style={{ left: -7, top: NODE_H / 2 - 7 }}
        />
      )}
    </div>
  );
}

function Minimap({
  bounds,
  nodes,
  pan,
  zoom,
  size,
  onJump,
}: {
  bounds: Bounds;
  nodes: { x: number; y: number; event: boolean }[];
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
          // biome-ignore lint/suspicious/noArrayIndexKey: the map only draws where nodes are.
          key={i}
          x={n.x * s + ox}
          y={n.y * s + oy}
          width={NODE_W * s}
          height={NODE_H * s}
          rx={2}
          className={n.event ? "fill-signal/70" : "fill-ink-3/70"}
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

function PanelHead({
  title,
  hint,
  onClose,
  children,
}: {
  title: string;
  hint?: string;
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-2 border-b border-line px-4 py-3">
      <div className="min-w-0 flex-1">
        <h2 className="m-0 truncate text-[14px] font-medium text-ink">{title}</h2>
        {hint && <p className="m-0 text-[12px] text-ink-3">{hint}</p>}
      </div>
      {children}
      <Button variant="quiet" size="iconSm" aria-label="Close" onClick={onClose}>
        <Icon name="close" size={14} />
      </Button>
    </div>
  );
}

function Picker({ onPick, onClose }: { onPick: (t: NodeType) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const hit = (s: string) => s.toLowerCase().includes(q.trim().toLowerCase());
  return (
    <>
      <PanelHead
        title="What happens next?"
        hint="Pick a node; it is wired from the selected one."
        onClose={onClose}
      />
      <div className="flex flex-col gap-3 px-3 pt-3">
        <Input
          aria-label="Search nodes"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search nodes"
          autoFocus
        />
        <Legend compact />
      </div>
      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto p-2">
        {pickerGroups.map((g) => {
          const types = g.types.filter((t) => hit(nodeTypes[t].label) || hit(nodeLooks[t].hint));
          if (types.length === 0) return null;
          return (
            <div key={g.group} className="mb-2">
              <div className={cn("px-2 pt-2 pb-1", eyebrow)}>{g.group}</div>
              {types.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => onPick(t)}
                  className="flex w-full items-center gap-3 rounded-control px-2 py-1.5 text-left transition-colors hover:bg-raised"
                >
                  <span
                    className={cn(
                      "flex size-7 shrink-0 items-center justify-center rounded-control",
                      familyTiles[familyOf(t)],
                    )}
                  >
                    <Icon name={nodeLooks[t].icon} size={14} />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] text-ink">
                      {nodeTypes[t].label}
                    </span>
                    <span className="block truncate text-[12px] text-ink-3">
                      {nodeLooks[t].hint}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </>
  );
}

function WalkPanel({
  walk,
  flow,
  onAdvance,
  onKind,
  onRestart,
  onClose,
}: {
  walk: Walk;
  flow?: WorkflowSummary;
  onAdvance: (nodeId: string, outcome: string) => void;
  onKind: (kind: ItemKind) => void;
  onRestart: () => void;
  onClose: () => void;
}) {
  const waiting = (walk.run?.active ?? [])
    .map((id) => flow?.definition.nodes.find((n) => n.id === id))
    .filter((n): n is WorkflowNode => Boolean(n));
  return (
    <>
      <PanelHead title="Walk an item through" hint={flow?.name} onClose={onClose} />
      <div className="scroll-quiet flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <label className="flex items-center gap-2 text-[12px] text-ink-3">
          The item is
          <Select
            className="w-auto"
            size="sm"
            value={walk.kind}
            onChange={(e) => onKind(e.target.value as ItemKind)}
          >
            <option value="audio">audio</option>
            <option value="video">video</option>
            <option value="document">a document</option>
            <option value="image">a picture</option>
          </Select>
        </label>
        {walk.refused ? (
          <p className="m-0 rounded-panel border border-signal/40 bg-signal/10 px-3 py-2 text-[12px] text-ink">
            It cannot run: {walk.refused}
          </p>
        ) : (
          <ol
            aria-label="What happened"
            className="m-0 flex list-none flex-col gap-1.5 p-0 text-[13px] text-ink-2"
          >
            {walk.log.map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the log only grows, in order.
              <li key={i} className="flex gap-2">
                <span className="tabular w-4 shrink-0 text-ink-3">{i + 1}</span>
                <span className={i === walk.log.length - 1 ? "text-ink" : undefined}>{line}</span>
              </li>
            ))}
          </ol>
        )}
        {waiting.map((n) => (
          <div key={n.id} className="flex flex-col gap-1.5">
            <span className={eyebrow}>What happens at “{n.name}”?</span>
            {outcomesOf(n.type).map((o) => (
              <Button key={o.id} variant="secondary" onClick={() => onAdvance(n.id, o.id)}>
                {outcomeWords(n.type, o.id)}
              </Button>
            ))}
          </div>
        ))}
        {walk.run && walk.run.state !== "running" && (
          <p className="m-0 text-[13px] text-ink-3">
            {walk.run.state === "finished"
              ? `The item is finished${walk.run.status ? `, ${walk.run.status}` : ""}.`
              : "The walk ended."}
          </p>
        )}
        <Button variant="ghost" size="sm" onClick={onRestart} className="self-start">
          Start again
        </Button>
      </div>
    </>
  );
}

function NodeInspector({
  projectId,
  node,
  flow,
  editing,
  onChange,
  onConfig,
  onAddAfter,
  onConnect,
  onSelectConnector,
  onDelete,
  onClose,
}: {
  projectId: string;
  node: WorkflowNode;
  flow?: WorkflowSummary;
  editing: boolean;
  onChange: (change: Partial<Pick<WorkflowNode, "name" | "groupId">>) => void;
  onConfig: (config: Record<string, string>) => void;
  onAddAfter: (outcome: string) => void;
  onConnect: (outcome: string, to: string) => void;
  onSelectConnector: (id: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const info = nodeTypes[node.type];
  const outs = outcomesOf(node.type);
  const definition = flow?.definition;
  const isTrigger = definition ? triggersOf(definition).some((t) => t.id === node.id) : false;
  const loops = definition ? flowShape(definition).loops : new Set<string>();
  const problems = flow?.problems.filter((p) => p.nodeId === node.id) ?? [];
  return (
    <>
      <PanelHead
        title={node.name}
        hint={`${info.kind === "event" ? (isTrigger ? "Event, starts the workflow" : "Event, waited for") : "Action"} · ${info.label}`}
        onClose={onClose}
      >
        {editing && (
          <Dropdown
            size="sm"
            align="right"
            label="More"
            value={<Icon name="more" size={14} />}
            actions={[{ label: "Delete", danger: true, onSelect: onDelete }]}
          />
        )}
      </PanelHead>
      <div className="scroll-quiet flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {problems.map((p) => (
          <p
            key={p.text}
            className={cn(
              "m-0 rounded-panel border px-3 py-2 text-[12px]",
              p.level === "error"
                ? "border-signal/40 bg-signal/10 text-ink"
                : "border-line bg-raised/40 text-ink-2",
            )}
          >
            {p.text}
          </p>
        ))}
        <div className="flex flex-col gap-1.5 text-[12px] text-ink-3">
          <span aria-hidden="true">Name</span>
          <Committed
            label="Name"
            value={node.name}
            size="md"
            disabled={!editing}
            onCommit={(name) => name && onChange({ name })}
          />
        </div>
        {nodeLooks[node.type].fields.map((f) => (
          <StepField
            key={f.id}
            projectId={projectId}
            node={node}
            field={f}
            editing={editing}
            stacked
            onChange={(value) => onConfig({ [f.id]: value })}
          />
        ))}
        {definition && definition.groups.length > 0 && (
          <label className="flex flex-col gap-1.5 text-[12px] text-ink-3">
            Stage
            <Select
              value={node.groupId ?? ""}
              disabled={!editing}
              onChange={(e) => onChange({ groupId: e.target.value || undefined })}
            >
              <option value="">None</option>
              {definition.groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          </label>
        )}
        {outs.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className={eyebrow}>Then</span>
            <div className="flex flex-col gap-1.5">
              {outs.map((o) => {
                const links =
                  definition?.connectors.filter((c) => c.from === node.id && c.outcome === o.id) ??
                  [];
                const others = definition?.nodes.filter((n) => n.id !== node.id) ?? [];
                return (
                  <div key={o.id} className="rounded-panel border border-line px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[12px] text-ink-3">
                        {o.label
                          ? `When ${o.label}`
                          : info.kind === "event"
                            ? "When it happens"
                            : "When done"}
                      </span>
                      {editing && (
                        <Dropdown
                          size="sm"
                          align="right"
                          label={`Add after ${o.label || "it"}`}
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
                              onSelect: () => onConnect(o.id, n.id),
                            })),
                          ]}
                        />
                      )}
                    </div>
                    {links.length === 0 ? (
                      <p className="m-0 mt-1 text-[13px] text-ink-3">Nothing yet</p>
                    ) : (
                      <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
                        {links.map((c) => {
                          const to = definition?.nodes.find((n) => n.id === c.to);
                          const text = conditionText(c);
                          return (
                            <li key={c.id}>
                              <button
                                type="button"
                                onClick={() => onSelectConnector(c.id)}
                                className="flex w-full items-center gap-2 rounded-control px-1.5 py-1 text-left text-[13px] text-ink transition-colors hover:bg-raised"
                              >
                                <Icon
                                  name={loops.has(c.id) ? "repeat" : "arrowRight"}
                                  size={13}
                                  className="text-ink-3"
                                />
                                <span className="min-w-0 flex-1 truncate">{to?.name}</span>
                                {text && (
                                  <span className="max-w-[45%] truncate text-[11px] text-ink-3">
                                    {text}
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

type Test = WorkflowCondition["test"] | "";

function ConnectorInspector({
  connector,
  flow,
  editing,
  onChange,
  onDelete,
  onClose,
}: {
  connector: WorkflowConnector;
  flow?: WorkflowDefinition;
  editing: boolean;
  onChange: (change: Partial<Pick<WorkflowConnector, "outcome" | "condition" | "until">>) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const from = flow?.nodes.find((n) => n.id === connector.from);
  const to = flow?.nodes.find((n) => n.id === connector.to);
  const loop = flow ? flowShape(flow).loops.has(connector.id) : false;
  const outs = from ? outcomesOf(from.type) : [];
  const condition = connector.condition;
  const setTest = (test: Test) =>
    onChange({
      condition:
        test === "kind"
          ? { test, is: "audio" }
          : test === "tag"
            ? { test, is: condition?.test === "tag" ? condition.is : "Final" }
            : test === "by"
              ? { test, is: "guest" }
              : undefined,
    });
  return (
    <>
      <PanelHead
        title={loop ? "Loop" : "Connector"}
        hint={`${from?.name ?? "?"} → ${to?.name ?? "?"}`}
        onClose={onClose}
      >
        {editing && (
          <Dropdown
            size="sm"
            align="right"
            label="More"
            value={<Icon name="more" size={14} />}
            actions={[{ label: "Remove", danger: true, onSelect: onDelete }]}
          />
        )}
      </PanelHead>
      <div className="flex flex-col gap-4 p-4">
        {outs.length > 1 && (
          <label className="flex flex-col gap-1.5 text-[12px] text-ink-3">
            Leaves “{from?.name}” when
            <Select
              value={connector.outcome}
              disabled={!editing}
              onChange={(e) => onChange({ outcome: e.target.value })}
            >
              {outs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </Select>
          </label>
        )}
        <div className="flex flex-col gap-1.5 text-[12px] text-ink-3">
          <span>Only if</span>
          <div className="flex flex-wrap gap-2">
            <Select
              aria-label="Only if"
              className="w-auto"
              value={condition?.test ?? ""}
              disabled={!editing}
              onChange={(e) => setTest(e.target.value as Test)}
            >
              <option value="">Always</option>
              <option value="kind">The file is</option>
              <option value="tag">The file is tagged</option>
              <option value="by">Who decided was</option>
            </Select>
            {condition && (
              <Select
                aria-label="Is or is not"
                className="w-auto"
                value={condition.not ? "not" : "is"}
                disabled={!editing}
                onChange={(e) =>
                  onChange({
                    condition: { ...condition, not: e.target.value === "not" || undefined },
                  })
                }
              >
                <option value="is">so</option>
                <option value="not">not so</option>
              </Select>
            )}
            {condition?.test === "kind" && (
              <Select
                aria-label="Kind of file"
                className="w-auto"
                value={condition.is}
                disabled={!editing}
                onChange={(e) =>
                  onChange({
                    condition: {
                      ...condition,
                      is: e.target.value as "audio" | "video" | "document" | "image",
                    },
                  })
                }
              >
                <option value="audio">audio</option>
                <option value="video">video</option>
                <option value="document">a document</option>
                <option value="image">a picture</option>
              </Select>
            )}
            {condition?.test === "tag" && (
              <Committed
                label="Tag"
                value={condition.is}
                size="md"
                className="w-36"
                disabled={!editing}
                onCommit={(is) => is && onChange({ condition: { ...condition, is } })}
              />
            )}
            {condition?.test === "by" && (
              <Select
                aria-label="Who decided"
                className="w-auto"
                value={condition.is}
                disabled={!editing}
                onChange={(e) =>
                  onChange({
                    condition: { ...condition, is: e.target.value as "member" | "guest" },
                  })
                }
              >
                <option value="guest">a guest</option>
                <option value="member">a member</option>
              </Select>
            )}
          </div>
        </div>
        {loop && (
          <div className="flex flex-col gap-1.5 text-[12px] text-ink-3">
            <span aria-hidden="true">Way out of the loop: at most, in times</span>
            <Committed
              label="Times round the loop at most"
              value={connector.until ? String(connector.until.times) : ""}
              placeholder="3"
              size="md"
              className="w-24"
              disabled={!editing}
              onCommit={(value) => {
                const times = Number.parseInt(value, 10);
                onChange({
                  until:
                    Number.isFinite(times) && times > 0
                      ? { times: Math.min(times, 100) }
                      : undefined,
                });
              }}
            />
          </div>
        )}
        <p className="m-0 text-[12px] text-ink-3">
          {loop
            ? "This connector goes back to an earlier node, so the item loops. Give it a bound or a condition that stops it."
            : "A condition narrows when the item takes this connector; without one it always does, for this outcome."}
        </p>
      </div>
    </>
  );
}
