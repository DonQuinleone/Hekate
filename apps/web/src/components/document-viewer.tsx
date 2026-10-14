import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { cn } from "~/lib/cn";
import { clampPage, zoomLabel, zoomStep } from "~/lib/pages";
import { viewQuery } from "~/lib/queries";
import { Button } from "./ui/button";

/**
 * A document or picture as the server drew it (#29): one page at a time, with thumbnails
 * beside it when there are several. The file itself never reaches the browser; each page
 * comes through a link bound to this session, and asking for a page is logged.
 */
export function DocumentViewer({ fileId, name }: { fileId: string; name: string }) {
  const client = useQueryClient();
  const { data, error } = useQuery(viewQuery(fileId));
  const [page, setPage] = useState(1);
  /** A multiple of the width that fits: 1 is the whole page across the viewer. */
  const [zoom, setZoom] = useState(1);
  const surface = useRef<HTMLElement>(null);
  const rail = useRef<HTMLOListElement>(null);
  const count = data?.pages.length ?? 0;
  const current = data?.pages.find((p) => p.page === page);
  const go = (to: number) => setPage(clampPage(to, count));

  // The thumbnail of the page shown stays in view.
  useEffect(() => {
    rail.current
      ?.querySelector(`[data-page="${page}"]`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [page]);
  // A new page starts at its top.
  useEffect(() => {
    if (page) surface.current?.scrollTo({ top: 0 });
  }, [page]);

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
    else return;
    event.preventDefault();
  };

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
        <span className="ml-auto flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            aria-label="Zoom out"
            disabled={zoom <= 1}
            onClick={() => setZoom((z) => zoomStep(z, -1))}
          >
            −
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
            +
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
            {data.pages.map((p) => (
              <li key={p.page} data-page={p.page}>
                <button
                  type="button"
                  aria-label={`Page ${p.page}`}
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
                      "tabular text-[11px]",
                      p.page === page ? "text-ink" : "text-ink-3",
                    )}
                  >
                    {p.page}
                  </span>
                </button>
              </li>
            ))}
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
            <img
              key={current.url}
              src={current.url}
              alt={`Page ${current.page} of ${name}`}
              draggable={false}
              width={current.width}
              height={current.height}
              onError={refresh}
              onContextMenu={(event) => event.preventDefault()}
              style={{ width: `${zoom * 100}%` }}
              className="mx-auto block h-auto max-w-none select-none"
            />
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
