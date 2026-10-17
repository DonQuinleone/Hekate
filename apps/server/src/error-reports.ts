import { randomBytes } from "node:crypto";
import { type Database, schema } from "@hekate/db";
import { ERROR_REPORT_DAYS, type ErrorSource, formatErrorReference } from "@hekate/shared";
import { lt } from "drizzle-orm";
import type { JobFailure } from "./jobs.ts";

/** What is known about a failure when it happens. */
export interface Failure {
  source: ErrorSource;
  location: string;
  error: unknown;
  status?: number;
  requestId?: string;
  jobId?: string;
  context?: Record<string, unknown>;
  organisationId?: string;
  userId?: string;
}

const pgCode = (error: unknown) =>
  error && typeof error === "object" && "cause" in error
    ? (error.cause as { code?: string } | undefined)?.code
    : (error as { code?: string } | undefined)?.code;

/**
 * Records a failure under a new reference (#159) and writes it as one structured log line, with
 * the request, the person, the job and the stack. Returns the reference, or null when even the
 * database could not take it; the log line is written either way. Never throws: it runs where
 * something has already gone wrong.
 */
export async function recordFailure(db: Database, failure: Failure): Promise<string | null> {
  const error = failure.error instanceof Error ? failure.error : new Error(String(failure.error));
  const row = {
    source: failure.source,
    location: failure.location,
    message: error.message.slice(0, 2000) || error.name,
    stack: error.stack?.slice(0, 8000) ?? null,
    status: failure.status ?? null,
    requestId: failure.requestId ?? null,
    jobId: failure.jobId ?? null,
    context: failure.context ?? null,
    organisationId: failure.organisationId ?? null,
    userId: failure.userId ?? null,
  };
  let reference: string | null = null;
  for (let attempt = 0; attempt < 4 && !reference; attempt++) {
    const candidate = formatErrorReference(randomBytes(3));
    try {
      const [saved] = await db
        .insert(schema.errorReports)
        .values({ ...row, reference: candidate })
        .onConflictDoNothing({ target: schema.errorReports.reference })
        .returning({ reference: schema.errorReports.reference });
      reference = saved?.reference ?? null;
    } catch (cause) {
      // The workspace or the account went while it failed, or a job's data named no real
      // workspace: keep the report without them.
      const code = pgCode(cause);
      if ((code === "23503" || code === "22P02") && (row.organisationId || row.userId)) {
        row.organisationId = null;
        row.userId = null;
        continue;
      }
      console.error("Could not record an error report:", cause);
      break;
    }
  }
  console.error(
    JSON.stringify({
      level: "error",
      reference,
      ...row,
      context: row.context ?? undefined,
    }),
  );
  return reference;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** What a route's `:id` names, by the resource the path begins with. */
const resources: Record<string, string> = {
  files: "fileId",
  reviews: "reviewId",
  tracks: "trackId",
  projects: "projectId",
  comments: "commentId",
  versions: "versionId",
};

/**
 * What a failed request was about, from its route and parameters, so an inspector can find the
 * reports of a file or a review: `/api/files/:id` names a file. Identifiers only.
 */
export function failureContext(
  routePath: string,
  params: Record<string, string>,
): Record<string, string> | undefined {
  const context: Record<string, string> = {};
  const [, root, resource] = routePath.split("/");
  const named = root === "api" && resource ? resources[resource] : undefined;
  if (named && params.id && UUID.test(params.id)) context[named] = params.id;
  for (const [key, value] of Object.entries(params))
    if (key.endsWith("Id") && UUID.test(value)) context[key] = value;
  return Object.keys(context).length > 0 ? context : undefined;
}

/** A job's last failure as a report: its workspace, when its data names one. */
export function failureOfJob(failure: JobFailure): Failure {
  const data =
    failure.data && typeof failure.data === "object" && !Array.isArray(failure.data)
      ? (failure.data as Record<string, unknown>)
      : undefined;
  const organisationId = typeof data?.organisationId === "string" ? data.organisationId : undefined;
  return {
    source: "worker",
    location: failure.name,
    error: failure.error,
    jobId: failure.id,
    ...(data && Object.keys(data).length > 0 ? { context: data } : {}),
    ...(organisationId ? { organisationId } : {}),
  };
}

/** Forgets reports older than ERROR_REPORT_DAYS. */
export async function purgeErrorReports(db: Database, now = new Date()) {
  const before = new Date(now.getTime() - ERROR_REPORT_DAYS * 24 * 60 * 60 * 1000);
  const gone = await db
    .delete(schema.errorReports)
    .where(lt(schema.errorReports.occurredAt, before))
    .returning({ id: schema.errorReports.id });
  return gone.length;
}
