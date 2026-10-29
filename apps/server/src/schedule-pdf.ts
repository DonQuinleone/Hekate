import {
  coverage,
  type DateFormat,
  formatDate,
  headCount,
  type Personnel,
  rowWords,
  type ScheduleDay,
  scheduleKindWords,
  timesOf,
} from "@hekate/shared";
import { showText, widthOf } from "./media/pdf-text.ts";
import { fitted } from "./patch-pdf.ts";
import type { Sheet } from "./xlsx.ts";

/**
 * The schedule as a production sends it out (#50): A4, a front page with what may be shared
 * beyond the team (the project, its dates, venues and repertoire, and the days at a glance),
 * then each day as a table carried over pages as needed, then the ensemble breakdown.
 */

export interface ScheduleExport {
  project: string;
  days: ScheduleDay[];
  works: {
    id: string;
    title: string;
    composer: string;
    forces: string;
    abbreviation: string;
    trackIds: string[];
  }[];
  tracks: { id: string; name: string }[];
  venues: { id: string; name: string; address: string }[];
  personnel: Personnel[];
  /** How its dates read (#481); ISO 8601 unless the workspace chose otherwise. */
  dateFormat?: DateFormat;
}

const A4 = { width: 595.28, height: 841.89 };
const MARGIN = 40;
const ROW = 15;
const SIZE = 9;
const WIDE = A4.width - 2 * MARGIN;
const COLUMNS = [
  { title: "Time", width: 66 },
  { title: "What", width: 190 },
  { title: "Personnel", width: 110 },
  { title: "Min", width: 32 },
  { title: "Notes", width: WIDE - 398 },
];

/** "Saturday, 2026-09-12" of "2026-09-12", with its day named, in the workspace's format (#481). */
export const longDate = (date: string, format: DateFormat = "iso") =>
  formatDate(format, `${date}T12:00:00Z`, { timeZone: "UTC", weekday: "long" });

/** A day's heading words: its label, date and venue. */
function dayLine(day: ScheduleDay, s: ScheduleExport): string {
  const venue = s.venues.find((v) => v.id === day.venueId);
  return [day.label, day.date ? longDate(day.date, s.dateFormat) : null, venue?.name]
    .filter(Boolean)
    .join(" · ");
}

/** The dates the schedule spans: "Saturday, 2026-09-12 to Sunday, 2026-09-13", or none. */
function span(s: ScheduleExport): string {
  const dates = s.days.flatMap((d) => (d.date ? [d.date] : [])).sort();
  const first = dates[0];
  const last = dates[dates.length - 1];
  if (!first || !last) return "";
  return first === last
    ? longDate(first, s.dateFormat)
    : `${longDate(first, s.dateFormat)} to ${longDate(last, s.dateFormat)}`;
}

const num = (n: number) => String(Math.round(n * 100) / 100);
const text = (font: "H" | "HB", size: number, x: number, y: number, words: string, grey = 0) =>
  showText(font === "HB" ? "bold" : "regular", size, x, y, words, `${grey} g`);

/** The pages' drawings, A4 portrait, for a project's schedule. */
export function schedulePages(s: ScheduleExport): string[] {
  const pages: { title: string; ops: string[] }[] = [];
  let ops: string[] = [];
  let y = 0;
  const top = A4.height - MARGIN - 34;
  const newPage = (title: string) => {
    ops = [];
    pages.push({ title, ops });
    y = top;
  };
  const need = (height: number, title: string, again?: () => void) => {
    if (y - height < MARGIN + 20) {
      newPage(title);
      again?.();
    }
  };
  const rule = (at: number, grey: number) =>
    ops.push(`${grey} G 0.5 w ${MARGIN} ${num(at)} m ${num(A4.width - MARGIN)} ${num(at)} l S`);
  const heading = (words: string, title: string) => {
    need(40, title);
    ops.push(text("HB", 12, MARGIN, y - 13, fitted(words, WIDE, 12, true)));
    y -= 24;
  };
  const line = (words: string, title: string, grey = 0, bold = false, indent = 0) => {
    need(ROW, title);
    ops.push(
      text(
        bold ? "HB" : "H",
        10,
        MARGIN + indent,
        y - 11,
        fitted(words, WIDE - indent, 10, bold),
        grey,
      ),
    );
    y -= ROW;
  };

  // The front page: what the schedule is for, without its notes or personnel.
  const front = "Schedule";
  newPage(front);
  ops.push(text("HB", 22, MARGIN, y - 24, fitted(s.project, WIDE, 22, true)));
  y -= 36;
  const when = span(s);
  if (when) line(when, front, 0.35);
  y -= 14;
  const used = s.venues.filter((v) => s.days.some((d) => d.venueId === v.id));
  if (used.length > 0) {
    heading("Venues", front);
    for (const v of used) {
      line(v.name, front, 0, true);
      for (const part of v.address.split("\n").filter(Boolean)) line(part, front, 0.35);
      y -= 6;
    }
    y -= 8;
  }
  if (s.works.length > 0) {
    heading("Repertoire", front);
    for (const w of s.works) {
      line(
        [w.title, w.abbreviation ? `(${w.abbreviation})` : ""].filter(Boolean).join(" "),
        front,
        0,
        true,
      );
      const by = [w.composer, w.forces].filter(Boolean).join(" · ");
      if (by) line(by, front, 0.35);
      y -= 6;
    }
    y -= 8;
  }
  heading("Days", front);
  if (s.days.length === 0) line("Nothing scheduled yet.", front, 0.4);
  for (const d of s.days) {
    const times = timesOf(d);
    const hours = times.length > 0 ? `${times[0]?.start}–${times[times.length - 1]?.end}` : d.start;
    line(`${dayLine(d, s)} · ${hours}`, front);
  }

  // Each day: a table of its rows.
  for (const d of s.days) {
    const title = d.label;
    const header = (cont: boolean) => {
      ops.push(
        text(
          "HB",
          13,
          MARGIN,
          y - 14,
          fitted(`${dayLine(d, s)}${cont ? " (cont.)" : ""}`, WIDE, 13, true),
        ),
      );
      y -= 26;
      let x = MARGIN;
      for (const c of COLUMNS) {
        ops.push(text("HB", SIZE, x + 2, y - 11, c.title));
        x += c.width;
      }
      y -= ROW;
      rule(y, 0.2);
    };
    newPage(title);
    header(false);
    if (d.rows.length === 0) {
      ops.push(text("H", SIZE, MARGIN + 2, y - 11, "No rows yet.", 0.45));
      y -= ROW;
    }
    const times = timesOf(d);
    d.rows.forEach((r, i) => {
      need(ROW, title, () => header(true));
      const at = times[i];
      const cells = [
        `${at?.start ?? ""}–${at?.end ?? ""}`,
        rowWords(r, s.works, s.tracks),
        r.personnel,
        String(r.minutes),
        r.notes,
      ];
      let x = MARGIN;
      cells.forEach((cell, j) => {
        const c = COLUMNS[j];
        if (!c) return;
        ops.push(
          text(
            r.kind === "slot" && j === 1 ? "HB" : "H",
            SIZE,
            x + 2,
            y - 11,
            fitted(cell, c.width - 6, SIZE, r.kind === "slot" && j === 1),
            j === 4 ? 0.35 : r.kind === "slot" ? 0 : 0.3,
          ),
        );
        x += c.width;
      });
      y -= ROW;
      rule(y, 0.85);
    });
  }

  // The ensemble breakdown: who plays, section by section, and everyone else by role.
  const breakdown = "Ensemble breakdown";
  newPage(breakdown);
  if (s.personnel.length === 0) line("No personnel yet.", breakdown, 0.4);
  for (const p of s.personnel.filter((x) => x.kind === "ensemble")) {
    heading(`${p.name} · ${headCount(p)}`, breakdown);
    for (const section of p.sections) {
      const players = section.members.map((m) => m.name).join(", ");
      need(ROW, breakdown);
      ops.push(text("H", 10, MARGIN, y - 11, fitted(section.name, 140, 10)));
      ops.push(
        text(
          "HB",
          10,
          MARGIN + 150,
          y - 11,
          String(Math.max(section.count, section.members.length)),
        ),
      );
      ops.push(text("H", 10, MARGIN + 180, y - 11, fitted(players, WIDE - 180, 10), 0.35));
      y -= ROW;
    }
    y -= 10;
  }
  const others = s.personnel.filter((x) => x.kind !== "ensemble");
  if (others.length > 0) {
    heading("Artists and staff", breakdown);
    for (const p of others) {
      need(ROW, breakdown);
      ops.push(text("H", 10, MARGIN, y - 11, fitted(p.name, 200, 10)));
      ops.push(text("H", 10, MARGIN + 210, y - 11, fitted(p.role, WIDE - 210, 10), 0.35));
      y -= ROW;
    }
  }

  return pages.map((page, i) =>
    [
      text(
        "HB",
        9,
        MARGIN,
        A4.height - MARGIN - 8,
        fitted(`${s.project} · ${page.title}`, WIDE - 80, 9, true),
        0.45,
      ),
      text(
        "H",
        8,
        A4.width - MARGIN - widthOf(`Page ${i + 1} of ${pages.length}`, 8),
        MARGIN - 4,
        `Page ${i + 1} of ${pages.length}`,
        0.45,
      ),
      ...page.ops,
    ].join("\n"),
  );
}

/** The schedule as a workbook: every row with its day, the coverage, and the ensembles. */
export function scheduleSheets(s: ScheduleExport): Sheet[] {
  const rows: Sheet["rows"] = [
    [
      "Day",
      "Date",
      "Venue",
      "Start",
      "End",
      "Kind",
      "What",
      "Minutes",
      "Personnel",
      "Notes",
      "Done",
    ],
  ];
  for (const d of s.days) {
    const times = timesOf(d);
    const venue = s.venues.find((v) => v.id === d.venueId)?.name ?? "";
    for (const [i, r] of d.rows.entries())
      rows.push([
        d.label,
        d.date ?? "",
        venue,
        times[i]?.start ?? "",
        times[i]?.end ?? "",
        scheduleKindWords[r.kind],
        rowWords(r, s.works, s.tracks),
        r.minutes,
        r.personnel,
        r.notes,
        r.done ? "Yes" : "",
      ]);
  }
  const covered: Sheet["rows"] = [["Track", "Slots", "Minutes"]];
  const slots = coverage(
    s.days,
    s.works,
    s.tracks.map((t) => t.id),
  );
  for (const t of s.tracks) {
    const held = slots.get(t.id) ?? [];
    covered.push([
      t.name,
      held.map((x) => `${x.day} ${x.start}`).join(", ") || "No slot",
      held.reduce((n, x) => n + x.minutes, 0),
    ]);
  }
  const ensembles: Sheet["rows"] = [["Ensemble", "Section", "Players", "Names"]];
  for (const p of s.personnel.filter((x) => x.kind === "ensemble"))
    for (const section of p.sections)
      ensembles.push([
        p.name,
        section.name,
        Math.max(section.count, section.members.length),
        section.members.map((m) => m.name).join(", "),
      ]);
  return [
    { name: "Schedule", rows },
    { name: "Coverage", rows: covered },
    { name: "Ensembles", rows: ensembles },
  ];
}

export const SCHEDULE_PAGE = A4;
