import { z } from "zod";

/**
 * The instance's Queues (decision 250): every pg-boss queue with what waits, runs and failed in
 * it, the jobs that ran last, and what an operator may do about them: run failures again, pause
 * a queue (kept in the instance's settings, so it outlasts a restart) and drain one.
 */

/** A queue's name, as the server's job definitions spell them. */
export const QUEUE_NAME = /^[a-z][a-z0-9-]{0,63}$/;

export const queueParam = z.object({ name: z.string().regex(QUEUE_NAME) });
export const queueJobParam = z.object({ name: z.string().regex(QUEUE_NAME), id: z.uuid() });
/** Pausing or resuming one queue, or every one. */
export const queuePauseInput = z.object({ paused: z.boolean() });

/** The most queues the settings may hold as paused: more than there are kinds of job. */
export const MAX_PAUSED_QUEUES = 64;
export const pausedQueues = z.array(z.string().regex(QUEUE_NAME)).max(MAX_PAUSED_QUEUES);

/** What each queue does, in a few words, for its row. Every queue the server defines has one. */
export const queueHints: Record<string, string> = {
  "media-probe": "Measures each upload",
  "media-proxy": "Streaming renditions",
  "media-reproxy": "Streaming renditions made again",
  "media-analysis": "Waveforms, loudness, spectrograms",
  "spectrogram-variant": "Spectrograms with a viewer's settings",
  "spectrogram-variants-expire": "Removes spectrograms unused for 30 days",
  "document-render": "Score and document pages",
  "media-align": "Where two versions line up",
  "blob-checksum": "Checksums of finished uploads",
  "logs-retention": "Trims each log to its retention",
  "sign-in-attempts-purge": "Forgets old sign-in attempts",
  "uploads-expire": "Ends uploads never finished",
  "alignments-sweep": "Alignments that lost their job",
  "release-check": "Reads the releases feed",
  "notifications-mail": "Notifications by mail",
  "events-dispatch": "Hands events to their channels",
  "event-delivery": "Webhooks: Slack, Discord, custom",
  "notifications-digest": "Hourly and daily digests",
  "workflow-wait": "Workflow clocks that ran out",
  "workflow-checks": "Workflow checks on measured files",
  "workflow-waits-sweep": "Workflow clocks no job ended",
  "reviews-remind": "Reminders of reviews and tasks due",
  "organisation-rewrap": "Rewraps after a key rotation",
  "workspaces-purge": "Deletes workspaces past their grace",
  "workspace-export": "Workspace exports",
  "usage-refresh": "Counts each workspace's month",
  "billing-dunning": "Warns and suspends unpaid workspaces",
  "storage-reconcile": "Storage checked against the database",
};

export const queueJobStates = [
  "created",
  "retry",
  "active",
  "completed",
  "cancelled",
  "failed",
] as const;
export type QueueJobState = (typeof queueJobStates)[number];

export interface QueueRow {
  name: string;
  /** The worker lane it runs in: transcode, analyse, pages, mail or system. */
  lane: string;
  hint: string;
  /** Run on a schedule rather than when something happens. */
  scheduled: boolean;
  /** Queued, including retries waiting their turn. */
  waiting: number;
  active: number;
  /** Failed for good and still kept by the queue. */
  failed: number;
  /** How long the 95th percentile of its jobs took in the last day; null with none finished. */
  p95Seconds: number | null;
  /** Paused by an operator: its workers take nothing until it is resumed. */
  paused: boolean;
}

/** One job, as the list of recent ones shows it. */
export interface QueueJobRow {
  id: string;
  queue: string;
  state: QueueJobState;
  /** What it was for, where its data names something: a file, a channel, a track. */
  what: string | null;
  workspace: { id: string; name: string } | null;
  /** When it last moved: finished, started, or was queued. */
  at: string;
  /** The error report its last failure left, where it failed. */
  reference: string | null;
}

export interface QueuesView {
  queues: QueueRow[];
  recent: QueueJobRow[];
  /** Maintenance mode holds every queue whatever is paused (#154). */
  maintenance: boolean;
}

/** One job in full, for its Details. */
export interface QueueJobDetail extends QueueJobRow {
  /** Its data: identifiers only, never media or secrets. */
  data: Record<string, unknown> | null;
  attempts: number;
  retryLimit: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  /** What its last failure said, where it failed. */
  error: string | null;
}

/**
 * What running failures again did: how many run again, and how many were only cleared from the
 * queue, as their file has since been prepared or removed.
 */
export interface QueueRetryResult {
  retried: number;
  cleared: number;
}

/** A job's time, as the queue table shows it: 0.8 s, 41 s, 2 min, 1.5 h. */
export function formatJobSeconds(seconds: number): string {
  if (seconds < 10) return `${Math.round(seconds * 10) / 10} s`;
  if (seconds < 120) return `${Math.round(seconds)} s`;
  if (seconds < 2 * 60 * 60) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 360) / 10} h`;
}
