import { z } from "zod";
import type { EmbeddedMetadata, MediaInfo } from "./media.ts";

/**
 * Correcting what a recording says about itself (decision 260): the fields of its embedded
 * metadata a person may correct, how each is checked, and how a correction is kept. The
 * original's bytes are never changed; a correction is Hekate's own record, shown wherever the
 * file's metadata is read and written into the file only as it leaves, downloaded.
 */

export const metadataFields = [
  "description",
  "originator",
  "originatorReference",
  "originationDate",
  "originationTime",
  "timeReference",
  "project",
  "scene",
  "take",
  "tape",
  "note",
  "title",
  "artist",
  "album",
  "albumArtist",
  "composer",
  "genre",
  "date",
  "isrc",
  "copyright",
] as const;
export const metadataField = z.enum(metadataFields);
export type MetadataField = z.infer<typeof metadataField>;

/** Where a field lives in a file: Broadcast Wave's bext chunk, its iXML, or the tags. */
export type MetadataGroup = "bext" | "ixml" | "tags";

interface FieldSpec {
  label: string;
  group: MetadataGroup;
  /** Longest value: bext's fixed fields are as long as the chunk gives them. */
  max: number;
  /** bext is written in Latin-1, one byte a character (EBU Tech 3285). */
  latin1?: boolean;
  /** What a value must look like, and how to say so. */
  pattern?: { test: RegExp; words: string };
}

const separators = "[-_:. ]";
const MAX_VALUE = 500;

export const metadataFieldSpecs: Record<MetadataField, FieldSpec> = {
  description: { label: "Description", group: "bext", max: 256, latin1: true },
  originator: { label: "Originator", group: "bext", max: 32, latin1: true },
  originatorReference: { label: "Originator reference", group: "bext", max: 32, latin1: true },
  originationDate: {
    label: "Origination date",
    group: "bext",
    max: 10,
    latin1: true,
    pattern: {
      test: new RegExp(`^\\d{4}${separators}\\d{2}${separators}\\d{2}$`),
      words: "A date as 2026-10-14",
    },
  },
  originationTime: {
    label: "Origination time",
    group: "bext",
    max: 8,
    latin1: true,
    pattern: {
      test: new RegExp(`^\\d{2}${separators}\\d{2}${separators}\\d{2}$`),
      words: "A time as 09:58:00",
    },
  },
  timeReference: {
    label: "Time reference",
    group: "bext",
    max: 18,
    pattern: { test: /^\d{1,16}$/, words: "Samples since midnight" },
  },
  project: { label: "Project", group: "ixml", max: MAX_VALUE },
  scene: { label: "Scene", group: "ixml", max: MAX_VALUE },
  take: { label: "Take", group: "ixml", max: MAX_VALUE },
  tape: { label: "Tape", group: "ixml", max: MAX_VALUE },
  note: { label: "Note", group: "ixml", max: MAX_VALUE },
  title: { label: "Title", group: "tags", max: MAX_VALUE },
  artist: { label: "Artist", group: "tags", max: MAX_VALUE },
  album: { label: "Album", group: "tags", max: MAX_VALUE },
  albumArtist: { label: "Album artist", group: "tags", max: MAX_VALUE },
  composer: { label: "Composer", group: "tags", max: MAX_VALUE },
  genre: { label: "Genre", group: "tags", max: MAX_VALUE },
  date: { label: "Date", group: "tags", max: MAX_VALUE },
  isrc: {
    label: "ISRC",
    group: "tags",
    max: 15,
    pattern: {
      test: /^[A-Z]{2}-?[A-Z0-9]{3}-?\d{2}-?\d{5}$/i,
      words: "An ISRC as GB-ABC-26-00001",
    },
  },
  copyright: { label: "Copyright", group: "tags", max: MAX_VALUE },
};

/**
 * The files whose metadata Hekate can write as they leave: Broadcast Wave (and plain WAV,
 * RF64 and BW64), written chunk by chunk by Hekate itself; FLAC and MP3, whose tags ffmpeg
 * writes without touching the sound. Anything else is not offered the editor.
 */
export type MetadataFormat = "wave" | "flac" | "mp3";

export function metadataFormatOf(info: MediaInfo | null | undefined): MetadataFormat | null {
  if (!info?.audio || !info.metadata) return null;
  if (info.format === "wav") return "wave";
  if (info.format === "flac") return "flac";
  if (info.format === "mp3") return "mp3";
  return null;
}

/** RIFF INFO, a WAV file's tags, has no place for an album artist or a composer. */
const notInWave = new Set<MetadataField>(["albumArtist", "composer"]);

/** The fields a file of this format can be corrected in, in the order the editor lists them. */
export function editableFields(format: MetadataFormat, sampleRate?: number): MetadataField[] {
  return metadataFields.filter((field) => {
    const { group } = metadataFieldSpecs[field];
    if (format !== "wave") return group === "tags";
    if (field === "timeReference") return Boolean(sampleRate);
    return !notInWave.has(field);
  });
}

// One control character at a time; a value is one line of text.
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
const control = /[\u0000-\u001f\u007f]/;
const latin1 = /^[ -~ -ÿ]*$/;

/** What is wrong with a value for a field, in words, or null. An empty value clears it. */
export function metadataValueProblem(field: MetadataField, value: string): string | null {
  if (value === "") return null;
  const spec = metadataFieldSpecs[field];
  if (control.test(value)) return "One line of text, please";
  if (spec.latin1 && !latin1.test(value))
    return "Broadcast Wave keeps this in Latin-1: letters such as é are fine, others are not";
  if (value.length > spec.max) return `At most ${spec.max} characters`;
  if (spec.pattern && !spec.pattern.test.test(value)) return spec.pattern.words;
  if (field === "timeReference" && !Number.isSafeInteger(Number(value))) return "Too large";
  return null;
}

/**
 * A change asked for: each field's new value (empty to clear it), or null to go back to what
 * the file itself says.
 */
export const metadataChanges = z
  .object({
    changes: z.partialRecord(metadataField, z.string().max(600).nullable()),
  })
  .superRefine(({ changes }, context) => {
    const entries = Object.entries(changes) as [MetadataField, string | null][];
    if (entries.length === 0)
      context.addIssue({ code: "custom", message: "Nothing to change", path: ["changes"] });
    for (const [field, value] of entries) {
      const problem = value === null ? null : metadataValueProblem(field, value.trim());
      if (problem) context.addIssue({ code: "custom", message: problem, path: ["changes", field] });
    }
  });
export type MetadataChanges = z.infer<typeof metadataChanges>;

/**
 * Hekate's record of a file's corrections: each corrected field's value (empty where it was
 * cleared) and what the file itself says (null where it says nothing).
 */
export const metadataCorrections = z.partialRecord(
  metadataField,
  z.object({ value: z.string(), read: z.string().nullable() }),
);
export type MetadataCorrections = z.infer<typeof metadataCorrections>;

/** A field's value in a file's metadata, as text; undefined where it has none. */
export function metadataValueOf(
  metadata: EmbeddedMetadata,
  field: MetadataField,
): string | undefined {
  const { group } = metadataFieldSpecs[field];
  if (group === "tags") return metadata.tags[field as keyof EmbeddedMetadata["tags"]];
  if (group === "ixml") return metadata.ixml?.[field as "project"];
  if (field === "timeReference") {
    const samples = metadata.bext?.timeReference;
    return samples === undefined ? undefined : String(samples);
  }
  return metadata.bext?.[field as "description"];
}

/** A file's metadata with one field set to a value, or removed where it is undefined. */
export function withMetadataValue(
  metadata: EmbeddedMetadata,
  field: MetadataField,
  value: string | undefined,
): EmbeddedMetadata {
  const { group } = metadataFieldSpecs[field];
  const set = <T extends object>(on: T, key: string): T => {
    const next = { ...on } as Record<string, unknown>;
    if (value === undefined) delete next[key];
    else next[key] = key === "timeReference" ? Number(value) : value;
    return next as T;
  };
  if (group === "tags") return { ...metadata, tags: set(metadata.tags, field) };
  // A recording without iXML gets one as it leaves: its size is not known until then.
  if (group === "ixml") return { ...metadata, ixml: set(metadata.ixml ?? { bytes: 0 }, field) };
  return { ...metadata, bext: set(metadata.bext ?? {}, field) };
}

/** One field changed by an edit, for the access log: what it said before, and now. */
export interface MetadataChange {
  field: MetadataField;
  from: string | null;
  to: string | null;
}

/**
 * An edit applied: the metadata as it now reads, the corrections kept, and what changed. A
 * value that comes back to what the file says is no longer a correction.
 */
export function applyMetadataChanges(
  metadata: EmbeddedMetadata,
  corrections: MetadataCorrections,
  changes: MetadataChanges["changes"],
): { metadata: EmbeddedMetadata; corrections: MetadataCorrections; changed: MetadataChange[] } {
  let next = metadata;
  const kept: MetadataCorrections = { ...corrections };
  const changed: MetadataChange[] = [];
  for (const [field, asked] of Object.entries(changes) as [MetadataField, string | null][]) {
    const current = metadataValueOf(next, field) ?? null;
    const read = field in kept ? (kept[field]?.read ?? null) : current;
    const value = asked === null ? (read ?? "") : asked.trim();
    if (value === (read ?? "")) delete kept[field];
    else kept[field] = { value, read };
    const to = value === "" ? null : value;
    if (to !== current) {
      changed.push({ field, from: current, to });
      next = withMetadataValue(next, field, to ?? undefined);
    }
  }
  return { metadata: next, corrections: kept, changed };
}

/** A file's metadata as just read from it, with Hekate's corrections over it (decision 260). */
export function correctedMetadata(
  metadata: EmbeddedMetadata,
  corrections: MetadataCorrections | null | undefined,
): EmbeddedMetadata {
  let next = metadata;
  for (const [field, correction] of Object.entries(corrections ?? {}) as [
    MetadataField,
    { value: string },
  ][])
    next = withMetadataValue(next, field, correction.value === "" ? undefined : correction.value);
  return next;
}

/** A frame rate as iXML writes it, as whole frames a second, as `timecodeOf` reads it. */
function framesPerSecond(rate: string | undefined): number | null {
  if (!rate) return null;
  const [n, d = "1"] = rate.split("/");
  const fps = Number(n) / Number(d);
  return Number.isFinite(fps) && fps > 0 && fps <= 1000 ? Math.round(fps) : null;
}

/**
 * Timecode typed as a bext time reference: "10:00:00:00" (frames where iXML gives the rate)
 * or "10:00:00", as samples since midnight at the file's rate; null where it is not one.
 */
export function samplesOfTimecode(text: string, sampleRate: number, rate?: string): number | null {
  const parts = /^(\d{1,2}):(\d{2}):(\d{2})(?:[:;.](\d{1,3}))?$/.exec(text.trim());
  if (!parts || !(sampleRate > 0)) return null;
  const [h, m, s] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (h > 23 || m > 59 || s > 59) return null;
  let seconds = h * 3600 + m * 60 + s;
  if (parts[4] !== undefined) {
    const fps = framesPerSecond(rate);
    const frames = Number(parts[4]);
    if (fps === null || frames >= fps) return null;
    seconds += frames / fps;
  }
  return Math.round(seconds * sampleRate);
}
