import { timecodeOf } from "./metadata.ts";
import { type WaveHeader, waveSeconds } from "./wave.ts";

/**
 * Take import (#45): every file of a day's recording dropped at once, and the organisation
 * proposed from what the files say about themselves (Broadcast Wave's bext and iXML) and from
 * their names, for someone to confirm or correct before anything is made.
 *
 * - Files make takes by their take number (iXML's, or the name's), else by their timecode: a
 *   recorder writes one file per microphone over the same span, though one may start or stop a
 *   little apart from the others (`sameSpan`).
 * - A take's summed mix is the file named so, or the one stereo file among mono microphones.
 * - Takes make sessions by the day they were recorded, else the recorder's tape, else their folder.
 * - Takes go to tracks by name: the scene, the description or the folder against the project's
 *   track names. Matching by the audio itself is the media worker's, and comes later.
 */

/** A file chosen for the import, with its header read where it is a wave file. */
export interface ImportSource {
  /** Unique within the import. */
  key: string;
  name: string;
  /** The folder it was dropped in, relative to what was dropped ("Day 2/Recorder A"). */
  folder: string;
  size: number;
  header: WaveHeader | null;
}

export interface ImportTrack {
  id: string;
  name: string;
}

export interface ImportSession {
  id: string;
  name: string;
  recordedOn: string | null;
}

export interface ImportFile {
  key: string;
  name: string;
  /** The microphone it holds, as iXML or the name gives it. */
  microphone: string | null;
  channels: number | null;
  size: number;
}

export interface ProposedTake {
  key: string;
  /** The take number as written ("27", "12A"), where one is known. */
  take: string | null;
  scene: string | null;
  label: string;
  /** Its start as timecode ("10:14:02:00"), and in seconds since midnight. */
  timecode: string | null;
  start: number | null;
  /** Seconds. */
  length: number | null;
  files: ImportFile[];
  /** The key of its summed mix: the file the take is heard by. */
  mix: string | null;
  trackId: string | null;
  /** How sure the track is, 0 to 1; 1 once someone chose it. */
  confidence: number;
  chosen: boolean;
  leftOut: boolean;
  /** Made already, in its session from the same file: an import carried on after a break. */
  imported: boolean;
}

export interface ProposedSession {
  key: string;
  name: string;
  recordedOn: string | null;
  /** The project's session it adds to, recorded the same day; null for a new one. */
  sessionId: string | null;
  takes: ProposedTake[];
}

export interface UnplacedFile {
  key: string;
  name: string;
  reason: string;
}

export interface ImportProposal {
  sessions: ProposedSession[];
  unplaced: UnplacedFile[];
}

/** What a file-name pattern can name. */
export const NAME_TOKENS = ["take", "mic", "tc", "scene", "session", "track"] as const;

const tokenPatterns: Record<(typeof NAME_TOKENS)[number], string> = {
  take: "(?<take>\\d+[A-Za-z]?)",
  mic: "(?<mic>.+?)",
  tc: "(?<tc>\\d{2}[:._-]?\\d{2}[:._-]?\\d{2}(?:[:._-]?\\d{2})?)",
  scene: "(?<scene>.+?)",
  session: "(?<session>.+?)",
  track: "(?<track>.+?)",
};

const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A file-name pattern ("T{take} {mic}.wav") as a pattern to match names against: spaces,
 * underscores and hyphens match one another, `*` anything, and case is ignored. Null when it
 * names something unknown, names a thing twice, or names nothing.
 */
export function compileNamePattern(pattern: string): RegExp | null {
  const trimmed = pattern.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\{([^{}]*)\}/);
  const seen = new Set<string>();
  let source = "";
  for (const [i, part] of parts.entries()) {
    if (i % 2 === 1) {
      const token = part.trim().toLowerCase();
      if (!(NAME_TOKENS as readonly string[]).includes(token) || seen.has(token)) return null;
      seen.add(token);
      source += tokenPatterns[token as (typeof NAME_TOKENS)[number]];
    } else {
      source += part
        .split(/([ _-]+|\*)/)
        .map((piece) =>
          piece === "*" ? ".*?" : /^[ _-]+$/.test(piece) ? "[ _-]+" : escapePattern(piece),
        )
        .join("");
    }
  }
  if (seen.size === 0) return null;
  // A pattern without the extension still matches names with one.
  const last = parts[parts.length - 1] ?? "";
  if (!/\.[A-Za-z0-9]+$/.test(last)) source += "(?:\\.[^.]+)?";
  return new RegExp(`^${source}$`, "i");
}

/** Extensions of the recordings an import takes. */
const RECORDINGS = /\.(wav|wave|bwf|rf64|w64|aif|aiff|flac|mp3|m4a|ogg|opus)$/i;

/** "2026:10:14", "2026/10/14" or "2026-10-14" as an ISO date, where it is one. */
export function isoDay(written: string | undefined): string | null {
  const match = written?.trim().match(/^(\d{4})[-:/.](\d{2})[-:/.](\d{2})$/);
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(`${y}-${m}-${d}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== `${y}-${m}-${d}`
    ? null
    : `${y}-${m}-${d}`;
}

/** "101402" or "10:14:02:00" as seconds since midnight; frames are left out. */
function clockSeconds(tc: string): number | null {
  const digits = tc.replace(/\D/g, "");
  if (digits.length < 6) return null;
  const [h, m, s] = [0, 2, 4].map((i) => Number(digits.slice(i, i + 2)));
  if (h === undefined || m === undefined || s === undefined || h > 23 || m > 59 || s > 59)
    return null;
  return h * 3600 + m * 60 + s;
}

const MIX = /(^|[^a-z0-9])(mix|mixdown|2mix|sum|summed|lr|stereo)([^a-z0-9]|$)/i;

const stopWords = new Set(["the", "a", "an", "of", "in", "and", "op", "no", "take", "t"]);

/** Lower case, without accents or punctuation, words single-spaced. */
const plain = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * How alike a name a file gives is to a track's name, 0 to 1: the same, one holding the other
 * word for word, or the share of words they have in common.
 */
export function nameLikeness(given: string, track: string): number {
  const a = plain(given);
  const b = plain(track);
  if (!a || !b) return 0;
  if (a === b) return 1;
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  if (short.length >= 4 && ` ${long} `.includes(` ${short} `)) return 0.9;
  const words = (s: string) => new Set(s.split(" ").filter((w) => !stopWords.has(w)));
  const x = words(a);
  const y = words(b);
  if (x.size === 0 || y.size === 0) return 0;
  const shared = [...x].filter((w) => y.has(w)).length;
  return Math.round(((2 * shared) / (x.size + y.size)) * 0.85 * 100) / 100;
}

/** The least likeness for a track to be proposed. */
export const TRACK_LIKENESS = 0.5;

/** What follows the take number in a file's name ("T27_Mix.wav" is Mix), else its name. */
function microphoneInName(name: string, take: string | null): string {
  const stem = name.replace(/\.[^.]+$/, "");
  if (!take) return stem;
  const found = new RegExp(`(?:^|[^a-z0-9])t?${escapePattern(take)}[ _-]+(.+)$`, "i").exec(stem);
  return found?.[1]?.trim() || stem;
}

interface Facts {
  source: ImportSource;
  take: string | null;
  scene: string | null;
  microphone: string | null;
  day: string | null;
  tape: string | null;
  sessionName: string | null;
  start: number | null;
  timecode: string | null;
  length: number | null;
  /** Names to match against the tracks'. */
  names: string[];
}

function factsOf(source: ImportSource, pattern: RegExp | null): Facts {
  const { header } = source;
  const groups = pattern?.exec(source.name)?.groups ?? {};
  const ixml = header?.ixml;
  const bext = header?.bext;
  const clean = (value: string | undefined) => value?.trim() || null;
  const take = clean(ixml?.take) ?? clean(groups.take);
  const microphones = header?.microphones ?? [];
  const sampleRate = header?.sampleRate;
  let start: number | null = null;
  let timecode: string | null = null;
  if (bext?.timeReference !== undefined && sampleRate) {
    start = bext.timeReference / sampleRate;
    timecode = timecodeOf(bext.timeReference, sampleRate, ixml?.timecodeRate);
  } else if (groups.tc) {
    start = clockSeconds(groups.tc);
    timecode = groups.tc;
  }
  const folders = source.folder.split("/").filter(Boolean);
  return {
    source,
    take,
    scene: clean(ixml?.scene) ?? clean(groups.scene),
    microphone:
      clean(groups.mic) ??
      (microphones.length === 1 ? clean(microphones[0]) : null) ??
      microphoneInName(source.name, take),
    day: isoDay(bext?.originationDate),
    tape: clean(ixml?.tape),
    sessionName: clean(groups.session),
    start,
    timecode,
    length: header ? waveSeconds(header) : null,
    names: [
      groups.track,
      ixml?.scene,
      groups.scene,
      bext?.description,
      ixml?.project,
      ...folders.slice().reverse(),
    ].filter((n): n is string => Boolean(n?.trim())),
  };
}

/** The summed mix among a take's files, where one stands out. */
export function mixOf(files: ImportFile[]): string | null {
  if (files.length === 1) return files[0]?.key ?? null;
  const named = files.filter((f) => MIX.test(f.microphone ?? "") || MIX.test(f.name));
  if (named.length === 1) return named[0]?.key ?? null;
  const wide = files.filter((f) => (f.channels ?? 1) > 1);
  if (wide.length === 1 && files.every((f) => f === wide[0] || f.channels === 1))
    return wide[0]?.key ?? null;
  return null;
}

/** The track most like the names a take's files give, and how alike. */
function trackFor(names: string[], tracks: ImportTrack[]): { id: string; likeness: number } | null {
  let best: { id: string; likeness: number } | null = null;
  for (const track of tracks)
    for (const name of names) {
      const likeness = nameLikeness(name, track.name);
      if (!best || likeness > best.likeness) best = { id: track.id, likeness };
    }
  if (best && best.likeness >= TRACK_LIKENESS) return best;
  // A project of one track has nowhere else for a take to go.
  const [only] = tracks;
  return tracks.length === 1 && only ? { id: only.id, likeness: TRACK_LIKENESS } : null;
}

const byNumber = (a: string | null, b: string | null) =>
  (a ?? "").localeCompare(b ?? "", undefined, { numeric: true });

/**
 * The proposed organisation of the files chosen: sessions holding takes, each take its files
 * with its mix and track, and what could not be placed, with why.
 */
/**
 * Whether two files without take numbers are the same take by their timecode: starting within a
 * second of each other, or, where both lengths are known, recording together for at least half
 * of the shorter one. Takes recorded one after another share at most a moment, so stay apart.
 */
export function sameSpan(
  a: { start: number | null; length: number | null },
  b: { start: number | null; length: number | null },
): boolean {
  if (a.start === null || b.start === null) return false;
  if (Math.abs(a.start - b.start) <= 1) return true;
  if (!a.length || !b.length) return false;
  const together = Math.min(a.start + a.length, b.start + b.length) - Math.max(a.start, b.start);
  return together >= Math.min(a.length, b.length) / 2;
}

export function proposeTakeImport(
  sources: ImportSource[],
  options: {
    pattern?: string;
    tracks: ImportTrack[];
    sessions?: ImportSession[];
    /** A new session's name for the day it was recorded ("14 October 2026"). */
    dayName?: (day: string) => string;
  },
): ImportProposal {
  const pattern = options.pattern ? compileNamePattern(options.pattern) : null;
  const unplaced: UnplacedFile[] = [];
  /** Sessions by key, each with its takes by key. */
  const grouped = new Map<string, { facts: Facts[]; takes: Map<string, Facts[]> }>();
  for (const source of sources) {
    if (!RECORDINGS.test(source.name)) {
      unplaced.push({ key: source.key, name: source.name, reason: "is not a recording" });
      continue;
    }
    const facts = factsOf(source, pattern);
    const session =
      (facts.sessionName && `name:${facts.sessionName}`) ??
      (facts.day && `day:${facts.day}`) ??
      (facts.tape && `tape:${facts.tape}`) ??
      `folder:${source.folder}`;
    const group = grouped.get(session) ?? { facts: [] as Facts[], takes: new Map() };
    grouped.set(session, group);
    group.facts.push(facts);
  }

  const sessions: ProposedSession[] = [];
  for (const [key, group] of grouped) {
    // Numbered takes first; the rest join a take they were recorded with (`sameSpan`).
    const loose: Facts[] = [];
    for (const facts of group.facts) {
      if (facts.take === null) {
        loose.push(facts);
        continue;
      }
      const take = `take:${facts.scene ?? ""}|${facts.take}`;
      group.takes.set(take, [...(group.takes.get(take) ?? []), facts]);
    }
    for (const facts of loose.sort((a, b) => (a.start ?? 0) - (b.start ?? 0))) {
      const start = facts.start;
      if (start === null) {
        unplaced.push({
          key: facts.source.key,
          name: facts.source.name,
          reason: "has no take number or timecode",
        });
        continue;
      }
      const near = [...group.takes.entries()].find(([, files]) =>
        files.some((f) => sameSpan(f, facts)),
      );
      const take = near?.[0] ?? `tc:${start}`;
      group.takes.set(take, [...(group.takes.get(take) ?? []), facts]);
    }
    if (group.takes.size === 0) continue;

    const first = group.facts[0];
    const day = group.facts.find((f) => f.day)?.day ?? null;
    const leaf = first?.source.folder.split("/").filter(Boolean).pop() ?? null;
    const named =
      first?.sessionName ??
      (key.startsWith("folder:") ? leaf : null) ??
      (day ? (options.dayName?.(day) ?? day) : null) ??
      first?.tape ??
      leaf ??
      "Imported takes";
    // The project's session it adds to: the one recorded that day, or, for files that give no
    // day, the one of the same name (as an earlier import of them named it).
    const existing = (options.sessions ?? []).filter((s) =>
      day === null ? plain(s.name) === plain(named) : s.recordedOn === day,
    );
    const name = existing.length === 1 ? (existing[0]?.name ?? named) : named;

    const takes: ProposedTake[] = [...group.takes.entries()].map(([takeKey, list]) => {
      const head = list.find((f) => f.start !== null) ?? list[0];
      const files: ImportFile[] = list
        .map((f) => ({
          key: f.source.key,
          name: f.source.name,
          microphone: f.microphone,
          channels: f.source.header?.channels ?? null,
          size: f.source.size,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      const track = trackFor(
        list.flatMap((f) => f.names),
        options.tracks,
      );
      const take = head?.take ?? null;
      const scene = head?.scene ?? null;
      const number = take && /^\d/.test(take) ? `T${take}` : take;
      return {
        key: `${key}/${takeKey}`,
        take,
        scene,
        label: number
          ? scene &&
            plain(scene) !== plain(options.tracks.find((t) => t.id === track?.id)?.name ?? "")
            ? `${scene} ${number}`
            : number
          : `Take at ${head?.timecode ?? "?"}`,
        timecode: head?.timecode ?? null,
        start: head?.start ?? null,
        length: Math.max(0, ...list.map((f) => f.length ?? 0)) || null,
        files,
        mix: mixOf(files),
        trackId: track?.id ?? null,
        confidence: track?.likeness ?? 0,
        chosen: false,
        leftOut: false,
        imported: false,
      };
    });
    takes.sort((a, b) => (a.start ?? 0) - (b.start ?? 0) || byNumber(a.take, b.take));
    sessions.push({
      key,
      name,
      recordedOn: day,
      sessionId: existing.length === 1 ? (existing[0]?.id ?? null) : null,
      takes,
    });
  }
  sessions.sort(
    (a, b) =>
      (a.recordedOn ?? "9999").localeCompare(b.recordedOn ?? "9999") ||
      a.name.localeCompare(b.name, undefined, { numeric: true }),
  );
  return { sessions, unplaced };
}

const eachTake = (
  proposal: ImportProposal,
  keys: ReadonlySet<string>,
  change: (take: ProposedTake) => ProposedTake,
): ImportProposal => ({
  ...proposal,
  sessions: proposal.sessions.map((s) => ({
    ...s,
    takes: s.takes.map((t) => (keys.has(t.key) ? change(t) : t)),
  })),
});

/** The takes given placed on a track, as chosen; null leaves them unplaced. */
export const placeTakes = (p: ImportProposal, keys: ReadonlySet<string>, trackId: string | null) =>
  eachTake(p, keys, (t) => ({ ...t, trackId, confidence: trackId ? 1 : 0, chosen: true }));

/** The takes given left out of the import, or brought back. */
export const leaveOut = (p: ImportProposal, keys: ReadonlySet<string>, leftOut: boolean) =>
  eachTake(p, keys, (t) => ({ ...t, leftOut }));

/** A take heard by another of its files. */
export const chooseMix = (p: ImportProposal, take: string, mix: string) =>
  eachTake(p, new Set([take]), (t) => (t.files.some((f) => f.key === mix) ? { ...t, mix } : t));

/** A session named otherwise. */
export const renameSession = (p: ImportProposal, key: string, name: string): ImportProposal => ({
  ...p,
  sessions: p.sessions.map((s) => (s.key === key ? { ...s, name } : s)),
});

/**
 * The takes made already: those whose mix is the file a take of their session was made from
 * (`made` holds "session id/file name"), so importing a day again skips what came in before.
 */
export function markImported(p: ImportProposal, made: ReadonlySet<string>): ImportProposal {
  return {
    ...p,
    sessions: p.sessions.map((s) => ({
      ...s,
      takes: s.takes.map((t) => {
        const mix = t.files.find((f) => f.key === t.mix)?.name;
        const imported = Boolean(s.sessionId && mix && made.has(`${s.sessionId}/${mix}`));
        return imported === t.imported ? t : { ...t, imported };
      }),
    })),
  };
}

/** Why a take will not be imported as it stands, or null when it will. */
export function takeHeld(take: ProposedTake): string | null {
  if (take.imported) return "Already imported";
  if (take.leftOut) return "Left out";
  if (!take.trackId) return "Choose a track";
  if (!take.mix) return "Choose its mix";
  return null;
}

/** The takes that will be imported, session by session; sessions with none are left out. */
export function importable(p: ImportProposal): ProposedSession[] {
  return p.sessions
    .map((s) => ({ ...s, takes: s.takes.filter((t) => takeHeld(t) === null) }))
    .filter((s) => s.takes.length > 0);
}
