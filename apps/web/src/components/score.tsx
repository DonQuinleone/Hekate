import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { cn } from "~/lib/cn";
import { threadsOf } from "~/lib/comments";
import { initialFocus, type PageFocus } from "~/lib/pages";
import { SCORE_WIDTH, scoreWidth } from "~/lib/panel-layout";
import { commentsQuery, fileQuery } from "~/lib/queries";
import { DocumentViewer } from "./document-viewer";
import { Icon } from "./icons";
import { Button } from "./ui/button";

/**
 * The track's score beside its recording (#12): its pages as the server drew them, to read
 * along with. Bars are named by the reviewer in a comment, never synced to the recording;
 * comments on the score itself live on the score's own page, which members reach from here.
 * Shown from the strip above the player, and put away again from its own header (#15).
 */
export function ScorePane({
  scoreFileId,
  onHide,
  guest = false,
  width,
  onWidth,
}: {
  scoreFileId: string;
  onHide: () => void;
  /** A guest has no score page of their own to go to. */
  guest?: boolean;
  /** On a wide screen, its width beside the player and the viewer's change of it (#646). */
  width?: number;
  onWidth?: (width: number) => void;
}) {
  const { data: score, error } = useQuery(fileQuery(scoreFileId));
  const { data: comments } = useQuery({ ...commentsQuery(scoreFileId), enabled: !guest });
  const open = comments ? threadsOf(comments).open.length : null;
  const [focus, setFocus] = useState<PageFocus>(initialFocus);
  // Another score starts on its first page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset whenever the score changes.
  useEffect(() => setFocus(initialFocus), [scoreFileId]);
  // Someone who cannot open the score (a guest whose review leaves it out) sees nothing of it.
  if (error || !score) return null;
  return (
    // Beside the player on a wide screen (#646), the full height of the frame and as wide as
    // the viewer drags it, so the waveform keeps its height; under the player on a phone.
    <section
      aria-label="Score"
      className="relative flex shrink-0 flex-col border-t border-line lg:min-h-0 lg:w-[var(--score-width)] lg:border-t-0 lg:border-l"
      style={width ? { ["--score-width" as string]: `${width}px` } : undefined}
    >
      {width !== undefined && onWidth && (
        <ScoreSplitter
          width={width}
          onWidth={onWidth}
          className="absolute inset-y-0 -left-1 z-10 hidden lg:block"
        />
      )}
      <div className="flex h-10 min-w-0 shrink-0 items-center gap-x-3 px-3 lg:px-4">
        <h2 className="m-0 shrink-0 text-[13px] font-medium text-ink">Score</h2>
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink-3">{score.name}</span>
        {!guest && (
          <Link
            to="/files/$fileId"
            params={{ fileId: score.id }}
            className="shrink-0 text-[13px] text-ink-3 hover:text-ink"
          >
            {open === null
              ? "Comments on the score"
              : `${open} ${open === 1 ? "comment" : "comments"} on the score`}
          </Link>
        )}
        <Button variant="ghost" size="iconSm" aria-label="Hide the score" onClick={onHide}>
          <Icon name="close" size={13} />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col px-3 pb-3 lg:px-4">
        {score.streamStatus === "ready" ? (
          <DocumentViewer
            fileId={score.id}
            name={score.name}
            focus={focus}
            onFocus={(change) => setFocus((f) => ({ ...f, ...change }))}
            fill
          />
        ) : (
          <p className="m-0 text-[13px] text-ink-3">
            {score.streamStatus === "failed" ? "The pages could not be drawn" : "Drawing the pages"}
          </p>
        )}
      </div>
    </section>
  );
}

/** The edge between the player and the score (#646): dragged, or moved with the arrow keys. */
function ScoreSplitter({
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
      aria-label="Score width"
      aria-valuemin={SCORE_WIDTH.min}
      aria-valuemax={SCORE_WIDTH.max}
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
        // Dragging left widens the score, which sits to the right of the handle.
        onWidth(scoreWidth(width - (e.clientX - last.current)));
        last.current = e.clientX;
      }}
      onKeyDown={(e) => {
        const by = e.key === "ArrowLeft" ? 24 : e.key === "ArrowRight" ? -24 : 0;
        if (e.key === "Home") onWidth(SCORE_WIDTH.max);
        else if (e.key === "End") onWidth(SCORE_WIDTH.min);
        else if (by) onWidth(scoreWidth(width + by));
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
