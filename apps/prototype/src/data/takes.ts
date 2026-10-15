import type { Session, Take } from "./types.ts";

const mics = ["Main L", "Main R", "Spot L", "Spot R", "Room L", "Room R"];

const take = (
  number: number,
  sessionId: string,
  trackId: string | null,
  rating: Take["rating"],
  notes: string,
  coverage: Take["coverage"],
  extra: Partial<Take> = {},
): Take => ({
  id: `take-${number}`,
  sessionId,
  number,
  trackId,
  rating,
  starred: false,
  falseStarts: 0,
  notes,
  lifecycle: "recorded",
  duration: 20 + ((number * 7) % 60),
  coverage,
  timecodeIn: `10:${String(12 + number).padStart(2, "0")}:${String((number * 13) % 60).padStart(2, "0")}:00`,
  timecodeOut: `10:${String(13 + number).padStart(2, "0")}:${String((number * 17) % 60).padStart(2, "0")}:12`,
  files: [...mics.map((m) => ({ name: `T${number} ${m}.wav`, channel: m })), { name: `T${number} Mix.wav`, channel: "Mix" }],
  seed: 100 + number,
  ...extra,
});

export const sessions: Session[] = [
  { id: "sess-1", projectId: "proj-joplin", name: "Day 1", date: "2026-09-12", venue: "St John's", takeIds: Array.from({ length: 14 }, (_, i) => `take-${i + 1}`) },
  { id: "sess-2", projectId: "proj-joplin", name: "Day 2", date: "2026-09-13", venue: "St John's", takeIds: Array.from({ length: 12 }, (_, i) => `take-${i + 15}`) },
];

export const takes: Take[] = [
  take(1, "sess-1", "t-maple", 2, "Warm-up run. Tempo settles after the repeat.", { page: 1, barFrom: 1, barTo: 32 }, { falseStarts: 1 }),
  take(2, "sess-1", "t-maple", 3, "", { page: 1, barFrom: 1, barTo: 16 }),
  take(3, "sess-1", "t-maple", 4, "Good opening, pedal noise at bar 5.", { page: 1, barFrom: 1, barTo: 16 }, { starred: true, usedIn: [{ versionNumber: 1, barFrom: 1, barTo: 16 }, { versionNumber: 2, barFrom: 1, barTo: 16 }] }),
  take(4, "sess-1", "t-maple", 1, "Memory slip at 12.", { page: 1, barFrom: 9, barTo: 16 }, { falseStarts: 2 }),
  take(5, "sess-1", "t-maple", 3, "Insert for bars 9 to 16.", { page: 1, barFrom: 9, barTo: 16 }),
  take(6, "sess-1", "t-maple", 0, "", undefined, { lifecycle: "aborted", notes: "Aborted: lorry outside." }),
  take(7, "sess-1", "t-maple", 5, "Keeper into the trio. Lovely rubato.", { page: 2, barFrom: 17, barTo: 32 }, { starred: true, usedIn: [{ versionNumber: 1, barFrom: 17, barTo: 32 }, { versionNumber: 2, barFrom: 17, barTo: 40 }] }),
  take(8, "sess-1", "t-maple", 3, "Bass heavy through 21 to 24.", { page: 2, barFrom: 17, barTo: 32 }),
  take(9, "sess-1", "t-maple", 4, "Clean through the trio; bass drops at 18 as written.", { page: 2, barFrom: 17, barTo: 48 }, { usedIn: [{ versionNumber: 1, barFrom: 33, barTo: 48 }] }),
  take(10, "sess-1", "t-maple", 2, "Rushed.", { page: 3, barFrom: 33, barTo: 48 }),
  take(11, "sess-1", "t-maple", 3, "", { page: 3, barFrom: 33, barTo: 64 }),
  take(12, "sess-1", "t-maple", 4, "False start, then a clean complete run.", { page: 1, barFrom: 1, barTo: 64 }, { falseStarts: 1, usedIn: [{ versionNumber: 1, barFrom: 49, barTo: 64 }, { versionNumber: 2, barFrom: 49, barTo: 64 }] }),
  take(13, "sess-1", "t-maple", 3, "Safety.", { page: 1, barFrom: 1, barTo: 64 }),
  take(14, "sess-1", "t-maple", 0, "", { page: 3, barFrom: 41, barTo: 48 }),
  take(15, "sess-2", "t-maple", 3, "Patching the return.", { page: 3, barFrom: 41, barTo: 48 }),
  take(16, "sess-2", "t-maple", 4, "", { page: 3, barFrom: 41, barTo: 48 }),
  take(17, "sess-2", "t-entertainer", 3, "First run.", { page: 1, barFrom: 1, barTo: 36 }, { falseStarts: 1 }),
  take(18, "sess-2", "t-entertainer", 4, "", { page: 1, barFrom: 1, barTo: 36 }, { starred: true }),
  take(19, "sess-2", "t-maple", 4, "Grace note at 41 clean; slightly slow.", { page: 3, barFrom: 39, barTo: 44 }),
  take(20, "sess-2", "t-maple", 2, "Smudged again.", { page: 3, barFrom: 39, barTo: 44 }),
  take(21, "sess-2", "t-maple", 5, "The one. Grace note clean, tempo right.", { page: 3, barFrom: 39, barTo: 48 }, { starred: true, usedIn: [{ versionNumber: 2, barFrom: 41, barTo: 48 }] }),
  take(22, "sess-2", "t-solace", 5, "Complete run.", { page: 1, barFrom: 1, barTo: 96 }, { starred: true, usedIn: [{ versionNumber: 1, barFrom: 1, barTo: 88 }] }),
  take(23, "sess-2", "t-solace", 3, "", { page: 4, barFrom: 65, barTo: 96 }),
  take(24, "sess-2", "t-solace", 4, "Coda.", { page: 5, barFrom: 89, barTo: 96 }, { usedIn: [{ versionNumber: 1, barFrom: 89, barTo: 96 }] }),
  take(25, "sess-2", "t-entertainer", 3, "Trio only.", { page: 2, barFrom: 37, barTo: 68 }),
  take(26, "sess-2", null, 0, "Unplaced: room tone.", undefined),
];

export const takeById = (id: string) => takes.find((t) => t.id === id);

/** Every take whose coverage includes the bar, for a track. */
export const takesCovering = (trackId: string, bar: number) =>
  takes.filter((t) => t.trackId === trackId && t.coverage && t.coverage.barFrom <= bar && t.coverage.barTo >= bar);
