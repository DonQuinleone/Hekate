import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { threadsOf } from "~/lib/comments";
import { initialFocus, type PageFocus } from "~/lib/pages";
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
}: {
  scoreFileId: string;
  onHide: () => void;
  /** A guest has no score page of their own to go to. */
  guest?: boolean;
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
    <section aria-label="Score" className="flex flex-col gap-3 border-t border-hairline pt-5">
      <div className="flex min-w-0 items-center gap-x-3">
        <h2 className="m-0 shrink-0 text-[15px] font-medium">Score</h2>
        <span className="min-w-0 flex-1 truncate text-xs text-ink-3">{score.name}</span>
        {!guest && (
          <Link
            to="/files/$fileId"
            params={{ fileId: score.id }}
            className="shrink-0 text-xs text-ink-3 hover:text-ink"
          >
            {open === null
              ? "Comments on the score"
              : `${open} ${open === 1 ? "comment" : "comments"} on the score`}
          </Link>
        )}
        <Button variant="ghost" size="icon" aria-label="Hide the score" onClick={onHide}>
          <Icon name="close" size={13} />
        </Button>
      </div>
      {score.streamStatus === "ready" ? (
        <DocumentViewer
          fileId={score.id}
          name={score.name}
          focus={focus}
          onFocus={(change) => setFocus((f) => ({ ...f, ...change }))}
        />
      ) : (
        <p className="m-0 text-[13px] text-ink-3">
          {score.streamStatus === "failed" ? "The pages could not be drawn" : "Drawing the pages"}
        </p>
      )}
    </section>
  );
}
