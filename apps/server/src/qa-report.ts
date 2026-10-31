import type { LoudnessSummary, MediaInfo, QaFinding } from "@hekate/shared";

/**
 * A recording's QA report to take away (#43): what the checks found, its loudness and its
 * format, stamped with where it is and who asked for it. As PDF to read and send (the document
 * of #515, in `qa-report-pdf.ts`), CSV for a spreadsheet, JSON for another program.
 */

export const qaReportFormats = ["pdf", "csv", "json"] as const;
export type QaReportFormat = (typeof qaReportFormats)[number];

export interface QaReportInput {
  file: { name: string /** "V2 · Dry", for a track's variant. */; version: string | null };
  workspace: string;
  project: string;
  /** Who downloaded it, and their part in the project. */
  requestedBy: { name: string; role: string | null };
  generatedAt: Date;
  profile: { label: string };
  status: string;
  loudness: LoudnessSummary | null;
  format: MediaInfo | null;
  findings: readonly QaFinding[];
}

/** The stamp every format carries: workspace, project, file, who asked and when. */
export const stampOf = (r: QaReportInput) =>
  [
    r.workspace,
    r.project,
    `${r.requestedBy.name}${r.requestedBy.role ? `, ${r.requestedBy.role}` : ""}`,
  ].join(" · ");

/**
 * One row a finding, for a spreadsheet; times in seconds. Every row carries the stamp (the
 * file, the profile, where it is, who asked and when), so a row copied elsewhere still says
 * what it is about, and the table keeps one shape.
 */
export function qaReportCsv(r: QaReportInput): string {
  const cell = (v: string | number | null) => {
    const text = v === null ? "" : String(v);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const head = [
    "severity",
    "check",
    "start_seconds",
    "end_seconds",
    "channel",
    "summary",
    "file",
    "version",
    "profile",
    "workspace",
    "project",
    "requested_by",
    "role",
    "generated_at",
  ];
  const stamp = [
    r.file.name,
    r.file.version,
    r.profile.label,
    r.workspace,
    r.project,
    r.requestedBy.name,
    r.requestedBy.role,
    r.generatedAt.toISOString(),
  ];
  const rows = r.findings.map((f) =>
    [
      f.severity,
      f.check,
      f.start === null ? null : Number(f.start.toFixed(3)),
      f.end === null ? null : Number(f.end.toFixed(3)),
      f.channel,
      f.summary,
      ...stamp,
    ].map(cell),
  );
  return `${[head, ...rows].map((row) => row.join(",")).join("\r\n")}\r\n`;
}

/** Everything, for another program. */
export function qaReportJson(r: QaReportInput): string {
  return `${JSON.stringify(
    {
      file: r.file,
      workspace: r.workspace,
      project: r.project,
      requestedBy: r.requestedBy,
      generatedAt: r.generatedAt.toISOString(),
      profile: r.profile,
      status: r.status,
      loudness: r.loudness,
      format: r.format,
      findings: r.findings,
    },
    null,
    2,
  )}\n`;
}

/** What a report in a format is called. */
export const qaReportFilename = (name: string, format: QaReportFormat) =>
  `${name.replace(/\.[^.]+$/, "")} QA report.${format}`;

/**
 * The report as a spreadsheet or for a program, with what to call it and how to say what it
 * is. The PDF is the document (#515), set by `qa-report-pdf.ts`.
 */
export function qaReport(r: QaReportInput, format: Exclude<QaReportFormat, "pdf">) {
  const filename = qaReportFilename(r.file.name, format);
  return format === "csv"
    ? { body: qaReportCsv(r), filename, contentType: "text/csv; charset=utf-8" }
    : { body: qaReportJson(r), filename, contentType: "application/json; charset=utf-8" };
}
