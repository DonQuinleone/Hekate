import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { initialFocus, type PageFocus } from "~/lib/pages";
import { fileQuery } from "~/lib/queries";
import { DocumentViewer } from "./document-viewer";

/**
 * The track's score beside its recording (#12): its pages as the server drew them, to read
 * along with. Bars are named by the reviewer in a comment, never synced to the recording;
 * comments on the score itself live on the score's own page.
 */
export function ScorePane({ scoreFileId }: { scoreFileId: string }) {
  const { data: score, error } = useQuery(fileQuery(scoreFileId));
  const [focus, setFocus] = useState<PageFocus>(initialFocus);
  // Another score starts on its first page.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset whenever the score changes.
  useEffect(() => setFocus(initialFocus), [scoreFileId]);
  // Someone who cannot open the score (a guest whose review leaves it out) sees nothing of it.
  if (error || !score) return null;
  return (
    <section aria-label="Score" className="flex flex-col gap-3 border-t border-hairline pt-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="m-0 text-[15px] font-medium">Score</h2>
        <span className="min-w-0 truncate text-xs text-ink-3">{score.name}</span>
        <Link
          to="/files/$fileId"
          params={{ fileId: score.id }}
          className="ml-auto text-xs text-ink-3 hover:text-ink"
        >
          Comments on the score
        </Link>
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
