import {
  type DateFormats,
  defaultDateFormats,
  type ExportThread,
  formatAnchor,
  formatDateTime,
} from "@hekate/shared";
import { type TextLine, textPdf } from "./text-pdf.ts";

/**
 * A file's comments as a sheet to print (#134): each thread with where it is, who wrote it,
 * whether it is settled and its replies, in the order the export writes them, stamped like
 * the QA report with the workspace, the project, who asked and when.
 */
export interface CommentSheetInput {
  file: { name: string; version: string | null };
  workspace: string;
  project: string;
  requestedBy: { name: string; role: string | null };
  generatedAt: Date;
  /** How its dates read (#481); ISO 8601 and the 24-hour clock unless the workspace chose otherwise. */
  dates?: DateFormats;
  /** Open threads only, or all of them. */
  scope: "open" | "all";
  threads: ExportThread[];
  /** A video's rate, so its times read as timecode as its player shows them. */
  fps?: number | null;
}

/** Where a thread is: its anchor as the comments column writes it, or the whole file. */
const placeOf = (t: ExportThread, fps?: number | null) =>
  t.anchor ? formatAnchor(t.anchor, fps ? { fps } : {}) : "Whole file";

/** The sheet's lines: the stamp, then each thread, numbered as the export orders them. */
export function commentSheetLines(r: CommentSheetInput): TextLine[] {
  const shown = r.threads.filter((t) => r.scope === "all" || !t.resolved);
  const date = formatDateTime(r.dates ?? defaultDateFormats, r.generatedAt, { timeZone: "UTC" });
  const who = `${r.requestedBy.name}${r.requestedBy.role ? `, ${r.requestedBy.role}` : ""}`;
  return [
    { text: "Comments", size: 18, bold: true },
    {
      text: r.file.version ? `${r.file.name} (${r.file.version})` : r.file.name,
      size: 12,
      space: 4,
    },
    { text: `${r.workspace} · ${r.project} · ${who} · ${date} UTC`, quiet: true, space: 2 },
    {
      text: `${shown.length} ${r.scope === "open" ? "open " : ""}${shown.length === 1 ? "thread" : "threads"}`,
      bold: true,
      space: 14,
    },
    ...(shown.length === 0
      ? [{ text: "Nothing to print.", quiet: true }]
      : shown.flatMap((t, i): TextLine[] => [
          {
            text: [
              String(i + 1).padStart(3, "0"),
              placeOf(t, r.fps),
              ...(t.channel ? [t.channel] : []),
              t.author,
              ...(t.resolved ? ["Resolved"] : []),
            ].join(" · "),
            bold: true,
            size: 9,
            space: 8,
          },
          { text: t.body, size: 10 },
          ...t.replies.map(
            (reply): TextLine => ({ text: `Reply from ${reply.author}: ${reply.body}`, size: 9 }),
          ),
        ])),
    { text: "Made by Hekate.", quiet: true, size: 8, space: 18 },
  ];
}

/** The sheet as a PDF, with what to call it. */
export function commentSheet(r: CommentSheetInput) {
  const base = r.file.name
    .replace(/\.[^./\\]{1,8}$/, "")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point.
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");
  return {
    filename: `${base || "Comments"} comments.pdf`,
    body: textPdf(commentSheetLines(r), `Comments: ${r.file.name}`),
  };
}
