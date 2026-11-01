import { variantNameFrom } from "@hekate/shared";

/**
 * What audio uploaded into a music project becomes (#485): a new track (version 1 of a track
 * named from the file), a new version of a track that exists, or a plain file. Several files
 * at once can be one track each, or one track with a version per file in name order. The
 * plan is worked out here, pure, from the files chosen and the choices made; the dialog
 * draws it and carries it out with the routes that exist.
 */

export type UploadChoice = "track" | "version" | "file";
/**
 * Several files under New track: a track each, one track for the files that name the same
 * track (its versions, #631), or one track with a version per file.
 */
export type TrackGrouping = "each" | "name" | "one";

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
  /** A track for each name the files give, the files that share it its versions in order. */
  | {
      kind: "by-name";
      tracks: { key: string; name: string; versions: { key: string; number: number }[] }[];
    }
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

/** A version marker in a file's name: V1, v2, ver 3, version 4. */
const VERSION = /(?:^|[\s([])(?:v|ver|version)\s*(\d+)\b/i;
/** Words that say how a file was mixed or which go it was, not what the piece is. */
const TREATMENT =
  /(?:\s+[-–:]?\s*|^)(?:(?:dry|wet|rough|stereo|mono|main|full|alt|new|old)\s+)?(?:mix|mixdown|master|bounce|print|edit|final|take\s*\d*)\s*$/i;
/** A number at the end, unless it is a catalogue or part number ("No 5", "Op 10", "Reel 2"). */
const TRAILING_NUMBER =
  /(?<!\d)(?<!\b(?:no|nr|op|opus|bwv|k|kv|hob|rv|hwv|wwv|part|act|scene|reel|cue|track|book)\.?\s*[-–:]?\s*\(?)\s*[-–:]?\s*\(?\d+\)?\s*$/i;

/**
 * A track's name from a file's (#631): the extension off, the separators tidied, and what
 * says which version or mix it is taken away, so "Pine Apple Rag - V1 mix.wav" and "Pine
 * Apple Rag - V2 mix.wav" both name "Pine Apple Rag". A marker cuts the name where it stands;
 * treatment words ("mix", "final", "dry mix") and plain trailing numbers come off the end. At
 * most 200 characters; where nothing would be left, the name as it was.
 */
export function trackNameFrom(fileName: string): string {
  const whole = tidy(stem(fileName));
  const marker = VERSION.exec(whole);
  let name = marker ? whole.slice(0, marker.index) : whole;
  for (let before = ""; before !== name; ) {
    before = name;
    name = tidy(name.replace(TREATMENT, "").replace(TRAILING_NUMBER, ""));
  }
  return (name.length >= 2 ? name : whole).slice(0, 200) || "Untitled";
}

/** The version a file's name says it is ("Rag - V2 mix.wav" is 2), or null where it says none. */
export function versionNumberFrom(fileName: string): number | null {
  const found = VERSION.exec(tidy(stem(fileName)));
  return found ? Number(found[1]) : null;
}

/** The files grouped by the track their names give, each group in version order, in name order. */
export function byTrackName<T extends { name: string }>(
  files: readonly T[],
): { name: string; files: T[] }[] {
  const groups = new Map<string, { name: string; files: T[] }>();
  for (const f of byName(files)) {
    const name = trackNameFrom(f.name);
    const id = name.toLowerCase();
    const group = groups.get(id) ?? { name, files: [] };
    group.files.push(f);
    groups.set(id, group);
  }
  return [...groups.values()].map((g) => ({ ...g, files: inVersionOrder(g.files) }));
}

/**
 * How several files go into tracks unless someone chooses: one track with a version each
 * where every file names the same track ("Rag - V1.wav", "Rag - V2.wav"), a track for each
 * name where some share one, else a track each.
 */
export function defaultGrouping(fileNames: readonly string[]): TrackGrouping {
  if (fileNames.length < 2) return "each";
  const names = new Set(fileNames.map((n) => trackNameFrom(n).toLowerCase()));
  return names.size === 1 ? "one" : names.size < fileNames.length ? "name" : "each";
}

/**
 * Files becoming one track's versions, in order: by the version each name gives where every
 * one gives a different one, else naturally by name, so "V2" comes before "V10" either way.
 */
export function inVersionOrder<T extends { name: string }>(files: readonly T[]): T[] {
  const numbers = files.map((f) => versionNumberFrom(f.name));
  const all = numbers.every((n) => n !== null) && new Set(numbers).size === numbers.length;
  if (!all) return byName(files);
  return files
    .map((f, i) => ({ f, n: numbers[i] ?? 0 }))
    .sort((a, b) => a.n - b.n)
    .map(({ f }) => f);
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
  prefix = trackNameFrom(prefix.replace(/\b(v|ver|version|take|mix|edit)\s*$/i, ""));
  return (
    prefix.length >= 3 && prefix !== "Untitled" ? prefix : trackNameFrom(fileNames[0] ?? "")
  ).slice(0, 200);
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
  if (options.grouping === "name" && files.length > 1) {
    return {
      kind: "by-name",
      tracks: byTrackName(files).map((g) => {
        // A group is known by its first file, so a name typed over it stays with it.
        const key = g.files[0]?.key ?? g.name;
        return {
          key,
          name: named(options.names, key, g.name),
          versions: g.files.map((f, i) => ({ key: f.key, number: i + 1 })),
        };
      }),
    };
  }
  if (options.grouping === "one" && files.length > 1) {
    return {
      kind: "one-track",
      name: named(options.names, "track", sharedTrackName(files.map((f) => f.name))),
      versions: inVersionOrder(files).map((f, i) => ({ key: f.key, number: i + 1 })),
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
      return `${n} files become versions 1 to ${n} of one track ${into}, in order${rest}.`;
    }
    case "by-name": {
      const n = plan.tracks.reduce((sum, t) => sum + t.versions.length, 0);
      const k = plan.tracks.length;
      return `${n} files become ${k === 1 ? "one track" : `${k} tracks`} ${into}, the files that name the same track its versions${rest}.`;
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
    case "by-name":
      return plan.tracks.length === 1 ? "Make the track" : `Make ${plan.tracks.length} tracks`;
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
