import { useState } from "react";
import { Icon } from "~/components/icons";
import { Dot, type DotState } from "~/components/status";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { MenuList, usePopover } from "~/components/ui/menu";
import type { Stage, Workflow } from "~/data/types";
import { cn } from "~/lib/cn";

const dotOf = (category: "todo" | "in_progress" | "done" | undefined): DotState =>
  category === "done" ? "approved" : category === "todo" ? "invited" : "in_review";

/**
 * Where a track stands, as a chip: its status with the board's dot. For whoever may edit the
 * workflow it opens the moves the workflow allows from here, each confirmed before the step
 * ends; the track's history records who moved it and when (#498).
 */
export function StatusChip({
  status,
  workflow,
  stage,
  canMove,
  onMove,
}: {
  status: string;
  workflow: Workflow | undefined;
  /** The stage the track waits at, where its workflow has one. */
  stage: Stage | undefined;
  canMove: boolean;
  onMove: (to: Stage) => void;
}) {
  const [open, setOpen, box] = usePopover();
  const [moving, setMoving] = useState<Stage | null>(null);
  const category = workflow?.statuses.find((s) => s.name === status)?.category;
  const next = workflow && stage ? workflow.stages.filter((s) => s.after.includes(stage.id)) : [];
  const chip =
    "flex h-7 items-center gap-2 rounded-full border border-line px-2.5 text-[12px] text-ink-2";
  if (!canMove || next.length === 0)
    return (
      <span className={chip} title="Status">
        <Dot state={dotOf(category)} className="size-[7px]" />
        {status}
      </span>
    );
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-label={`Status: ${status}. Move on`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn(
          chip,
          "cursor-pointer transition-colors hover:border-edge hover:text-ink",
          open && "border-edge bg-raised text-ink",
        )}
      >
        <Dot state={dotOf(category)} className="size-[7px]" />
        {status}
        <Icon name="chevronDown" size={12} className="text-ink-3" />
      </button>
      {open && (
        <MenuList
          anchor={box}
          onClose={() => setOpen(false)}
          actions={next.map((s) => ({
            label: `Move to ${s.status}`,
            hint: s.name,
            onSelect: () => setMoving(s),
          }))}
        />
      )}
      {moving && (
        <Dialog
          title={`Move to ${moving.status}`}
          description={`${stage?.name ?? "This step"} ends and ${moving.name} begins. Everyone following the track is told.`}
          width="sm"
          onClose={() => setMoving(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setMoving(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  onMove(moving);
                  setMoving(null);
                }}
              >
                Move to {moving.status}
              </Button>
            </>
          }
        >
          <p className="text-[13px] text-ink-2">
            Recorded in the track's history as your move, with the time.
          </p>
        </Dialog>
      )}
    </div>
  );
}
