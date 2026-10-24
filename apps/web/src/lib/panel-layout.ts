import { useCallback, useState } from "react";

/**
 * Where a file's comments sit on a wide screen (#15): beside the player, below it, or away;
 * and whether the score is shown.
 */
export type CommentsPlace = "right" | "below" | "hidden";

export interface PanelLayout {
  comments: CommentsPlace;
  /** The comments column's width beside the player, in pixels. */
  width: number;
  /** Whether a track's linked score is shown under the player: off until asked for (#15). */
  score: boolean;
}

export const COMMENTS_WIDTH = { min: 300, max: 640, default: 400 } as const;
export const defaultPanelLayout: PanelLayout = {
  comments: "right",
  width: COMMENTS_WIDTH.default,
  score: false,
};

const places: readonly CommentsPlace[] = ["right", "below", "hidden"];
const KEY = "hekate.file.layout";

/** A width kept within what the column can be. */
export const commentsWidth = (width: number) =>
  Math.round(Math.min(COMMENTS_WIDTH.max, Math.max(COMMENTS_WIDTH.min, width)));

/** What a browser kept, read safely: anything unreadable or out of range falls back. */
export function readPanelLayout(stored: unknown): PanelLayout {
  if (!stored || typeof stored !== "object") return defaultPanelLayout;
  const { comments, width, score } = stored as Partial<Record<keyof PanelLayout, unknown>>;
  return {
    comments: places.includes(comments as CommentsPlace)
      ? (comments as CommentsPlace)
      : defaultPanelLayout.comments,
    width:
      typeof width === "number" && Number.isFinite(width)
        ? commentsWidth(width)
        : defaultPanelLayout.width,
    score: typeof score === "boolean" ? score : defaultPanelLayout.score,
  };
}

function load(): PanelLayout {
  try {
    const raw = localStorage.getItem(KEY);
    return readPanelLayout(raw ? JSON.parse(raw) : null);
  } catch {
    return defaultPanelLayout;
  }
}

/** The viewer's own placement of the comments, kept in this browser, as the prototype keeps it. */
export function usePanelLayout(): [PanelLayout, (patch: Partial<PanelLayout>) => void] {
  const [layout, setLayout] = useState(load);
  const update = useCallback((patch: Partial<PanelLayout>) => {
    setLayout((current) => {
      const next = readPanelLayout({ ...current, ...patch });
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // Not remembered; the placement still holds for this visit.
      }
      return next;
    });
  }, []);
  return [layout, update];
}
