import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Rating } from "~/components/comments/takes";
import { Icon } from "~/components/icons";
import { Button } from "~/components/ui/button";
import { ActionMenu } from "~/components/ui/menu";
import { sessions, type Take, type Track, takes } from "~/data";
import { cn } from "~/lib/cn";
import { formatDuration } from "~/lib/format";

const BARS = 100;

/**
 * The take manager for a track, under the player: every take that covers it, by bar, with its
 * rating and whether the edit uses it. Click a take to audition it level-matched against the
 * version; drag over bars to set its coverage (here, a click sets the hovered bar).
 */
export function TakeManager({
  track,
  versionNumber,
  canEdit,
  onClose,
}: {
  track: Track;
  versionNumber: number;
  canEdit: boolean;
  onClose: () => void;
}) {
  const list = takes
    .filter((t) => t.trackId === track.id && t.coverage)
    .sort((a, b) => (a.coverage?.barFrom ?? 0) - (b.coverage?.barFrom ?? 0) || a.number - b.number);
  const [filter, setFilter] = useState<"all" | "starred" | "used">("all");
  const [auditioning, setAuditioning] = useState<string | null>(null);
  const shown = list.filter((t) =>
    filter === "starred"
      ? t.starred || t.rating >= 4
      : filter === "used"
        ? t.usedIn?.some((u) => u.versionNumber === versionNumber)
        : true,
  );
  const covered = new Array(BARS).fill(false);
  for (const t of list)
    for (let b = (t.coverage?.barFrom ?? 1) - 1; b < (t.coverage?.barTo ?? 0); b++)
      covered[b] = true;
  const gaps = covered.filter((c) => !c).length;
  const sessionOf = (t: Take) => sessions.find((s) => s.id === t.sessionId);
  return (
    <section aria-label="Takes" className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-4 text-[13px]">
        <Icon name="take" size={14} className="text-ink-3" />
        <span className="font-medium text-ink">Takes</span>
        <span className="text-ink-3">
          {list.length} cover this track
          {gaps > 0 ? ` · ${gaps} bars uncovered` : " · every bar covered"}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {(
            [
              ["all", "All"],
              ["starred", "Best"],
              ["used", `In V${versionNumber}`],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
              className={cn(
                "h-7 rounded-control px-2 text-[12px] transition-colors",
                filter === id ? "bg-raised text-ink shadow-1" : "text-ink-3 hover:text-ink",
              )}
            >
              {label}
            </button>
          ))}
          <Link
            to="/projects/$projectId/$view"
            params={{ projectId: track.projectId, view: "production" }}
            search={{ section: "takelog" }}
            className="ml-1 h-7 rounded-control px-2 text-[12px] leading-7 text-ink-3 hover:bg-raised hover:text-ink"
          >
            Take log
          </Link>
          <button
            type="button"
            aria-label="Hide takes"
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-control text-ink-3 hover:bg-raised hover:text-ink"
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      </div>
      <div className="scroll-quiet min-h-0 flex-1 overflow-auto">
        <div className="grid min-w-[760px] grid-cols-[220px_minmax(0,1fr)_32px]">
          <div className="sticky top-0 z-10 col-span-3 grid grid-cols-subgrid border-b border-line bg-pane/95 backdrop-blur">
            <span className="eyebrow px-4 py-1.5">Take</span>
            <div className="relative h-7">
              {Array.from({ length: BARS / 10 + 1 }, (_, i) => (
                <span
                  key={String(i)}
                  className="tabular absolute top-1.5 text-[10px] text-ink-3"
                  style={{ left: `${(i * 10 * 100) / BARS}%` }}
                >
                  {i === 0 ? "bar 1" : i * 10}
                </span>
              ))}
            </div>
            <span />
          </div>
          {shown.map((t) => {
            const from = t.coverage?.barFrom ?? 1;
            const to = t.coverage?.barTo ?? 1;
            const used = t.usedIn?.filter((u) => u.versionNumber === versionNumber) ?? [];
            const on = auditioning === t.id;
            return (
              <div
                key={t.id}
                className={cn(
                  "group col-span-3 grid grid-cols-subgrid items-center border-b border-line transition-colors hover:bg-raised/40",
                  on && "bg-signal/10",
                )}
              >
                <button
                  type="button"
                  onClick={() => setAuditioning(on ? null : t.id)}
                  className="flex items-center gap-2.5 px-4 py-1.5 text-left"
                >
                  <span
                    className={cn(
                      "flex size-6 shrink-0 items-center justify-center rounded-full",
                      on ? "bg-signal text-ground" : "bg-raised text-ink",
                    )}
                  >
                    <Icon
                      name={on ? "pause" : "play"}
                      size={9}
                      fill="currentColor"
                      strokeWidth={0}
                    />
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 text-[13px] text-ink">
                      <span className="tabular font-medium">T{t.number}</span>
                      {t.starred && (
                        <Icon name="star" size={11} fill="currentColor" className="text-ink-2" />
                      )}
                      <Rating value={t.rating} />
                    </span>
                    <span className="block truncate text-[11px] text-ink-3">
                      {sessionOf(t)?.name} · {formatDuration(t.duration)}
                      {t.notes ? ` · ${t.notes}` : ""}
                    </span>
                  </span>
                </button>
                <div className="relative h-9">
                  {Array.from({ length: BARS / 10 }, (_, i) => (
                    <span
                      key={String(i)}
                      className="absolute top-0 bottom-0 w-px bg-line"
                      style={{ left: `${(i * 10 * 100) / BARS}%` }}
                    />
                  ))}
                  <span
                    title={`Bars ${from} to ${to}`}
                    className={cn(
                      "absolute top-2 h-5 rounded-[4px] border transition-colors",
                      used.length
                        ? "border-ink/50 bg-ink/80"
                        : "border-ink-3/40 bg-ink-3/40 group-hover:bg-ink-3/55",
                    )}
                    style={{
                      left: `${((from - 1) * 100) / BARS}%`,
                      width: `${((to - from + 1) * 100) / BARS}%`,
                    }}
                  >
                    {used.map((u) => (
                      <span
                        key={`${u.barFrom}-${u.barTo}`}
                        className="absolute top-0 bottom-0 bg-signal/90"
                        style={{
                          left: `${((u.barFrom - from) * 100) / (to - from + 1)}%`,
                          width: `${((u.barTo - u.barFrom + 1) * 100) / (to - from + 1)}%`,
                        }}
                      />
                    ))}
                  </span>
                </div>
                <span className="pr-2">
                  {canEdit && (
                    <ActionMenu
                      label={`take ${t.number}`}
                      actions={[
                        {
                          label: `Use bars ${from} to ${to} in V${versionNumber}`,
                          onSelect: () => {},
                        },
                        { label: "Set coverage…", onSelect: () => {} },
                        { label: t.starred ? "Unstar" : "Star", onSelect: () => {} },
                        { label: "Share with a comment…", onSelect: () => {} },
                        "divider",
                        { label: "Open the take", onSelect: () => {} },
                      ]}
                    />
                  )}
                </span>
              </div>
            );
          })}
          {shown.length === 0 && (
            <p className="col-span-3 px-4 py-6 text-[13px] text-ink-3">
              No takes match. Coverage is set here or in the take log; takes are matched to tracks
              by their audio on import.
            </p>
          )}
        </div>
      </div>
      <div className="flex h-9 shrink-0 items-center gap-4 border-t border-line px-4 text-[12px] text-ink-3">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-4 rounded-[2px] bg-ink-3/40" /> covers
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-4 rounded-[2px] bg-signal/90" /> in the edit
        </span>
        {auditioning && (
          <span className="ml-auto text-ink-2">
            Auditioning T{takes.find((t) => t.id === auditioning)?.number}, level-matched; keys 1
            and 2 flip between take and version.
          </span>
        )}
        {!auditioning && canEdit && (
          <Button variant="ghost" size="sm" className="ml-auto h-6 text-[12px]">
            <Icon name="upload" size={12} />
            Import takes
          </Button>
        )}
      </div>
    </section>
  );
}
