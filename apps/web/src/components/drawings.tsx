import {
  type Drawing,
  type DrawingColour,
  type DrawingTool,
  drawingColours,
  drawingTools,
} from "@hekate/shared";
import { type PointerEvent, type ReactNode, useRef, useState } from "react";
import { cn } from "~/lib/cn";
import { Icon, type IconName } from "./icons";
import { Input } from "./ui/input";

/** A drawing waiting to join the comment being written: what was drawn, and when. */
export interface FrameDraft {
  drawing: Drawing;
  /** Where in the video it was drawn, in seconds. */
  at: number;
}

/** A thread's drawing on the video, shown while the playhead is on its frame or range. */
export interface FrameDrawing {
  id: string;
  drawing: Drawing;
  at: number;
  end?: number;
}

/** Each colour as a token of the design system: drawings never hard-code a colour. */
export const drawingColour: Record<DrawingColour, string> = {
  signal: "var(--hk-signal)",
  paper: "var(--hk-paper)",
  blue: "var(--hk-draw-blue)",
  green: "var(--hk-draw-green)",
};

const colourWords: Record<DrawingColour, string> = {
  signal: "Orange",
  paper: "White",
  blue: "Blue",
  green: "Green",
};

const toolCopy: Record<DrawingTool, { label: string; icon: IconName }> = {
  box: { label: "Box", icon: "grid" },
  circle: { label: "Circle", icon: "record" },
  line: { label: "Line", icon: "edit" },
  arrow: { label: "Arrow", icon: "arrowRight" },
  free: { label: "Freehand", icon: "pulse" },
  text: { label: "Text", icon: "tag" },
};

/** Units across the picture's height; its width is the aspect times this, so shapes keep their shape. */
const H = 1000;

/** One drawing, in a picture `aspect` wide for each unit high. */
function Shape({ d, aspect, faint = false }: { d: Drawing; aspect: number; faint?: boolean }) {
  const W = aspect * H;
  const pts = d.points.map(([x, y]) => [x * W, y * H] as const);
  const colour = drawingColour[d.colour];
  const stroke = {
    stroke: colour,
    strokeWidth: 3,
    fill: "none",
    vectorEffect: "non-scaling-stroke" as const,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    opacity: faint ? 0.6 : 1,
  };
  const [a, b] = [pts[0], pts[1] ?? pts[0]] as const;
  if (!a || !b) return null;
  switch (d.tool) {
    case "box":
      return (
        <rect
          x={Math.min(a[0], b[0])}
          y={Math.min(a[1], b[1])}
          width={Math.abs(b[0] - a[0])}
          height={Math.abs(b[1] - a[1])}
          {...stroke}
        />
      );
    case "circle":
      return (
        <ellipse
          cx={(a[0] + b[0]) / 2}
          cy={(a[1] + b[1]) / 2}
          rx={Math.abs(b[0] - a[0]) / 2}
          ry={Math.abs(b[1] - a[1]) / 2}
          {...stroke}
        />
      );
    case "line":
      return <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} {...stroke} />;
    case "arrow": {
      // The head drawn in the picture's own proportions, so it points true at any size.
      const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const head = 28;
      const wing = (side: 1 | -1) =>
        `${b[0] - head * Math.cos(angle - (side * Math.PI) / 7)},${b[1] - head * Math.sin(angle - (side * Math.PI) / 7)}`;
      return (
        <g>
          <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} {...stroke} />
          <polyline points={`${wing(1)} ${b[0]},${b[1]} ${wing(-1)}`} {...stroke} />
        </g>
      );
    }
    case "free":
      return <polyline points={pts.map((p) => p.join(",")).join(" ")} {...stroke} />;
    case "text":
      return (
        <text
          x={a[0]}
          y={a[1]}
          fill={colour}
          fontSize={44}
          dominantBaseline="hanging"
          stroke="var(--hk-paper-ink)"
          strokeWidth={6}
          paintOrder="stroke"
          opacity={faint ? 0.6 : 1}
        >
          {d.text}
        </text>
      );
  }
}

/** A box laid over the picture itself, not the player around it, as the frame guides are. */
function OverPicture({
  aspect,
  children,
  className,
}: {
  aspect: number;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-e2e-overlap
      className={cn("absolute inset-0 flex items-center justify-center", className)}
    >
      <div
        className={cn("relative max-h-full max-w-full", aspect >= 16 / 9 ? "w-full" : "h-full")}
        style={{ aspectRatio: aspect }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Drawings on the video (#146): the threads' at the playhead, and the one being written. They
 * take no click; the picture beneath still plays and pauses.
 */
export function DrawingMarks({
  drawings,
  draft,
  aspect,
}: {
  drawings: Drawing[];
  draft: Drawing | null;
  aspect: number;
}) {
  if (drawings.length === 0 && !draft) return null;
  return (
    <OverPicture aspect={aspect} className="pointer-events-none select-none">
      <svg
        aria-hidden="true"
        viewBox={`0 0 ${aspect * H} ${H}`}
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full overflow-visible"
      >
        {drawings.map((d, i) => (
          <Shape key={`${d.tool}-${String(i)}`} d={d} aspect={aspect} faint={draft !== null} />
        ))}
        {draft && <Shape d={draft} aspect={aspect} />}
      </svg>
    </OverPicture>
  );
}

/**
 * Where a drawing is made (#146): a drag draws a box, circle, line or arrow from corner to
 * corner, or a freehand stroke along its path; a click places text, typed in place.
 */
export function DrawLayer({
  tool,
  colour,
  aspect,
  onDrawn,
}: {
  tool: DrawingTool;
  colour: DrawingColour;
  aspect: number;
  onDrawn: (drawing: Drawing) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [points, setPoints] = useState<[number, number][] | null>(null);
  const [typing, setTyping] = useState<{ at: [number, number]; text: string } | null>(null);
  const at = (event: PointerEvent): [number, number] => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect) return [0, 0];
    const unit = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 10_000) / 10_000;
    return [
      unit((event.clientX - rect.left) / rect.width),
      unit((event.clientY - rect.top) / rect.height),
    ];
  };
  const down = (event: PointerEvent) => {
    event.preventDefault();
    if (tool === "text") {
      setTyping({ at: at(event), text: "" });
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const p = at(event);
    setPoints([p, p]);
  };
  const move = (event: PointerEvent) => {
    if (!points) return;
    const p = at(event);
    if (tool === "free") {
      const last = points[points.length - 1];
      // A point every few pixels is enough; a stroke keeps under the limit.
      if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.004 && points.length < 512)
        setPoints([...points, p]);
    } else setPoints([points[0] as [number, number], p]);
  };
  const up = () => {
    if (!points) return;
    const [first, last] = [points[0], points[points.length - 1]];
    setPoints(null);
    // A click, not a drag: nothing is drawn.
    if (!first || !last || Math.hypot(last[0] - first[0], last[1] - first[1]) < 0.01) return;
    onDrawn({ tool, colour, points: tool === "free" ? points : [first, last] });
  };
  const preview: Drawing | null = points
    ? {
        tool,
        colour,
        points: tool === "free" ? points : ([points[0], points[1]] as [number, number][]),
      }
    : null;
  return (
    <OverPicture aspect={aspect}>
      <div
        ref={box}
        role="application"
        aria-label={`Draw on the frame: ${toolCopy[tool].label.toLowerCase()}`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={() => setPoints(null)}
        className="absolute inset-0 cursor-crosshair touch-none"
      >
        {preview && (
          <svg
            aria-hidden="true"
            viewBox={`0 0 ${aspect * H} ${H}`}
            preserveAspectRatio="none"
            className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
          >
            <Shape d={preview} aspect={aspect} />
          </svg>
        )}
        {typing && (
          <form
            className="absolute"
            style={{ left: `${typing.at[0] * 100}%`, top: `${typing.at[1] * 100}%` }}
            onPointerDown={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              const text = typing.text.trim();
              if (text) onDrawn({ tool: "text", colour, points: [typing.at], text });
              setTyping(null);
            }}
          >
            <Input
              size="sm"
              autoFocus
              aria-label="Text on the frame"
              maxLength={200}
              value={typing.text}
              onChange={(e) => setTyping({ ...typing, text: e.target.value })}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Escape") setTyping(null);
              }}
              onBlur={(e) => e.currentTarget.form?.requestSubmit()}
              className="w-48"
            />
          </form>
        )}
      </div>
    </OverPicture>
  );
}

/** The tools and colours, over the foot of the picture, as the prototype's toolbar has them. */
export function DrawToolbar({
  tool,
  onTool,
  colour,
  onColour,
  onClose,
}: {
  tool: DrawingTool;
  onTool: (tool: DrawingTool) => void;
  colour: DrawingColour;
  onColour: (colour: DrawingColour) => void;
  onClose: () => void;
}) {
  const button =
    "flex size-8 cursor-pointer items-center justify-center rounded-full border-0 bg-transparent transition-colors";
  return (
    <div
      role="toolbar"
      aria-label="Drawing"
      data-e2e-overlap
      className="rise-in absolute inset-x-0 bottom-3 z-20 mx-auto flex w-fit max-w-[calc(100%-1.5rem)] flex-wrap items-center justify-center gap-0.5 rounded-full bg-overlay p-1 shadow-3"
    >
      {drawingTools.map((t) => (
        <button
          key={t}
          type="button"
          aria-label={toolCopy[t].label}
          aria-pressed={tool === t}
          title={toolCopy[t].label}
          onClick={() => onTool(t)}
          className={cn(button, tool === t ? "bg-raised text-ink" : "text-ink-2 hover:text-ink")}
        >
          <Icon name={toolCopy[t].icon} size={14} />
        </button>
      ))}
      <span className="mx-1 h-5 w-px bg-line-strong" />
      {drawingColours.map((c) => (
        <button
          key={c}
          type="button"
          aria-label={colourWords[c]}
          aria-pressed={colour === c}
          title={colourWords[c]}
          onClick={() => onColour(c)}
          className={cn(button, colour === c && "bg-raised")}
        >
          <span className="size-3.5 rounded-full" style={{ background: drawingColour[c] }} />
        </button>
      ))}
      <span className="mx-1 h-5 w-px bg-line-strong" />
      <button
        type="button"
        aria-label="Stop drawing"
        title="Stop drawing"
        onClick={onClose}
        className={cn(button, "text-ink-2 hover:text-ink")}
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
