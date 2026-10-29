import { variantNameFrom } from "@hekate/shared";

/**
 * What audio uploaded into a music project becomes (#485): a new track (version 1 of a track
 * named from the file), a new version of a track that exists, or a plain file. Several files
 * at once can be one track each, or one track with a version per file in name order. The
 * plan is worked out here, pure, from the files chosen and the choices made; the dialog
 * draws it and carries it out with the routes that exist.
 */

export type UploadChoice = "track" | "version" | "file";
/** Several files under New track: a track each, or one track with a version per file. */
export type TrackGrouping = "each" | "one";

/** A file chosen, by the key the upload dialog gave it, with its name as the recorder left it. */
export interface PlannedFile {
  key: string;
  name: string;
}

/** The track a new version goes to: its name reads in the copy, its versions give the number. */
export interface TargetTrack {
  id: string;
  name: string;
  versions: number;
}

export type UploadPlan =
  /** One track per file, each with the file as its version 1. */
  | { kind: "tracks"; tracks: { key: string; name: string }[] }
  /** One track, the files its versions 1 to n in name order. */
  | { kind: "one-track"; name: string; versions: { key: string; number: number }[] }
  /** The files as the variants of the track's next version. */
  | {
      kind: "version";
      track: TargetTrack;
      number: number;
      variants: { key: string; name: string; primary: boolean }[];
    }
  /** Uploaded as they are. */
  | { kind: "files"; count: number };

const AUDIO = /\.(wav|wave|bwf|rf64|aif|aiff|aifc|flac|mp3|m4a|aac|ogg|opus|wma|caf|dsf|dff)$/i;

/** Whether a file is audio, by its type where the browser knows it and by its name otherwise. */
export const isAudio = (file: { name: string; type?: string }) =>
  (file.type?.startsWith("audio/") ?? false) || AUDIO.test(file.name);

/** A file's name without its extension. */
const stem = (fileName: string) => fileName.replace(/\.[a-z0-9]{1,5}$/i, "");

/** Spaces for the separators file names carry, tidied: "maple_leaf-rag__v1" reads "maple leaf rag v1". */
const tidy = (name: string) =>
  name
    .replace(/[_]+/g, " ")
    // A hyphen between words with no space around it joins them; one spaced out is kept.
    .replace(/(?<=\S)-(?=\S)/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–:.,]+|[\s\-–:.,]+$/g, "")
    .trim();

/** A track's name from a file's: the extension off, the separators tidied, at most 200 characters. */
export function trackNameFrom(fileName: string): string {
  return tidy(stem(fileName)).slice(0, 200) || "Untitled";
}

/** Natural order by name, so "V2" comes before "V10". */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
export const byName = <T extends { name: string }>(files: readonly T[]): T[] =>
  [...files].sort((a, b) => collator.compare(a.name, b.name));

/**
 * One name for several files becoming one track: what their names share, cut at a word, with
 * version markers off ("Maple Leaf Rag - V1 mix", "Maple Leaf Rag - V2 mix" give "Maple Leaf
 * Rag"); the first file's name where they share nothing worth keeping.
 */
export function sharedTrackName(fileNames: readonly string[]): string {
  const names = fileNames.map((n) => tidy(stem(n)));
  const first = names[0] ?? "";
  if (names.length < 2) return trackNameFrom(fileNames[0] ?? "");
  let end = 0;
  while (
    end < first.length &&
    names.every((n) => n[end]?.toLowerCase() === first[end]?.toLowerCase())
  )
    end += 1;
  // Back to the last whole word, then off any version marker and separator left hanging.
  let prefix = first.slice(0, end);
  if (end < first.length && !/\s/.test(first[end] ?? "")) prefix = prefix.replace(/\S*$/, "");
  prefix = tidy(prefix.replace(/\b(v|ver|version|take|mix|edit)\s*$/i, ""));
  return (prefix.length >= 3 ? prefix : trackNameFrom(fileNames[0] ?? "")).slice(0, 200);
}

export interface PlanOptions {
  grouping: TrackGrouping;
  /** Names typed over the ones read from the files, by file key; "track" is the one track's. */
  names?: Record<string, string>;
  /** The track a new version goes to; without one, the version choice falls back to files. */
  track?: TargetTrack | null;
  /** The key of the variant that is primary; the first otherwise. */
  primary?: string | null;
}

const named = (names: Record<string, string> | undefined, key: string, fallback: string) => {
  const typed = names?.[key];
  return typed === undefined ? fallback : typed.trim() || fallback;
};

/** The plan for the audio files chosen, given the choice and the options beside it. */
export function planUpload(
  files: readonly PlannedFile[],
  choice: UploadChoice,
  options: PlanOptions,
): UploadPlan {
  if (files.length === 0 || choice === "file") return { kind: "files", count: files.length };
  if (choice === "version") {
    const track = options.track;
    if (!track) return { kind: "files", count: files.length };
    const primary = files.some((f) => f.key === options.primary) ? options.primary : files[0]?.key;
    return {
      kind: "version",
      track,
      number: track.versions + 1,
      variants: files.map((f) => ({
        key: f.key,
        name: named(options.names, f.key, variantNameFrom(f.name, track.name)),
        primary: f.key === primary,
      })),
    };
  }
  if (options.grouping === "one" && files.length > 1) {
    return {
      kind: "one-track",
      name: named(options.names, "track", sharedTrackName(files.map((f) => f.name))),
      versions: byName(files).map((f, i) => ({ key: f.key, number: i + 1 })),
    };
  }
  return {
    kind: "tracks",
    tracks: files.map((f) => ({
      key: f.key,
      name: named(options.names, f.key, trackNameFrom(f.name)),
    })),
  };
}

const files = (n: number) => (n === 1 ? "The file" : `${n} files`);

/**
 * One line on what will happen, before the button is pressed: "3 files become 3 tracks".
 * `folder` is the one the files land in, null at the top of the project; `others` is how many
 * files beside the audio go up as they are.
 */
export function describePlan(plan: UploadPlan, folder: string | null, others = 0): string {
  const into = folder ? `in ${folder}` : "at the top of the project";
  const where = folder ?? "the top of the project";
  const rest =
    others === 0
      ? ""
      : others === 1
        ? ", and the other file is uploaded as it is"
        : `, and the ${others} other files are uploaded as they are`;
  switch (plan.kind) {
    case "tracks": {
      const n = plan.tracks.length;
      return n === 1
        ? `The file becomes version 1 of a new track ${into}${rest}.`
        : `${n} files become ${n} tracks ${into}, each at version 1${rest}.`;
    }
    case "one-track": {
      const n = plan.versions.length;
      return `${n} files become versions 1 to ${n} of one track ${into}, in name order${rest}.`;
    }
    case "version": {
      const n = plan.variants.length;
      return n === 1
        ? `The file becomes version ${plan.number} of ${plan.track.name}${rest}.`
        : `${n} files become the variants of version ${plan.number} of ${plan.track.name}${rest}.`;
    }
    default:
      return plan.count === 0
        ? `Uploaded to ${where} as they are.`
        : `${files(plan.count)} ${plan.count === 1 ? "is" : "are"} uploaded to ${where} as ${plan.count === 1 ? "it is" : "they are"}.`;
  }
}

/** The primary action, named for the job: "Make 3 tracks", "Upload version 4", "Upload 3 files". */
export function actionFor(plan: UploadPlan, others = 0): string {
  switch (plan.kind) {
    case "tracks":
      return plan.tracks.length === 1 ? "Make a track" : `Make ${plan.tracks.length} tracks`;
    case "one-track":
      return "Make the track";
    case "version":
      return `Upload version ${plan.number}`;
    default: {
      const n = plan.count + others;
      return `Upload ${n} ${n === 1 ? "file" : "files"}`;
    }
  }
}

const CHOICE_KEY = (projectId: string) => `hekate:upload-as:${projectId}`;

/** The choice last made in this project, remembered in this browser. */
export function rememberedChoice(projectId: string): UploadChoice | null {
  try {
    const kept = localStorage.getItem(CHOICE_KEY(projectId));
    return kept === "track" || kept === "version" || kept === "file" ? kept : null;
  } catch {
    return null;
  }
}

export function rememberChoice(projectId: string, choice: UploadChoice) {
  try {
    localStorage.setItem(CHOICE_KEY(projectId), choice);
  } catch {
    // Private windows may refuse storage; the choice still holds for this dialog.
  }
}

/**
 * The choice the dialog opens with: the track the files were dropped on, else what was chosen
 * last time (where it is still on offer), else a new track for those who may make one, else a
 * new version where there is a track to take one, else a plain file.
 */
export function defaultChoice(input: {
  projectId: string;
  droppedOnTrack: boolean;
  mayMakeTracks: boolean;
  hasTracks: boolean;
}): UploadChoice {
  const offered = (c: UploadChoice) =>
    c === "file" || (c === "track" ? input.mayMakeTracks : input.hasTracks);
  if (input.droppedOnTrack && input.hasTracks) return "version";
  const kept = rememberedChoice(input.projectId);
  if (kept && offered(kept)) return kept;
  if (input.mayMakeTracks) return "track";
  if (input.hasTracks) return "version";
  return "file";
}
