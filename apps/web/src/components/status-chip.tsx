import type { ColumnCategory } from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Icon } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { type MenuAction, MenuList, usePopover } from "~/components/ui/menu";
import { ReviewerDot, type ReviewerDotState } from "~/components/ui/status";
import { cn } from "~/lib/cn";
import {
  trackStandingQuery,
  trackWorkflowRunsQuery,
  useEndWorkflowStep,
  useProjectCan,
} from "~/lib/queries";
import { movesOf, type StatusMove } from "~/lib/status-moves";

const categoryDot: Record<ColumnCategory, ReviewerDotState> = {
  todo: "invited",
  in_progress: "in_review",
  done: "approved",
};

const chip =
  "inline-flex h-7 max-w-[14rem] items-center gap-2 rounded-full border border-line px-2.5 text-[12px] text-ink-2";

/**
 * Where a track stands, as the board's dot and the status its workflow gave it (#498). Given
 * moves, it opens them as a menu; each is confirmed before the step ends, and the track's
 * history records who ended it and when.
 */
export function StatusChipView({
  status,
  category,
  moves = [],
  onMove,
  pending = false,
}: {
  status: string;
  category: ColumnCategory | null;
  moves?: StatusMove[];
  onMove?: (move: StatusMove) => void;
  pending?: boolean;
}) {
  const [open, setOpen, box] = usePopover();
  const [moving, setMoving] = useState<StatusMove | null>(null);
  const dot = <ReviewerDot state={categoryDot[category ?? "in_progress"]} />;
  if (moves.length === 0 || !onMove)
    return (
      <span className={chip} title="Status">
        {dot}
        <span className="truncate">{status}</span>
      </span>
    );
  // One step waiting: each outcome stands alone. Several: the step names each.
  const steps = new Set(moves.map((m) => m.step));
  const actions: MenuAction[] = moves.map((m) => ({
    label: steps.size > 1 ? `${m.step}: ${m.label}` : m.label,
    onSelect: () => setMoving(m),
  }));
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-label={`Status: ${status}. Move on`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={pending}
        onClick={() => setOpen(!open)}
        className={cn(
          chip,
          "cursor-pointer transition-colors hover:border-edge hover:text-ink disabled:cursor-default disabled:opacity-60",
          open && "border-edge bg-raised text-ink",
        )}
      >
        {dot}
        <span className="truncate">{status}</span>
        <Icon name="chevronDown" size={12} className="shrink-0 text-ink-3" />
      </button>
      {open && (
        <MenuList
          anchor={box}
          align="left"
          label="Move on"
          actions={actions}
          onClose={() => setOpen(false)}
        />
      )}
      {moving && (
        <Dialog
          title={`${moving.step}: ${moving.label.toLowerCase()}`}
          description="The step ends and the workflow moves on from here. Everyone following the track is told."
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
                {moving.label}
              </Button>
            </>
          }
        >
          <p className="m-0 text-[13px] text-ink-2">
            Recorded in the {"track's"} history as your move, with the time.
          </p>
        </Dialog>
      )}
    </div>
  );
}

/**
 * A track's status chip in the player's header (#498): its standing, and for whoever may
 * edit the project's workflows, the moves its running workflow allows from here, ended
 * through the same route the track's history records.
 */
export function TrackStatusChip({ trackId, projectId }: { trackId: string; projectId: string }) {
  const can = useProjectCan(projectId);
  const mayMove = can("edit_workflows") && can("view_workflows");
  const { data: standing } = useQuery(trackStandingQuery(trackId));
  const { data: runs } = useQuery({ ...trackWorkflowRunsQuery(trackId), enabled: mayMove });
  const end = useEndWorkflowStep(trackId, projectId);
  const status = standing?.status ?? standing?.stage;
  if (!standing || !status) return null;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <StatusChipView
        status={status}
        category={standing.category}
        moves={mayMove && runs ? movesOf(runs) : []}
        pending={end.isPending}
        onMove={(move) => end.mutate(move)}
      />
      {end.error && <span className="text-[12px] text-signal">{end.error.message}</span>}
    </span>
  );
}
