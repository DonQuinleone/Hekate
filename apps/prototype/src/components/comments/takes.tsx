import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Icon } from "~/components/icons";
import { Label } from "~/components/label";
import { Button } from "~/components/ui/button";
import { type Take, takeById, takesCovering } from "~/data";
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
          <span className="text-[13px] text-ink-3">Share with this thread:</span>
          {(
            [
              ["specific", "the ticked takes"],
              ["all", "every take covering the bar"],
              ["except", "all but the ticked"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                "h-6 rounded-chip border px-2 text-[13px]",
                mode === m
                  ? "border-edge bg-raised text-ink"
                  : "border-transparent text-ink-3 hover:text-ink",
              )}
            >
              {label}
            </button>
          ))}
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

/** The takes a producer shared with a thread: the only takes a reviewer without the tool hears. */
export function SharedTakes({ ids }: { ids: string[] }) {
  const [auditioning, setAuditioning] = useState<string | null>(null);
  const list = ids.map(takeById).filter((t): t is Take => Boolean(t));
  return (
    <div className="mt-2 rounded-panel border border-line bg-ground">
      <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
        <Icon name="take" size={14} className="text-ink-3" />
        <span className="text-[13px] text-ink-2">
          {list.length} takes shared with you for this passage
        </span>
      </div>
      <ul className="list-none p-0">
        {list.map((t) => (
          <li
            key={t.id}
            className={cn(
              "flex items-center gap-3 border-b border-line px-3 py-2 last:border-b-0",
              auditioning === t.id && "bg-signal/10",
            )}
          >
            <button
              type="button"
              aria-label={`Play take ${t.number}`}
              onClick={() => setAuditioning(auditioning === t.id ? null : t.id)}
              className={cn(
                "flex size-7 items-center justify-center rounded-full",
                auditioning === t.id ? "bg-signal text-ground" : "bg-raised text-ink",
              )}
            >
              <Icon
                name={auditioning === t.id ? "pause" : "play"}
                size={11}
                fill="currentColor"
                strokeWidth={0}
              />
            </button>
            <span className="tabular text-[14px] text-ink">Take {t.number}</span>
            <span className="truncate text-[13px] text-ink-3">{t.notes}</span>
            <span className="tabular ml-auto text-[13px] text-ink-3">
              {formatDuration(t.duration)}
            </span>
          </li>
        ))}
      </ul>
      <p className="px-3 py-1.5 text-[12px] text-ink-3">
        Those with the take manager see every take:{" "}
        <Link
          to="/sessions/$sessionId"
          params={{ sessionId: "sess-2" }}
          className="text-ink-2 hover:text-ink"
        >
          open the session
        </Link>
        .
      </p>
    </div>
  );
}
