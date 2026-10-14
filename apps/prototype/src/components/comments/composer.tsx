import { useState } from "react";
import { Icon } from "~/components/icons";
import { Kbd } from "~/components/label";
import { Button } from "~/components/ui/button";
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

/** The comment box: where it points, what it refers to, what it says. */
export function Composer({
  playback,
  kind,
  video = false,
  fps = 25,
  references,
  canCategorise,
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
  page?: number;
  onPost: (body: string) => void;
  disabledReason?: string;
}) {
  const [target, setTarget] = useState<Target>(kind === "media" ? "playhead" : "page");
  const [body, setBody] = useState("");
  const fmt = (t: number) => (video ? formatTimecode(t, fps) : formatClock(t));
  if (disabledReason) {
    return (
      <p className="m-0 border-t border-hairline-soft px-4 py-3 text-xs text-ink-3">
        {disabledReason}
      </p>
    );
  }
  const chips: { id: Target; label: string }[] =
    kind === "media"
      ? [
          { id: "playhead", label: `At ${playback ? fmt(playback.time) : "playhead"}` },
          {
            id: "range",
            label:
              playback?.loop && playback.looping
                ? `${formatClock(playback.loop.start, false)}–${formatClock(playback.loop.end, false)}`
                : "Range",
          },
          { id: "whole", label: "Whole file" },
        ]
      : [
          { id: "region", label: "Drag a region" },
          { id: "page", label: `Page ${page ?? 1}` },
          { id: "whole", label: "Whole file" },
        ];
  const anyRef = references.page || references.bar || references.beat;
  return (
    <form
      className="flex flex-col gap-2 border-t border-hairline-soft bg-surface px-3 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!body.trim()) return;
        onPost(body);
        setBody("");
      }}
    >
      <div className="flex flex-wrap items-center gap-1">
        {chips.map((c) => (
          <button
            key={c.id}
            type="button"
            aria-pressed={target === c.id}
            onClick={() => setTarget(c.id)}
            className={cn(
              "tabular h-7 rounded-full border px-2.5 text-xs",
              target === c.id
                ? "border-signal/60 bg-signal/10 text-ink"
                : "border-hairline text-ink-3 hover:border-edge hover:text-ink",
            )}
          >
            {c.label}
          </button>
        ))}
      </div>
      {anyRef && (
        <div className="flex flex-wrap items-center gap-2">
          {references.page && (
            <input
              aria-label="Page"
              placeholder="Page"
              className="tabular h-7 w-16 rounded-chip border border-hairline bg-ground px-2 text-xs text-ink placeholder:text-ink-3"
            />
          )}
          {references.bar && (
            <input
              aria-label="Bar or bars"
              placeholder="Bar, or 9-12"
              className="tabular h-7 w-24 rounded-chip border border-hairline bg-ground px-2 text-xs text-ink placeholder:text-ink-3"
            />
          )}
          {references.beat && (
            <input
              aria-label="Beat"
              placeholder="Beat"
              className="tabular h-7 w-14 rounded-chip border border-hairline bg-ground px-2 text-xs text-ink placeholder:text-ink-3"
            />
          )}
          <span className="text-[11px] text-ink-3">as printed; 0 for an upbeat</span>
        </div>
      )}
      <div className="flex items-end gap-2">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter")
              (e.currentTarget.form as HTMLFormElement | null)?.requestSubmit();
          }}
          rows={2}
          placeholder={target === "whole" ? "Comment on the whole file" : "Comment"}
          className="min-h-[44px] flex-1 resize-y rounded-control border border-edge bg-ground px-3 py-2 text-[13px] text-ink placeholder:text-ink-3 focus:border-ink-3 focus:outline-none"
        />
        <Button
          type="submit"
          variant="primary"
          size="icon"
          aria-label="Post comment"
          disabled={!body.trim()}
          className="size-9 shrink-0"
        >
          <Icon name="send" size={14} />
        </Button>
      </div>
      <div className="flex items-center gap-2 text-[11px] text-ink-3">
        {canCategorise && (
          <select
            aria-label="Category"
            defaultValue=""
            className="h-6 rounded-chip border border-hairline bg-ground px-1.5 text-[11px] text-ink-2"
          >
            <option value="">No category</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        <button type="button" className="hover:text-ink">
          @ mention
        </button>
        <button type="button" className="hover:text-ink">
          Attach a file
        </button>
        <span className="ml-auto flex items-center gap-1">
          <Kbd>⌘</Kbd>
          <Kbd>↵</Kbd> posts
        </span>
      </div>
    </form>
  );
}
