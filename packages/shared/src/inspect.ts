import { z } from "zod";
import type { ErrorReportRow } from "./error-reports.ts";
import type { ReviewerPermissions } from "./reviewer-permissions.ts";

/**
 * Debug tools' inspectors (#159): read-only views of what the system holds for a file, a
 * review or a session that is not working, for operators. Each is opened by an id, or by a
 * link someone pasted from the address bar.
 */

export const inspectKinds = ["file", "run", "review", "session"] as const;
export type InspectKind = (typeof inspectKinds)[number];

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** A sign-in session's id, as the auth library makes it. */
const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * What to inspect, from what was pasted: an id, or a link. A link names the file after
 * `/files/`, the review after `/reviews/` or `item=`, and a workflow run's track after
 * `/tracks/` (decision 253); otherwise its last id is taken. A session is a member's sign-in id
 * or a guest's session id. Null when nothing fits.
 */
export function inspectTarget(kind: InspectKind, input: string): string | null {
  const text = input.trim();
  if (text.length === 0 || text.length > 2000) return null;
  if (kind === "session") {
    const uuid = text.match(UUID);
    if (uuid?.length === 1 && uuid[0].length === text.length) return uuid[0].toLowerCase();
    return SESSION_ID.test(text) ? text : null;
  }
  const marker =
    kind === "file" ? ["/files/"] : kind === "run" ? ["/tracks/"] : ["/reviews/", "item="];
  for (const m of marker) {
    const at = text.lastIndexOf(m);
    if (at === -1) continue;
    const after = text.slice(at + m.length).match(UUID);
    if (after?.[0] && text.indexOf(after[0], at) === at + m.length) return after[0].toLowerCase();
  }
  const ids = text.match(UUID);
  return ids ? (ids[ids.length - 1]?.toLowerCase() ?? null) : null;
}

export const inspectFileParam = z.object({ id: z.uuid() });
export const inspectReviewParam = z.object({ id: z.uuid() });
/** A workflow run's id, or a track's, whose latest run is meant (decision 253). */
export const inspectRunParam = z.object({ id: z.uuid() });
export const inspectSessionParam = z.object({ id: z.string().regex(SESSION_ID) });

/** What the access log holds for it, by action: how many, and the latest. */
export interface AccessTally {
  action: string;
  count: number;
  last: string;
}

/** A job that touched it, from the queue. */
export interface InspectedJob {
  id: string;
  name: string;
  state: string;
  retries: number;
  createdAt: string;
  completedAt: string | null;
}

export interface Placed {
  workspace: { id: string; name: string };
  project: { id: string; name: string };
}

export interface FileInspection extends Placed {
  id: string;
  name: string;
  kind: string;
  contentType: string;
  byteSize: number;
  createdAt: string;
  uploadedBy: string | null;
  streamStatus: string;
  analysisStatus: string;
  pageCount: number | null;
  pagesDrawn: number;
  blob: {
    id: string;
    backend: string;
    key: string;
    byteSize: number;
    sha256: string | null;
    keyVersion: number;
  };
  renditions: {
    name: string;
    codecs: string;
    bandwidth: number;
    width: number | null;
    height: number | null;
    segments: number;
    keyVersion: number;
  }[];
  /** Null when the queue could not be read. */
  jobs: InspectedJob[] | null;
  errors: ErrorReportRow[];
  access: AccessTally[];
}

/**
 * A workflow run (decision 253): which node its track is at, what it waits for, and every
 * transition it made, with the clocks the queue holds for it.
 */
export interface WorkflowRunInspection extends Placed {
  id: string;
  workflowName: string;
  workflowVersion: number;
  track: { id: string; name: string };
  state: string;
  /** The track's status, as the run last set it. */
  status: string | null;
  startedAt: string;
  startedBy: string | null;
  endedAt: string | null;
  /** Nodes started and waited on: an approval, a task, an event, a clock. */
  waiting: { nodeId: string; name: string; type: string }[];
  /** Nodes one branch reached, waiting for the others. */
  joining: { nodeId: string; name: string }[];
  /** Every move, oldest first: the node that ended, how, by whom, and what followed. */
  steps: {
    at: string;
    node: string | null;
    outcome: string | null;
    by: string | null;
    effects: string[];
  }[];
  /** The track's other runs, newest first. */
  others: { id: string; workflowName: string; state: string; startedAt: string }[];
  /** The queue's jobs for it (its clocks); null when the queue could not be read. */
  jobs: InspectedJob[] | null;
}

export interface InspectedReviewer {
  id: string;
  name: string;
  email: string;
  guest: boolean;
  permissions: ReviewerPermissions;
  viewedAt: string | null;
  submittedAt: string | null;
  /** Which of the review's items they opened. */
  opened: number;
  /** A guest's sessions: how many, and when one was last used. */
  sessions: { count: number; lastSeenAt: string | null } | null;
}

export interface ReviewInspection extends Placed {
  id: string;
  title: string;
  kind: string;
  status: string;
  outcome: string | null;
  createdAt: string;
  createdBy: string | null;
  dueAt: string | null;
  completedAt: string | null;
  items: { id: string; name: string }[];
  reviewers: InspectedReviewer[];
  access: AccessTally[];
}

export interface SessionInspection {
  id: string;
  kind: "member" | "guest";
  who: { name: string; email: string };
  workspace: { id: string; name: string } | null;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  /** Ended before it expired: signed out, or a guest's link revoked. Expiry is `expiresAt`. */
  ended: boolean;
  /** How it was signed in (members): a password, a password and a second factor, a passkey. */
  factor: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  /** What the access log holds for them in that workspace since the session began. */
  access: AccessTally[];
}
