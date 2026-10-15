import { useState } from "react";
import { cn } from "~/lib/cn";

/**
 * One series per chart, thin marks, recessive grid, a hover readout. Identity never rides on colour:
 * the title names the series, and signal is kept for a value that needs a person.
 */
export function Spark({
  label,
  points,
  unit = "",
  hint,
  flag = false,
  max,
}: {
  label: string;
  points: number[];
  unit?: string;
  hint?: string;
  flag?: boolean;
  max?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 240;
  const H = 64;
  const top = max ?? (Math.max(...points) * 1.15 || 1);
  const x = (i: number) => (i / (points.length - 1)) * W;
  const y = (v: number) => H - (v / top) * (H - 6) - 2;
  const d = points
    .map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`)
    .join(" ");
  const area = `${d} L${W},${H} L0,${H} Z`;
  const i = hover ?? points.length - 1;
  const value = points[i] ?? 0;
  return (
    <div className="flex flex-col gap-2 bg-raised/25 px-4 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] text-ink-3">{label}</span>
        <span className={cn("tabular text-[14px]", flag ? "text-signal" : "text-ink")}>
          {Number.isInteger(value) ? value : value.toFixed(1)}
          {unit}
          {hover !== null && (
            <span className="ml-1 text-[11px] text-ink-3">
              {24 - Math.round((i / (points.length - 1)) * 24)} h ago
            </span>
          )}
        </span>
      </div>
      <svg
        role="img"
        aria-label={`${label} over the last day`}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-16 w-full"
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setHover(Math.round(((e.clientX - r.left) / r.width) * (points.length - 1)));
        }}
        onMouseLeave={() => setHover(null)}
      >
        {[0.5].map((g) => (
          <line
            key={g}
            x1={0}
            x2={W}
            y1={H * g}
            y2={H * g}
            className="stroke-line"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <path d={area} className={flag ? "fill-signal/10" : "fill-ink/5"} />
        <path
          d={d}
          fill="none"
          className={flag ? "stroke-signal" : "stroke-ink-2"}
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
        />
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
        <circle
          cx={x(i)}
          cy={y(value)}
          r={3}
          className={cn(flag ? "fill-signal" : "fill-ink", "stroke-raised")}
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {hint && <span className="text-[11px] text-ink-3">{hint}</span>}
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
  value: number;
  text: string;
  hint?: string;
  warnAt?: number;
}) {
  const r = 34;
  const c = Math.PI * r;
  const v = Math.min(1, Math.max(0, value));
  const flag = v >= warnAt;
  return (
    <div className="flex flex-col items-center gap-1 bg-raised/25 px-4 py-3">
      <span className="self-start text-[12px] text-ink-3">{label}</span>
      <svg
        role="img"
        aria-label={`${label}: ${text}`}
        viewBox="0 0 88 50"
        className="h-[50px] w-[88px]"
      >
        <path
          d={`M6,46 A${r},${r} 0 0 1 82,46`}
          fill="none"
          className="stroke-raised"
          strokeWidth={6}
          strokeLinecap="round"
        />
        <path
          d={`M6,46 A${r},${r} 0 0 1 82,46`}
          fill="none"
          className={flag ? "stroke-signal" : "stroke-ink-2"}
          strokeWidth={6}
          strokeLinecap="round"
          strokeDasharray={`${c * v} ${c}`}
        />
        <text
          x={44}
          y={44}
          textAnchor="middle"
          className={cn("tabular text-[16px] font-medium", flag ? "fill-signal" : "fill-ink")}
        >
          {text}
        </text>
      </svg>
      {hint && <span className="text-[11px] text-ink-3">{hint}</span>}
    </div>
  );
}
