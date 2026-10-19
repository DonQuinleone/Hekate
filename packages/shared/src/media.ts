import { z } from "zod";
import { timecodePattern } from "./video-time.ts";

/** Technical facts about an audio or video file, measured by the media worker. */
/**
 * What a recording says about itself (#41): Broadcast Wave's bext and iXML chunks, the tags
 * of ID3, Vorbis comments, MP4 and RIFF INFO by their common names, and embedded artwork.
 * Read when the file is probed; absent on files probed before it was read.
 */
export const embeddedMetadata = z.object({
  bext: z
    .object({
      description: z.string().optional(),
      originator: z.string().optional(),
      originatorReference: z.string().optional(),
      /** As written: "2026-10-14". */
      originationDate: z.string().optional(),
      /** As written: "09:58:00". */
      originationTime: z.string().optional(),
      /** Samples since midnight at the start of the file: its timecode, with the sample rate. */
      timeReference: z.number().int().nonnegative().optional(),
      codingHistory: z.string().optional(),
    })
    .optional(),
  ixml: z
    .object({
      /** Size of the chunk, in bytes. */
      bytes: z.number().int().nonnegative(),
      project: z.string().optional(),
      scene: z.string().optional(),
      take: z.string().optional(),
      tape: z.string().optional(),
      note: z.string().optional(),
      /** The timecode's frame rate, as written: "25/1", "30000/1001". */
      timecodeRate: z.string().optional(),
    })
    .optional(),
  tags: z
    .object({
      title: z.string(),
      artist: z.string(),
      album: z.string(),
      albumArtist: z.string(),
      composer: z.string(),
      genre: z.string(),
      date: z.string(),
      isrc: z.string(),
      copyright: z.string(),
    })
    .partial()
    .default({}),
  /**
   * An ADM BWF master's description of itself (#74), from its chna and axml chunks: the bed
   * (channels fed straight to speakers) and the objects. Dolby Atmos masters are delivered so.
   */
  adm: z
    .object({
      /** Size of the axml chunk, in bytes; 0 when there is none. */
      bytes: z.number().int().nonnegative(),
      programme: z.string().optional(),
      /** How many channels the bed has, and its layout where its speakers name one. */
      bed: z.number().int().nonnegative(),
      layout: z.string().optional(),
      /** How many channels carry objects. */
      objects: z.number().int().nonnegative(),
      /** The channels carrying LFE, 0-based. */
      lfe: z.array(z.number().int().nonnegative()),
      /** Whether Dolby's own metadata (the dbmd chunk its renderer writes) is in the file. */
      dolby: z.boolean(),
    })
    // Null once the file has been read and has none; absent on files read before ADM was.
    .nullable()
    .optional(),
  artwork: z
    .object({
      codec: z.string(),
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .optional(),
});
export type EmbeddedMetadata = z.infer<typeof embeddedMetadata>;

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
      /**
       * The audio stream's own length in seconds, where the container says it: a video's
       * sound may start late or end early, so it can differ from the file's duration.
       */
      duration: z.number().nonnegative().optional(),
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
      /** The timecode of its first frame, as written: "10:00:00:00", or "01:00:00;00" dropping frames (#146). */
      timecode: z.string().regex(timecodePattern).optional(),
    })
    .optional(),
  metadata: embeddedMetadata.optional(),
});

export type MediaInfo = z.infer<typeof mediaInfo>;
