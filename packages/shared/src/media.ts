import { z } from "zod";

/** Technical facts about an audio or video file, measured by the media worker. */
export const mediaInfo = z.object({
  /** Container format, for example "wav", "flac" or "mov,mp4,m4a,3gp,3g2,mj2". */
  format: z.string().optional(),
  /** Seconds. */
  duration: z.number().nonnegative().optional(),
  /** Overall bit rate in bits per second. */
  bitRate: z.number().int().nonnegative().optional(),
  audio: z
    .object({
      codec: z.string(),
      channels: z.number().int().positive(),
      /** For example "stereo" or "5.1(side)". */
      channelLayout: z.string().optional(),
      sampleRate: z.number().int().positive(),
      /** Bits per sample for PCM and lossless codecs, for example 24. */
      bitDepth: z.number().int().positive().optional(),
    })
    .optional(),
  video: z
    .object({
      codec: z.string(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      /** Frames per second, for example 23.976 or 25. */
      fps: z.number().positive().optional(),
      /** Exact frame rate as a ratio, for example "24000/1001". */
      frameRate: z.string().optional(),
      pixelFormat: z.string().optional(),
    })
    .optional(),
});

export type MediaInfo = z.infer<typeof mediaInfo>;
