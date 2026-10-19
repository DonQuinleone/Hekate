import {
  admHeading,
  admLine,
  formatClock,
  type LoudnessSummary,
  type MediaInfo,
  metadataRows,
  type QaFinding,
  qaCheckNames,
  qaSeverityNames,
} from "@hekate/shared";
import { type TextLine, textPdf } from "./text-pdf.ts";

/**
 * A recording's QA report to take away (#43): what the checks found, its loudness and its
 * format, stamped with where it is and who asked for it. As PDF to read and send, CSV for a
 * spreadsheet, JSON for another program.
 */

export const qaReportFormats = ["pdf", "csv", "json"] as const;
export type QaReportFormat = (typeof qaReportFormats)[number];

export interface QaReportInput {
  file: { name: string /** "V2 · Dry", for a track's variation. */; version: string | null };
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

const number = (n: number | null | undefined, unit: string, digits = 1) =>
  n === null || n === undefined ? "Not measured" : `${n.toFixed(digits)} ${unit}`;

const formatLine = (info: MediaInfo | null) => {
  const audio = info?.audio;
  const video = info?.video;
  if (!audio && !video) return "Not measured";
  return [
    // A video's picture first (#42), then its sound.
    video ? `${video.codec} ${video.width}×${video.height}` : null,
    video?.fps ? `${Number(video.fps.toFixed(3))} fps` : null,
    audio?.codec,
    audio ? `${audio.sampleRate / 1000} kHz` : null,
    audio?.bitDepth ? `${audio.bitDepth}-bit` : null,
    audio
      ? `${audio.channels} channel${audio.channels === 1 ? "" : "s"}${audio.channelLayout ? ` (${audio.channelLayout})` : ""}`
      : null,
    info?.duration !== undefined ? formatClock(info.duration) : null,
  ]
    .filter(Boolean)
    .join(" · ");
};

const where = (f: QaFinding) =>
  f.start === null
    ? "Whole file"
    : f.end !== null && f.end - f.start > 0.01
      ? `${formatClock(f.start)} - ${formatClock(f.end)}`
      : formatClock(f.start);

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

/** The PDF's lines: the stamp, the measures, then the findings, worst first. */
export function qaReportLines(r: QaReportInput): TextLine[] {
  const problems = r.findings.filter((f) => f.severity !== "pass");
  const passed = r.findings.filter((f) => f.severity === "pass");
  const date = r.generatedAt.toISOString().slice(0, 16).replace("T", " ");
  return [
    { text: "QA report", size: 18, bold: true },
    {
      text: r.file.version ? `${r.file.name} (${r.file.version})` : r.file.name,
      size: 12,
      space: 4,
    },
    { text: `${stampOf(r)} · ${date} UTC`, quiet: true, space: 2 },
    { text: "Measured against", bold: true, space: 14 },
    { text: r.profile.label },
    { text: "Format", bold: true, space: 10 },
    { text: formatLine(r.format) },
    // What the file says about itself (#41), where it has been read.
    ...(r.format?.metadata
      ? [
          { text: "Embedded metadata", bold: true, space: 10 },
          ...metadataRows(r.format.metadata, r.format.audio?.sampleRate).map(
            ([label, value]): TextLine => ({ text: `${label}: ${value}`, size: 9 }),
          ),
          ...(r.format.metadata.adm
            ? [
                {
                  text: `${admHeading(r.format.metadata.adm)}: ${admLine(r.format.metadata.adm)}`,
                  size: 9,
                },
              ]
            : []),
        ]
      : []),
    { text: "Loudness", bold: true, space: 10 },
    {
      text: `Integrated ${number(r.loudness?.integrated, "LUFS")} · range ${number(r.loudness?.range, "LU")} · true peak ${number(r.loudness?.truePeak, "dBTP")}`,
    },
    { text: `Findings (${problems.length})`, bold: true, space: 14 },
    ...(problems.length === 0
      ? [{ text: r.status === "ready" ? "Nothing to report." : "Not measured yet.", quiet: true }]
      : problems.flatMap((f): TextLine[] => [
          {
            text: `${qaSeverityNames[f.severity]} · ${qaCheckNames[f.check]} · ${where(f)}`,
            bold: true,
            size: 9,
            space: 6,
          },
          { text: f.summary, size: 9 },
        ])),
    ...(passed.length > 0
      ? [
          { text: `Passed (${passed.length})`, bold: true, space: 14 },
          ...passed.map((f) => ({ text: `${qaCheckNames[f.check]}: ${f.summary}`, size: 9 })),
        ]
      : []),
    { text: "Made by Hekate.", quiet: true, size: 8, space: 18 },
  ];
}

/** The report in a format, with what to call it and how to say what it is. */
export function qaReport(r: QaReportInput, format: QaReportFormat) {
  const stem = r.file.name.replace(/\.[^.]+$/, "");
  const filename = `${stem} QA report.${format}`;
  switch (format) {
    case "csv":
      return { body: qaReportCsv(r), filename, contentType: "text/csv; charset=utf-8" };
    case "json":
      return { body: qaReportJson(r), filename, contentType: "application/json; charset=utf-8" };
    default:
      return {
        body: textPdf(qaReportLines(r), `QA report: ${r.file.name}`),
        filename,
        contentType: "application/pdf",
      };
  }
}
