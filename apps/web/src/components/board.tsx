import {
  type BoardCard,
  type BoardColumn,
  type BoardDisplay,
  boardColumnOf,
  defaultBoardDisplay,
  NO_STATUS,
  NOT_AT_A_STAGE,
} from "@hekate/shared";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AvatarRow } from "~/components/avatar";
import { Empty } from "~/components/empty";
import { Icon } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { ToggleChip } from "~/components/ui/chip";
import { usePopover } from "~/components/ui/menu";
import { Segmented } from "~/components/ui/segmented";
import { ReviewerDot, type ReviewerDotState } from "~/components/ui/status";
import { Switch } from "~/components/ui/toggle";
import { cn } from "~/lib/cn";
import { formatDates } from "~/lib/locale";
import { projectBoardQuery, usePreferences, useSavePreferences } from "~/lib/queries";

const dayFormat = formatDates({ day: "numeric", month: "short" });

const columnDot: Record<BoardColumn["category"], ReviewerDotState> = {
  todo: "invited",
  in_progress: "in_review",
  done: "approved",
};

const decisionDot = {
  approved: "approved",
  changes_requested: "changes_requested",
  feedback: "submitted",
} as const;
const decisionWords = {
  approved: "approved",
  changes_requested: "requested changes",
  feedback: "gave feedback",
} as const;

/** The board's display options, as Linear keeps them: grouping, what cards carry, which fields. */
function Customise({
  display,
  onChange,
}: {
  display: BoardDisplay;
  onChange: (d: BoardDisplay) => void;
}) {
  const [open, setOpen, box] = usePopover();
  const row = (label: string, checked: boolean, set: (v: boolean) => void) => (
    <span className="flex h-8 items-center justify-between gap-6 text-[13px] text-ink">
      {label}
      <Switch label={label} checked={checked} onChange={set} />
    </span>
  );
  return (
    <div ref={box} className="relative">
      <Button variant="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="sliders" size={14} />
        Customise
      </Button>
      {open && (
        <div
          role="dialog"
          aria-label="Customise the board"
          data-e2e-overlap
          className="rise-in absolute right-0 z-30 mt-1 w-72 rounded-panel-lg bg-overlay p-3 shadow-4"
        >
          <div className="flex flex-col gap-1.5">
            <span className="eyebrow">Group by</span>
            <Segmented
              label="Group by"
              value={display.groupBy}
              options={[
                { value: "status", label: "Status" },
                { value: "stage", label: "Stage" },
              ]}
              onChange={(groupBy) => onChange({ ...display, groupBy })}
            />
          </div>
          <div className="mt-3 flex flex-col">
            <span className="eyebrow mb-1">On the cards</span>
            {row("Tasks", display.tasks, (tasks) => onChange({ ...display, tasks }))}
            {row("Open comments", display.comments, (comments) =>
              onChange({ ...display, comments }),
            )}
            {row("Decisions and feedback", display.decisions, (decisions) =>
              onChange({ ...display, decisions }),
            )}
          </div>
          <div className="mt-3 flex flex-col gap-1.5">
            <span className="eyebrow">Fields</span>
            <div className="flex flex-wrap gap-1">
              {(
                [
                  ["version", "Version"],
                  ["stage", "Stage"],
                  ["reviewers", "Reviewers"],
                  ["due", "Due"],
                ] as const
              ).map(([id, label]) => (
                <ToggleChip
                  key={id}
                  pressed={display.fields[id]}
                  onClick={() =>
                    onChange({
                      ...display,
                      fields: { ...display.fields, [id]: !display.fields[id] },
                    })
                  }
                >
                  {label}
                </ToggleChip>
              ))}
            </div>
          </div>
          <div className="mt-3 flex items-center border-t border-line pt-3 text-[12px]">
            <button
              type="button"
              onClick={() => onChange(defaultBoardDisplay)}
              className="text-ink-3 hover:text-ink"
            >
              Reset
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Card({ card, display }: { card: BoardCard; display: BoardDisplay }) {
  const late = card.dueAt !== null && new Date(card.dueAt).getTime() < Date.now();
  const shows =
    (display.decisions && card.decisions.length > 0) ||
    (display.tasks && card.tasks.length > 0) ||
    (display.comments && card.openComments > 0);
  return (
    <Link
      {...(card.version?.fileId
        ? { to: "/files/$fileId", params: { fileId: card.version.fileId } }
        : { to: "/tracks/$trackId", params: { trackId: card.id } })}
      className="flex flex-col gap-2 rounded-panel border border-line bg-raised/40 p-3 shadow-1 transition-colors hover:border-edge focus-visible:border-edge"
    >
      <span className="flex items-start gap-2">
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">
          {card.name}
        </span>
        {display.fields.version && card.version && (
          <span className="tabular shrink-0 text-[12px] text-ink-3">V{card.version.number}</span>
        )}
      </span>
      {display.fields.stage && card.stage && (
        <span className="truncate text-[12px] text-ink-2">{card.stage}</span>
      )}
      {((display.fields.reviewers && card.waitingOn.length > 0) ||
        (display.fields.due && card.dueAt)) && (
        <span className="flex items-center gap-2 text-[12px] text-ink-3">
          {display.fields.reviewers && card.waitingOn.length > 0 && (
            <>
              <AvatarRow people={card.waitingOn} size={18} />
              <span>waiting</span>
            </>
          )}
          {display.fields.due && card.dueAt && (
            <span className={cn("tabular ml-auto", late && "text-signal")}>
              {dayFormat.format(new Date(card.dueAt))}
            </span>
          )}
        </span>
      )}
      {shows && (
        <span className="mt-0.5 flex flex-col gap-1 border-t border-line pt-2">
          {display.decisions &&
            card.decisions.map((d) => (
              <span
                key={`${d.name}-${d.decision}`}
                className="flex items-center gap-1.5 text-[12px] text-ink-2"
              >
                <ReviewerDot state={decisionDot[d.decision]} />
                <span className="truncate">
                  {d.name} {decisionWords[d.decision]}
                </span>
              </span>
            ))}
          {display.tasks &&
            card.tasks.map((t) => (
              <span key={t.id} className="flex items-center gap-1.5 text-[12px] text-ink-2">
                <Icon name="task" size={12} className="shrink-0 text-ink-3" />
                <span className="truncate">{t.title}</span>
              </span>
            ))}
          {display.comments && card.openComments > 0 && (
            <span className="flex items-center gap-1.5 text-[12px] text-ink-3">
              <Icon name="comment" size={12} />
              {card.openComments} open
            </span>
          )}
        </span>
      )}
    </Link>
  );
}

/**
 * A project's board (#141), as the prototype has it: its tracks in columns by the status their
 * workflow gave them, or by the stage each waits at; each card with its version, stage, whom it
 * waits on and by when, what reviewers said, its open tasks and threads. How it is arranged is
 * each person's own, kept with their account.
 */
export function ProjectBoard({ projectId }: { projectId: string }) {
  const { data, error } = useQuery(projectBoardQuery(projectId));
  const display = usePreferences().board;
  const save = useSavePreferences();
  const set = (board: BoardDisplay) => save.mutate({ board });
  if (error) return <p className="m-0 text-signal">{error.message}</p>;
  if (!data) return <p className="m-0 text-ink-3">Loading</p>;
  const columns = data.columns[display.groupBy];
  const cardsIn = (id: string) =>
    data.cards.filter((card) => boardColumnOf(card, display.groupBy) === id);

  const hidden = new Set(display.hidden);
  // The column of tracks not yet in the workflow shows only while one is.
  const shown = columns.filter(
    (c) =>
      !hidden.has(c.id) &&
      !((c.id === NO_STATUS || c.id === NOT_AT_A_STAGE) && cardsIn(c.id).length === 0),
  );
  const putAway = columns.filter((c) => hidden.has(c.id));
  if (data.cards.length === 0)
    return (
      <Empty
        title="No tracks yet"
        text="The board shows each track by where its workflow has it. Add a track and upload a version to start."
      />
    );
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 truncate text-[13px] text-ink-3">
          {data.workflows.length > 0
            ? data.workflows.join(", ")
            : "No workflow is switched on; tracks show the last status they were given."}
        </span>
        <span className="ml-auto">
          <Customise display={display} onChange={set} />
        </span>
      </div>
      <div className="scroll-quiet -mx-5 overflow-x-auto px-5 @3xl/app:-mx-10 @3xl/app:px-10">
        <div className="flex min-w-max items-start gap-3 pb-2">
          {shown.map((column) => {
            const cards = cardsIn(column.id);
            return (
              <section
                key={column.id}
                aria-label={column.name}
                className="flex w-[272px] shrink-0 flex-col gap-2"
              >
                <div className="group flex h-8 items-center gap-2 px-1">
                  <ReviewerDot state={columnDot[column.category]} />
                  <h3 className="m-0 truncate text-[14px] font-medium text-ink">{column.name}</h3>
                  <span className="tabular text-[13px] text-ink-3">{cards.length}</span>
                  <button
                    type="button"
                    aria-label={`Hide ${column.name}`}
                    onClick={() => set({ ...display, hidden: [...display.hidden, column.id] })}
                    className="ml-auto flex size-7 items-center justify-center rounded-control text-ink-3 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-raised hover:text-ink focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                  >
                    <Icon name="eyeOff" size={13} />
                  </button>
                </div>
                <div className="flex min-h-28 flex-col gap-2 rounded-panel-lg bg-sunken/80 p-2">
                  {cards.map((card) => (
                    <Card key={card.id} card={card} display={display} />
                  ))}
                  {cards.length === 0 && (
                    <span className="px-2 py-4 text-center text-[12px] text-ink-3">
                      Nothing here
                    </span>
                  )}
                </div>
              </section>
            );
          })}
          {putAway.length > 0 && (
            <section
              aria-label="Hidden columns"
              className="flex w-[200px] shrink-0 flex-col gap-1 rounded-panel-lg border border-dashed border-line p-3"
            >
              <span className="eyebrow">Hidden columns</span>
              {putAway.map((column) => (
                <button
                  key={column.id}
                  type="button"
                  onClick={() =>
                    set({ ...display, hidden: display.hidden.filter((h) => h !== column.id) })
                  }
                  className="flex h-8 items-center gap-2 rounded-control px-2 text-left text-[13px] text-ink-2 hover:bg-raised hover:text-ink"
                >
                  <Icon name="eye" size={12} />
                  <span className="truncate">{column.name}</span>
                  <span className="tabular ml-auto text-ink-3">{cardsIn(column.id).length}</span>
                </button>
              ))}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
