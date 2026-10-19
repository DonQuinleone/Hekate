import type { Rendition } from "./queries";

/**
 * Which of a video's two encodings a browser plays (#148, decision 142): H.264, or the
 * royalty-free one (AV1 or VP9) beside it. One only, so the picture never changes codec while
 * it plays.
 */
export type VideoFamily = "h264" | "free";

/** A rendition's family, by its codecs. */
export const familyOf = (rendition: Pick<Rendition, "codecs">): VideoFamily =>
  /^(av01|vp09)\./.test(rendition.codecs) ? "free" : "h264";

/**
 * The family to play: the royalty-free one where H.264 cannot be played at all, or where the
 * browser decodes it smoothly and without draining a battery; otherwise H.264, which every
 * device decodes in hardware. A video with one family plays that.
 */
export function chooseFamily(o: {
  hasH264: boolean;
  hasFree: boolean;
  h264Playable: boolean;
  /** Whether the browser says it decodes the royalty-free one smoothly and power-efficiently. */
  freeEfficient: boolean;
}): VideoFamily {
  if (!o.hasFree) return "h264";
  if (!o.hasH264 || !o.h264Playable) return "free";
  return o.freeEfficient ? "free" : "h264";
}

const mime = (codecs: string) => `video/mp4; codecs="${codecs}"`;

/** The browser's answer for a video's renditions: which family it plays. */
export async function videoFamilyFor(renditions: Rendition[]): Promise<VideoFamily> {
  const video = renditions.filter((r) => r.height);
  const free = video.filter((r) => familyOf(r) === "free");
  const h264 = video.filter((r) => familyOf(r) === "h264");
  const top = free.reduce<Rendition | undefined>(
    (best, r) => (!best || (r.height ?? 0) > (best.height ?? 0) ? r : best),
    undefined,
  );
  const supported = (codecs: string) =>
    typeof MediaSource !== "undefined" &&
    MediaSource.isTypeSupported(mime(codecs.split(",")[0] ?? ""));
  let freeEfficient = false;
  if (top && navigator.mediaCapabilities) {
    try {
      const info = await navigator.mediaCapabilities.decodingInfo({
        type: "media-source",
        video: {
          contentType: mime(top.codecs.split(",")[0] ?? ""),
          width: top.width ?? 1920,
          height: top.height ?? 1080,
          bitrate: top.bandwidth,
          framerate: 30,
        },
      });
      freeEfficient = info.supported && info.smooth && info.powerEfficient;
    } catch {
      // A browser that cannot say plays H.264, which it surely can.
    }
  }
  return chooseFamily({
    hasH264: h264.length > 0,
    hasFree: free.length > 0,
    h264Playable: h264.some((r) => supported(r.codecs)),
    freeEfficient,
  });
}
