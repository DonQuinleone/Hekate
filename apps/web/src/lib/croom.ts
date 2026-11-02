import { type CroomReport, croomSubject } from "@hekate/shared";

/** A line of the import's report, and how often the file has it. */
export interface ReportLine {
  what: string;
  count: number;
}

/** A sentence ends in a full stop, whatever the server wrote. */
export const sentence = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/**
 * The import preview's report in people's words (#551): the problems to look over, each a
 * sentence; what is not brought over, by what it is; and, apart, the file's own event and field
 * ids for "Details for support", the only place an id appears.
 */
export function reportLines(report: CroomReport): {
  lookOver: string[];
  notBrought: ReportLine[];
  support: ReportLine[];
} {
  const unknown = report.unknownEvents.reduce((n, e) => n + e.count, 0);
  // Unread details grouped by what they belong to: "Details of a venue this import does not read."
  const unread = new Map<string, number>();
  for (const f of report.unknownFields) {
    const subject = croomSubject(f.type) ?? "something this import does not know";
    unread.set(subject, (unread.get(subject) ?? 0) + f.count);
  }
  // What is set aside for the same reason is one line, whichever event it came from.
  const setAside = new Map<string, number>();
  for (const i of report.ignored)
    setAside.set(sentence(i.reason), (setAside.get(sentence(i.reason)) ?? 0) + i.count);
  return {
    lookOver: report.problems.map(sentence),
    notBrought: [
      ...[...setAside].map(([what, count]) => ({ what, count })),
      ...(unknown > 0
        ? [
            {
              what: `${unknown === 1 ? "A change" : "Changes"} this import does not know, from a newer ControlRoom.`,
              count: unknown,
            },
          ]
        : []),
      ...[...unread].map(([subject, count]) => ({
        what: `Details of ${subject} this import does not read.`,
        count,
      })),
    ],
    support: [
      ...report.unknownEvents.map((e) => ({ what: `Unknown event ${e.type}`, count: e.count })),
      ...report.unknownFields.map((f) => ({
        what: `Unread field ${f.type}.${f.field}`,
        count: f.count,
      })),
      ...report.ignored.map((i) => ({ what: `Set aside ${i.type}`, count: i.count })),
      ...(report.support ?? []).map((what) => ({ what, count: 1 })),
    ],
  };
}
