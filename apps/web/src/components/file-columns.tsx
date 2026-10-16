import {
  defaultFileColumns,
  type FileColumn,
  type FileColumnLayout,
  fileColumns,
} from "@hekate/shared";
import { type PointerEvent, useRef } from "react";
import { moveColumn, resizeColumn, toggleColumn } from "~/lib/browser";
import { Icon } from "./icons";
import { usePopover } from "./ui/menu";
import { Switch } from "./ui/toggle";

/** How each column is headed, and named in the Columns menu. */
export const columnNames: Record<FileColumn, string> = {
  status: "Status",
  versions: "Versions",
  people: "People",
  updated: "Updated",
  size: "Size",
  format: "Format",
  duration: "Duration",
  tags: "Tags",
};

/**
 * The Columns control at the end of the list's header: which columns show, in what order,
 * kept for this member. Widths change by dragging a header's edge.
 */
export function ColumnsMenu({
  columns,
  names,
  onChange,
  shown: fitted,
}: {
  columns: FileColumnLayout;
  names: Record<FileColumn, string>;
  onChange: (columns: FileColumnLayout) => void;
  /** The columns that fit the list now; the others chosen are left off for lack of room. */
  shown?: FileColumn[];
}) {
  const [open, setOpen, box] = usePopover();
  const shown = columns.map((c) => c.id);
  const listed = [...shown, ...fileColumns.filter((id) => !shown.includes(id))];
  return (
    <div ref={box} className="relative flex justify-end">
      <button
        type="button"
        aria-label="Choose columns"
        title="Choose columns"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(!open)}
        className="flex size-7 items-center justify-center rounded-control text-ink-3 normal-case tracking-normal hover:bg-raised hover:text-ink"
      >
        <Icon name="sliders" size={14} />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Columns"
          data-e2e-overlap
          className="rise-in absolute top-full right-0 z-30 mt-1 w-60 rounded-panel-lg bg-overlay p-2 text-[13px] font-normal normal-case tracking-normal shadow-4"
        >
          <p className="eyebrow m-0 px-2 text-ink-2">Columns, in order</p>
          <ul className="m-0 mt-1 flex list-none flex-col p-0">
            {listed.map((id) => {
              const on = shown.includes(id);
              return (
                <li key={id} className="flex h-8 items-center gap-1 rounded-control px-2 text-ink">
                  <Switch
                    label={names[id]}
                    checked={on}
                    onChange={() => onChange(toggleColumn(columns, id))}
                  />
                  <span className="ml-1.5 min-w-0 flex-1 truncate">{names[id]}</span>
                  {on && fitted && !fitted.includes(id) && (
                    <span className="shrink-0 text-[11px] text-ink-3">No room</span>
                  )}
                  {on && (
                    <>
                      <button
                        type="button"
                        aria-label={`Move ${names[id]} earlier`}
                        onClick={() => onChange(moveColumn(columns, id, -1))}
                        className="flex size-6 items-center justify-center rounded-control text-ink-2 hover:bg-raised hover:text-ink"
                      >
                        <Icon name="chevronUp" size={12} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Move ${names[id]} later`}
                        onClick={() => onChange(moveColumn(columns, id, 1))}
                        className="flex size-6 items-center justify-center rounded-control text-ink-2 hover:bg-raised hover:text-ink"
                      >
                        <Icon name="chevronDown" size={12} />
                      </button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="mt-2 border-t border-line px-2 pt-2">
            <button
              type="button"
              onClick={() => onChange(defaultFileColumns)}
              className="text-[12px] text-ink-2 hover:text-ink"
            >
              Reset
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * A column's heading, with an edge to drag for its width. While dragging only the page
 * changes; the new width is kept when the pointer lets go.
 */
export function ColumnHeading({
  id,
  name,
  columns,
  onResize,
  onResized,
}: {
  id: FileColumn;
  name: string;
  columns: FileColumnLayout;
  /** Each step of a drag. */
  onResize: (columns: FileColumnLayout) => void;
  /** The drag finished. */
  onResized: (columns: FileColumnLayout) => void;
}) {
  const drag = useRef<{ x: number; width: number; last: FileColumnLayout } | null>(null);
  const width = columns.find((c) => c.id === id)?.width ?? 100;
  const move = (event: PointerEvent<HTMLSpanElement>) => {
    if (!drag.current) return;
    const next = resizeColumn(columns, id, drag.current.width + event.clientX - drag.current.x);
    drag.current.last = next;
    onResize(next);
  };
  const end = () => {
    if (drag.current) onResized(drag.current.last);
    drag.current = null;
  };
  return (
    <span className="relative flex h-full min-w-0 items-center">
      <span className="truncate">{name}</span>
      {/* Pointer only: the Columns menu is the way to arrange the list from the keyboard. */}
      <span
        aria-hidden="true"
        data-e2e-overlap
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { x: event.clientX, width, last: columns };
        }}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        className="absolute top-1.5 -right-2 bottom-1.5 w-2 cursor-col-resize after:absolute after:inset-y-0 after:left-[3px] after:w-px after:bg-transparent hover:after:bg-edge"
      />
    </span>
  );
}
