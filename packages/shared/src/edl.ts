import { z } from "zod";

/**
 * Edit decision lists (#56): how a version was cut from the takes. A CMX 3600 list, which
 * every editor and DAW writes, is read event by event; each event's source is matched to a
 * take of the track by its clip or reel name, and placed in the take by the take's own
 * timecode, so "which take is used at bar 72" can be answered from the list.
 */

/** One edit: a stretch of a source, laid on the version's timeline. */
export interface EdlEvent {
  number: number;
  /** The source as the list names it: a reel, often the file's name cut to eight characters. */
  reel: string;
  /** Which tracks it fills: "A", "A2", "AA", "V", "AA/V"… */
  track: string;
  /** C (cut), D (dissolve), W001 (wipe), K (key). */
  transition: string;
  /** In seconds of the source's timecode. */
  sourceIn: number;
  sourceOut: number;
  /** In seconds from the start of the version's timeline. */
  recordIn: number;
  recordOut: number;
  /** The full name of the clip, where the list gives it ("* FROM CLIP NAME:"). */
  clipName: string | null;
}

export interface Edl {
  title: string | null;
  /** The timecode rate the list was read at, and whether it was told rather than worked out. */
  fps: number;
  fpsGuessed: boolean;
  dropFrame: boolean;
  /** Where the version's timeline starts, as timecode in seconds (often 01:00:00:00). */
  recordStart: number;
  events: EdlEvent[];
}

/** The timecode rates a list is read at; 29.97 is drop frame. */
export const edlRates = [24, 25, 30, 29.97] as const;
export type EdlRate = (typeof edlRates)[number];

const TIMECODE = /^(\d{2}):(\d{2}):(\d{2})([:;.])(\d{2})$/;

/**
 * A timecode in seconds at a rate: whole frames at 24, 25 or 30, and 29.97 drop frame, which
 * skips two frame numbers each minute but every tenth. Null for anything that is not one.
 */
export function timecodeSeconds(timecode: string, fps: number): number | null {
  const m = TIMECODE.exec(timecode.trim());
  if (!m) return null;
  const [h, min, s, f] = [m[1], m[2], m[3], m[5]].map(Number) as [number, number, number, number];
  if (min > 59 || s > 59) return null;
  if (fps === 29.97) {
    if (f > 29) return null;
    const minutes = h * 60 + min;
    const frames = (h * 3600 + min * 60 + s) * 30 + f - 2 * (minutes - Math.floor(minutes / 10));
    return (frames * 1001) / 30_000;
  }
  if (f >= fps) return null;
  return h * 3600 + min * 60 + s + f / fps;
}

/** A timecode as a list writes it, with ";" or "." before the frames in drop frame. */
const isTimecode = (token: string) => TIMECODE.test(token);

/**
 * An event line, read word by word: its number, reel, tracks, a transition (C, D, W001, K,
 * KO or K B, with a duration after any but a cut) and the four timecodes it ends with.
 */
function eventOf(line: string): Omit<RawEvent, "clipName"> | null {
  const words = line.split(/\s+/);
  if (words.length < 8 || words.length > 10) return null;
  const [number, reel, track] = words;
  if (!number || !reel || !track || !/^\d{1,6}$/.test(number)) return null;
  const codes = words.slice(-4);
  if (!codes.every(isTimecode)) return null;
  const middle = words.slice(3, -4);
  // A duration in frames follows a dissolve, wipe or key.
  if (middle.length > 1 && /^\d{1,3}$/.test(middle.at(-1) ?? "")) middle.pop();
  const transition = middle.join(" ");
  if (!/^(C|D|W\d{3}|K|KO|K B)$/.test(transition)) return null;
  return { number: Number(number), reel, track, transition, codes: codes as RawEvent["codes"] };
}

/** What follows a label such as "TITLE:" at the start of a line, case aside; null if another. */
function after(line: string, label: string): string | null {
  return line.slice(0, label.length).toUpperCase() === label
    ? line.slice(label.length).trim()
    : null;
}

/** Each event line as written, before its timecodes are read at a rate. */
interface RawEvent {
  number: number;
  reel: string;
  track: string;
  transition: string;
  codes: [string, string, string, string];
  clipName: string | null;
}

/**
 * The rate a list's timecodes must have been written at, where it does not say: the lowest
 * that every frame number fits under (a frame 27 rules out 25). A list whose frames never
 * reach 24 could be any rate, and is read at 25 until someone says otherwise.
 */
function guessRate(raw: RawEvent[]): number {
  let highest = 0;
  for (const event of raw)
    for (const code of event.codes) highest = Math.max(highest, Number(code.slice(-2)));
  return highest >= 25 ? 30 : 25;
}

/**
 * Reads a CMX 3600 list, as editors and DAWs export it: the title, the frame count mode,
 * each event (number, reel, track, transition, source and record timecodes) and the clip
 * names noted under them. Lines it does not know (motion effects, other notes) are passed
 * over; events of no length (the cut that opens a dissolve) are left out. The timecode rate
 * is the one given, or 29.97 for a drop frame list, or worked out from the frame numbers.
 */
export function parseCmx3600(text: string, rate?: EdlRate): Edl {
  let title: string | null = null;
  let dropFrame = false;
  const raw: RawEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const titled = after(trimmed, "TITLE:");
    if (titled !== null) {
      title = titled || null;
      continue;
    }
    const mode = after(trimmed, "FCM:");
    if (mode !== null) {
      dropFrame = mode.toUpperCase().startsWith("DROP");
      continue;
    }
    if (trimmed.startsWith("*")) {
      // A note on the event above it: "* FROM CLIP NAME: Take 12.wav".
      const note = trimmed.slice(1);
      const colon = note.indexOf(":");
      const label = note.slice(0, Math.max(0, colon)).trim().split(/\s+/).join(" ").toUpperCase();
      const name = note.slice(colon + 1).trim();
      const last = raw.at(-1);
      if ((label === "FROM CLIP NAME" || label === "SOURCE FILE") && name && last && !last.clipName)
        last.clipName = name;
      continue;
    }
    const event = eventOf(trimmed);
    if (!event) continue;
    if (event.codes.some((c) => c.includes(";"))) dropFrame = true;
    raw.push({ ...event, clipName: null });
  }
  // Drop frame exists only at 29.97, whatever rate is asked for.
  const fps = dropFrame ? 29.97 : (rate ?? guessRate(raw));
  const events: EdlEvent[] = [];
  for (const r of raw) {
    const [sourceIn, sourceOut, recordIn, recordOut] = r.codes.map((c) => timecodeSeconds(c, fps));
    if (sourceIn == null || sourceOut == null || recordIn == null || recordOut == null) continue;
    if (recordOut <= recordIn || sourceOut <= sourceIn) continue;
    events.push({
      number: r.number,
      reel: r.reel,
      track: r.track,
      transition: r.transition,
      sourceIn,
      sourceOut,
      recordIn,
      recordOut,
      clipName: r.clipName,
    });
  }
  // A timeline starts on an hour, most often 01:00:00:00 or 00:00:00:00.
  const first = Math.min(...events.map((e) => e.recordIn));
  const recordStart = events.length > 0 ? Math.floor(first / 3600) * 3600 : 0;
  for (const e of events) {
    e.recordIn -= recordStart;
    e.recordOut -= recordStart;
  }
  return {
    title,
    fps,
    fpsGuessed: rate === undefined && !dropFrame,
    dropFrame,
    recordStart,
    events,
  };
}

/** A take as an edit decision list is matched against. */
export interface EdlTake {
  id: string;
  number: number;
  label: string | null;
  /** The take's file name, as it was uploaded. */
  fileName: string;
  /** The file's own timecode at its first sample, in seconds (Broadcast Wave's time reference). */
  start: number | null;
  duration: number | null;
  inPoint: number | null;
  outPoint: number | null;
  barFrom: number | null;
  barTo: number | null;
}

/** An event of the list matched to a take, or not. */
export interface EdlUse {
  event: EdlEvent;
  takeId: string | null;
  /** Where in the take the event starts and ends, in seconds, where that can be told. */
  from: number | null;
  to: number | null;
  /** The bars of the take it uses, worked out from the take's bars and in and out points. */
  bars: [number, number] | null;
}

/** Sources that are no take: black, and the auxiliary inputs. */
const NOT_A_TAKE = /^(BL|BLK|BLACK|AX|AUX)$/i;

/** A name compared as people mean it: no extension, no case, no spaces or punctuation. */
const stem = (name: string) =>
  name
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

/** "T12", "TK_12", "Take 12" as a take number. */
function takeNumber(name: string): number | null {
  const m = /^(?:t|tk|take)[\s_-]*(\d{1,6})$/i.exec(name.trim().replace(/\.[a-z0-9]{2,5}$/i, ""));
  return m ? Number(m[1]) : null;
}

/** The take an event's source is: by clip name, by reel, then by take number. */
function takeFor(event: EdlEvent, takes: EdlTake[]): EdlTake | null {
  const names = [event.clipName, event.reel].filter((n): n is string => Boolean(n));
  for (const name of names) {
    const wanted = stem(name);
    if (!wanted) continue;
    const exact = takes.filter(
      (t) => stem(t.fileName) === wanted || (t.label && stem(t.label) === wanted),
    );
    if (exact.length === 1) return exact[0] ?? null;
  }
  // A reel is the file's name cut short, at eight characters in a strict list.
  const reel = stem(event.reel);
  if (reel.length >= 6) {
    const cut = takes.filter((t) => stem(t.fileName).startsWith(reel));
    if (cut.length === 1) return cut[0] ?? null;
  }
  for (const name of names) {
    const n = takeNumber(name);
    if (n !== null) return takes.find((t) => t.number === n) ?? null;
  }
  return null;
}

/**
 * The bars a stretch of a take covers, where the take has bars: its bars spread evenly over
 * the part that counts (its in to out points, or the whole file), as near as that can say.
 */
export function barsUsed(take: EdlTake, from: number, to: number): [number, number] | null {
  const { barFrom, barTo } = take;
  if (barFrom === null || barTo === null) return null;
  const start = take.inPoint ?? 0;
  const end = take.outPoint ?? take.duration;
  if (end === null || end <= start) return null;
  if (to <= start || from >= end) return null;
  const count = barTo - barFrom + 1;
  const at = (t: number) =>
    barFrom + ((Math.min(end, Math.max(start, t)) - start) / (end - start)) * count;
  const first = Math.floor(at(from));
  const last = Math.max(first, Math.ceil(at(to)) - 1);
  return [Math.min(first, barTo), Math.min(last, barTo)];
}

/**
 * Each event of a list matched to the track's takes and placed in them: the take's own
 * timecode is where its file starts, so the event's source timecode less that is where in
 * the take it begins. A take with no timecode is taken to start at zero, and a place that
 * falls outside the file is left unknown rather than guessed. Black and auxiliary sources
 * are left out.
 */
export function matchEdl(edl: Edl, takes: EdlTake[]): EdlUse[] {
  return edl.events
    .filter((event) => !NOT_A_TAKE.test(event.reel))
    .map((event) => {
      const take = takeFor(event, takes);
      if (!take) return { event, takeId: null, from: null, to: null, bars: null };
      const from = event.sourceIn - (take.start ?? 0);
      const to = event.sourceOut - (take.start ?? 0);
      // Half a second's grace either side, for lists rounded to the frame.
      const fits = from >= -0.5 && (take.duration === null || to <= take.duration + 0.5);
      return {
        event,
        takeId: take.id,
        from: fits ? Math.max(0, from) : null,
        to: fits ? to : null,
        bars: fits ? barsUsed(take, Math.max(0, from), to) : null,
      };
    });
}

/** A track's edit decisions as the takes view shows them: from one version's list. */
export interface EditDecisions {
  version: { id: string; number: number };
  /** The list's file name, as it was uploaded. */
  fileName: string;
  title: string | null;
  fps: number;
  fpsGuessed: boolean;
  dropFrame: boolean;
  uses: EdlUse[];
}

/** Which version's list to read, and at what timecode rate, where the list leaves it unsure. */
export const editDecisionsQuery = z.object({
  version: z.uuid().optional(),
  rate: z.coerce
    .number()
    .refine(
      (r): r is EdlRate => (edlRates as readonly number[]).includes(r),
      "A rate the list may use",
    )
    .optional(),
});

/** A file's own timecode at its first sample, in seconds, from its Broadcast Wave time reference. */
export function fileStart(
  metadata: { bext?: { timeReference?: number } } | undefined,
  sampleRate: number | undefined,
): number | null {
  const reference = metadata?.bext?.timeReference;
  return reference !== undefined && sampleRate ? reference / sampleRate : null;
}
