import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type KeyboardEvent, type PointerEvent, useEffect, useRef, useState } from "react";
import { cn } from "~/lib/cn";
import {
  clampPage,
  drawsWith,
  type PageFocus,
  type Point,
  pointIn,
  type Rect,
  regionFromDrag,
  regionFromPress,
  zoomLabel,
  zoomStep,
} from "~/lib/pages";
import { viewQuery } from "~/lib/queries";
import { useShortcuts } from "~/lib/shortcuts";
import { Icon } from "./icons";
import { Button } from "./ui/button";

/** An open thread pinned to a region of a page, numbered as in the comments. */
export interface RegionMarker {
  id: string;
  n: number;
  /** Undefined on a picture, which is one page. */
  page: number | undefined;
  rect: Rect;
}

const place = (r: Rect) => ({
  left: `${r.x * 100}%`,
  top: `${r.y * 100}%`,
  width: `${r.width * 100}%`,
  height: `${r.height * 100}%`,
});

/**
 * A document or picture as the server drew it (#29): one page at a time, with thumbnails
 * beside it when there are several. The file itself never reaches the browser; each page
 * comes through a link bound to this session, and asking for a page is logged.
 *
 * Whoever may comment draws a rectangle on the page to point a new comment at it; open
 * threads show where they point, and picking one picks it in the comments too.
 */
export function DocumentViewer({
  fileId,
  name,
  focus,
  onFocus,
  markers = [],
  canDraw = false,
}: {
  fileId: string;
  name: string;
  focus: PageFocus;
  onFocus: (change: Partial<PageFocus>) => void;
  markers?: RegionMarker[];
  canDraw?: boolean;
}) {
  const client = useQueryClient();
  const { data, error } = useQuery(viewQuery(fileId));
  /** A multiple of the width that fits: 1 is the whole page across the viewer. */
  const [zoom, setZoom] = useState(1);
  /** Where a drag began on the page, while one is under way. */
  const [dragFrom, setDragFrom] = useState<{ x: number; y: number } | null>(null);
  const [dragRect, setDragRect] = useState<Rect | null>(null);
  /**
   * Drawing turned on (#150): a finger draws instead of scrolling, and two taps make a region
   * as well as a drag. Off, a finger scrolls and zooms the page.
   */
  const [drawing, setDrawing] = useState(false);
  /** The first corner tapped while drawing, until the opposite one is. */
  const [corner, setCorner] = useState<Point | null>(null);
  const surface = useRef<HTMLElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const rail = useRef<HTMLOListElement>(null);
  const count = data?.pages.length ?? 0;
  const page = focus.page;
  const current = data?.pages.find((p) => p.page === page);
  // A document's regions carry the page they are on; a picture's carry none.
  const here = markers.filter((m) => m.page === undefined || m.page === page);
  const go = (to: number) => {
    const next = clampPage(to, count);
    // A region drawn, or a thread picked, on one page is let go on another.
    if (next !== page) onFocus({ page: next, draft: null, selected: null });
  };

  // The thumbnail of the page shown stays in view.
  useEffect(() => {
    rail.current
      ?.querySelector(`[data-page="${page}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [page]);
  // A new page starts at its top, and a corner tapped on the last one is let go.
  useEffect(() => {
    if (page) surface.current?.scrollTo({ top: 0 });
    setCorner(null);
  }, [page]);
  // A thread picked in the comments brings its region into view.
  useEffect(() => {
    if (!focus.selected) return;
    sheet.current
      ?.querySelector(`[data-region="${focus.selected}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [focus.selected]);

  // The viewer takes these itself, once it has focus; the map shows them while it is here.
  useShortcuts(
    "document",
    "Document",
    [
      { keys: ["ArrowRight", "PageDown"], label: "Next page", where: "In the document" },
      { keys: ["ArrowLeft", "PageUp"], label: "Previous page", where: "In the document" },
      { keys: ["Home"], label: "First page", where: "In the document" },
      { keys: ["End"], label: "Last page", where: "In the document" },
      { keys: ["+", "-", "0"], label: "Zoom in, out, or back to fit", where: "In the document" },
    ],
    Boolean(data && !error),
  );

  if (error) return <p className="m-0 text-sm text-signal">{error.message}</p>;
  if (!data) return <p className="m-0 text-sm text-ink-3">Loading the pages</p>;

  // Links lapse after a few hours: when one fails, ask for fresh ones.
  const refresh = () => void client.invalidateQueries({ queryKey: viewQuery(fileId).queryKey });

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === "ArrowRight" || event.key === "PageDown") go(page + 1);
    else if (event.key === "ArrowLeft" || event.key === "PageUp") go(page - 1);
    else if (event.key === "Home") go(1);
    else if (event.key === "End") go(count);
    else if (event.key === "+" || event.key === "=") setZoom((z) => zoomStep(z, 1));
    else if (event.key === "-") setZoom((z) => zoomStep(z, -1));
    else if (event.key === "0") setZoom(1);
    else if (event.key === "Escape" && (focus.draft || focus.selected || corner)) {
      setCorner(null);
      onFocus({ draft: null, selected: null });
    } else return;
    event.preventDefault();
  };

  const at = (event: PointerEvent<HTMLElement>) =>
    pointIn(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY);
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    // A finger scrolls and zooms the page unless drawing is on; a mouse or a pen draws.
    if (!canDraw || event.button !== 0 || !drawsWith(event.pointerType, drawing)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragFrom(at(event));
    setDragRect(null);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragFrom) setDragRect(regionFromDrag(dragFrom, at(event)));
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragFrom) return;
    const to = at(event);
    setDragFrom(null);
    setDragRect(null);
    if (drawing) {
      // A drag draws its region; a tap sets a corner, and the next tap the opposite one.
      const pressed = regionFromPress(corner, dragFrom, to);
      setCorner(pressed.corner);
      onFocus({ draft: pressed.draft, selected: null });
      return;
    }
    // A click on the page lets go of the region and the thread; a drag draws a new region.
    const rect = regionFromDrag(dragFrom, to);
    onFocus(rect ? { draft: rect, selected: null } : { draft: null, selected: null });
  };
  const toggleDrawing = () => {
    setDrawing(!drawing);
    setCorner(null);
  };
  const drawn = dragRect ?? focus.draft;

  return (
    <section
      aria-label={`Pages of ${name}`}
      className="flex flex-col overflow-hidden rounded-panel border border-hairline bg-surface"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-3 py-2">
        {count > 1 && (
          <span className="flex items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              aria-label="Previous page"
              disabled={page <= 1}
              onClick={() => go(page - 1)}
            >
              ‹
            </Button>
            <span className="tabular min-w-16 text-center text-xs text-ink-2">
              {page} / {count}
            </span>
            <Button
              size="icon"
              variant="ghost"
              aria-label="Next page"
              disabled={page >= count}
              onClick={() => go(page + 1)}
            >
              ›
            </Button>
          </span>
        )}
        {canDraw && (
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={drawing}
            title={drawing ? "Stop drawing, so a finger scrolls" : "Draw a region with a finger"}
            onClick={toggleDrawing}
            className="aria-pressed:bg-raised aria-pressed:text-ink"
          >
            <Icon name="edit" size={14} />
            Draw
          </Button>
        )}
        {canDraw &&
          (drawing ? (
            <span role="status" className="text-xs text-ink-3">
              {corner ? "Now tap the opposite corner" : "Drag, or tap two corners"}
            </span>
          ) : (
            <span className="hidden text-xs text-ink-3 md:inline">
              Drag on the page to comment on part of it
            </span>
          ))}
        <span className="ml-auto flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Zoom out"
            disabled={zoom <= 1}
            onClick={() => setZoom((z) => zoomStep(z, -1))}
          >
            <Icon name="zoomOut" size={14} />
          </Button>
          <button
            type="button"
            onClick={() => setZoom(1)}
            className="tabular h-7 min-w-14 cursor-pointer rounded-chip border-0 bg-transparent px-2 text-xs text-ink-2 hover:text-ink"
            title="Fit the page to the viewer"
          >
            {zoomLabel(zoom)}
          </button>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Zoom in"
            disabled={zoom >= 4}
            onClick={() => setZoom((z) => zoomStep(z, 1))}
          >
            <Icon name="zoomIn" size={14} />
          </Button>
        </span>
      </div>
      <div className="flex min-h-0">
        {count > 1 && (
          <ol
            ref={rail}
            aria-label="Pages"
            className="m-0 hidden max-h-[75vh] w-28 shrink-0 list-none flex-col gap-3 overflow-y-auto border-r border-hairline p-3 sm:flex"
          >
            {data.pages.map((p) => {
              const threads = markers.filter((m) => m.page === p.page).length;
              return (
                <li key={p.page} data-page={p.page}>
                  <button
                    type="button"
                    aria-label={`Page ${p.page}${threads ? `, ${threads} ${threads === 1 ? "thread" : "threads"}` : ""}`}
                    aria-current={p.page === page ? "page" : undefined}
                    onClick={() => go(p.page)}
                    className="flex w-full cursor-pointer flex-col items-center gap-1 border-0 bg-transparent p-0"
                  >
                    <img
                      src={p.thumbUrl}
                      alt=""
                      loading="lazy"
                      draggable={false}
                      width={p.width}
                      height={p.height}
                      onError={refresh}
                      className={cn(
                        "h-auto w-full rounded-[3px] bg-ground outline outline-1",
                        p.page === page ? "outline-signal" : "outline-hairline",
                      )}
                    />
                    <span
                      className={cn(
                        "tabular flex items-center gap-1.5 text-[11px]",
                        p.page === page ? "text-ink" : "text-ink-3",
                      )}
                    >
                      {p.page}
                      {threads > 0 && (
                        <span aria-hidden className="size-1.5 rounded-full bg-signal" />
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
        {/* Focusable, so the arrow keys turn pages once the viewer has been clicked. */}
        <section
          ref={surface}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the page surface takes keys for turning pages and zooming.
          tabIndex={0}
          aria-label={`Page ${page}`}
          onKeyDown={onKeyDown}
          className="max-h-[75vh] min-w-0 flex-1 overflow-auto bg-ground p-4 outline-none focus-visible:ring-1 focus-visible:ring-signal"
        >
          {current && (
            <div
              ref={sheet}
              className={cn(
                "relative mx-auto select-none",
                canDraw && "cursor-crosshair",
                // Drawing on, a finger draws rather than scrolling the page.
                canDraw && drawing && "touch-none",
              )}
              style={{ width: `${zoom * 100}%` }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => {
                setDragFrom(null);
                setDragRect(null);
              }}
            >
              <img
                key={current.url}
                src={current.url}
                alt={`Page ${current.page} of ${name}`}
                draggable={false}
                width={current.width}
                height={current.height}
                onError={refresh}
                onContextMenu={(event) => event.preventDefault()}
                className="block h-auto w-full max-w-none"
              />
              {here.map((m) => {
                const picked = m.id === focus.selected;
                return (
                  <button
                    key={m.id}
                    type="button"
                    data-region={m.id}
                    aria-label={`Thread ${m.n}`}
                    aria-pressed={picked}
                    // A marker is picked, not drawn over.
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => onFocus({ selected: picked ? null : m.id, draft: null })}
                    style={place(m.rect)}
                    className={cn(
                      "absolute cursor-pointer rounded-[2px] border p-0",
                      picked
                        ? "border-signal bg-signal/15"
                        : "border-signal/70 bg-signal/5 hover:bg-signal/10",
                    )}
                  >
                    <span
                      className={cn(
                        "tabular absolute -top-px -left-px flex h-4 min-w-4 items-center justify-center rounded-br-[3px] px-1 text-[10px] leading-none font-medium",
                        picked ? "bg-signal text-ground" : "bg-signal/80 text-ground",
                      )}
                    >
                      {m.n}
                    </span>
                  </button>
                );
              })}
              {drawn && (
                <div
                  aria-hidden
                  data-draft
                  style={place(drawn)}
                  className="pointer-events-none absolute rounded-[2px] border border-dashed border-signal bg-signal/10"
                />
              )}
              {corner && (
                <div
                  aria-hidden
                  data-e2e-overlap
                  style={{ left: `${corner.x * 100}%`, top: `${corner.y * 100}%` }}
                  className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-signal bg-ground"
                />
              )}
            </div>
          )}
        </section>
      </div>
      {data.pageCount > count && (
        <p className="m-0 border-t border-hairline px-3 py-2 text-xs text-ink-3">
          Showing the first {count} of {data.pageCount} pages.
        </p>
      )}
    </section>
  );
}
