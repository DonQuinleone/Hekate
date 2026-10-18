import { useState } from "react";
import { Icon } from "~/components/icons";
import { Kbd } from "~/components/label";
import { Button } from "~/components/ui/button";
import { Dropdown } from "~/components/ui/menu";
import { categories } from "~/data";
import { cn } from "~/lib/cn";
import { formatClock, formatTimecode } from "~/lib/format";
import type { Playback } from "../player/playback.ts";

export type Target = "playhead" | "range" | "whole" | "region" | "page";

export interface References {
  page: boolean;
  bar: boolean;
  beat: boolean;
}

const smallField =
  "tabular h-7 rounded-chip border border-line bg-ground/60 px-2 text-[12px] text-ink transition-colors placeholder:text-ink-3 focus:border-edge-strong focus:outline-none";

/** The comment box: pinned to the playhead, the page or the whole file; what it refers to; what it says. */
export function Composer({
  playback,
  kind,
  video = false,
  fps = 25,
  references,
  canCategorise,
  channels = [],
  page,
  onPost,
  disabledReason,
}: {
  playback: Playback | null;
  kind: "media" | "document";
  video?: boolean;
  fps?: number;
  references: References;
  canCategorise: boolean;
  /** A recording's speakers: a comment can be about one of them (#74). */
  channels?: readonly string[];
  page?: number;
  onPost: (body: string) => void;
  disabledReason?: string;
}) {
  const [target, setTarget] = useState<Target>(kind === "media" ? "playhead" : "page");
  const [body, setBody] = useState("");
  const [focused, setFocused] = useState(false);
  const fmt = (t: number) => (video ? formatTimecode(t, fps) : formatClock(t));
  if (disabledReason) {
    return (
      <p className="border-t border-line px-4 py-3 text-[13px] text-ink-3">{disabledReason}</p>
    );
  }
  const loop = playback?.loop && playback.looping ? playback.loop : null;
  const targets: { id: Target; label: string }[] =
    kind === "media"
      ? [
          { id: "playhead", label: "At the playhead" },
          { id: "range", label: loop ? "Over the loop" : "Over a range (drag on the waveform)" },
          { id: "whole", label: "The whole file" },
        ]
      : [
          { id: "region", label: "A region (drag on the page)" },
          { id: "page", label: `Page ${page ?? 1}` },
          { id: "whole", label: "The whole file" },
        ];
  const where =
    target === "playhead" && playback
      ? fmt(playback.time)
      : target === "range"
        ? loop
          ? `${formatClock(loop.start, false)}–${formatClock(loop.end, false)}`
          : "Range"
        : target === "whole"
          ? "Whole file"
          : target === "page"
            ? `Page ${page ?? 1}`
            : "Region";
  const anyRef = references.page || references.bar || references.beat;
  const open = focused || body.length > 0;
  return (
    <form
      className="flex flex-col gap-2 border-t border-line px-3 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!body.trim()) return;
        onPost(body);
        setBody("");
      }}
    >
      <div className="flex items-end gap-2 rounded-panel border border-line bg-ground/50 p-1.5 pl-2 shadow-1 transition-colors focus-within:border-edge-strong">
        <Dropdown
          size="sm"
          value={<span className="tabular font-medium text-signal">{where}</span>}
          actions={targets.map((t) => ({
            label: t.label,
            checked: target === t.id,
            onSelect: () => setTarget(t.id),
          }))}
          className="mb-0.5 shrink-0 px-1.5"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter")
              (e.currentTarget.form as HTMLFormElement | null)?.requestSubmit();
          }}
          rows={open ? 2 : 1}
          placeholder="Write a comment"
          className="min-h-8 flex-1 resize-none bg-transparent py-1.5 text-[14px] leading-5 text-ink placeholder:text-ink-3 focus:outline-none"
        />
        <Button
          type="submit"
          variant={body.trim() ? "primary" : "ghost"}
          size="icon"
          aria-label="Post comment"
          disabled={!body.trim()}
          className="size-8 shrink-0 rounded-full"
        >
          <Icon name="send" size={14} />
        </Button>
      </div>
      {open && (
        <div className="rise-in flex flex-wrap items-center gap-2 px-0.5 text-[12px] text-ink-3">
          {anyRef && (
            <>
              {/* On a document the page is the one shown; on a recording it is typed. */}
              {references.page && kind === "media" && (
                <input aria-label="Page" placeholder="Page" className={cn(smallField, "w-16")} />
              )}
              {references.bar && (
                <input
                  aria-label="Bar or bars"
                  placeholder="Bar, or 9–12"
                  className={cn(smallField, "w-24")}
                />
              )}
              {references.beat && (
                <input aria-label="Beat" placeholder="Beat" className={cn(smallField, "w-14")} />
              )}
            </>
          )}
          {channels.length > 0 && (
            <select aria-label="Channel" defaultValue="" className={cn(smallField, "text-ink-2")}>
              <option value="">Every channel</option>
              {channels.map((name, i) => (
                <option key={`${name}-${String(i)}`} value={String(i)}>
                  {name}
                </option>
              ))}
            </select>
          )}
          {canCategorise && (
            <select aria-label="Category" defaultValue="" className={cn(smallField, "text-ink-2")}>
              <option value="">No category</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="flex h-7 items-center gap-1 rounded-chip px-1.5 hover:bg-raised hover:text-ink"
          >
            @ Mention
          </button>
          <button
            type="button"
            className="flex h-7 items-center gap-1 rounded-chip px-1.5 hover:bg-raised hover:text-ink"
          >
            <Icon name="link" size={12} /> Attach
          </button>
          <span className="ml-auto flex items-center gap-1">
            <Kbd>⌘</Kbd>
            <Kbd>↵</Kbd>
          </span>
        </div>
      )}
    </form>
  );
}
