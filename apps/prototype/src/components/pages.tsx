import { useEffect, useRef, useState } from "react";
import { Icon } from "~/components/icons";
import type { Comment, File } from "~/data";
import { cn } from "~/lib/cn";
import { seeded } from "~/lib/seeded";

/** One page of a score, a document or a picture, as the server would have drawn it. */
export function Page({
  file,
  page,
  width,
  className,
}: {
  file: File;
  page: number;
  width: number;
  className?: string;
}) {
  const rand = seeded(file.seed * 100 + page);
  const score = file.name.toLowerCase().includes("score");
  const picture = file.kind === "image";
  const h = picture ? width : Math.round(width * Math.SQRT2);
  if (picture) {
    return (
      <svg
        width={width}
        height={h}
        viewBox="0 0 300 300"
        className={className}
        role="img"
        aria-label={file.name}
      >
        <defs>
          <radialGradient id={`g-${file.id}`} cx="35%" cy="30%" r="80%">
            <stop offset="0%" stopColor="#3b2c2a" />
            <stop offset="60%" stopColor="#15110f" />
            <stop offset="100%" stopColor="#070708" />
          </radialGradient>
        </defs>
        <rect width="300" height="300" fill={`url(#g-${file.id})`} />
        <circle cx="105" cy="90" r="38" fill="#f0762e" opacity="0.9" />
        <rect
          x="24"
          y="14"
          width="252"
          height="30"
          fill="none"
          stroke="#e9e8e3"
          strokeOpacity="0.35"
        />
        <text
          x="150"
          y="34"
          textAnchor="middle"
          fill="#e9e8e3"
          fontFamily="var(--hk-font-sans)"
          fontSize="18"
          fontWeight="500"
          letterSpacing="-0.02em"
        >
          JOPLIN RAGS
        </text>
        <text
          x="150"
          y="262"
          textAnchor="middle"
          fill="#e9e8e3"
          fontFamily="var(--hk-font-mono)"
          fontSize="9"
          letterSpacing="0.2em"
          opacity="0.8"
        >
          ENDLESS HALL RECORDS
        </text>
      </svg>
    );
  }
  return (
    <svg
      width={width}
      height={h}
      viewBox="0 0 420 594"
      className={className}
      role="img"
      aria-label={`${file.name}, page ${page}`}
    >
      <rect width="420" height="594" fill="var(--hk-paper)" />
      {score ? (
        <>
          {page === 1 && (
            <>
              <text
                x="210"
                y="56"
                textAnchor="middle"
                fill="#1a1a1c"
                fontFamily="var(--hk-font-sans)"
                fontSize="20"
                fontWeight="500"
              >
                Maple Leaf Rag
              </text>
              <text
                x="372"
                y="80"
                textAnchor="end"
                fill="#1a1a1c"
                fontFamily="var(--hk-font-sans)"
                fontSize="9"
              >
                Scott Joplin
              </text>
              <text
                x="48"
                y="80"
                fill="#1a1a1c"
                fontFamily="var(--hk-font-sans)"
                fontSize="9"
                fontStyle="italic"
              >
                Tempo di marcia
              </text>
            </>
          )}
          {Array.from({ length: 6 }, (_, sys) => {
            const top = (page === 1 ? 100 : 48) + sys * 82;
            if (top > 540) return null;
            const barStart = (page - 1) * 24 + sys * 4 + 1;
            return (
              <g key={sys}>
                {[0, 1].map((staff) =>
                  [0, 1, 2, 3, 4].map((line) => (
                    <line
                      key={`${staff}-${line}`}
                      x1="40"
                      x2="380"
                      y1={top + staff * 34 + line * 5}
                      y2={top + staff * 34 + line * 5}
                      stroke="#2a2a2e"
                      strokeWidth="0.6"
                    />
                  )),
                )}
                <line
                  x1="40"
                  x2="40"
                  y1={top}
                  y2={top + 34 + 20}
                  stroke="#2a2a2e"
                  strokeWidth="0.8"
                />
                {[1, 2, 3, 4].map((b) => (
                  <line
                    key={b}
                    x1={40 + b * 85}
                    x2={40 + b * 85}
                    y1={top}
                    y2={top + 54}
                    stroke="#2a2a2e"
                    strokeWidth="0.6"
                  />
                ))}
                <text
                  x="40"
                  y={top - 4}
                  fill="#2a2a2e"
                  fontFamily="var(--hk-font-sans)"
                  fontSize="7"
                >
                  {barStart}
                </text>
                {Array.from({ length: 28 }, (_, n) => {
                  const x = 48 + n * 11.8;
                  const y = top + Math.floor(rand() * 5) * 5 + (n % 2 ? 0 : 34);
                  return (
                    <g key={n}>
                      <ellipse
                        cx={x}
                        cy={y}
                        rx="2.6"
                        ry="1.9"
                        fill="#1a1a1c"
                        transform={`rotate(-20 ${x} ${y})`}
                      />
                      <line
                        x1={x + 2.4}
                        x2={x + 2.4}
                        y1={y - 14}
                        y2={y}
                        stroke="#1a1a1c"
                        strokeWidth="0.7"
                      />
                    </g>
                  );
                })}
              </g>
            );
          })}
          <text
            x="210"
            y="580"
            textAnchor="middle"
            fill="#2a2a2e"
            fontFamily="var(--hk-font-sans)"
            fontSize="7"
          >
            {page}
          </text>
        </>
      ) : (
        <>
          <text
            x="48"
            y="70"
            fill="#1a1a1c"
            fontFamily="var(--hk-font-sans)"
            fontSize="16"
            fontWeight="500"
          >
            {page === 1 ? file.name.replace(/\.pdf$/i, "") : ""}
          </text>
          {Array.from({ length: 30 }, (_, i) => (
            <rect
              key={i}
              x="48"
              y={100 + i * 14}
              width={i % 7 === 6 ? 120 + rand() * 80 : 300 + rand() * 24}
              height="4"
              rx="2"
              fill="#1a1a1c"
              opacity={i % 7 === 6 ? 0.25 : 0.55}
            />
          ))}
          <text
            x="210"
            y="580"
            textAnchor="middle"
            fill="#2a2a2e"
            fontFamily="var(--hk-font-sans)"
            fontSize="7"
          >
            {page}
          </text>
        </>
      )}
    </svg>
  );
}

export interface RegionMarker {
  id: string;
  number: number;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  active: boolean;
}

export function markersFrom(comments: Comment[], open: Comment[]): RegionMarker[] {
  return open
    .filter((c) => c.anchor.kind === "region" && c.anchor.page !== undefined)
    .map((c) => {
      const a = c.anchor as Extract<Comment["anchor"], { kind: "region" }>;
      return {
        id: c.id,
        number: open.indexOf(c) + 1,
        page: a.page ?? 1,
        x: a.x,
        y: a.y,
        width: a.width,
        height: a.height,
        active: false,
      };
    })
    .filter((m) => comments.some((c) => c.id === m.id));
}

/**
 * Pages the server drew, with a rail of thumbnails, zoom, and region comments numbered in
 * reading order. Dragging on a page draws the next comment's region when the viewer may.
 */
export function PageViewer({
  file,
  page,
  onPage,
  markers,
  selected,
  onSelect,
  canDraw,
  watermark,
  compact = false,
}: {
  file: File;
  page: number;
  onPage: (p: number) => void;
  markers: RegionMarker[];
  selected: string | null;
  onSelect: (id: string) => void;
  canDraw: boolean;
  watermark?: string;
  compact?: boolean;
}) {
  const [zoom, setZoom] = useState<number>(1);
  const [drag, setDrag] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [drawn, setDrawn] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const pages = file.media.pages ?? 1;
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setWidth(Math.floor(e.contentRect.width));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const pageWidth = Math.min(width - (compact ? 0 : 24), 720) * zoom;
  const rel = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  return (
    <div className="flex min-h-0 flex-col rounded-panel-lg border border-hairline bg-surface shadow-1">
      <div className="flex flex-wrap items-center gap-2 border-b border-hairline-soft px-3 py-2">
        <button
          type="button"
          aria-label="Previous page"
          onClick={() => onPage(Math.max(1, page - 1))}
          disabled={page <= 1}
          className="flex size-7 items-center justify-center rounded-control text-ink-2 hover:bg-raised disabled:opacity-40"
        >
          <Icon name="chevronLeft" size={14} />
        </button>
        <span className="tabular text-xs text-ink">
          P. {page} <span className="text-ink-3">/ {pages}</span>
        </span>
        <button
          type="button"
          aria-label="Next page"
          onClick={() => onPage(Math.min(pages, page + 1))}
          disabled={page >= pages}
          className="flex size-7 items-center justify-center rounded-control text-ink-2 hover:bg-raised disabled:opacity-40"
        >
          <Icon name="chevronRight" size={14} />
        </button>
        {!compact && (
          <label className="ml-2 flex items-center gap-1 text-xs text-ink-3">
            Go to{" "}
            <input
              aria-label="Go to page"
              className="tabular h-6 w-12 rounded-chip border border-hairline bg-ground px-1.5 text-xs text-ink"
              onKeyDown={(e) => {
                if (e.key === "Enter")
                  onPage(
                    Math.min(pages, Math.max(1, Number((e.target as HTMLInputElement).value) || 1)),
                  );
              }}
            />
          </label>
        )}
        {canDraw && (
          <span className="hidden text-xs text-ink-3 @3xl/app:inline">
            Drag on the page to comment on part of it
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            aria-label="Zoom out"
            onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))}
            className="flex size-7 items-center justify-center rounded-control text-ink-2 hover:bg-raised"
          >
            <Icon name="zoomOut" size={14} />
          </button>
          <button
            type="button"
            onClick={() => setZoom(1)}
            className="tabular h-7 rounded-control px-1.5 text-xs text-ink-2 hover:bg-raised"
          >
            {zoom === 1 ? "Fit" : `${Math.round(zoom * 100)}%`}
          </button>
          <button
            type="button"
            aria-label="Zoom in"
            onClick={() => setZoom((z) => Math.min(4, z + 0.25))}
            className="flex size-7 items-center justify-center rounded-control text-ink-2 hover:bg-raised"
          >
            <Icon name="zoomIn" size={14} />
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        {!compact && pages > 1 && (
          <div
            className="hidden w-[108px] shrink-0 flex-col gap-2 overflow-auto border-r border-hairline-soft bg-sunken p-2 @3xl/app:flex"
            style={{ maxHeight: 640 }}
          >
            {Array.from({ length: Math.min(pages, 40) }, (_, i) => i + 1).map((p) => (
              <button
                key={p}
                type="button"
                aria-label={`Page ${p}`}
                aria-current={p === page ? "page" : undefined}
                onClick={() => onPage(p)}
                className={cn(
                  "relative rounded-[3px] ring-offset-2 ring-offset-sunken",
                  p === page && "ring-1 ring-signal",
                )}
              >
                <Page file={file} page={p} width={88} className="block shadow-paper" />
                {markers.filter((m) => m.page === p).length > 0 && (
                  <span className="tabular absolute top-1 right-1 rounded-full bg-signal px-1 text-[9px] leading-[14px] font-medium text-ground">
                    {markers.filter((m) => m.page === p).length}
                  </span>
                )}
                <span className="tabular mt-0.5 block text-[10px] text-ink-3">{p}</span>
              </button>
            ))}
            {pages > 40 && <p className="m-0 text-[10px] text-ink-3">{pages - 40} more pages</p>}
          </div>
        )}
        <div
          ref={box}
          className="min-h-0 min-w-0 flex-1 overflow-auto bg-sunken p-3 @3xl/app:p-6"
          style={{ maxHeight: compact ? 420 : 720 }}
        >
          <div
            className={cn(
              "relative mx-auto select-none shadow-paper",
              canDraw && "cursor-crosshair",
            )}
            style={{ width: pageWidth }}
            onPointerDown={(e) => {
              if (!canDraw) return;
              const p = rel(e);
              setDrag({ x: p.x, y: p.y, w: 0, h: 0 });
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (!drag) return;
              const p = rel(e);
              setDrag({ x: drag.x, y: drag.y, w: p.x - drag.x, h: p.y - drag.y });
            }}
            onPointerUp={() => {
              if (drag && Math.abs(drag.w) > 0.02 && Math.abs(drag.h) > 0.02)
                setDrawn({
                  x: Math.min(drag.x, drag.x + drag.w),
                  y: Math.min(drag.y, drag.y + drag.h),
                  w: Math.abs(drag.w),
                  h: Math.abs(drag.h),
                });
              setDrag(null);
            }}
          >
            <Page file={file} page={page} width={pageWidth} className="block" />
            {watermark && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden"
              >
                <span
                  className="-rotate-[28deg] whitespace-nowrap font-mono text-[11px] tracking-[0.3em] text-[#1a1a1c] opacity-[0.16]"
                  style={{ fontSize: Math.max(10, pageWidth / 28) }}
                >
                  {watermark}
                </span>
              </div>
            )}
            {markers
              .filter((m) => m.page === page)
              .map((m) => (
                <button
                  key={m.id}
                  type="button"
                  aria-label={`Comment ${m.number}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(m.id);
                  }}
                  className={cn(
                    "absolute rounded-[2px] border",
                    selected === m.id
                      ? "border-signal bg-signal/20"
                      : "border-signal/70 bg-signal/10 hover:bg-signal/20",
                  )}
                  style={{
                    left: `${m.x * 100}%`,
                    top: `${m.y * 100}%`,
                    width: `${m.width * 100}%`,
                    height: `${m.height * 100}%`,
                  }}
                >
                  <span className="tabular absolute -top-2 -left-2 flex size-[17px] items-center justify-center rounded-full bg-signal text-[10px] font-medium text-ground">
                    {m.number}
                  </span>
                </button>
              ))}
            {(drag || drawn) && (
              <div
                className="pointer-events-none absolute border border-dashed border-signal bg-signal/10"
                style={{
                  left: `${(drag ? Math.min(drag.x, drag.x + drag.w) : (drawn?.x ?? 0)) * 100}%`,
                  top: `${(drag ? Math.min(drag.y, drag.y + drag.h) : (drawn?.y ?? 0)) * 100}%`,
                  width: `${(drag ? Math.abs(drag.w) : (drawn?.w ?? 0)) * 100}%`,
                  height: `${(drag ? Math.abs(drag.h) : (drawn?.h ?? 0)) * 100}%`,
                }}
              />
            )}
          </div>
          {drawn && (
            <p className="m-0 mt-3 text-center text-xs text-ink-3">
              Region drawn on page {page}: the next comment points at it.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
