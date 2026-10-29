import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Icon } from "~/components/icons";
import { Label } from "~/components/label";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { sessions, type Take, takeById, takes, takesCovering } from "~/data";
import { cn } from "~/lib/cn";
import { formatDuration } from "~/lib/format";

export function Rating({ value }: { value: number }) {
  return (
    <span role="img" className="inline-flex gap-[3px]" aria-label={`Rated ${value} of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span
          key={n}
          className={cn(
            "size-[6px] rounded-full",
            n <= value ? "bg-ink" : "border border-edge-strong",
          )}
        />
      ))}
    </span>
  );
}

function TakeRow({
  take,
  used,
  onAudition,
  auditioning,
  selectable,
  selected,
  onSelect,
}: {
  take: Take;
  used: boolean;
  onAudition: () => void;
  auditioning: boolean;
  selectable: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li
      className={cn(
        "flex items-center gap-3 border-b border-line px-3 py-2 last:border-b-0",
        auditioning && "bg-signal/10",
      )}
    >
      {selectable && (
        <input
          type="checkbox"
          checked={selected}
          onChange={onSelect}
          aria-label={`Share take ${take.number}`}
        />
      )}
      <button
        type="button"
        aria-label={`Audition take ${take.number}`}
        onClick={onAudition}
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-full",
          auditioning ? "bg-signal text-ground" : "bg-raised text-ink hover:bg-edge",
        )}
      >
        <Icon name={auditioning ? "pause" : "play"} size={11} fill="currentColor" strokeWidth={0} />
      </button>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-[14px] text-ink">
          <span className="tabular">T{take.number}</span>
          {take.starred && (
            <Icon name="star" size={12} className="text-signal" fill="var(--hk-signal)" />
          )}
          <Rating value={take.rating} />
          {used && <Label className="text-ink-2">in this version</Label>}
          {take.lifecycle === "aborted" && <Label>aborted</Label>}
        </span>
        <span className="block truncate text-[13px] text-ink-3">
          {take.coverage
            ? `p. ${take.coverage.page}, bars ${take.coverage.barFrom}–${take.coverage.barTo}`
            : "no coverage"}
          {take.notes && ` · ${take.notes}`}
        </span>
      </span>
      <span className="tabular text-[13px] text-ink-3">{formatDuration(take.duration)}</span>
    </li>
  );
}

/**
 * "Any other options for bar 72?" Every take covering the bar, rated and annotated, with
 * the one the version uses, each auditioned at the bar, looped and level-matched; and
 * the choice of which to share with the thread.
 */
export function OtherTakes({
  trackId,
  bar,
  versionNumber,
  canShare,
  onClose,
}: {
  trackId: string;
  bar: number;
  versionNumber: number;
  canShare: boolean;
  onClose: () => void;
}) {
  const list = takesCovering(trackId, bar).sort(
    (a, b) => b.rating - a.rating || a.number - b.number,
  );
  const [auditioning, setAuditioning] = useState<string | null>(null);
  const [mode, setMode] = useState<"specific" | "all" | "except">("specific");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  return (
    <div className="mt-2 rounded-panel border border-line bg-ground">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Icon name="take" size={14} className="text-ink-3" />
        <span className="text-[14px] font-medium text-ink">Other takes for bar {bar}</span>
        <span className="text-[13px] text-ink-3">{list.length} cover it</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="ml-auto text-ink-3 hover:text-ink"
        >
          <Icon name="close" size={14} />
        </button>
      </div>
      {list.length === 0 ? (
        <p className="px-3 py-3 text-[13px] text-ink-3">
          No take covers bar {bar}. Coverage is set in the take manager, or proposed from the audio.
        </p>
      ) : (
        <ul className="list-none p-0">
          {list.map((t) => (
            <TakeRow
              key={t.id}
              take={t}
              used={Boolean(
                t.usedIn?.some(
                  (u) => u.versionNumber === versionNumber && u.barFrom <= bar && u.barTo >= bar,
                ),
              )}
              onAudition={() => setAuditioning(auditioning === t.id ? null : t.id)}
              auditioning={auditioning === t.id}
              selectable={canShare && mode !== "all"}
              selected={selected.has(t.id)}
              onSelect={() => toggle(t.id)}
            />
          ))}
        </ul>
      )}
      {auditioning && (
        <p className="border-t border-line px-3 py-1.5 text-[12px] text-ink-3">
          Auditioning at bar {bar}, looped and level-matched against the version. Press 1 and 2 to
          flip between them.
        </p>
      )}
      {canShare && list.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2">
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as typeof mode)}
            aria-label="Which takes to share with this thread"
            className="h-7 min-w-0 flex-1 rounded-control border border-edge bg-ground px-2 text-[13px] text-ink"
          >
            <option value="specific">The ticked takes</option>
            <option value="all">Every take covering the bar</option>
            <option value="except">All but the ticked</option>
          </select>
          <Button
            variant="primary"
            size="sm"
            className="ml-auto"
            disabled={mode !== "all" && selected.size === 0}
          >
            Share{" "}
            {mode === "all"
              ? list.length
              : mode === "except"
                ? list.length - selected.size
                : selected.size}
          </Button>
        </div>
      )}
    </div>
  );
}

/** Takes attached to a thread: one line in the comment, and a modal to hear and compare them. */
export function SharedTakes({ ids, bar }: { ids: string[]; bar?: number }) {
  const [open, setOpen] = useState(false);
  const list = ids.map(takeById).filter((t): t is Take => Boolean(t));
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className="mt-1 flex h-7 items-center gap-2 self-start rounded-chip border border-line bg-raised/40 px-2.5 text-[12px] text-ink-2 transition-colors hover:border-edge hover:text-ink"
      >
        <Icon name="take" size={12} className="text-ink-3" />
        {list.length} {list.length === 1 ? "take" : "takes"} attached
        <span className="text-ink-3">· compare</span>
      </button>
      {open && <TakeCompareDialog takes={list} bar={bar} onClose={() => setOpen(false)} />}
    </>
  );
}

/** The attached takes beside the version: audition each, flip between them, loop the passage. */
export function TakeCompareDialog({
  takes: list,
  bar,
  onClose,
}: {
  takes: Take[];
  bar?: number;
  onClose: () => void;
}) {
  const [current, setCurrent] = useState<string>("version");
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(true);
  const options = [
    { id: "version", label: "The version" },
    ...list.map((t) => ({ id: t.id, label: `Take ${t.number}` })),
  ];
  return (
    <Dialog
      title={bar !== undefined ? `Takes for bar ${bar}` : "Attached takes"}
      description="Level-matched and aligned at the bar. Keys 1 to 9 flip between them while playing."
      onClose={onClose}
      width="md"
      footer={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            aria-label={playing ? "Pause" : "Play"}
            onClick={() => setPlaying((p) => !p)}
            className="flex size-9 items-center justify-center rounded-full bg-ink text-ground"
          >
            <Icon name={playing ? "pause" : "play"} size={12} fill="currentColor" strokeWidth={0} />
          </button>
          <div
            role="radiogroup"
            aria-label="Listening to"
            className="flex flex-wrap gap-1 rounded-control border border-line bg-ground/60 p-0.5"
          >
            {options.map((o, i) => (
              <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={current === o.id}
                onClick={() => setCurrent(o.id)}
                className={cn(
                  "flex h-7 items-center gap-1.5 rounded-[4px] px-2.5 text-[13px]",
                  current === o.id ? "bg-overlay text-ink shadow-2" : "text-ink-3 hover:text-ink",
                )}
              >
                <span className="tabular text-[11px] text-ink-3">{i + 1}</span>
                {o.label}
              </button>
            ))}
          </div>
          <label className="ml-auto flex items-center gap-2 text-[13px] text-ink-2">
            <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />
            Loop the passage
          </label>
        </div>
        <ul className="flex flex-col divide-y divide-line rounded-panel border border-line">
          {list.map((t) => (
            <li
              key={t.id}
              className={cn(
                "flex items-center gap-3 px-3 py-2",
                current === t.id && "bg-signal/10",
              )}
            >
              <span className="tabular w-12 text-[14px] font-medium text-ink">T{t.number}</span>
              <Rating value={t.rating} />
              <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">
                {t.notes || "No notes"}
              </span>
              <span className="text-[12px] text-ink-3">
                bars {t.coverage?.barFrom}–{t.coverage?.barTo}
              </span>
              <span className="tabular text-[13px] text-ink-3">{formatDuration(t.duration)}</span>
            </li>
          ))}
        </ul>
        <p className="text-[12px] text-ink-3">
          Everything a take is here is in the{" "}
          <Link
            to="/tracks/$trackId"
            params={{ trackId: list[0]?.trackId ?? "" }}
            search={{ view: "takes" }}
            className="text-ink-2 hover:text-ink"
          >
            take manager
          </Link>
          , for those with the tool.
        </p>
      </div>
    </Dialog>
  );
}

/**
 * The track's takes to put on a comment (#497): number, session, bars and rating, each with
 * a play preview; several can be ticked. Attached, they are heard at the comment's bar as
 * from Other takes.
 */
export function TakePickerDialog({
  trackId,
  chosen,
  onPick,
  onClose,
}: {
  trackId: string;
  chosen: string[];
  onPick: (ids: string[]) => void;
  onClose: () => void;
}) {
  const list = takes.filter((t) => t.trackId === trackId);
  const [ticked, setTicked] = useState<Set<string>>(new Set(chosen));
  const [playing, setPlaying] = useState<string | null>(null);
  const toggle = (id: string) => {
    const next = new Set(ticked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setTicked(next);
  };
  return (
    <Dialog
      title="Takes from this track"
      description="They go on the comment for whoever reads it to hear, at its bar where it has one."
      onClose={onClose}
      width="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={ticked.size === 0}
            onClick={() => {
              onPick([...ticked]);
              onClose();
            }}
          >
            Attach {ticked.size || ""}
          </Button>
        </>
      }
    >
      {list.length === 0 ? (
        <p className="text-[13px] text-ink-3">This track has no takes yet.</p>
      ) : (
        <ul className="flex list-none flex-col divide-y divide-line rounded-panel border border-line p-0">
          {list.map((t) => {
            const session = sessions.find((s) => s.id === t.sessionId);
            return (
              <li
                key={t.id}
                className={cn(
                  "flex items-center gap-3 px-3 py-2",
                  playing === t.id && "bg-signal/10",
                )}
              >
                <input
                  type="checkbox"
                  checked={ticked.has(t.id)}
                  onChange={() => toggle(t.id)}
                  aria-label={`Attach take ${t.number}`}
                />
                <button
                  type="button"
                  aria-label={playing === t.id ? `Stop take ${t.number}` : `Play take ${t.number}`}
                  aria-pressed={playing === t.id}
                  onClick={() => setPlaying(playing === t.id ? null : t.id)}
                  className={cn(
                    "flex size-7 shrink-0 items-center justify-center rounded-full",
                    playing === t.id ? "bg-signal text-ground" : "bg-raised text-ink hover:bg-edge",
                  )}
                >
                  <Icon
                    name={playing === t.id ? "pause" : "play"}
                    size={11}
                    fill="currentColor"
                    strokeWidth={0}
                  />
                </button>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-[14px] text-ink">
                    <span className="tabular font-medium">T{t.number}</span>
                    {t.starred && (
                      <Icon name="star" size={12} className="text-signal" fill="var(--hk-signal)" />
                    )}
                    <Rating value={t.rating} />
                  </span>
                  <span className="block truncate text-[13px] text-ink-3">
                    {[
                      session?.name,
                      t.coverage ? `bars ${t.coverage.barFrom}–${t.coverage.barTo}` : null,
                      t.notes || null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <span className="tabular text-[13px] text-ink-3">{formatDuration(t.duration)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
