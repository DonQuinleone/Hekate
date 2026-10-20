import { useState } from "react";
import { cn } from "~/lib/cn";

/**
 * One series per chart, thin marks, a recessive grid and a hover readout, as the prototype
 * draws them. Identity never rides on colour: the title names the series, and signal is kept
 * for a value that needs a person. A point nothing measured is a gap, not a zero.
 */
export function Spark({
  label,
  points,
  format,
  when,
  hint,
  max,
}: {
  label: string;
  points: (number | null)[];
  format: (value: number) => string;
  /** When a point was, for the hover readout ("3 h ago"). */
  when: (index: number) => string;
  hint?: string;
  max?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 240;
  const H = 64;
  const known = points.filter((p): p is number => p !== null);
  const top = max || Math.max(...known, 0) * 1.15 || 1;
  const x = (i: number) => (i / Math.max(1, points.length - 1)) * W;
  const y = (v: number) => H - (v / top) * (H - 6) - 2;
  // Runs of measured points, each drawn on its own.
  const runs: { i: number; v: number }[][] = [];
  points.forEach((v, i) => {
    if (v === null) return;
    const run = runs.at(-1);
    if (run && run.at(-1)?.i === i - 1) run.push({ i, v });
    else runs.push([{ i, v }]);
  });
  const line = (run: { i: number; v: number }[]) =>
    run.map((p, n) => `${n === 0 ? "M" : "L"}${x(p.i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const lastKnown = points.findLastIndex((p) => p !== null);
  const i = hover ?? lastKnown;
  const value = i >= 0 ? (points[i] ?? null) : null;
  return (
    <div className="flex min-w-0 flex-col gap-2 bg-pane px-4 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[12px] text-ink-3">{label}</span>
        <span className="tabular shrink-0 text-[14px] text-ink">
          {value === null ? "No data" : format(value)}
          {hover !== null && <span className="ml-1 text-[11px] text-ink-3">{when(i)}</span>}
        </span>
      </div>
      <svg
        role="img"
        aria-label={`${label}${value === null ? ": nothing measured" : `, latest ${format(value)}`}`}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-16 w-full"
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setHover(Math.round(((e.clientX - r.left) / r.width) * (points.length - 1)));
        }}
        onMouseLeave={() => setHover(null)}
      >
        <line
          x1={0}
          x2={W}
          y1={H / 2}
          y2={H / 2}
          className="stroke-line"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        {runs.map((run) => {
          const d = line(run);
          const first = run[0];
          const last = run.at(-1);
          return (
            <g key={first?.i}>
              {first && last && (
                <path
                  d={`${d} L${x(last.i)},${H} L${x(first.i)},${H} Z`}
                  className="fill-node-review/10"
                />
              )}
              <path
                d={d}
                fill="none"
                className="stroke-node-review"
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
              />
            </g>
          );
        })}
        {hover !== null && (
          <line
            x1={x(i)}
            x2={x(i)}
            y1={0}
            y2={H}
            className="stroke-ink-3"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
            strokeDasharray="3 3"
          />
        )}
        {value !== null && (
          <circle
            cx={x(i)}
            cy={y(value)}
            r={3}
            className="fill-node-review stroke-pane"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      {hint && <span className="truncate text-[11px] text-ink-3">{hint}</span>}
    </div>
  );
}

/** A share of a whole, as a thin arc with the figure inside; signal past the threshold. */
export function Gauge({
  label,
  value,
  text,
  hint,
  warnAt = 0.85,
}: {
  label: string;
  /** The share, or null when it could not be measured. */
  value: number | null;
  text: string;
  hint?: string;
  warnAt?: number;
}) {
  const r = 44;
  const c = Math.PI * r;
  const v = Math.min(1, Math.max(0, value ?? 0));
  const flag = value !== null && v >= warnAt;
  return (
    <div className="flex flex-col items-center gap-1 bg-pane px-4 py-3">
      <span className="self-start text-[12px] text-ink-3">{label}</span>
      <svg
        role="img"
        aria-label={`${label}: ${text}`}
        viewBox="0 0 112 64"
        className="h-[64px] w-[112px]"
      >
        <path
          d={`M8,58 A${r},${r} 0 0 1 104,58`}
          fill="none"
          className="stroke-raised"
          strokeWidth={7}
          strokeLinecap="round"
        />
        {value !== null && (
          <path
            d={`M8,58 A${r},${r} 0 0 1 104,58`}
            fill="none"
            className={flag ? "stroke-signal" : "stroke-node-review"}
            strokeWidth={7}
            strokeLinecap="round"
            strokeDasharray={`${c * v} ${c}`}
          />
        )}
        <text
          x={56}
          y={56}
          textAnchor="middle"
          className={cn("tabular text-[20px] font-medium", flag ? "fill-signal" : "fill-ink")}
        >
          {text}
        </text>
      </svg>
      {hint && <span className="text-center text-[11px] text-ink-3">{hint}</span>}
    </div>
  );
}
