import { z } from "zod";

/**
 * Error references (#159): every failure a person can see carries one, such as `HK-7F3A-2C`,
 * and an operator pastes it into Debug tools for the whole story. Six hexadecimal digits, so
 * it reads aloud and fits in a support message; unique among the reports still kept.
 */

/** How long a report is kept, in days. */
export const ERROR_REPORT_DAYS = 30;

/** A reference from three random bytes. */
export function formatErrorReference(bytes: Uint8Array): string {
  if (bytes.length < 3) throw new RangeError("An error reference takes three bytes");
  const hex = Array.from(bytes.subarray(0, 3), (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  return `HK-${hex.slice(0, 4)}-${hex.slice(4)}`;
}

/**
 * A reference as someone pasted it: any case, with or without its prefix and dashes, and with
 * spaces around it. Null when it cannot be one.
 */
export function parseErrorReference(input: string): string | null {
  let digits = input.trim().toUpperCase();
  if (digits.startsWith("HK")) digits = digits.slice(2);
  digits = digits.replaceAll("-", "");
  if (digits.length !== 6) return null;
  for (const c of digits) if (!"0123456789ABCDEF".includes(c)) return null;
  return `HK-${digits.slice(0, 4)}-${digits.slice(4)}`;
}

/** A reference in a path, normalised as `parseErrorReference` does. */
export const errorReferenceParam = z.object({
  reference: z
    .string()
    .max(32)
    .transform((value, ctx) => {
      const reference = parseErrorReference(value);
      if (!reference) {
        ctx.addIssue({ code: "custom", message: "Not an error reference" });
        return z.NEVER;
      }
      return reference;
    }),
});

/** Which failures to list: those since a moment, by default a day before now. */
export const errorReportsQuery = z.object({ since: z.iso.datetime({ offset: true }).optional() });

export type ErrorSource = "api" | "worker";

/** One failure in the list of what failed today. */
export interface ErrorReportRow {
  reference: string;
  occurredAt: string;
  source: ErrorSource;
  /** The route (`GET /api/files/:id`) or the job's name (`document-render`). */
  location: string;
  message: string;
  workspace: string | null;
}

/** The whole story behind a reference. */
export interface ErrorReport extends ErrorReportRow {
  status: number | null;
  stack: string | null;
  requestId: string | null;
  jobId: string | null;
  /** The OpenTelemetry trace it happened in (#162), where the instance sends traces. */
  traceId: string | null;
  /** The job's data: identifiers only, never media or secrets. */
  context: Record<string, unknown> | null;
  workspaceId: string | null;
  /** Who it happened to, when it happened in a request; nothing else about them. */
  who: { name: string; email: string } | null;
}

/** The report as plain text, for pasting into a ticket or an issue. */
export function errorReportText(report: ErrorReport): string {
  const lines = [
    `${report.reference} · ${report.occurredAt} · ${report.source} · ${report.location}`,
    report.message,
    report.who ? `Who: ${report.who.name} <${report.who.email}>` : null,
    report.workspace ? `Workspace: ${report.workspace} (${report.workspaceId})` : null,
    report.status ? `Status: ${report.status}` : null,
    report.requestId ? `Request: ${report.requestId}` : null,
    report.jobId ? `Job: ${report.jobId}` : null,
    report.traceId ? `Trace: ${report.traceId}` : null,
    report.context ? `Data: ${JSON.stringify(report.context)}` : null,
    report.stack,
  ];
  return lines.filter((line): line is string => !!line).join("\n");
}
