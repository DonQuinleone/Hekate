import { useQuery } from "@tanstack/react-query";
import type Hls from "hls.js";
import { type CSSProperties, useEffect, useRef } from "react";
import { cn } from "~/lib/cn";
import { type Playback, playbackQuery } from "~/lib/queries";
import { familyOf, videoFamilyFor } from "~/lib/video-family";
import { useFollow } from "./stream-part";

/**
 * Another cut of a deliverable (#147), shown beside or under the player's own and locked to
 * its frame: within half a frame while paused, a few frames while both play. Never heard, and
 * played from its own protected stream, issued to this session like any other.
 */
export function CutVideo({
  fileId,
  master,
  frameSeconds,
  className,
  style,
}: {
  fileId: string;
  master: HTMLMediaElement;
  /** How long one frame of the player's cut shows. */
  frameSeconds: number;
  className?: string;
  style?: CSSProperties;
}) {
  const { data, error } = useQuery(playbackQuery(fileId));
  if (error)
    return (
      <div
        className={cn(
          "flex items-center justify-center bg-ground text-[13px] text-ink-3",
          className,
        )}
        style={style}
      >
        That cut could not be loaded.
      </div>
    );
  if (!data) return <div className={cn("bg-ground", className)} style={style} />;
  return (
    <CutStream
      playback={data}
      master={master}
      frameSeconds={frameSeconds}
      className={className}
      style={style}
    />
  );
}

function CutStream({
  playback,
  master,
  frameSeconds,
  className,
  style,
}: {
  playback: Playback;
  master: HTMLMediaElement;
  frameSeconds: number;
  className?: string;
  style?: CSSProperties;
}) {
  const element = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = element.current;
    if (!video) return;
    let hls: Hls | null = null;
    let cancelled = false;
    // The same encoding the player chose for its own cut (#148), so both decode alike, asked
    // about at the cut's frame rate.
    Promise.all([import("hls.js"), videoFamilyFor(playback.renditions, 1 / frameSeconds)]).then(
      ([{ default: Hls }, chosen]) => {
        if (cancelled) return;
        if (!Hls.isSupported()) {
          video.src = playback.url;
          return;
        }
        // No larger than it shows: half the frame side by side, the whole frame under a wipe.
        const instance = new Hls({ enableWorker: true, capLevelToPlayerSize: true });
        hls = instance;
        instance.on(Hls.Events.MANIFEST_PARSED, () => {
          for (let i = instance.levels.length - 1; i >= 0; i--) {
            const level = instance.levels[i];
            const codecs = level?.videoCodec ?? level?.codecSet ?? "";
            if (instance.levels.length > 1 && familyOf({ codecs }) !== chosen)
              instance.removeLevel(i);
          }
        });
        instance.loadSource(playback.url);
        instance.attachMedia(video);
      },
    );
    return () => {
      cancelled = true;
      hls?.destroy();
      video.removeAttribute("src");
    };
  }, [playback, frameSeconds]);
  useFollow(element, master, frameSeconds / 2, { playingDrift: frameSeconds * 3, heard: false });
  return (
    <video
      ref={element}
      muted
      playsInline
      preload="auto"
      // Seen, never used: the player's own controls move it.
      tabIndex={-1}
      aria-hidden="true"
      className={cn("bg-ground", className)}
      style={style}
    />
  );
}
