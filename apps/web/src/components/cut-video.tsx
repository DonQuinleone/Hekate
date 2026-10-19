import { useQuery } from "@tanstack/react-query";
import type Hls from "hls.js";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { cn } from "~/lib/cn";
import { type Playback, playbackQuery } from "~/lib/queries";
import { familyOf, type VideoFamily } from "~/lib/video-family";
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
  family,
  className,
  style,
}: {
  fileId: string;
  master: HTMLMediaElement;
  /** How long one frame of the player's cut shows. */
  frameSeconds: number;
  /** The encoding the player chose for its own cut (#148): this one plays the same. */
  family: VideoFamily | null;
  className?: string;
  style?: CSSProperties;
}) {
  const { data, error } = useQuery(playbackQuery(fileId));
  if (error) return <Unavailable className={className} style={style} />;
  if (!data) return <div className={cn("bg-ground", className)} style={style} />;
  return (
    <CutStream
      playback={data}
      master={master}
      frameSeconds={frameSeconds}
      family={family}
      className={className}
      style={style}
    />
  );
}

function Unavailable({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <div
      className={cn("flex items-center justify-center bg-ground text-[13px] text-ink-3", className)}
      style={style}
    >
      That cut could not be loaded.
    </div>
  );
}

function CutStream({
  playback,
  master,
  frameSeconds,
  family,
  className,
  style,
}: {
  playback: Playback;
  master: HTMLMediaElement;
  frameSeconds: number;
  family: VideoFamily | null;
  className?: string;
  style?: CSSProperties;
}) {
  const element = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const video = element.current;
    if (!video) return;
    let hls: Hls | null = null;
    let cancelled = false;
    setFailed(false);
    import("hls.js")
      .then(({ default: Hls }) => {
        if (cancelled) return;
        if (!Hls.isSupported()) {
          video.src = playback.url;
          return;
        }
        // No larger than it shows: half the frame side by side, the whole frame under a wipe.
        const instance = new Hls({ enableWorker: true, capLevelToPlayerSize: true });
        hls = instance;
        instance.on(Hls.Events.MANIFEST_PARSED, () => {
          const codecsOf = (i: number) => {
            const level = instance.levels[i];
            return level?.videoCodec ?? level?.codecSet ?? "";
          };
          // The player's family, where this cut was encoded in it too; an older cut made
          // before the royalty-free encoding plays the H.264 it has.
          const ours = instance.levels.some((_, i) => familyOf({ codecs: codecsOf(i) }) === family);
          if (!family || !ours) return;
          for (let i = instance.levels.length - 1; i >= 0; i--)
            if (familyOf({ codecs: codecsOf(i) }) !== family) instance.removeLevel(i);
        });
        instance.loadSource(playback.url);
        instance.attachMedia(video);
      })
      .catch(() => {
        // The player's code could not be fetched (a deployment mid-visit, a dropped request).
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      hls?.destroy();
      video.removeAttribute("src");
    };
  }, [playback, family]);
  useFollow(element, master, frameSeconds / 2, { playingDrift: frameSeconds * 3, heard: false });
  if (failed) return <Unavailable className={className} style={style} />;
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
