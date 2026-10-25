import {
  type CroomConflict,
  type CroomConflictChoice,
  type CroomCount,
  type CroomKind,
  croomKinds,
  type DrawingColour,
  drawingColours,
  type PersonnelKind,
  patchRowInput,
  personnelInput,
  type ScheduleRowKind,
  type ScoreMarkKind,
  scheduleDayInput,
  scheduleRowInput,
  scoreMarkCategoryInput,
  scoreMarkInput,
  sessionInput,
  stageBoxInput,
  stageItemInput,
  stagePlanInput,
  trackName,
  venueInput,
  workInput,
} from "@hekate/shared";
import type { z } from "zod";
import type { CroomModel, CrPatch, CrSection, ReportCollector } from "./model.ts";

/**
 * What an import will write, worked out from the replayed model and what the project already
 * has (#57, decision 242). Pure: the preview shows it and the import writes it, each from the
 * same function, so the two cannot disagree. Every entry is checked with the schema the API
 * checks the same thing with, so nothing goes in that the project's own pages would refuse;
 * an entry that fails is left out and said in the report.
 */

/** What the project holds that an import may meet, by name. */
export interface Existing {
  works: { id: string; title: string; tracks: { id: string; name: string; takes: number[] }[] }[];
  venues: { id: string; name: string }[];
  personnel: { id: string; name: string }[];
  stagePlans: { id: string; name: string }[];
  stageBoxes: { id: string; name: string; inputs: number[]; outputs: number[] }[];
  categories: { id: string; name: string }[];
}

export const nothingExisting = (): Existing => ({
  works: [],
  venues: [],
  personnel: [],
  stagePlans: [],
  stageBoxes: [],
  categories: [],
});

export interface PlannedScore {
  key: string;
  name: string;
  blobId: string;
  byteSize: number;
}

export interface PlannedTrack {
  key: string;
  existingId: string | null;
  name: string;
  number: string;
  pageFrom: number | null;
  pageTo: number | null;
}

export interface PlannedWork {
  key: string;
  existingId: string | null;
  title: string;
  composer: string;
  forces: string;
  abbreviation: string;
  notes: string;
  scoreKey: string | null;
  pageOffset: number;
  tracks: PlannedTrack[];
}

export interface PlannedVenue {
  key: string;
  existingId: string | null;
  name: string;
  address: string;
  notes: string;
}

export interface PlannedPerson {
  key: string;
  existingId: string | null;
  name: string;
  kind: PersonnelKind;
  role: string;
  agreement: boolean;
  headphones: boolean;
  seating: string;
  sections: CrSection[];
}

export interface PlannedSession {
  key: string;
  name: string;
  recordedOn: string | null;
  venue: string | null;
  notes: string | null;
  trackKeys: string[];
}

export interface PlannedTake {
  trackKey: string;
  sessionKey: string | null;
  number: number;
  notes: string | null;
  rating: number;
  starred: boolean;
  lifecycle: "recorded" | "aborted";
  falseStarts: number;
  timecodeIn: string | null;
  timecodeOut: string | null;
  wallIn: string | null;
  wallOut: string | null;
  page: number | null;
  pageTo: number | null;
  barFrom: number | null;
  barTo: number | null;
}

export interface PlannedCategory {
  key: string;
  existingId: string | null;
  name: string;
  colour: DrawingColour;
  shortcut: string | null;
}

export interface PlannedMark {
  trackKey: string;
  kind: ScoreMarkKind;
  page: number;
  x: number;
  y: number;
  width: number | null;
  height: number | null;
  points: [number, number][] | null;
  barFrom: number | null;
  barTo: number | null;
  text: string | null;
  categoryKey: string | null;
  takes: number[];
  fixedBy: number | null;
  resolved: boolean;
  from: number | null;
  to: number | null;
  overdub: boolean;
}

export interface PlannedRow {
  kind: ScheduleRowKind;
  start: string | null;
  minutes: number;
  label: string;
  allRepertoire: boolean;
  workKeys: string[];
  trackKeys: string[];
  personnel: string;
  notes: string;
  done: boolean;
}

export interface PlannedDay {
  label: string;
  date: string | null;
  venueKey: string | null;
  start: string;
  rows: PlannedRow[];
}

export interface PlannedItem {
  kind: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  personKey: string | null;
  patch: { boxKey: string; channel: number } | null;
  group: string;
}

export interface PlannedStagePlan {
  key: string;
  existingId: string | null;
  name: string;
  width: number;
  depth: number;
  grid: number;
  items: PlannedItem[];
}

export interface PlannedBox {
  key: string;
  existingId: string | null;
  name: string;
  inputs: CrPatch[];
  outputs: CrPatch[];
}

export interface ImportPlan {
  scores: PlannedScore[];
  works: PlannedWork[];
  venues: PlannedVenue[];
  personnel: PlannedPerson[];
  sessions: PlannedSession[];
  takes: PlannedTake[];
  categories: PlannedCategory[];
  marks: PlannedMark[];
  days: PlannedDay[];
  stagePlans: PlannedStagePlan[];
  stageBoxes: PlannedBox[];
  counts: CroomCount[];
  names: { kind: CroomKind; names: string[] }[];
  conflicts: CroomConflict[];
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A name not yet taken: "Endless Hall", else "Endless Hall (2)" and on. */
export function freeName(name: string, taken: readonly string[], max: number): string {
  if (!taken.some((t) => same(t, name))) return name;
  for (let n = 2; ; n += 1) {
    const suffix = ` (${n})`;
    const candidate = `${name.slice(0, max - suffix.length)}${suffix}`;
    if (!taken.some((t) => same(t, candidate))) return candidate;
  }
}

/** Why a schema refused an entry, in its first issue's words. */
const refusal = (error: z.ZodError) => error.issues[0]?.message ?? "it is not valid";

const colourOf = (written: string | null): DrawingColour => {
  if (!written) return "signal";
  const word = written.trim().toLowerCase();
  if ((drawingColours as readonly string[]).includes(word)) return word as DrawingColour;
  if (/blue|cyan|teal/.test(word) || /^#?[0-3][0-9a-f]{3}[8-9a-f]/.test(word)) return "blue";
  if (/green|lime/.test(word)) return "green";
  if (/white|paper|grey|gray|yellow/.test(word)) return "paper";
  return "signal";
};

export function planImport(
  model: CroomModel,
  blobSizes: ReadonlyMap<string, number>,
  existing: Existing,
  choice: CroomConflictChoice,
  report: ReportCollector,
): ImportPlan {
  const conflicts: CroomConflict[] = [];
  const counted = new Map<CroomKind, { create: number; merge: number }>(
    croomKinds.map((k) => [k, { create: 0, merge: 0 }]),
  );
  const names = new Map<CroomKind, string[]>();
  const count = (kind: CroomKind, merged: boolean, name?: string) => {
    const held = counted.get(kind);
    if (held) held[merged ? "merge" : "create"] += 1;
    if (name) {
      const list = names.get(kind) ?? [];
      if (list.length < 6) list.push(name);
      names.set(kind, list);
    }
  };
  /** The entry already there with this name, as the choice treats it. */
  const meet = <E extends { id: string; name: string }>(
    kind: CroomKind,
    name: string,
    there: readonly E[],
  ): E | null => {
    const found = there.find((e) => same(e.name, name));
    if (!found) return null;
    conflicts.push({ kind, name: found.name });
    return choice === "merge" ? found : null;
  };

  // Scores: each PDF with its bytes in the file.
  const scores: PlannedScore[] = [];
  for (const pdf of model.pdfs.values()) {
    const blobId = pdf.blobId;
    if (!blobId || !blobSizes.has(blobId)) {
      report.problem(
        `The PDF "${pdf.name || pdf.id}" has no bytes in the file, so it was left out`,
      );
      continue;
    }
    const name = (pdf.name.trim() || `Score ${pdf.id}`).replace(/[/\\]/g, "-").slice(0, 200);
    const fileName = /\.pdf$/i.test(name) ? name : `${name}.pdf`;
    scores.push({ key: pdf.id, name: fileName, blobId, byteSize: blobSizes.get(blobId) ?? 0 });
    count("score", false, fileName);
  }
  const scoreKeys = new Set(scores.map((s) => s.key));

  // Works and their tracks: a movement each, or the piece itself where it has none.
  const works: PlannedWork[] = [];
  /** Where each take or mark's place lands: movement id, or `work:<id>`. */
  const trackKeys = new Set<string>();
  const trackOfWork = new Map<string, string>();
  const takenTracks = new Map<string, Set<number>>();
  for (const work of model.works.values()) {
    const checked = workInput.safeParse({
      title: work.title,
      composer: work.composer,
      forces: work.forces,
      abbreviation: work.abbreviation,
      notes: work.notes,
      pageOffset: work.pageOffset,
    });
    if (!checked.success) {
      report.problem(
        `The piece "${work.title || work.id}": ${refusal(checked.error)}, so it and its takes were left out`,
      );
      continue;
    }
    const there = meet(
      "work",
      checked.data.title,
      existing.works.map((w) => ({ ...w, name: w.title })),
    );
    const movements = [...model.movements.values()].filter((m) => m.workId === work.id);
    const tracks: PlannedTrack[] = [];
    const parts =
      movements.length > 0
        ? movements.map((m, i) => ({
            key: m.id,
            name: m.title.trim() || `${checked.data.title} ${m.number || i + 1}`,
            number: m.number.slice(0, 12),
            pageFrom: m.pageFrom,
            pageTo:
              m.pageTo !== null && m.pageFrom !== null && m.pageTo >= m.pageFrom ? m.pageTo : null,
          }))
        : [
            {
              key: `work:${work.id}`,
              name: checked.data.title,
              number: "",
              pageFrom: null,
              pageTo: null,
            },
          ];
    for (const part of parts) {
      const name = trackName.safeParse(part.name.slice(0, 200));
      if (!name.success) {
        report.problem(
          `A movement of "${checked.data.title}" has no name Hekate can use, so it was left out`,
        );
        continue;
      }
      const thereTrack = there?.tracks.find((t) => same(t.name, name.data)) ?? null;
      tracks.push({ ...part, name: name.data, existingId: thereTrack?.id ?? null });
      trackKeys.add(part.key);
      takenTracks.set(part.key, new Set(thereTrack?.takes ?? []));
      count("track", thereTrack !== null, name.data);
    }
    // A take or mark placed on the piece alone goes on its track, or its first movement's.
    if (tracks[0]) trackOfWork.set(work.id, tracks[0].key);
    works.push({
      key: work.id,
      existingId: there?.id ?? null,
      title: checked.data.title,
      composer: checked.data.composer,
      forces: checked.data.forces,
      abbreviation: checked.data.abbreviation,
      notes: checked.data.notes,
      scoreKey: work.pdfId && scoreKeys.has(work.pdfId) ? work.pdfId : null,
      pageOffset: checked.data.pageOffset,
      tracks,
    });
    count("work", there !== null, checked.data.title);
  }
  const trackOf = (place: { workId: string | null; movementId: string | null }, what: string) => {
    if (place.movementId && trackKeys.has(place.movementId)) return place.movementId;
    if (place.workId) {
      const key = trackOfWork.get(place.workId);
      if (key) {
        const work = model.works.get(place.workId);
        if (
          place.movementId === null &&
          [...model.movements.values()].some((m) => m.workId === place.workId)
        )
          report.problem(
            `${what} on "${work?.title ?? place.workId}" names no movement, so it is on the first`,
          );
        return key;
      }
    }
    report.problem(`${what} belongs to no piece in the file, so it was left out`);
    return null;
  };

  // Venues.
  const venues: PlannedVenue[] = [];
  const venueNames = existing.venues.map((v) => v.name);
  for (const venue of model.venues.values()) {
    const checked = venueInput.safeParse(venue);
    if (!checked.success) {
      report.problem(
        `The venue "${venue.name || venue.id}": ${refusal(checked.error)}, so it was left out`,
      );
      continue;
    }
    const there = meet("venue", checked.data.name, existing.venues);
    const name = there ? there.name : freeName(checked.data.name, venueNames, 120);
    venueNames.push(name);
    venues.push({ key: venue.id, existingId: there?.id ?? null, ...checked.data, name });
    count("venue", there !== null, name);
  }
  const venueKeys = new Set(venues.map((v) => v.key));

  // Personnel.
  const personnel: PlannedPerson[] = [];
  for (const person of model.personnel.values()) {
    const checked = personnelInput.safeParse({
      name: person.name,
      kind: person.kind,
      role: person.role,
      agreement: person.agreement,
      headphones: person.headphones,
      seating: person.seating,
      sections: person.kind === "ensemble" ? person.sections : [],
    });
    if (!checked.success) {
      report.problem(
        `"${person.name || person.id}" on the personnel: ${refusal(checked.error)}, so they were left out`,
      );
      continue;
    }
    if (person.kind !== "ensemble" && person.sections.length > 0)
      report.problem(
        `"${person.name}" has sections but is not an ensemble, so their sections were left out`,
      );
    const there = meet("personnel", checked.data.name, existing.personnel);
    personnel.push({
      key: person.id,
      existingId: there?.id ?? null,
      name: checked.data.name,
      kind: checked.data.kind,
      role: checked.data.role,
      agreement: checked.data.agreement,
      headphones: checked.data.headphones,
      seating: checked.data.seating,
      sections: checked.data.sections,
    });
    count("personnel", there !== null, checked.data.name);
  }
  const personKeys = new Set(personnel.map((p) => p.key));

  // Takes, each on its track, numbered as the file numbers it where that number is free.
  const takes: PlannedTake[] = [];
  const sessionTracks = new Map<string, Set<string>>();
  for (const take of model.takes.values()) {
    const trackKey = trackOf(take, `Take ${take.number ?? take.id}`);
    if (!trackKey) continue;
    const taken = takenTracks.get(trackKey) ?? new Set<number>();
    let number = take.number;
    if (number !== null && (number < 1 || taken.has(number))) {
      report.problem(
        `Take ${number} of "${trackNameOf(works, trackKey)}" is there already, so the file's was left out`,
      );
      continue;
    }
    if (number === null) number = Math.max(0, ...taken) + 1;
    taken.add(number);
    takenTracks.set(trackKey, taken);
    const sessionKey = take.sessionId && model.sessions.has(take.sessionId) ? take.sessionId : null;
    if (take.sessionId && !sessionKey)
      report.problem(`Take ${number} names a session the file never added, so it has none`);
    if (sessionKey) {
      const held = sessionTracks.get(sessionKey) ?? new Set();
      held.add(trackKey);
      sessionTracks.set(sessionKey, held);
    }
    const barsForward = take.barFrom === null || take.barTo === null || take.barFrom <= take.barTo;
    if (!barsForward) report.problem(`Take ${number}'s bars run backwards, so they were left out`);
    takes.push({
      trackKey,
      sessionKey,
      number,
      notes: take.notes.trim() ? take.notes.slice(0, 4000) : null,
      rating: take.rating,
      starred: take.starred,
      lifecycle: take.aborted ? "aborted" : "recorded",
      falseStarts: Math.max(0, take.falseStarts),
      timecodeIn: take.timecodeIn?.slice(0, 32) ?? null,
      timecodeOut: take.timecodeOut?.slice(0, 32) ?? null,
      wallIn: take.wallIn,
      wallOut: take.wallOut,
      page: take.page !== null && take.page >= 1 ? take.page : null,
      pageTo: take.pageTo !== null && take.pageTo >= 1 ? take.pageTo : null,
      barFrom: barsForward ? take.barFrom : null,
      barTo: barsForward ? take.barTo : null,
    });
    count("take", false);
  }

  // Sessions, with the tracks their takes are of.
  const sessions: PlannedSession[] = [];
  for (const session of model.sessions.values()) {
    const venue = session.venueId ? model.venues.get(session.venueId) : undefined;
    const checked = sessionInput.safeParse({
      name: session.name.trim() || `Session ${session.id}`,
      recordedOn: session.date,
      venue: venue?.name ?? null,
      notes: session.notes.trim() || null,
    });
    if (!checked.success) {
      report.problem(
        `The session "${session.name || session.id}": ${refusal(checked.error)}, so it was left out`,
      );
      for (const t of takes) if (t.sessionKey === session.id) t.sessionKey = null;
      continue;
    }
    sessions.push({
      key: session.id,
      name: checked.data.name,
      recordedOn: checked.data.recordedOn ?? null,
      venue: checked.data.venue ?? null,
      notes: checked.data.notes ?? null,
      trackKeys: [...(sessionTracks.get(session.id) ?? [])],
    });
    count("session", false, checked.data.name);
  }

  // Categories of issue.
  const categories: PlannedCategory[] = [];
  for (const category of model.categories.values()) {
    const shortcut = category.key && /^[1-9]$/.test(category.key) ? category.key : null;
    const checked = scoreMarkCategoryInput.safeParse({
      name: category.name,
      colour: colourOf(category.colour),
      key: shortcut,
    });
    if (!checked.success) {
      report.problem(
        `The category "${category.name || category.id}": ${refusal(checked.error)}, so it was left out`,
      );
      continue;
    }
    const there = meet("category", checked.data.name, existing.categories);
    categories.push({
      key: category.id,
      existingId: there?.id ?? null,
      name: checked.data.name,
      colour: checked.data.colour,
      shortcut: checked.data.key,
    });
    count("category", there !== null, checked.data.name);
  }
  const categoryKeys = new Set(categories.map((c) => c.key));

  // Score marks, each on its track.
  const marks: PlannedMark[] = [];
  for (const mark of model.marks.values()) {
    if (mark.kind === null) continue;
    const trackKey = trackOf(mark, `A ${mark.kind} mark`);
    if (!trackKey) continue;
    if (mark.page === null || mark.page < 1) {
      report.problem(`A ${mark.kind} mark has no page, so it was left out`);
      continue;
    }
    const checked = scoreMarkInput.safeParse({
      kind: mark.kind,
      page: mark.page,
      x: mark.x,
      y: mark.y,
      width: mark.width,
      height: mark.height,
      points: mark.points,
      barFrom: mark.barFrom,
      barTo: mark.barTo,
      text: mark.text,
      takes: mark.takes.filter((n) => n >= 1),
      fixedBy: mark.fixedBy,
      resolved: mark.resolved,
      from: mark.from,
      to: mark.to,
      overdub: mark.overdub,
    });
    if (!checked.success) {
      report.problem(
        `A ${mark.kind} mark on page ${mark.page}: ${refusal(checked.error)}, so it was left out`,
      );
      continue;
    }
    const m = checked.data;
    marks.push({
      trackKey,
      kind: m.kind,
      page: m.page,
      x: m.x,
      y: m.y,
      width: m.width ?? null,
      height: m.height ?? null,
      points: m.points ?? null,
      barFrom: m.barFrom ?? null,
      barTo: m.barTo ?? null,
      text: m.text ?? null,
      categoryKey: mark.categoryId && categoryKeys.has(mark.categoryId) ? mark.categoryId : null,
      takes: m.takes ?? [],
      fixedBy: m.fixedBy ?? null,
      resolved: m.resolved ?? false,
      from: m.from ?? null,
      to: m.to ?? null,
      overdub: m.overdub ?? false,
    });
    count("score-mark", false);
  }

  // The schedule: its days, and rows under them; a row with a date and no day finds or makes one.
  const days: PlannedDay[] = [];
  const dayByKey = new Map<string, PlannedDay>();
  for (const day of model.days.values()) {
    const checked = scheduleDayInput.safeParse({
      label: day.label.trim() || day.date || `Day ${days.length + 1}`,
      date: day.date,
      start: day.start ?? "10:00",
    });
    if (!checked.success) {
      report.problem(
        `The day "${day.label || day.id}": ${refusal(checked.error)}, so it and its rows were left out`,
      );
      continue;
    }
    const planned: PlannedDay = {
      label: checked.data.label,
      date: checked.data.date,
      venueKey: day.venueId && venueKeys.has(day.venueId) ? day.venueId : null,
      start: checked.data.start,
      rows: [],
    };
    days.push(planned);
    dayByKey.set(day.id, planned);
    count("schedule-day", false, planned.label);
  }
  for (const row of model.rows.values()) {
    let day = row.dayId ? dayByKey.get(row.dayId) : undefined;
    if (!day && row.date) {
      day = days.find((d) => d.date === row.date);
      if (!day) {
        day = {
          label: `Day ${days.length + 1}`,
          date: row.date,
          venueKey: null,
          start: "10:00",
          rows: [],
        };
        days.push(day);
        count("schedule-day", false, day.label);
      }
    }
    if (!day) {
      report.problem(`A schedule row "${row.label || row.id}" is on no day, so it was left out`);
      continue;
    }
    const workKeys = row.workIds.filter((id) => works.some((w) => w.key === id));
    const rowTracks = row.movementIds.filter((id) => trackKeys.has(id));
    if (workKeys.length + rowTracks.length < row.workIds.length + row.movementIds.length)
      report.problem(`A schedule row names repertoire the file never added, which was left off it`);
    const checked = scheduleRowInput.safeParse({
      kind: row.kind,
      start: row.start,
      minutes: row.minutes,
      label: row.label,
      allRepertoire: row.kind === "slot" && row.allRepertoire,
      personnel: row.personnel.slice(0, 200),
      notes: row.notes,
    });
    if (!checked.success) {
      report.problem(
        `A schedule row "${row.label || row.id}": ${refusal(checked.error)}, so it was left out`,
      );
      continue;
    }
    day.rows.push({
      ...checked.data,
      workKeys: checked.data.kind === "slot" ? workKeys : [],
      trackKeys: checked.data.kind === "slot" ? rowTracks : [],
      done: row.done,
    });
    count("schedule-row", false);
  }

  // Stage boxes and their channels.
  const stageBoxes: PlannedBox[] = [];
  const boxNames = existing.stageBoxes.map((b) => b.name);
  for (const box of model.stageBoxes.values()) {
    const checked = stageBoxInput.safeParse({ name: box.name });
    if (!checked.success) {
      report.problem(
        `The stage box "${box.name || box.id}": ${refusal(checked.error)}, so it was left out`,
      );
      continue;
    }
    const there = meet("stage-box", checked.data.name, existing.stageBoxes);
    const name = there ? there.name : freeName(checked.data.name, boxNames, 60);
    boxNames.push(name);
    const channels = (rows: CrPatch[], direction: "input" | "output", held: number[]) => {
      const kept: CrPatch[] = [];
      const seen = new Set(held);
      for (const r of rows) {
        const row = patchRowInput.safeParse({ direction, ...r });
        if (!row.success || seen.has(r.channel)) {
          report.problem(
            `${name} ${direction} ${r.channel}: ${row.success ? "the channel is taken" : refusal(row.error)}, so it was left out`,
          );
          continue;
        }
        seen.add(r.channel);
        kept.push({
          channel: r.channel,
          source: row.data.source,
          device: row.data.device,
          cable: row.data.cable,
          notes: row.data.notes,
        });
        count("patch-row", false);
      }
      return kept;
    };
    stageBoxes.push({
      key: box.id,
      existingId: there?.id ?? null,
      name,
      inputs: channels(box.inputs, "input", there?.inputs ?? []),
      outputs: channels(box.outputs, "output", there?.outputs ?? []),
    });
    count("stage-box", there !== null, name);
  }
  const boxKeys = new Set(stageBoxes.map((b) => b.key));

  // Stage plans and what stands on them. A plan merged into one already there keeps its own items.
  const stagePlans: PlannedStagePlan[] = [];
  const planNames = existing.stagePlans.map((p) => p.name);
  for (const plan of model.stagePlans.values()) {
    const checked = stagePlanInput.safeParse({
      name:
        plan.name.trim() || (plan.venueId ? model.venues.get(plan.venueId)?.name : "") || "Stage",
      width: plan.width,
      depth: plan.depth,
      grid: plan.grid,
    });
    if (!checked.success) {
      report.problem(
        `The stage plan "${plan.name || plan.id}": ${refusal(checked.error)}, so it was left out`,
      );
      continue;
    }
    const there = meet("stage-plan", checked.data.name, existing.stagePlans);
    const name = there ? there.name : freeName(checked.data.name, planNames, 80);
    planNames.push(name);
    const items: PlannedItem[] = [];
    const elements = [...model.stageElements.values()].filter((e) => e.planId === plan.id);
    if (there && elements.length > 0)
      report.problem(
        `The stage plan "${name}" is there already, so what stands on the file's was left out`,
      );
    for (const e of there ? [] : elements) {
      const item = stageItemInput.safeParse({
        id: "00000000-0000-7000-8000-000000000000",
        kind: e.kind,
        label: e.label.slice(0, 60),
        x: e.x,
        y: e.y,
        w: e.w,
        h: e.h,
        rotation: e.rotation,
        group: e.group.slice(0, 40),
      });
      if (!item.success) {
        report.problem(`A ${e.kind} on "${name}": ${refusal(item.error)}, so it was left out`);
        continue;
      }
      const boxed = e.boxId && boxKeys.has(e.boxId) && e.channel !== null;
      items.push({
        kind: item.data.kind,
        label: item.data.label,
        x: item.data.x,
        y: item.data.y,
        w: item.data.w,
        h: item.data.h,
        rotation: item.data.rotation,
        personKey: e.personId && personKeys.has(e.personId) ? e.personId : null,
        patch: boxed ? { boxKey: e.boxId as string, channel: e.channel as number } : null,
        group: item.data.group,
      });
      count("stage-item", false);
    }
    stagePlans.push({
      key: plan.id,
      existingId: there?.id ?? null,
      name,
      width: checked.data.width,
      depth: checked.data.depth,
      grid: checked.data.grid,
      items,
    });
    count("stage-plan", there !== null, name);
  }
  const unplaced = [...model.stageElements.values()].filter(
    (e) => !e.planId || !model.stagePlans.has(e.planId),
  ).length;
  if (unplaced > 0)
    report.problem(
      `${unplaced} stage elements are on no stage plan in the file, so they were left out`,
    );

  return {
    scores,
    works,
    venues,
    personnel,
    sessions,
    takes,
    categories,
    marks,
    days,
    stagePlans,
    stageBoxes,
    counts: croomKinds
      .map((kind) => ({ kind, ...(counted.get(kind) ?? { create: 0, merge: 0 }) }))
      .filter((c) => c.create + c.merge > 0),
    names: croomKinds
      .filter((kind) => names.has(kind))
      .map((kind) => ({ kind, names: names.get(kind) ?? [] })),
    conflicts,
  };
}

function trackNameOf(works: PlannedWork[], key: string) {
  for (const w of works) for (const t of w.tracks) if (t.key === key) return t.name;
  return key;
}
