import { useRef } from "react";
import { cn } from "~/lib/cn";
import { COMMENTS_WIDTH, commentsWidth, type PanelLayout } from "~/lib/panel-layout";
import { Icon } from "./icons";
import { Button } from "./ui/button";
import { MenuList, usePopover } from "./ui/menu";

/** Where the comments sit, from their header (#15); a wide screen's choice, as the prototype's. */
export function PanelPlacement({
  layout,
  onChange,
}: {
  layout: PanelLayout;
  onChange: (patch: Partial<PanelLayout>) => void;
}) {
  const [open, setOpen, box] = usePopover();
  return (
    <div ref={box} className="relative hidden lg:block">
      <Button
        variant="ghost"
        size="iconSm"
        aria-label="Panel position"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name={layout.comments === "below" ? "layoutBottom" : "layoutRight"} size={14} />
      </Button>
      {open && (
        <MenuList
          anchor={box}
          onClose={() => setOpen(false)}
          actions={[
            {
              label: "Comments on the right",
              checked: layout.comments === "right",
              onSelect: () => onChange({ comments: "right" }),
            },
            {
              label: "Comments below",
              checked: layout.comments === "below",
              onSelect: () => onChange({ comments: "below" }),
            },
          ]}
        />
      )}
    </div>
  );
}

/** Steps the keyboard moves the column by. */
const STEP = 16;

/**
 * The handle between the player and the comments beside it: drag it, or focus it and use
 * the arrow keys, to widen or narrow the comments.
 */
export function CommentsSplitter({
  width,
  onWidth,
  className,
}: {
  width: number;
  onWidth: (width: number) => void;
  className?: string;
}) {
  const last = useRef(0);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a separator that moves is focusable, which <hr> is not.
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Comments width"
      aria-valuemin={COMMENTS_WIDTH.min}
      aria-valuemax={COMMENTS_WIDTH.max}
      aria-valuenow={width}
      tabIndex={0}
      data-e2e-overlap
      className={cn(
        "group/split w-1.5 cursor-col-resize touch-none rounded-full outline-none",
        className,
      )}
      onPointerDown={(e) => {
        last.current = e.clientX;
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!(e.buttons & 1)) return;
        // Dragging left widens the comments, which sit to the right of the handle.
        onWidth(commentsWidth(width - (e.clientX - last.current)));
        last.current = e.clientX;
      }}
      onKeyDown={(e) => {
        const by = e.key === "ArrowLeft" ? STEP : e.key === "ArrowRight" ? -STEP : 0;
        if (e.key === "Home") onWidth(COMMENTS_WIDTH.max);
        else if (e.key === "End") onWidth(COMMENTS_WIDTH.min);
        else if (by) onWidth(commentsWidth(width + by));
        else return;
        e.preventDefault();
      }}
    >
      <span
        aria-hidden="true"
        className="sticky top-1/2 mx-auto mt-24 block h-10 w-0.5 rounded-full bg-line-strong opacity-0 transition-opacity group-hover/split:opacity-100 group-focus-visible/split:opacity-100 group-active/split:bg-signal group-active/split:opacity-100"
      />
    </div>
  );
}
