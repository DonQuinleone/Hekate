import {
  type Alignment,
  align,
  applyEdit,
  boundsOf,
  inMarquee,
  inverseOf,
  isEmptyEdit,
  moveBy,
  type PatchedChannel,
  patchableKinds,
  patchedName,
  roundKinds,
  type StageEdit,
  type StageItem,
  type StageKind,
  type StagePlan,
  shownLabel,
  snapTo,
  stageKindDefaults,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import {
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Empty } from "~/components/empty";
import { Icon } from "~/components/icons";
import { ProductionNav } from "~/components/production-nav";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { Dropdown } from "~/components/ui/menu";
import { Switch } from "~/components/ui/toggle";
import { stagePlansQuery, useProjectCan, useStagePlans } from "~/lib/queries";
import { uuidv7 } from "~/lib/uuidv7";
import { ProjectFrame } from "./project";

/** Pixels a metre: as wide as the panel allows, within what stays legible. */
const SCALES = { fallback: 68, least: 40, most: 96 };
/** Room around the stage for the rulers, and for what stands just off it. */
const PAD = { left: 30, top: 20, right: 20, bottom: 20 };

/** On the toolbar; the rest of the kinds are under More. */
const mainKinds: StageKind[] = [
  "performer",
  "ensemble",
  "mic",
  "piano",
  "instrument",
  "riser",
  "wall",
  "label",
];
const moreKinds: StageKind[] = ["timpani", "stage-box", "cable", "rect", "ellipse"];

const alignments: { how: Alignment; label: string }[] = [
  { how: "left", label: "Left edges" },
  { how: "centre", label: "Centres, across" },
  { how: "right", label: "Right edges" },
  { how: "top", label: "Back edges" },
  { how: "middle", label: "Centres, front to back" },
  { how: "bottom", label: "Front edges" },
];

/**
 * Stage plans (#53), in Production as the prototype has them: a venue's stage to scale on a
 * snapping grid, with what stands on it. Those who see the production tools read it; those who
 * use them change it, a step at a time, with undo.
 */
export function StagePlanPage({ projectId }: { projectId: string }) {
  const can = useProjectCan(projectId);
  const { data, error } = useQuery({
    ...stagePlansQuery(projectId),
    enabled: can("view_production"),
  });
  const [chosen, setChosen] = useState<string | null>(null);
  const [editing, setEditing] = useState<"new" | StagePlan | null>(null);
  return (
    <ProjectFrame projectId={projectId} title="Stage plan">
      {(project) => {
        const canEdit = can("edit_production") && !project.archivedAt;
        const plan = data?.plans.find((p) => p.id === chosen) ?? data?.plans[0];
        return (
          <div className="fade-in mx-auto flex w-full max-w-[1280px] flex-col gap-5 px-5 py-6 @3xl/app:px-10">
            <ProductionNav projectId={projectId} current="stage" can={can} />
            {!can("view_production") ? (
              <Empty
                title="Not among what your role shows"
                text="Stage plans are shown to the roles the project's access gives the production tools."
              />
            ) : error ? (
              <p className="m-0 text-signal">{error.message}</p>
            ) : !data ? (
              <p className="m-0 text-ink-3">Loading</p>
            ) : !plan ? (
              <Empty
                title="No stage plan yet"
                text="A venue's stage to scale, in metres: performers, microphones, instruments, risers and walls, linked to the patch list."
                action={
                  canEdit ? (
                    <Button variant="primary" onClick={() => setEditing("new")}>
                      Add a stage plan
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <Editor
                key={plan.id}
                projectId={projectId}
                plan={plan}
                plans={data.plans}
                channels={data.channels}
                canEdit={canEdit}
                onChoose={setChosen}
                onEdit={setEditing}
              />
            )}
            {editing && (
              <PlanDialog
                projectId={projectId}
                plan={editing === "new" ? undefined : editing}
                onClose={() => setEditing(null)}
                onMade={setChosen}
              />
            )}
          </div>
        );
      }}
    </ProjectFrame>
  );
}

interface Drag {
  kind: "move";
  ids: string[];
  /** Where the pointer went down, in metres, and the item it went down on. */
  from: { x: number; y: number };
  anchor: StageItem;
  dx: number;
  dy: number;
}

interface Marquee {
  kind: "marquee";
  from: { x: number; y: number };
  to: { x: number; y: number };
  adding: boolean;
}

function Editor({
  projectId,
  plan,
  plans,
  channels,
  canEdit,
  onChoose,
  onEdit,
}: {
  projectId: string;
  plan: StagePlan;
  plans: StagePlan[];
  channels: PatchedChannel[];
  canEdit: boolean;
  onChoose: (id: string) => void;
  onEdit: (editing: "new" | StagePlan) => void;
}) {
  const { sendStep, refresh, removePlan } = useStagePlans(projectId);
  // What the editor shows: the server's items with this person's steps on top.
  const [items, setItems] = useState(plan.items);
  const [selected, setSelected] = useState<string[]>([]);
  const [snap, setSnap] = useState(true);
  const [hidden, setHidden] = useState<string[]>([]);
  const [gesture, setGesture] = useState<Drag | Marquee | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const undo = useRef<{ step: StageEdit; back: StageEdit }[]>([]);
  const redo = useRef<{ step: StageEdit; back: StageEdit }[]>([]);
  const [, setDepth] = useState(0);
  const pending = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const svg = useRef<SVGSVGElement>(null);
  const panel = useRef<HTMLElement>(null);
  const [scale, setScale] = useState(SCALES.fallback);
  // The whole stage across the panel where it fits; a stage too wide for it scrolls.
  useEffect(() => {
    const el = panel.current;
    if (!el) return;
    const fitStage = () => {
      const room = el.clientWidth - 32 - PAD.left - PAD.right;
      setScale(Math.min(SCALES.most, Math.max(SCALES.least, Math.floor(room / plan.width))));
    };
    fitStage();
    const watch = new ResizeObserver(fitStage);
    watch.observe(el);
    return () => watch.disconnect();
  }, [plan.width]);

  // The server's copy, once nothing this person did is still on its way.
  useEffect(() => {
    if (pending.current === 0 && !gesture) setItems(plan.items);
  }, [plan.items, gesture]);

  const send = (step: StageEdit) => {
    pending.current++;
    queue.current = queue.current
      .then(() => sendStep(plan.id, step))
      .then(
        (held) => {
          pending.current--;
          if (pending.current === 0) setItems(held);
        },
        (e: unknown) => {
          pending.current--;
          // What the server holds wins; what was undone or redone is no longer to hand.
          setFailure(e instanceof Error ? e.message : "That change was not saved");
          undo.current = [];
          redo.current = [];
          refresh();
        },
      );
  };

  /** Take a step: shown at once, sent in order, and undoable as one. */
  const take = (step: StageEdit) => {
    if (isEmptyEdit(step)) return;
    setFailure(null);
    undo.current.push({ step, back: inverseOf(items, step) });
    redo.current = [];
    setDepth((d) => d + 1);
    setItems((now) => applyEdit(now, step));
    send(step);
  };
  const stepBack = () => {
    const last = undo.current.pop();
    if (!last) return;
    redo.current.push(last);
    setDepth((d) => d + 1);
    setItems((now) => applyEdit(now, last.back));
    setSelected((ids) => ids.filter((id) => !last.step.add.some((i) => i.id === id)));
    send(last.back);
  };
  const stepForward = () => {
    const next = redo.current.pop();
    if (!next) return;
    undo.current.push(next);
    setDepth((d) => d + 1);
    setItems((now) => applyEdit(now, next.step));
    send(next.step);
  };

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const channelOf = (i: StageItem) =>
    i.patchRowId ? channels.find((c) => c.id === i.patchRowId) : undefined;
  const chosen = selected.flatMap((id) => byId.get(id) ?? []);
  const groups = [...new Set(items.map((i) => i.group).filter(Boolean))].sort();
  const place = (v: number) => (snap ? snapTo(v, plan.grid) : Math.round(v * 100) / 100);

  const add = (kind: StageKind) => {
    const size = stageKindDefaults[kind];
    const round = roundKinds.includes(kind);
    const item: StageItem = {
      id: uuidv7(),
      kind,
      label: "",
      // Put down in the middle of the stage, where it is easy to find and drag on.
      x: place(plan.width / 2 - (round ? 0 : size.w / 2)),
      y: place(plan.depth / 2 - (round ? 0 : size.h / 2)),
      w: size.w,
      h: size.h,
      rotation: 0,
      patchRowId: null,
      group: "",
    };
    take({ add: [item], change: [], remove: [] });
    setSelected([item.id]);
  };
  const duplicate = () => {
    const copies = chosen.map((i) => ({ ...i, id: uuidv7(), x: i.x + 0.5, y: i.y + 0.5 }));
    take({ add: copies, change: [], remove: [] });
    setSelected(copies.map((c) => c.id));
  };
  const remove = () => {
    take({ add: [], change: [], remove: selected });
    setSelected([]);
  };

  /** Where the pointer is on the stage, in metres. */
  const metresAt = (e: { clientX: number; clientY: number }) => {
    const box = svg.current?.getBoundingClientRect();
    return {
      x: (e.clientX - (box?.left ?? 0) - PAD.left) / scale,
      y: (e.clientY - (box?.top ?? 0) - PAD.top) / scale,
    };
  };
  const pressItem = (e: PointerEvent, item: StageItem) => {
    e.stopPropagation();
    const ids = e.shiftKey
      ? selected.includes(item.id)
        ? selected.filter((id) => id !== item.id)
        : [...selected, item.id]
      : selected.includes(item.id)
        ? selected
        : [item.id];
    setSelected(ids);
    if (!canEdit || !ids.includes(item.id)) return;
    svg.current?.setPointerCapture(e.pointerId);
    setGesture({ kind: "move", ids, from: metresAt(e), anchor: item, dx: 0, dy: 0 });
  };
  const pressStage = (e: PointerEvent) => {
    svg.current?.setPointerCapture(e.pointerId);
    const at = metresAt(e);
    setGesture({ kind: "marquee", from: at, to: at, adding: e.shiftKey });
  };
  const movePointer = (e: PointerEvent) => {
    if (!gesture) return;
    const at = metresAt(e);
    if (gesture.kind === "marquee") return setGesture({ ...gesture, to: at });
    // The item pressed lands on the grid; the rest of the selection keeps its place to it.
    const { anchor } = gesture;
    const dx = place(anchor.x + at.x - gesture.from.x) - anchor.x;
    const dy = place(anchor.y + at.y - gesture.from.y) - anchor.y;
    setGesture({ ...gesture, dx, dy });
  };
  const release = () => {
    if (!gesture) return;
    if (gesture.kind === "marquee") {
      const { from, to } = gesture;
      const tiny = Math.abs(to.x - from.x) < 0.05 && Math.abs(to.y - from.y) < 0.05;
      const touched = tiny
        ? []
        : inMarquee(items, { left: from.x, top: from.y, right: to.x, bottom: to.y });
      setSelected(gesture.adding ? [...new Set([...selected, ...touched])] : touched);
    } else if (Math.abs(gesture.dx) > 0.001 || Math.abs(gesture.dy) > 0.001) {
      take(moveBy(items, gesture.ids, gesture.dx, gesture.dy));
    }
    setGesture(null);
  };

  const keys = (e: KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      if (canEdit) (e.shiftKey ? stepForward : stepBack)();
      return;
    }
    if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      if (canEdit) stepForward();
      return;
    }
    if (mod && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSelected(items.map((i) => i.id));
      return;
    }
    if (e.key === "Escape") return setSelected([]);
    if (!canEdit || selected.length === 0) return;
    if (mod && e.key.toLowerCase() === "d") {
      e.preventDefault();
      duplicate();
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      remove();
      return;
    }
    // A tenth of a metre a press, a whole one with Shift, as design tools nudge.
    const by = e.shiftKey ? 1 : 0.1;
    const nudge: Record<string, [number, number]> = {
      ArrowLeft: [-by, 0],
      ArrowRight: [by, 0],
      ArrowUp: [0, -by],
      ArrowDown: [0, by],
    };
    const d = nudge[e.key];
    if (d) {
      e.preventDefault();
      take(moveBy(items, selected, d[0], d[1]));
    }
  };

  const shown = (i: StageItem) =>
    gesture?.kind === "move" && gesture.ids.includes(i.id)
      ? { ...i, x: i.x + gesture.dx, y: i.y + gesture.dy }
      : i;

  return (
    <div className="flex flex-col gap-3 @3xl/app:flex-row">
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Dropdown
            value={plan.name}
            label="Stage plan"
            actions={[
              ...plans.map((p) => ({
                label: p.name,
                checked: p.id === plan.id,
                onSelect: () => onChoose(p.id),
              })),
              ...(canEdit
                ? [
                    "divider" as const,
                    { label: "New stage plan", onSelect: () => onEdit("new") },
                    { label: "Size and grid", onSelect: () => onEdit(plan) },
                    {
                      label: "Remove this plan",
                      danger: true,
                      onSelect: () => removePlan.mutate(plan.id),
                    },
                  ]
                : []),
            ]}
          />
          <span className="tabular text-[12px] text-ink-3">
            {plan.width} × {plan.depth} m
          </span>
          <span className="ml-auto flex items-center gap-2 text-[12px] text-ink-3">
            {canEdit && (
              <span className="flex items-center gap-1.5">
                snap
                <Switch label="Snap to the grid" checked={snap} onChange={setSnap} />
              </span>
            )}
          </span>
        </div>
        {canEdit && (
          <div className="flex flex-wrap items-center gap-1.5" role="toolbar" aria-label="Add">
            {mainKinds.map((k) => (
              <Button key={k} variant="secondary" size="sm" onClick={() => add(k)}>
                {stageKindDefaults[k].name === "Microphone" ? "Mic" : stageKindDefaults[k].name}
              </Button>
            ))}
            <Dropdown
              value="More"
              size="sm"
              actions={moreKinds.map((k) => ({
                label: stageKindDefaults[k].name,
                onSelect: () => add(k),
              }))}
            />
            <span className="ml-auto flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                disabled={undo.current.length === 0}
                onClick={stepBack}
                title="Undo (Ctrl+Z)"
              >
                Undo
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={redo.current.length === 0}
                onClick={stepForward}
                title="Redo (Ctrl+Shift+Z)"
              >
                Redo
              </Button>
            </span>
          </div>
        )}
        {failure && <p className="m-0 text-[13px] text-signal">{failure}</p>}
        <section
          ref={panel}
          aria-label="The stage"
          aria-describedby="stage-keys"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the plan takes focus for its keys and to scroll.
          tabIndex={0}
          onKeyDown={keys}
          className="scroll-quiet overflow-auto rounded-panel-lg border border-line bg-sunken p-4 outline-none focus-visible:ring-2 focus-visible:ring-signal"
        >
          <svg
            ref={svg}
            data-scale={scale}
            width={plan.width * scale + PAD.left + PAD.right}
            height={plan.depth * scale + PAD.top + PAD.bottom}
            className="touch-none select-none"
            aria-hidden="true"
            onPointerDown={pressStage}
            onPointerMove={movePointer}
            onPointerUp={release}
            onPointerCancel={() => setGesture(null)}
          >
            <defs>
              <pattern
                id={`grid-${plan.id}`}
                width={plan.grid * scale}
                height={plan.grid * scale}
                patternUnits="userSpaceOnUse"
              >
                <path
                  d={`M ${plan.grid * scale} 0 L 0 0 0 ${plan.grid * scale}`}
                  fill="none"
                  stroke="var(--hk-line)"
                  strokeWidth={0.5}
                />
              </pattern>
            </defs>
            <g transform={`translate(${PAD.left}, ${PAD.top})`}>
              <rect
                width={plan.width * scale}
                height={plan.depth * scale}
                fill={`url(#grid-${plan.id})`}
                stroke="var(--hk-line-strong)"
              />
              {Array.from({ length: Math.floor(plan.width) + 1 }, (_, i) => (
                <text
                  key={`x${String(i)}`}
                  x={i * scale}
                  y={-6}
                  fill="var(--hk-ink-3)"
                  fontSize={9}
                  textAnchor="middle"
                  fontFamily="var(--hk-font-sans)"
                >
                  {i} m
                </text>
              ))}
              {Array.from({ length: Math.floor(plan.depth) + 1 }, (_, i) => (
                <text
                  key={`y${String(i)}`}
                  x={-6}
                  y={i * scale + 3}
                  fill="var(--hk-ink-3)"
                  fontSize={9}
                  textAnchor="end"
                  fontFamily="var(--hk-font-sans)"
                >
                  {i}
                </text>
              ))}
              {items.map((i) => (
                <Shape
                  key={i.id}
                  item={shown(i)}
                  scale={scale}
                  label={hidden.includes(i.group) ? null : shownLabel(i, channelOf(i))}
                  selected={selected.includes(i.id)}
                  onPress={(e) => pressItem(e, i)}
                />
              ))}
              {gesture?.kind === "marquee" && (
                <rect
                  x={Math.min(gesture.from.x, gesture.to.x) * scale}
                  y={Math.min(gesture.from.y, gesture.to.y) * scale}
                  width={Math.abs(gesture.to.x - gesture.from.x) * scale}
                  height={Math.abs(gesture.to.y - gesture.from.y) * scale}
                  fill="color-mix(in oklab, var(--hk-signal) 10%, transparent)"
                  stroke="var(--hk-signal)"
                  strokeDasharray="3 3"
                />
              )}
            </g>
          </svg>
          {items.length === 0 && (
            <p className="m-0 mt-3 text-[13px] text-ink-3">
              Nothing on the stage yet.{" "}
              {canEdit
                ? "Add performers, microphones, instruments, risers and walls from the toolbar, then drag them into place."
                : "Those who use the production tools draw it."}
            </p>
          )}
        </section>
        <p id="stage-keys" className="sr-only">
          Arrow keys move the selection by a tenth of a metre, a metre with Shift. Delete removes
          it; Control or Command and Z undoes, D duplicates, A selects everything.
        </p>
      </div>
      <aside className="flex w-full shrink-0 flex-col gap-3 @3xl/app:w-[280px]">
        <section
          aria-label="Selected"
          className="rounded-panel-lg border border-line bg-raised/25 p-3"
        >
          <span className="label">Selected</span>
          {chosen.length === 0 ? (
            <p className="m-0 mt-2 text-[13px] text-ink-3">
              Click something on the plan, or drag a marquee around several.
            </p>
          ) : chosen.length === 1 && chosen[0] ? (
            <ItemPanel
              key={chosen[0].id}
              item={chosen[0]}
              channel={channelOf(chosen[0])}
              channels={channels}
              canEdit={canEdit}
              onChange={(change) => take({ add: [], change: [change], remove: [] })}
              onDuplicate={duplicate}
              onRemove={remove}
            />
          ) : (
            <div className="mt-2 flex flex-col gap-2 text-[13px]">
              <span className="text-[14px] font-medium text-ink">{chosen.length} items</span>
              {canEdit && (
                <div className="flex flex-wrap gap-1">
                  <Dropdown
                    value="Align"
                    size="sm"
                    actions={[
                      ...alignments.map((a) => ({
                        label: a.label,
                        onSelect: () => take(align(items, selected, a.how, plan.width)),
                      })),
                      "divider" as const,
                      {
                        label: "Centre on the stage",
                        onSelect: () => take(align(items, selected, "stage-centre", plan.width)),
                      },
                    ]}
                  />
                  <Button variant="ghost" size="sm" onClick={duplicate}>
                    Duplicate
                  </Button>
                  <Button variant="ghost" size="sm" onClick={remove}>
                    Remove
                  </Button>
                </div>
              )}
            </div>
          )}
        </section>
        {items.length > 0 && (
          // The plan's layers, as Figma lists them: every item reachable by keyboard and by
          // name, however close together they stand on the plan.
          <section
            aria-label="On the stage"
            className="rounded-panel-lg border border-line bg-raised/25 p-3"
          >
            <span className="label">On the stage · {items.length}</span>
            <ul className="scroll-quiet m-0 mt-2 flex max-h-[240px] list-none flex-col overflow-auto p-0">
              {[...items].reverse().map((i) => (
                <li key={i.id}>
                  <button
                    type="button"
                    aria-pressed={selected.includes(i.id)}
                    onClick={(e) =>
                      setSelected((ids) =>
                        e.shiftKey
                          ? ids.includes(i.id)
                            ? ids.filter((id) => id !== i.id)
                            : [...ids, i.id]
                          : [i.id],
                      )
                    }
                    className="flex min-h-7 w-full items-center gap-2 rounded-panel px-2 text-left text-[13px] text-ink-2 transition-colors hover:bg-raised aria-pressed:bg-raised aria-pressed:text-ink"
                  >
                    <span className="min-w-0 flex-1 truncate">{shownLabel(i, channelOf(i))}</span>
                    <span className="shrink-0 text-[12px] text-ink-3">
                      {stageKindDefaults[i.kind as StageKind]?.name ?? i.kind}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <section
          aria-label="Label groups"
          className="rounded-panel-lg border border-line bg-raised/25 p-3"
        >
          <span className="label">Label groups</span>
          {groups.length === 0 ? (
            <p className="m-0 mt-2 text-[13px] text-ink-3">
              Give items a group, such as Main pair, to show or hide their labels together.
            </p>
          ) : (
            <ul className="m-0 mt-2 flex list-none flex-col gap-1.5 p-0 text-[13px] text-ink-2">
              {groups.map((g) => (
                <li key={g} className="flex items-center gap-2">
                  <Icon name="tag" size={12} className="text-ink-3" />
                  <span className="min-w-0 flex-1 truncate">{g}</span>
                  <Switch
                    label={`Show the labels of ${g}`}
                    checked={!hidden.includes(g)}
                    onChange={(on) => setHidden((h) => (on ? h.filter((x) => x !== g) : [...h, g]))}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
      </aside>
    </div>
  );
}

/** One item, drawn as the prototype draws its kind. */
function Shape({
  item,
  scale,
  label,
  selected,
  onPress,
}: {
  item: StageItem;
  scale: number;
  label: string | null;
  selected: boolean;
  onPress: (e: PointerEvent) => void;
}) {
  const stroke = selected ? "var(--hk-signal)" : "var(--hk-line-strong)";
  const fill = selected
    ? "color-mix(in oklab, var(--hk-signal) 22%, var(--hk-raised))"
    : "var(--hk-raised)";
  const text = (x: number, y: number, anchor: "start" | "middle" = "middle") =>
    label === null ? null : (
      <text
        x={x}
        y={y}
        fill="var(--hk-ink-2)"
        fontSize={10}
        textAnchor={anchor}
        fontFamily="var(--hk-font-sans)"
        className="pointer-events-none"
      >
        {label}
      </text>
    );
  const at = `translate(${item.x * scale}, ${item.y * scale})`;
  const w = item.w * scale;
  const h = item.h * scale;
  const common = { onPointerDown: onPress, className: "cursor-pointer", "data-item": item.id };
  if (item.kind === "mic")
    return (
      <g transform={at} {...common}>
        <circle
          r={9}
          fill={selected ? "var(--hk-signal)" : "var(--hk-raised)"}
          stroke={selected ? "var(--hk-signal)" : "var(--hk-ink-3)"}
        />
        <circle r={3} fill={selected ? "var(--hk-ground)" : "var(--hk-ink-2)"} />
        {text(12, 4, "start")}
      </g>
    );
  if (item.kind === "cable")
    return (
      <g transform={at} {...common}>
        {/* A wide clear line under the drawn one, so a thin cable is easy to pick up. */}
        <line x2={w} y2={h} stroke="transparent" strokeWidth={12} />
        <line
          x2={w}
          y2={h}
          stroke={selected ? "var(--hk-signal)" : "var(--hk-ink-3)"}
          strokeWidth={2}
          strokeDasharray="6 3"
        />
        {text(w / 2, h / 2 - 5)}
      </g>
    );
  if (roundKinds.includes(item.kind))
    return (
      <g transform={`${at} rotate(${item.rotation})`} {...common}>
        <ellipse
          rx={w / 2}
          ry={h / 2}
          fill={fill}
          stroke={selected ? "var(--hk-signal)" : "var(--hk-ink-3)"}
        />
        {item.kind === "performer" ? text(0, 4) : text(0, h / 2 + 12)}
      </g>
    );
  return (
    <g transform={`${at} rotate(${item.rotation}, ${w / 2}, ${h / 2})`} {...common}>
      <rect
        width={w}
        height={h}
        rx={item.kind === "piano" || item.kind === "instrument" ? 10 : 2}
        fill={
          item.kind === "wall" ? "var(--hk-ink-3)" : item.kind === "label" ? "transparent" : fill
        }
        stroke={item.kind === "label" && !selected ? "none" : stroke}
        strokeDasharray={item.kind === "riser" || item.kind === "label" ? "4 3" : undefined}
      />
      {item.kind !== "wall" && text(w / 2, h / 2 + 4)}
    </g>
  );
}

/** A number typed in metres or degrees: what it reads as, or nothing while it is not one. */
const numberOf = (typed: string) => {
  const v = Number(typed.replace(",", "."));
  return typed.trim() !== "" && Number.isFinite(v) ? v : undefined;
};

/** The one selected item: its label, place, size, turn, group and patch channel. */
function ItemPanel({
  item,
  channel,
  channels,
  canEdit,
  onChange,
  onDuplicate,
  onRemove,
}: {
  item: StageItem;
  channel?: PatchedChannel;
  channels: PatchedChannel[];
  canEdit: boolean;
  onChange: (change: Partial<StageItem> & { id: string }) => void;
  onDuplicate: () => void;
  onRemove: () => void;
}) {
  const kindName = stageKindDefaults[item.kind as StageKind]?.name ?? item.kind;
  const commit = (field: keyof StageItem, value: string | number | null) => {
    if (item[field] !== value) onChange({ id: item.id, [field]: value });
  };
  const box = boundsOf(item);
  if (!canEdit)
    return (
      <div className="mt-2 flex flex-col gap-1 text-[13px]">
        <span className="text-[14px] font-medium text-ink">
          {kindName}: {shownLabel(item, channel)}
        </span>
        <span className="tabular text-ink-3">
          {box.left.toFixed(2)} m, {box.top.toFixed(2)} m · {Math.abs(item.w)} × {Math.abs(item.h)}{" "}
          m{item.rotation ? ` · ${item.rotation}°` : ""}
        </span>
        {channel && <span className="text-ink-2">Patch: {patchedName(channel)}</span>}
      </div>
    );
  const measure = (field: "x" | "y" | "w" | "h" | "rotation", label: string) => (
    <Field label={label}>
      <Input
        inputMode="decimal"
        defaultValue={String(item[field])}
        key={`${field}-${item[field]}`}
        onBlur={(e) => {
          const v = numberOf(e.target.value);
          if (v === undefined) e.target.value = String(item[field]);
          else commit(field, Math.round(v * 100) / 100);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
      />
    </Field>
  );
  return (
    <form className="mt-2 flex flex-col gap-2.5" onSubmit={(e: FormEvent) => e.preventDefault()}>
      <span className="text-[14px] font-medium text-ink">{kindName}</span>
      <Field label="Label" hint={channel?.source ? "Follows the patch list" : undefined}>
        <Input
          defaultValue={item.label}
          maxLength={60}
          placeholder={channel?.source || kindName}
          onBlur={(e) => commit("label", e.target.value.trim())}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        {measure("x", "Across, m")}
        {measure("y", "Back to front, m")}
        {item.kind === "cable" ? (
          <>
            {measure("w", "Runs across, m")}
            {measure("h", "Runs forward, m")}
          </>
        ) : (
          <>
            {measure("w", "Width, m")}
            {measure("h", "Depth, m")}
          </>
        )}
        {item.kind !== "cable" && item.kind !== "mic" && measure("rotation", "Turned, °")}
      </div>
      {patchableKinds.includes(item.kind) && (
        <Field label="Patch">
          <Dropdown
            variant="field"
            value={
              channel
                ? `${patchedName(channel)}${channel.source ? `, ${channel.source}` : ""}`
                : "Not patched"
            }
            actions={[
              {
                label: "Not patched",
                checked: !channel,
                onSelect: () => commit("patchRowId", null),
              },
              ...(channels.length > 0 ? ["divider" as const] : []),
              ...channels.map((c) => ({
                label: `${patchedName(c)}${c.source ? `, ${c.source}` : ""}`,
                checked: c.id === channel?.id,
                onSelect: () => commit("patchRowId", c.id),
              })),
            ]}
          />
        </Field>
      )}
      <Field label="Label group">
        <Input
          defaultValue={item.group}
          maxLength={40}
          placeholder="Main pair"
          onBlur={(e) => commit("group", e.target.value.trim())}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
      </Field>
      <div className="flex flex-wrap gap-1">
        <Button variant="ghost" size="sm" onClick={onDuplicate}>
          Duplicate
        </Button>
        <Button variant="ghost" size="sm" onClick={onRemove}>
          Remove
        </Button>
      </div>
    </form>
  );
}

/** A new stage plan, or a plan's name, size and grid. */
function PlanDialog({
  projectId,
  plan,
  onClose,
  onMade,
}: {
  projectId: string;
  plan?: StagePlan;
  onClose: () => void;
  onMade: (id: string) => void;
}) {
  const { addPlan, changePlan } = useStagePlans(projectId);
  const [name, setName] = useState(plan?.name ?? "");
  const [width, setWidth] = useState(String(plan?.width ?? 12));
  const [depth, setDepth] = useState(String(plan?.depth ?? 8));
  const [grid, setGrid] = useState(String(plan?.grid ?? 0.5));
  const saving = plan ? changePlan : addPlan;
  const sizes = { width: numberOf(width), depth: numberOf(depth), grid: numberOf(grid) };
  const fits = (v: number | undefined, low: number, high: number) =>
    v !== undefined && v >= low && v <= high;
  const valid =
    name.trim() !== "" &&
    fits(sizes.width, 1, 200) &&
    fits(sizes.depth, 1, 200) &&
    fits(sizes.grid, 0.05, 5);
  const save = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const input = {
      name: name.trim(),
      width: sizes.width ?? 12,
      depth: sizes.depth ?? 8,
      grid: sizes.grid ?? 0.5,
    };
    if (plan) changePlan.mutate({ id: plan.id, ...input }, { onSuccess: onClose });
    else
      addPlan.mutate(input, {
        onSuccess: (made) => {
          onMade(made.id);
          onClose();
        },
      });
  };
  return (
    <Dialog
      title={plan ? "Size and grid" : "Add a stage plan"}
      onClose={onClose}
      width="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="stage-plan"
            disabled={!valid || saving.isPending}
          >
            {plan ? "Save" : "Add"}
          </Button>
        </>
      }
    >
      <form id="stage-plan" onSubmit={save} className="grid grid-cols-2 gap-3">
        <Field label="Venue or layout" className="col-span-2" error={saving.error?.message}>
          <Input
            autoFocus
            value={name}
            maxLength={80}
            placeholder="Endless Hall, recital layout"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field
          label="Width, m"
          error={fits(sizes.width, 1, 200) ? undefined : "From 1 to 200 metres"}
        >
          <Input inputMode="decimal" value={width} onChange={(e) => setWidth(e.target.value)} />
        </Field>
        <Field
          label="Depth, m"
          error={fits(sizes.depth, 1, 200) ? undefined : "From 1 to 200 metres"}
        >
          <Input inputMode="decimal" value={depth} onChange={(e) => setDepth(e.target.value)} />
        </Field>
        <Field
          label="Grid, m"
          hint="What items snap to"
          error={fits(sizes.grid, 0.05, 5) ? undefined : "From 0.05 to 5 metres"}
        >
          <Input inputMode="decimal" value={grid} onChange={(e) => setGrid(e.target.value)} />
        </Field>
      </form>
    </Dialog>
  );
}
