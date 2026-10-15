import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "~/components/icons";
import { Label } from "~/components/label";
import { usePageHeader } from "~/components/page-header";
import { Dot } from "~/components/status";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Input, Select } from "~/components/ui/input";
import { Dropdown } from "~/components/ui/menu";
import { Switch } from "~/components/ui/toggle";
import { type Project, projectById, type Stage, type StageKind, tracks, workflows } from "~/data";
import { cn } from "~/lib/cn";
import { useViewer } from "~/viewer/context";
import { Refused } from "~/viewer/state-gate";

const kindIcon: Record<StageKind, IconName> = {
  approval: "check",
  feedback: "comment",
  task: "edit",
};
const kindCopy: Record<StageKind, string> = {
  approval: "Approval",
  feedback: "Feedback",
  task: "Task",
};

const NODE_W = 196;
const NODE_H = 60;
const COL = 244;
const ROW = 88;

/** Stages in layers by what they come after; the start node sits before the first layer. */
function layout(stages: Stage[]) {
  const depth = new Map<string, number>();
  const d = (s: Stage): number => {
    const known = depth.get(s.id);
    if (known !== undefined) return known;
    const v =
      s.after.length === 0
        ? 0
        : 1 + Math.max(...s.after.map((a) => d(stages.find((x) => x.id === a) as Stage)));
    depth.set(s.id, v);
    return v;
  };
  for (const s of stages) d(s);
  const byDepth = new Map<number, Stage[]>();
  for (const s of stages) {
    const list = byDepth.get(depth.get(s.id) ?? 0) ?? [];
    list.push(s);
    byDepth.set(depth.get(s.id) ?? 0, list);
  }
  const maxRows = Math.max(1, ...[...byDepth.values()].map((l) => l.length));
  const pos = new Map<string, { x: number; y: number }>();
  for (const [dep, list] of byDepth) {
    const offset = ((maxRows - list.length) * ROW) / 2;
    list.forEach((s, i) => {
      pos.set(s.id, { x: 120 + dep * COL, y: 40 + offset + i * ROW });
    });
  }
  const cols = Math.max(...[...byDepth.keys()]) + 2;
  return {
    pos,
    width: 60 + cols * COL + NODE_W,
    height: 80 + maxRows * ROW,
    start: { x: 60, y: 40 + ((maxRows - 1) * ROW) / 2 },
  };
}

/** A curve from one point to another, leaving and arriving horizontally. */
const edgePath = (x1: number, y1: number, x2: number, y2: number) => {
  const c = Math.max(40, (x2 - x1) / 2);
  return `M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}`;
};

const templates = [
  { id: "simple", name: "Simple approval", hint: "One approval stage, everyone approves" },
  { id: "conductor", name: "Conductor first", hint: "Feedback, triage, edit, approval" },
  {
    id: "parallel",
    name: "Parallel stakeholders",
    hint: "Several feedback stages at once, then lock",
  },
];

const uploadChecks = [
  { id: "tp", name: "True peak ceiling", hint: "From the delivery profile", action: "refuse" },
  {
    id: "lufs",
    name: "Loudness within tolerance",
    hint: "From the delivery profile",
    action: "warn",
  },
  {
    id: "fmt",
    name: "Format matches the profile",
    hint: "Rate, bit depth and layout",
    action: "warn",
  },
  {
    id: "edl",
    name: "Edit decision list attached",
    hint: "For versions after the first",
    action: "off",
  },
];

/** The canvas: stages, their transitions, the inspector, simulation and the upload rules. */
export function WorkflowPage({ project }: { project: Project }) {
  const viewer = useViewer();
  const canEdit = viewer.can(project.id, "edit_workflows");
  const workflow = workflows.find((w) => w.id === project.workflowId);
  const [stages, setStages] = useState<Stage[]>(workflow?.stages ?? []);
  const [selected, setSelected] = useState<string | null>(stages[0]?.id ?? null);
  const [tab, setTab] = useState<"stages" | "upload" | "overrides">("stages");
  const [simulating, setSimulating] = useState<string | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [activated, setActivated] = useState(false);
  const { pos, width, height, start } = useMemo(() => layout(stages), [stages]);
  const [zoom, setZoom] = useState<number | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const [canvasWidth, setCanvasWidth] = useState(900);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setCanvasWidth(Math.floor(e.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const fit = Math.min(1, Math.max(0.72, (canvasWidth - 32) / width));
  const scale = zoom ?? fit;
  const current = stages.find((s) => s.id === selected) ?? null;
  const invalid = stages.filter((s) => s.after.some((a) => !stages.some((x) => x.id === a)));
  const name = workflow?.name ?? "Workflow";

  usePageHeader({
    crumbs: [
      { label: project.name, to: `/projects/${project.id}` },
      { label: "Settings", to: `/projects/${project.id}/settings` },
    ],
    title: name,
    actions: canEdit ? (
      <>
        <Button
          variant="ghost"
          onClick={() => setSimulating(simulating ? null : (stages[0]?.id ?? null))}
        >
          <Icon name="play" size={12} fill="currentColor" strokeWidth={0} />
          {simulating ? "Stop simulating" : "Simulate"}
        </Button>
        <Button variant="primary" onClick={() => setActivated(true)} disabled={invalid.length > 0}>
          {activated ? "Active" : "Activate"}
        </Button>
      </>
    ) : undefined,
    revision: `${simulating}-${activated}-${invalid.length}`,
  });
  if (!workflow) return <Refused />;

  const update = (patch: Partial<Stage>) =>
    setStages((list) => list.map((s) => (s.id === selected ? { ...s, ...patch } : s)));
  const addStage = () => {
    const id = `st-new-${stages.length}`;
    setStages((list) => [
      ...list,
      {
        id,
        kind: "feedback",
        name: "New stage",
        participants: "Choose people",
        after: selected ? [selected] : [],
        status: workflow.statuses[0]?.name ?? "",
      },
    ]);
    setSelected(id);
  };
  const removeStage = () => {
    setStages((list) =>
      list
        .filter((s) => s.id !== selected)
        .map((s) => ({ ...s, after: s.after.filter((a) => a !== selected) })),
    );
    setSelected(null);
  };
  const successors = (id: string) => stages.filter((s) => s.after.includes(id));
  const simStage = simulating ? stages.find((s) => s.id === simulating) : null;

  return (
    <div className="fade-in flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        <div role="tablist" className="flex gap-1">
          {(
            [
              ["stages", "Stages"],
              ["upload", "Upload rules"],
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
        {tab === "stages" && canEdit && (
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
                  onSelect: () => setStages(w.stages),
                }))}
            />
            <Button variant="secondary" size="md" onClick={addStage}>
              <Icon name="plus" size={14} />
              Stage
            </Button>
          </div>
        )}
      </div>
      {tab === "stages" && (
        <div className="flex min-h-0 flex-1 flex-col @3xl/app:flex-row">
          <div
            ref={canvas}
            className="scroll-quiet relative flex min-h-[320px] flex-1 items-center overflow-auto bg-[radial-gradient(circle_at_1px_1px,var(--hk-line)_1px,transparent_0)] bg-[length:24px_24px] py-6"
          >
            <svg
              width={Math.max(width * scale, 300)}
              height={Math.max(height * scale, 300)}
              viewBox={`0 0 ${Math.max(width, 300 / scale)} ${Math.max(height, 300 / scale)}`}
              className="block"
              role="img"
              aria-label="Workflow diagram"
            >
              <defs>
                <marker
                  id="arrow"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="8"
                  markerHeight="8"
                  orient="auto-start-reverse"
                >
                  <path d="M0,0 L10,5 L0,10 z" fill="var(--hk-edge-strong)" />
                </marker>
                <marker
                  id="arrow-hot"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="8"
                  markerHeight="8"
                  orient="auto-start-reverse"
                >
                  <path d="M0,0 L10,5 L0,10 z" fill="var(--hk-signal)" />
                </marker>
              </defs>
              {stages.map((s) => {
                const to = pos.get(s.id);
                if (!to) return null;
                const sources =
                  s.after.length === 0
                    ? [{ x: start.x + 56, y: start.y + 16 }]
                    : s.after
                        .map((a) => pos.get(a))
                        .filter((p): p is { x: number; y: number } => Boolean(p))
                        .map((p) => ({ x: p.x + NODE_W, y: p.y + NODE_H / 2 }));
                return sources.map((from, i) => {
                  const hot = simulating === s.id || s.after.some((a) => a === simulating);
                  const active =
                    selected === s.id || (s.after[i] !== undefined && s.after[i] === selected);
                  return (
                    <path
                      key={`${s.id}-${String(i)}`}
                      d={edgePath(from.x, from.y, to.x, to.y + NODE_H / 2)}
                      fill="none"
                      stroke={
                        hot
                          ? "var(--hk-signal)"
                          : active
                            ? "var(--hk-ink-3)"
                            : "var(--hk-edge-strong)"
                      }
                      strokeWidth={hot || active ? 2 : 1.5}
                      markerEnd={hot ? "url(#arrow-hot)" : "url(#arrow)"}
                      className="transition-[stroke] duration-200"
                    />
                  );
                });
              })}
              <g transform={`translate(${start.x}, ${start.y})`}>
                <rect
                  width={56}
                  height={32}
                  rx={16}
                  fill="var(--hk-raised)"
                  stroke="var(--hk-line-strong)"
                />
                <text
                  x={28}
                  y={20}
                  textAnchor="middle"
                  fill="var(--hk-ink-2)"
                  fontSize={12}
                  fontFamily="var(--hk-font-sans)"
                  fontWeight={500}
                >
                  Start
                </text>
              </g>
              {stages.map((s) => {
                const p = pos.get(s.id);
                if (!p) return null;
                const isSel = selected === s.id;
                const isSim = simulating === s.id;
                const status = workflow.statuses.find((st) => st.name === s.status);
                return (
                  <g
                    key={s.id}
                    transform={`translate(${p.x}, ${p.y})`}
                    onClick={() => setSelected(s.id)}
                    className="cursor-pointer"
                    role="button"
                    aria-label={`${s.name}, ${kindCopy[s.kind]}`}
                  >
                    <rect
                      width={NODE_W}
                      height={NODE_H}
                      rx={10}
                      fill={
                        isSim
                          ? "color-mix(in oklab, var(--hk-signal) 14%, var(--hk-raised))"
                          : isSel
                            ? "var(--hk-overlay)"
                            : "var(--hk-raised)"
                      }
                      stroke={
                        isSim
                          ? "var(--hk-signal)"
                          : isSel
                            ? "var(--hk-ink-3)"
                            : "var(--hk-line-strong)"
                      }
                      strokeWidth={isSel || isSim ? 1.5 : 1}
                      className="transition-[fill,stroke] duration-200"
                      style={{
                        filter: isSel
                          ? "drop-shadow(0 8px 20px rgb(0 0 0 / 0.5))"
                          : "drop-shadow(0 2px 6px rgb(0 0 0 / 0.35))",
                      }}
                    />
                    <foreignObject x={0} y={0} width={NODE_W} height={NODE_H}>
                      <div className="flex h-full items-center gap-3 px-3">
                        <span
                          className={cn(
                            "flex size-7 shrink-0 items-center justify-center rounded-full",
                            isSim ? "bg-signal text-ground" : "bg-ground/60 text-ink-2",
                          )}
                        >
                          <Icon name={kindIcon[s.kind]} size={13} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium text-ink">
                            {s.name}
                          </span>
                          <span className="block truncate text-[11px] text-ink-3">
                            {kindCopy[s.kind]} · {s.participants}
                          </span>
                        </span>
                      </div>
                    </foreignObject>
                    {status && (
                      <g transform={`translate(${NODE_W - 10}, -8)`}>
                        <circle
                          r={5}
                          fill={status.category === "done" ? "var(--hk-ink)" : "var(--hk-raised)"}
                          stroke="var(--hk-ink-3)"
                          strokeWidth={1.5}
                        />
                      </g>
                    )}
                  </g>
                );
              })}
            </svg>
            <div className="absolute right-3 bottom-3 flex items-center gap-0.5 rounded-control bg-overlay p-0.5 shadow-3">
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
            </div>
            <div className="absolute right-3 bottom-3 flex items-center gap-0.5 rounded-control bg-overlay p-0.5 shadow-3">
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
            </div>
            <div className="pointer-events-none absolute bottom-3 left-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-3">
              {(["todo", "in_progress", "done"] as const).map((cat) => (
                <span key={cat} className="flex items-center gap-2">
                  <Dot
                    state={cat === "done" ? "approved" : cat === "todo" ? "invited" : "in_review"}
                  />
                  {cat === "todo" ? "To do" : cat === "in_progress" ? "In progress" : "Done"}:{" "}
                  {workflow.statuses
                    .filter((s) => s.category === cat)
                    .map((s) => s.name)
                    .join(", ") || "none"}
                </span>
              ))}
              {invalid.length > 0 && (
                <span className="flex items-center gap-1.5 text-signal">
                  <Icon name="warning" size={12} /> {invalid.length} stage
                  {invalid.length === 1 ? "" : "s"} point at nothing
                </span>
              )}
            </div>
          </div>
          <aside className="scroll-quiet flex w-full shrink-0 flex-col gap-5 overflow-auto border-t border-line p-4 @3xl/app:w-[320px] @3xl/app:border-t-0 @3xl/app:border-l">
            {simulating && simStage ? (
              <div className="flex flex-col gap-3">
                <Label>Simulating</Label>
                <p className="text-[14px] text-ink">
                  <span className="font-medium">{simStage.name}</span>
                  <span className="block text-[13px] text-ink-3">
                    The track is {simStage.status}; {simStage.participants}{" "}
                    {simStage.kind === "task" ? "work on it" : "are asked"}.
                  </span>
                </p>
                <div className="flex flex-col gap-1.5">
                  {(simStage.kind === "approval"
                    ? ["Approved", "Changes requested"]
                    : simStage.kind === "feedback"
                      ? ["Feedback submitted"]
                      : ["Done"]
                  ).map((outcome) => {
                    const next =
                      outcome === "Changes requested"
                        ? stages.find((s) => s.kind === "task" && s.after.length > 0)
                        : successors(simStage.id)[0];
                    return (
                      <Button
                        key={outcome}
                        variant="secondary"
                        size="md"
                        className="justify-between"
                        onClick={() => setSimulating(next?.id ?? null)}
                      >
                        {outcome}
                        <span className="text-[12px] text-ink-3">
                          {next ? `→ ${next.name}` : "→ end"}
                        </span>
                      </Button>
                    );
                  })}
                </div>
                <p className="text-[12px] text-ink-3">Nothing is sent while simulating.</p>
              </div>
            ) : current ? (
              <>
                <div className="flex items-center gap-2">
                  <Label>Stage</Label>
                  {canEdit && (
                    <button
                      type="button"
                      onClick={removeStage}
                      className="ml-auto text-[12px] text-ink-3 hover:text-signal"
                    >
                      Delete
                    </button>
                  )}
                </div>
                <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                  Name
                  <Input
                    value={current.name}
                    onChange={(e) => update({ name: e.target.value })}
                    disabled={!canEdit}
                  />
                </label>
                <div className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                  Kind
                  <div className="flex gap-1">
                    {(["approval", "feedback", "task"] as StageKind[]).map((k) => (
                      <button
                        key={k}
                        type="button"
                        aria-pressed={current.kind === k}
                        disabled={!canEdit}
                        onClick={() => update({ kind: k })}
                        className={cn(
                          "flex h-8 flex-1 items-center justify-center gap-1.5 rounded-control border text-[13px] transition-colors",
                          current.kind === k
                            ? "border-signal/60 bg-signal/10 text-ink"
                            : "border-line text-ink-3 hover:border-edge hover:text-ink",
                        )}
                      >
                        <Icon name={kindIcon[k]} size={12} />
                        {kindCopy[k]}
                      </button>
                    ))}
                  </div>
                </div>
                <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                  Participants
                  <Input
                    value={current.participants}
                    onChange={(e) => update({ participants: e.target.value })}
                    disabled={!canEdit}
                  />
                  <span className="text-[12px] text-ink-3">A role, a group, people or guests.</span>
                </label>
                {current.kind !== "task" && (
                  <>
                    <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                      Order
                      <Select defaultValue="parallel" disabled={!canEdit}>
                        <option value="parallel">All at once</option>
                        <option value="sequence">In turn</option>
                      </Select>
                    </label>
                    {current.kind === "approval" && (
                      <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                        Approved when
                        <Select
                          defaultValue={current.participants.includes("any") ? "any" : "all"}
                          disabled={!canEdit}
                        >
                          <option value="all">Everyone approves</option>
                          <option value="any">Any one approves</option>
                          <option value="quorum">A share approves</option>
                        </Select>
                      </label>
                    )}
                  </>
                )}
                <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                  After
                  <Select
                    multiple
                    value={current.after}
                    disabled={!canEdit}
                    onChange={(e) =>
                      update({ after: [...e.target.selectedOptions].map((o) => o.value) })
                    }
                    className="h-auto py-1"
                  >
                    {stages
                      .filter((s) => s.id !== current.id)
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                  </Select>
                  <span className="text-[12px] text-ink-3">
                    Nothing chosen means it starts the workflow.
                  </span>
                </label>
                <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                  Sets the status
                  <Select
                    value={current.status}
                    onChange={(e) => update({ status: e.target.value })}
                    disabled={!canEdit}
                  >
                    {workflow.statuses.map((s) => (
                      <option key={s.name} value={s.name}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="flex flex-col gap-1.5 text-[13px] text-ink-2">
                  Due
                  <span className="flex items-center gap-2">
                    <Input defaultValue="5" className="w-16 text-center" disabled={!canEdit} />
                    <span className="text-ink-3">days after the stage starts</span>
                  </span>
                </label>
                <div className="flex flex-col gap-2 text-[13px] text-ink-2">
                  Notify on entering
                  {[
                    "Participants, in the app",
                    "Participants, by mail",
                    "The producer, when it ends",
                  ].map((n, i) => (
                    <span key={n} className="flex items-center justify-between text-ink">
                      {n}
                      <Switch label={n} checked={i < 2} onChange={() => {}} />
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-[13px] text-ink-3">Choose a stage on the canvas, or add one.</p>
            )}
          </aside>
        </div>
      )}
      {tab === "upload" && (
        <div className="scroll-quiet min-h-0 flex-1 overflow-auto p-4 @3xl/app:p-6">
          <div className="mx-auto flex max-w-[720px] flex-col gap-4">
            <p className="text-[14px] text-ink-2">
              Checks that run on every file as it arrives. A check can warn, refuse the upload, or
              stay off. A producer can let a refused file through.
            </p>
            <ul className="flex flex-col divide-y divide-line rounded-panel-lg border border-line bg-raised/25">
              {uploadChecks.map((c) => (
                <li key={c.id} className="flex items-center gap-4 px-4 py-3">
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] text-ink">{c.name}</span>
                    <span className="block text-[13px] text-ink-3">{c.hint}</span>
                  </span>
                  <Select defaultValue={c.action} className="w-32" disabled={!canEdit}>
                    <option value="off">Off</option>
                    <option value="warn">Warn</option>
                    <option value="refuse">Refuse</option>
                  </Select>
                </li>
              ))}
            </ul>
            <p className="text-[13px] text-ink-3">
              What arrives also sets the next stage: a new version restarts the workflow from the
              stage chosen when it is uploaded.
            </p>
          </div>
        </div>
      )}
      {tab === "overrides" && (
        <div className="scroll-quiet min-h-0 flex-1 overflow-auto p-4 @3xl/app:p-6">
          <div className="mx-auto flex max-w-[720px] flex-col gap-4">
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
                    if (t.id === "simple")
                      setStages([
                        {
                          id: "st-a",
                          kind: "approval",
                          name: "Approval",
                          participants: "Producer, everyone",
                          after: [],
                          status: workflow.statuses.at(-1)?.name ?? "",
                        },
                      ]);
                    if (t.id === "conductor") setStages(workflows[0]?.stages ?? []);
                    if (t.id === "parallel")
                      setStages([
                        {
                          id: "st-p1",
                          kind: "feedback",
                          name: "Director",
                          participants: "Mira Solberg",
                          after: [],
                          status: workflow.statuses[1]?.name ?? "",
                        },
                        {
                          id: "st-p2",
                          kind: "feedback",
                          name: "Composer",
                          participants: "Guest",
                          after: [],
                          status: workflow.statuses[1]?.name ?? "",
                        },
                        {
                          id: "st-p3",
                          kind: "feedback",
                          name: "Label",
                          participants: "Label group",
                          after: [],
                          status: workflow.statuses[1]?.name ?? "",
                        },
                        {
                          id: "st-p4",
                          kind: "approval",
                          name: "Lock",
                          participants: "Producer, any one",
                          after: ["st-p1", "st-p2", "st-p3"],
                          status: workflow.statuses.at(-1)?.name ?? "",
                        },
                      ]);
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
