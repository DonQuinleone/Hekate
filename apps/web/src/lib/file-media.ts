import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The page's media element, once the player has announced it for the file shown, and a
 * start position applied as soon as that file can seek (#15). An element announced for the
 * file before is never taken for this one, so arriving from another version cannot seek the
 * old source and lose the position.
 */
export function useFileMedia(
  fileId: string,
  startAt: number | undefined,
  onStarted: () => void,
): { media: HTMLMediaElement | null; onMedia: (element: HTMLMediaElement | null) => void } {
  const [announced, setAnnounced] = useState<{
    fileId: string;
    element: HTMLMediaElement;
  } | null>(null);
  // The player announces from its effects, after the render for the file it now plays.
  const shown = useRef(fileId);
  shown.current = fileId;
  const onMedia = useCallback(
    (element: HTMLMediaElement | null) =>
      setAnnounced(element ? { fileId: shown.current, element } : null),
    [],
  );
  const media = announced?.fileId === fileId ? announced.element : null;
  const started = useRef(onStarted);
  started.current = onStarted;
  useEffect(() => {
    if (!media || startAt === undefined) return;
    const seek = () => {
      media.currentTime = Math.min(
        startAt,
        Number.isFinite(media.duration) ? media.duration : startAt,
      );
      started.current();
    };
    if (media.readyState >= 1) return seek();
    media.addEventListener("loadedmetadata", seek, { once: true });
    return () => media.removeEventListener("loadedmetadata", seek);
  }, [media, startAt]);
  return { media, onMedia };
}
