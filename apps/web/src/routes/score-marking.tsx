import {
  type EditPlot,
  editLabel,
  readingOrder,
  type ScoreMark,
  type ScoreMarkCategory,
  type ScoreMarkChange,
  type ScoreMarkInput,
  type ScoreMarkKind,
  scoreMarkKinds,
  scoreMarksCsv,
  scoreMarkTools,
  takeList,
} from "@hekate/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type PointerEvent, useId, useRef, useState } from "react";
import { drawingColour } from "~/components/drawings";
import { Empty } from "~/components/empty";
import { Icon } from "~/components/icons";
import { Kbd } from "~/components/kbd";
import { ProductionNav } from "~/components/production-nav";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/choice";
import { Dialog } from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { Input, Select } from "~/components/ui/input";
import { Dropdown } from "~/components/ui/menu";
import { cn } from "~/lib/cn";
import {
  projectTracksQuery,
  scoreMarksQuery,
  useProjectCan,
  useScoreMarks,
  viewQuery,
} from "~/lib/queries";
import { useShortcuts } from "~/lib/shortcuts";
import { ProjectFrame } from "./project";

type Layout = "single" | "two" | "continuous";
const layouts: Record<Layout, string> = {
  single: "Single",
  two: "Two-up",
  continuous: "Continuous",
};

/** Display filters for a dark control room: the score's paper, as it suits the light. */
const filters = {
  paper: { name: "Paper", css: "" },
  invert: { name: "Invert", css: "invert(1) hue-rotate(180deg)" },
  sepia: { name: "Sepia", css: "sepia(0.6)" },
  amber: { name: "Amber", css: "sepia(0.8) saturate(2) hue-rotate(-10deg)" },
  cyan: { name: "Cyan", css: "sepia(0.5) hue-rotate(150deg)" },
  grey: { name: "Grey", css: "grayscale(1) contrast(0.9)" },
} as const;
type Filter = keyof typeof filters;

/** What each kind shows on the page. */
const glyphs: Record<ScoreMarkKind, string> = {
  issue: "!",
  edit: "T",
  "take-start": "[",
  "take-end": "]",
  "punch-in": "P",
  "wrong-note": "×",
  dynamic: "○",
  note: "≡",
  ink: "~",
};

/** Kinds that ask for their details before they are placed. */
const asked: ScoreMarkKind[] = ["edit", "take-start", "take-end", "punch-in", "dynamic", "note"];

const barsOf = (m: Pick<ScoreMark, "barFrom" | "barTo">) =>
  m.barFrom == null
    ? ""
    : m.barTo != null && m.barTo !== m.barFrom
      ? `bars ${m.barFrom}–${m.barTo}`
      : `bar ${m.barFrom}`;

/** What a mark says in a list: its words, its edit, or its take. */
function markText(m: ScoreMark, categories: ScoreMarkCategory[]): string {
  if (m.kind === "edit") return editLabel(m);
  if (m.kind === "take-start") return `T${m.to} starts`;
  if (m.kind === "take-end") return `T${m.to} ends`;
  if (m.kind === "punch-in") return `Punch-in, T${m.to}`;
  if (m.kind === "wrong-note") return m.text || "Wrong note";
  if (m.kind === "ink") return "Ink";
  if (m.kind === "issue")
    return m.text || categories.find((c) => c.id === m.categoryId)?.name || "Issue";
  return m.text ?? "";
}

/**
 * Score marking (#52): the producer's pencil on a track's score, in Production as the
 * prototype has it. A kind is chosen by its key and placed with a click (ink is drawn); the
 * inspector holds what the chosen mark says, and the edit plot check reads the T-edits.
 */
export function ScoreMarkingPage({ projectId, trackId }: { projectId: string; trackId?: string }) {
  const can = useProjectCan(projectId);
  const navigate = useNavigate();
  const { data: tracks } = useQuery(projectTracksQuery(projectId));
  const scored = (tracks ?? []).filter((t) => t.scoreFileId);
  const track = scored.find((t) => t.id === trackId) ?? scored[0];
  return (
    <ProjectFrame projectId={projectId} title="Score marking">
      {(project) => (
        <div className="fade-in mx-auto flex w-full max-w-[1360px] flex-col gap-4 px-5 py-6 @3xl/app:px-10">
          <ProductionNav projectId={projectId} current="score" />
          {!can("view_production") ? (
            <Empty
              title="Not among what your role shows"
              text="Score marking is shown to the roles the project's access gives the production tools."
            />
          ) : !tracks ? (
            <p className="m-0 text-ink-3">Loading</p>
          ) : !track?.scoreFileId ? (
            <Empty
              title="No scores to mark"
              text="Give a track its score, in the track's settings, to mark it here."
            />
          ) : (
            <Marking
              key={track.id}
              trackId={track.id}
              scoreFileId={track.scoreFileId}
              canMark={can("edit_production") && !project.archivedAt}
              tracks={scored.map((t) => ({ id: t.id, name: t.name }))}
              onTrack={(id) =>
                void navigate({
                  to: "/projects/$projectId/score-marking",
                  params: { projectId },
                  search: { track: id },
                })
              }
            />
          )}
        </div>
      )}
    </ProjectFrame>
  );
}

interface Placing {
  kind: ScoreMarkKind;
  page: number;
  x: number;
  y: number;
}

function Marking({
  trackId,
  scoreFileId,
  canMark,
  tracks,
  onTrack,
}: {
  trackId: string;
  scoreFileId: string;
  canMark: boolean;
  tracks: { id: string; name: string }[];
  onTrack: (id: string) => void;
}) {
  const client = useQueryClient();
  const { data, error } = useQuery(scoreMarksQuery(trackId));
  const { data: view } = useQuery(viewQuery(scoreFileId));
  const { add, change, remove } = useScoreMarks(trackId);
  const [page, setPage] = useState(1);
  const [layout, setLayout] = useState<Layout>("single");
  const [filter, setFilter] = useState<Filter>("paper");
  const [tool, setTool] = useState<ScoreMarkKind>("issue");
  const [category, setCategory] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [placing, setPlacing] = useState<Placing | null>(null);
  const [goTo, setGoTo] = useState("");

  const marks = data?.marks ?? [];
  const categories = data?.categories ?? [];
  const pageCount = view?.pageCount ?? 1;
  const current = marks.find((m) => m.id === selected) ?? null;
  const edits = readingOrder(marks.filter((m) => m.kind === "edit"));
  const issueCategory = category ?? categories[0]?.id ?? null;
  const shownPages =
    layout === "two"
      ? [page, page + 1].filter((p) => p <= pageCount)
      : layout === "continuous"
        ? Array.from({ length: pageCount }, (_, i) => i + 1)
        : [page];

  const go = (p: number) => setPage(Math.min(Math.max(1, p), pageCount));
  const nextEdit = () => {
    const at = edits.findIndex((m) => m.id === selected);
    const next = edits[(at + 1) % Math.max(1, edits.length)];
    if (!next) return;
    setSelected(next.id);
    go(next.page);
  };
  const place = (where: Placing) => {
    if (!canMark) return;
    if (asked.includes(where.kind)) return setPlacing(where);
    add.mutate(
      {
        kind: where.kind,
        page: where.page,
        x: where.x,
        y: where.y,
        ...(where.kind === "issue" ? { categoryId: issueCategory } : {}),
      },
      { onSuccess: (made) => setSelected(made.id) },
    );
  };
  const exportCsv = () => {
    const blob = new Blob([scoreMarksCsv(marks, categories)], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${tracks.find((t) => t.id === trackId)?.name ?? "Score"} marks.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  useShortcuts(
    "score-marking",
    "Score marking",
    [
      ...scoreMarkKinds.map((kind) => ({
        keys: [scoreMarkTools[kind].key],
        label: scoreMarkTools[kind].name,
        run: () => setTool(kind),
      })),
      ...categories
        .filter((c) => c.key)
        .map((c) => ({
          keys: [c.key as string],
          label: `Issue: ${c.name}`,
          run: () => {
            setTool("issue");
            setCategory(c.id);
          },
        })),
      { keys: ["ArrowLeft"], label: "Previous page", run: () => go(page - 1) },
      { keys: ["ArrowRight"], label: "Next page", run: () => go(page + 1) },
      { keys: ["."], label: "Next edit point", run: nextEdit },
      { keys: ["Escape"], label: "Let go of the mark", run: () => setSelected(null) },
    ],
    canMark,
  );

  if (error) return <p className="m-0 text-signal">{error.message}</p>;

  return (
    <div className="flex min-h-0 flex-col gap-4 lg:flex-row lg:items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        {canMark && (
          <div role="toolbar" aria-label="Marks" className="flex flex-wrap items-center gap-1.5">
            {scoreMarkKinds.map((kind) => (
              <Button
                key={kind}
                size="sm"
                variant="secondary"
                aria-pressed={tool === kind}
                onClick={() => setTool(kind)}
                className="aria-pressed:border-signal/60 aria-pressed:bg-signal/10"
              >
                <span aria-hidden="true" className="tabular w-3 text-center text-ink-3">
                  {glyphs[kind]}
                </span>
                {scoreMarkTools[kind].name}
                <Kbd>{scoreMarkTools[kind].key.toUpperCase()}</Kbd>
              </Button>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-ink-3">
          {tracks.length > 1 && (
            <Select
              size="sm"
              aria-label="Track"
              value={trackId}
              onChange={(e) => onTrack(e.target.value)}
              className="w-auto min-w-[160px]"
            >
              {tracks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          )}
          {layout !== "continuous" && (
            <span className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="iconSm"
                aria-label="Previous page"
                disabled={page <= 1}
                onClick={() => go(page - 1)}
              >
                <Icon name="chevronLeft" size={14} />
              </Button>
              <span className="tabular text-ink">
                p. {page} <span className="text-ink-3">/ {pageCount}</span>
              </span>
              <Button
                variant="ghost"
                size="iconSm"
                aria-label="Next page"
                disabled={page >= pageCount}
                onClick={() => go(page + 1)}
              >
                <Icon name="chevronRight" size={14} />
              </Button>
            </span>
          )}
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              const n = Number.parseInt(goTo, 10);
              if (n >= 1) go(n);
              setGoTo("");
            }}
          >
            <Input
              size="sm"
              inputMode="numeric"
              aria-label="Go to page"
              placeholder="Go to page"
              value={goTo}
              onChange={(e) => setGoTo(e.target.value)}
              className="w-28"
            />
          </form>
          <span className="ml-auto flex flex-wrap items-center justify-end gap-1">
            {edits.length > 0 && (
              <Button variant="ghost" size="sm" onClick={nextEdit}>
                Next edit point
                <Kbd>.</Kbd>
              </Button>
            )}
            <Dropdown
              size="sm"
              label="Layout"
              value={layouts[layout]}
              align="right"
              actions={(Object.keys(layouts) as Layout[]).map((l) => ({
                label: layouts[l],
                checked: l === layout,
                onSelect: () => setLayout(l),
              }))}
            />
            <Dropdown
              size="sm"
              label="Display"
              value={filters[filter].name}
              align="right"
              actions={(Object.keys(filters) as Filter[]).map((f) => ({
                label: filters[f].name,
                checked: f === filter,
                onSelect: () => setFilter(f),
              }))}
            />
            {marks.length > 0 && (
              <Dropdown
                size="sm"
                value="Export"
                align="right"
                actions={[{ label: "Marks as CSV", onSelect: exportCsv }]}
              />
            )}
          </span>
        </div>
        <div className="scroll-quiet flex max-h-[78vh] flex-wrap justify-center gap-4 overflow-auto rounded-panel bg-sunken p-4">
          {!view ? (
            <p className="m-auto text-[13px] text-ink-3">Drawing the score</p>
          ) : (
            shownPages.map((p) => (
              <ScorePage
                key={p}
                page={p}
                url={view.pages.find((v) => v.page === p)?.url}
                width={layout === "single" ? 720 : 480}
                filter={filters[filter].css}
                marks={marks.filter((m) => m.page === p)}
                categories={categories}
                selected={selected}
                tool={canMark ? tool : null}
                onSelect={setSelected}
                onPlace={(x, y) => place({ kind: tool, page: p, x, y })}
                onInk={(points) =>
                  canMark &&
                  add.mutate(
                    {
                      kind: "ink",
                      page: p,
                      x: points[0]?.[0] ?? 0,
                      y: points[0]?.[1] ?? 0,
                      points,
                    },
                    { onSuccess: (made) => setSelected(made.id) },
                  )
                }
                onLapsed={() =>
                  void client.invalidateQueries({ queryKey: viewQuery(scoreFileId).queryKey })
                }
              />
            ))
          )}
        </div>
        {marks.length === 0 && data && (
          <p className="m-0 text-center text-[13px] text-ink-3">
            {canMark
              ? "No marks yet. Choose a kind and click on the score."
              : "No marks on this score yet."}
          </p>
        )}
        {(add.error ?? change.error ?? remove.error) && (
          <p role="alert" className="m-0 text-[13px] text-signal">
            {(add.error ?? change.error ?? remove.error)?.message}
          </p>
        )}
      </div>
      <aside
        aria-label="Beside the score"
        className="flex w-full shrink-0 flex-col gap-5 lg:w-[300px]"
      >
        <Inspector
          mark={current}
          categories={categories}
          canMark={canMark}
          onChange={(patch) => current && change.mutate({ id: current.id, ...patch })}
          onDelete={() => {
            if (!current) return;
            remove.mutate(current.id);
            setSelected(null);
          }}
        />
        <PlotCheck
          plot={data?.plot}
          edits={edits}
          selected={selected}
          onSelect={(m) => {
            setSelected(m.id);
            go(m.page);
          }}
        />
        <OnThisPage
          several={shownPages.length > 1}
          marks={readingOrder(marks.filter((m) => shownPages.includes(m.page)))}
          categories={categories}
          selected={selected}
          onSelect={setSelected}
        />
      </aside>
      {placing && (
        <NewMark
          placing={placing}
          onClose={() => setPlacing(null)}
          onMake={(details) =>
            add.mutate(
              { kind: placing.kind, page: placing.page, x: placing.x, y: placing.y, ...details },
              {
                onSuccess: (made) => {
                  setSelected(made.id);
                  setPlacing(null);
                },
              },
            )
          }
          pending={add.isPending}
          error={add.error?.message}
        />
      )}
    </div>
  );
}

/** One page of the score with its marks over it; a click places, a drag inks. */
function ScorePage({
  page,
  url,
  width,
  filter,
  marks,
  categories,
  selected,
  tool,
  onSelect,
  onPlace,
  onInk,
  onLapsed,
}: {
  page: number;
  url: string | undefined;
  width: number;
  filter: string;
  marks: ScoreMark[];
  categories: ScoreMarkCategory[];
  selected: string | null;
  tool: ScoreMarkKind | null;
  onSelect: (id: string) => void;
  onPlace: (x: number, y: number) => void;
  onInk: (points: [number, number][]) => void;
  onLapsed: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [stroke, setStroke] = useState<[number, number][] | null>(null);
  const at = (e: PointerEvent): [number, number] => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return [0, 0];
    const clamp = (n: number) => Math.min(1, Math.max(0, n));
    return [clamp((e.clientX - r.left) / r.width), clamp((e.clientY - r.top) / r.height)];
  };
  const colourOf = (m: ScoreMark) =>
    drawingColour[categories.find((c) => c.id === m.categoryId)?.colour ?? "signal"];
  return (
    <figure
      className="relative m-0 max-w-full shrink-0 bg-paper shadow-paper"
      style={{ width }}
      aria-label={`Page ${page}`}
    >
      {url ? (
        <img
          src={url}
          alt={`Page ${page} of the score`}
          onError={onLapsed}
          className="block h-auto w-full select-none"
          style={{ filter: filter || undefined }}
          draggable={false}
        />
      ) : (
        <div className="aspect-[1/1.414] w-full" />
      )}
      {/* Where the pencil lands: a click places the chosen mark, a drag draws ink. */}
      <div
        ref={box}
        data-e2e-overlap
        className={cn("absolute inset-0", tool && "cursor-crosshair touch-none")}
        onPointerDown={(e) => {
          if (!tool || e.button !== 0) return;
          if (tool === "ink") {
            e.currentTarget.setPointerCapture(e.pointerId);
            setStroke([at(e)]);
          }
        }}
        onPointerMove={(e) => {
          if (!stroke) return;
          const [x, y] = at(e);
          const last = stroke.at(-1);
          if (last && Math.hypot(x - last[0], y - last[1]) > 0.004)
            setStroke((s) => (s && s.length < 1024 ? [...s, [x, y]] : s));
        }}
        onPointerUp={(e) => {
          if (!tool) return;
          if (tool === "ink") {
            if (stroke && stroke.length >= 2) onInk(stroke);
            setStroke(null);
            return;
          }
          const [x, y] = at(e);
          onPlace(x, y);
        }}
      />
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 h-full w-full"
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
      >
        {[...marks.filter((m) => m.kind === "ink" && m.points), ...(stroke ? [null] : [])].map(
          (m) => (
            <polyline
              key={m?.id ?? "drawing"}
              points={(m?.points ?? stroke ?? []).map(([x, y]) => `${x},${y}`).join(" ")}
              fill="none"
              stroke="var(--hk-signal)"
              strokeWidth={m && m.id === selected ? 3 : 2}
              vectorEffect="non-scaling-stroke"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ),
        )}
      </svg>
      {marks
        .filter((m) => m.width != null && m.height != null)
        .map((m) => (
          <span
            key={`${m.id}-region`}
            aria-hidden="true"
            className="pointer-events-none absolute rounded-[2px] border-2"
            style={{
              left: `${m.x * 100}%`,
              top: `${m.y * 100}%`,
              width: `${(m.width ?? 0) * 100}%`,
              height: `${(m.height ?? 0) * 100}%`,
              borderColor: colourOf(m),
            }}
          />
        ))}
      {marks
        .filter((m) => m.kind !== "ink")
        .map((m) => (
          <button
            key={m.id}
            type="button"
            data-e2e-overlap
            onClick={() => onSelect(m.id)}
            className={cn(
              "absolute flex h-6 min-w-6 -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border-2 bg-ground px-1.5 text-[11px] font-medium text-ink shadow-2 transition-transform hover:scale-110",
              m.kind === "edit" && "bg-signal text-ground",
              m.kind === "issue" && m.resolved && "opacity-60",
              m.id === selected && "ring-2 ring-signal ring-offset-2 ring-offset-paper",
            )}
            style={{
              left: `${m.x * 100}%`,
              top: `${m.y * 100}%`,
              borderColor: m.kind === "issue" ? colourOf(m) : "transparent",
            }}
          >
            <span aria-hidden="true">
              {m.kind === "edit"
                ? m.from == null
                  ? `T${m.to}`
                  : `${m.from}T${m.to}`
                : glyphs[m.kind]}
            </span>
            <span className="sr-only">
              {scoreMarkTools[m.kind].name}
              {m.barFrom != null ? `, ${barsOf(m)}` : ""}
            </span>
          </button>
        ))}
    </figure>
  );
}

/** The details a kind needs before it is placed: an edit's takes, a dynamic's words. */
function NewMark({
  placing,
  onClose,
  onMake,
  pending,
  error,
}: {
  placing: Placing;
  onClose: () => void;
  onMake: (details: Partial<ScoreMarkInput>) => void;
  pending: boolean;
  error?: string;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [bar, setBar] = useState("");
  const [text, setText] = useState("");
  const [overdub, setOverdub] = useState(false);
  const kind = placing.kind;
  const number = (typed: string) => {
    const n = Number.parseInt(typed.replace(/^t/i, ""), 10);
    return n >= 1 ? n : null;
  };
  const wantsTake = kind !== "dynamic" && kind !== "note";
  const ready = wantsTake ? number(to) !== null : text.trim() !== "";
  return (
    <Dialog
      title={scoreMarkTools[kind].name}
      description={
        kind === "edit"
          ? "Written as the plot is: 3T12 into T7 is bar 3 of take 12 into take 7. Leave the first take empty for the lead-in."
          : undefined
      }
      onClose={onClose}
      width="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!ready || pending}
            onClick={() =>
              onMake({
                barFrom: number(bar),
                ...(wantsTake
                  ? {
                      to: number(to),
                      ...(kind === "edit" ? { from: number(from), overdub } : {}),
                    }
                  : { text: text.trim() }),
              })
            }
          >
            Place
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {kind === "edit" && (
          <Field label="From take" hint="Empty for the lead-in">
            <Input inputMode="numeric" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
        )}
        {wantsTake && (
          <Field label={kind === "edit" ? "Into take" : "Take"}>
            <Input
              inputMode="numeric"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              autoFocus
            />
          </Field>
        )}
        {!wantsTake && (
          <Field label={kind === "dynamic" ? "Dynamic" : "Note"}>
            <Input
              value={text}
              maxLength={500}
              placeholder={kind === "dynamic" ? "mp" : "Breath before the trio"}
              onChange={(e) => setText(e.target.value)}
              autoFocus
            />
          </Field>
        )}
        <Field label="Bar" hint="Where known">
          <Input inputMode="numeric" value={bar} onChange={(e) => setBar(e.target.value)} />
        </Field>
        {kind === "edit" && (
          <label className="flex items-center gap-2 text-[13px] text-ink-2">
            <Checkbox checked={overdub} onChange={(e) => setOverdub(e.target.checked)} />
            An overdub, laid over the chain
          </label>
        )}
        {error && (
          <p role="alert" className="m-0 text-[13px] text-signal">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/** The chosen mark: what it says, where, and the takes it names. */
function Inspector({
  mark,
  categories,
  canMark,
  onChange,
  onDelete,
}: {
  mark: ScoreMark | null;
  categories: ScoreMarkCategory[];
  canMark: boolean;
  onChange: (patch: ScoreMarkChange) => void;
  onDelete: () => void;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h2 id={id} className="label m-0">
        Inspector
      </h2>
      {!mark ? (
        <p className="m-0 text-[13px] text-ink-3">Choose a mark on the score.</p>
      ) : (
        <MarkFields
          key={mark.id}
          mark={mark}
          categories={categories}
          canMark={canMark}
          onChange={onChange}
          onDelete={onDelete}
        />
      )}
    </section>
  );
}

function MarkFields({
  mark,
  categories,
  canMark,
  onChange,
  onDelete,
}: {
  mark: ScoreMark;
  categories: ScoreMarkCategory[];
  canMark: boolean;
  onChange: (patch: ScoreMarkChange) => void;
  onDelete: () => void;
}) {
  const [text, setText] = useState(mark.text ?? "");
  const [bars, setBars] = useState(
    mark.barFrom == null
      ? ""
      : `${mark.barFrom}${mark.barTo && mark.barTo !== mark.barFrom ? `–${mark.barTo}` : ""}`,
  );
  const [takes, setTakes] = useState(mark.takes.map((t) => `T${t}`).join(", "));
  const [fixedBy, setFixedBy] = useState(mark.fixedBy ? `T${mark.fixedBy}` : "");
  const [from, setFrom] = useState(mark.from ? String(mark.from) : "");
  const [to, setTo] = useState(mark.to ? String(mark.to) : "");
  const [problem, setProblem] = useState<string | null>(null);
  const number = (typed: string) => {
    const n = Number.parseInt(typed.replace(/^t/i, ""), 10);
    return n >= 1 ? n : null;
  };
  const saveBars = () => {
    const found = /^\s*(\d+)\s*(?:[-–]\s*(\d+))?\s*$/.exec(bars);
    if (!bars.trim()) return onChange({ barFrom: null, barTo: null });
    if (!found) return setProblem("Bars as 17, or 17–19");
    const first = Number(found[1]);
    const last = found[2] ? Number(found[2]) : null;
    if (last !== null && last < first) return setProblem("The bars run forwards");
    setProblem(null);
    onChange({ barFrom: first, barTo: last });
  };
  const category = categories.find((c) => c.id === mark.categoryId);
  return (
    <div className="flex flex-col gap-2.5 text-[13px]">
      <span className="text-[14px] font-medium text-ink">
        {mark.kind === "edit" ? editLabel(mark) : scoreMarkTools[mark.kind].name}
        {category ? ` · ${category.name}` : ""}
      </span>
      <span className="tabular text-ink-3">
        p. {mark.page}
        {mark.barFrom != null ? ` · ${barsOf(mark)}` : ""}
        {mark.by ? ` · ${mark.by.name}` : ""}
      </span>
      {canMark && (
        <>
          <Field label="Bars" error={problem}>
            <Input
              size="sm"
              value={bars}
              placeholder="17–19"
              onChange={(e) => setBars(e.target.value)}
              onBlur={saveBars}
            />
          </Field>
          {mark.kind === "issue" && (
            <Field label="Category">
              <Select
                size="sm"
                value={mark.categoryId ?? ""}
                onChange={(e) => onChange({ categoryId: e.target.value || null })}
              >
                <option value="">None</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {mark.kind === "edit" && (
            <div className="grid grid-cols-2 gap-2">
              <Field label="From take">
                <Input
                  size="sm"
                  inputMode="numeric"
                  value={from}
                  placeholder="Lead-in"
                  onChange={(e) => setFrom(e.target.value)}
                  onBlur={() => onChange({ from: number(from) })}
                />
              </Field>
              <Field label="Into take">
                <Input
                  size="sm"
                  inputMode="numeric"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  onBlur={() => number(to) !== null && onChange({ to: number(to) })}
                />
              </Field>
            </div>
          )}
          {mark.kind !== "edit" && mark.kind !== "ink" && (
            <Field label={mark.kind === "dynamic" ? "Dynamic" : "Says"}>
              <Input
                size="sm"
                value={text}
                maxLength={500}
                onChange={(e) => setText(e.target.value)}
                onBlur={() => text !== (mark.text ?? "") && onChange({ text: text || null })}
              />
            </Field>
          )}
          {mark.kind === "issue" && (
            <>
              <Field label="Takes it occurred in">
                <Input
                  size="sm"
                  value={takes}
                  placeholder="T3, T7"
                  onChange={(e) => setTakes(e.target.value)}
                  onBlur={() => {
                    const list = takeList(takes);
                    if (list === null) return setProblem("Takes as T3, T7");
                    setProblem(null);
                    onChange({ takes: list });
                  }}
                />
              </Field>
              <Field label="Fixed by">
                <Input
                  size="sm"
                  value={fixedBy}
                  placeholder="T12"
                  onChange={(e) => setFixedBy(e.target.value)}
                  onBlur={() => onChange({ fixedBy: number(fixedBy) })}
                />
              </Field>
              <label className="flex items-center gap-2 text-ink-2">
                <Checkbox
                  checked={mark.resolved}
                  onChange={(e) => onChange({ resolved: e.target.checked })}
                />
                Resolved
              </label>
            </>
          )}
          <span>
            <Button variant="ghost" size="sm" onClick={onDelete}>
              <Icon name="trash" size={14} />
              Rub out
            </Button>
          </span>
        </>
      )}
    </div>
  );
}

/** The edit plot check (#52): the chain from lead-in to final take, and where it breaks. */
function PlotCheck({
  plot,
  edits,
  selected,
  onSelect,
}: {
  plot: EditPlot | undefined;
  edits: ScoreMark[];
  selected: string | null;
  onSelect: (m: ScoreMark) => void;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h2 id={id} className="label m-0">
        Edit plot check
      </h2>
      {!plot || edits.length === 0 ? (
        <p className="m-0 text-[13px] text-ink-3">
          No edit points yet. The check follows them from lead-in to final take.
        </p>
      ) : plot.problems.length === 0 ? (
        <p className="m-0 flex items-start gap-2 text-[13px] text-ink-2">
          <Icon name="check" size={14} className="mt-0.5 shrink-0 text-ink-3" />
          Every hand-over leaves the take the last went into, and every take was recorded.
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px] text-signal">
          {plot.problems.map((p) => (
            <li key={`${p.markId}-${p.text}`} className="flex items-start gap-2">
              <Icon name="warning" size={14} className="mt-0.5 shrink-0" />
              {p.text}
            </li>
          ))}
        </ul>
      )}
      {plot && plot.chain.length > 0 && (
        <p className="tabular m-0 text-[12px] text-ink-3">
          {plot.chain.map((t) => `T${t}`).join(" → ")}
        </p>
      )}
      {edits.length > 0 && (
        <ul className="m-0 flex list-none flex-col p-0 text-[12px]">
          {edits.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => onSelect(m)}
                className={cn(
                  "tabular flex w-full cursor-pointer items-baseline gap-2 rounded-chip border-0 bg-transparent px-1 py-0.5 text-left hover:text-ink",
                  selected === m.id ? "text-ink" : "text-ink-3",
                )}
              >
                <span className="w-14 shrink-0">{barsOf(m) || `p. ${m.page}`}</span>
                {editLabel(m)}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function OnThisPage({
  several,
  marks,
  categories,
  selected,
  onSelect,
}: {
  several: boolean;
  marks: ScoreMark[];
  categories: ScoreMarkCategory[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h2 id={id} className="label m-0">
        On {several ? "these pages" : "this page"} · {marks.length}
      </h2>
      {marks.length > 0 && (
        <ul className="m-0 flex list-none flex-col p-0 text-[13px]">
          {marks.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => onSelect(m.id)}
                className={cn(
                  "flex w-full cursor-pointer items-baseline gap-2 rounded-chip border-0 bg-transparent px-1 py-0.5 text-left hover:text-ink",
                  selected === m.id ? "text-ink" : "text-ink-2",
                )}
              >
                <span className="tabular w-14 shrink-0 text-ink-3">
                  {barsOf(m) || `p. ${m.page}`}
                </span>
                <span className="min-w-0">{markText(m, categories)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
