import { type Database, inOrg, schema } from "@hekate/db";
import {
  CHANNEL_PAUSE_AFTER,
  CHANNEL_PAUSE_MINUTES,
  DELIVERY_ATTEMPTS,
  type EventData,
  type EventKind,
  eventData,
  eventSummary,
  retryDelaySeconds,
  type WebhookBody,
} from "@hekate/shared";
import { and, asc, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import { type ChannelConfig, outgoing, type Send } from "./channels.ts";
import type { Jobs } from "./jobs.ts";
import type { Keyring } from "./keyring.ts";
import { metrics } from "./metrics/index.ts";
import { actorName, type NotificationActor } from "./notifications.ts";
import { openSecret, sealSecret } from "./secrets.ts";

const { channels, events, eventDeliveries, projects, reviews, files, tracks, organisations } =
  schema;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Db = Database | Tx;

/**
 * The event system (#161). An event is written to the outbox in the transaction that made it
 * happen, so it is told exactly when the change commits; a job hands it to each channel that
 * carries its kind, one delivery per channel, and another job sends each delivery, again until
 * it is through or given up. A delivery is claimed before it is sent, so two workers never send
 * it twice, and it carries the event's id, so a receiver can tell a retry from a new event.
 */

/** What happened, as the place it happened in says it; names are looked up from the ids. */
export interface EventInput {
  organisationId: string;
  kind: EventKind;
  actor: NotificationActor;
  /** The page in the app it leads to. */
  path: string;
  projectId?: string | null;
  reviewId?: string | null;
  fileId?: string | null;
  trackId?: string | null;
  commentId?: string | null;
  /** What only this kind says: a decision, a version's number, a stage's name. */
  details?: Record<string, unknown>;
}

let kick: (() => void) | null = null;

/**
 * What to do once an event is written: queue its dispatch, a moment later, for after the
 * transaction commits. Set where the jobs are; the dispatch sweep runs every minute regardless.
 */
export function onEventWritten(listener: (() => void) | null) {
  kick = listener;
}

export const sealContext = (organisationId: string, channelId: string) =>
  `channel:${organisationId}:${channelId}`;

export function sealConfig(key: Buffer, config: ChannelConfig, context: string) {
  return sealSecret(key, JSON.stringify(config), context);
}

export function openConfig(key: Buffer, sealed: string, context: string): ChannelConfig {
  return JSON.parse(openSecret(key, sealed, context)) as ChannelConfig;
}

async function named<T extends { id: string; name: string }>(rows: Promise<T[]>) {
  const [row] = await rows;
  return row ? { id: row.id, name: row.name } : null;
}

/** The event's data, its names as they are now; written once, so a later rename leaves it be. */
async function describe(db: Db, input: EventInput) {
  const org = input.organisationId;
  const project = input.projectId
    ? await named(
        db
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(inOrg(projects, org, eq(projects.id, input.projectId))),
      )
    : null;
  const [review] = input.reviewId
    ? await db
        .select({ id: reviews.id, title: reviews.title, kind: reviews.kind })
        .from(reviews)
        .where(inOrg(reviews, org, eq(reviews.id, input.reviewId)))
    : [];
  const file = input.fileId
    ? await named(
        db
          .select({ id: files.id, name: files.name })
          .from(files)
          .where(inOrg(files, org, eq(files.id, input.fileId))),
      )
    : null;
  const track = input.trackId
    ? await named(
        db
          .select({ id: tracks.id, name: tracks.name })
          .from(tracks)
          .where(inOrg(tracks, org, eq(tracks.id, input.trackId))),
      )
    : null;
  const name = await actorName(db, org, input.actor);
  return {
    project,
    actor: input.actor ? { name: name ?? "Someone", guest: "guestId" in input.actor } : null,
    path: input.path,
    ...(review ? { review } : {}),
    ...(file ? { file } : {}),
    ...(track ? { track } : {}),
    ...(input.commentId ? { comment: { id: input.commentId } } : {}),
    ...input.details,
  };
}

/**
 * Write an event to the outbox, in the transaction that makes it happen. Nothing is written
 * while no channel of the workspace carries its kind: a channel hears of what happens from
 * when it is set up. Returns the event's id, or null.
 */
export async function emitEvent(db: Db, input: EventInput): Promise<string | null> {
  const [carrying] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(inOrg(channels, input.organisationId, sql`${input.kind} = any(${channels.events})`))
    .limit(1);
  if (!carrying) return null;
  const parsed = eventData[input.kind].safeParse(await describe(db, input));
  if (!parsed.success) {
    // A mistake here must not undo what happened: the event is left out, and said so.
    console.warn(`An ${input.kind} event did not fit its schema: ${parsed.error.message}`);
    return null;
  }
  const [row] = await db
    .insert(events)
    .values({ organisationId: input.organisationId, kind: input.kind, data: parsed.data })
    .returning({ id: events.id });
  kick?.();
  return row?.id ?? null;
}

type DeliveryJobs = Pick<Jobs, "send">;

/**
 * Queue a delivery's job, now or for when it is next due. Each due time has its own key, so the
 * job sending a delivery can queue its retry, and a resume is not held back by a retry queued
 * for later; the claim in `deliver` keeps any two from sending it twice.
 */
const queueDelivery = (
  jobs: DeliveryJobs,
  organisationId: string,
  id: string,
  due?: { at: Date; now: Date },
) =>
  jobs
    .send(
      "event-delivery",
      { organisationId, deliveryId: id },
      due
        ? {
            singletonKey: `${id}:${due.at.getTime()}`,
            startAfterSeconds: Math.max(
              1,
              Math.ceil((due.at.getTime() - due.now.getTime()) / 1000),
            ),
          }
        : { singletonKey: `${id}:now` },
    )
    .catch((error: unknown) =>
      // The sweep queues what is due and has no job, a minute later.
      console.warn(`Could not queue delivery ${id} now: ${String(error)}`),
    );

/**
 * Hand waiting events to their channels: one delivery for each channel that carries the kind,
 * made at most once however often this runs. Then queue what is due and has lost its job.
 * Runs as a job, a moment after each event and every minute. Returns the deliveries queued.
 */
export async function dispatchEvents(db: Database, jobs: DeliveryJobs, now = new Date()) {
  const queued: { organisationId: string; id: string }[] = [];
  for (;;) {
    const { made, more } = await db.transaction(async (tx) => {
      // Every workspace's, oldest first: the dispatcher works for all of them, each scoped below.
      const waiting = await tx
        .select({ id: events.id, organisationId: events.organisationId, kind: events.kind })
        .from(events)
        .where(isNull(events.dispatchedAt))
        .orderBy(asc(events.createdAt))
        .limit(100)
        .for("update", { skipLocked: true });
      const made: { organisationId: string; id: string }[] = [];
      for (const event of waiting) {
        const carrying = await tx
          .select({ id: channels.id })
          .from(channels)
          .where(
            inOrg(channels, event.organisationId, sql`${event.kind} = any(${channels.events})`),
          );
        if (carrying.length > 0) {
          const rows = await tx
            .insert(eventDeliveries)
            .values(
              carrying.map((c) => ({
                organisationId: event.organisationId,
                channelId: c.id,
                eventId: event.id,
              })),
            )
            .onConflictDoNothing()
            .returning({ id: eventDeliveries.id });
          made.push(...rows.map((r) => ({ organisationId: event.organisationId, id: r.id })));
        }
        await tx
          .update(events)
          .set({ dispatchedAt: now })
          .where(inOrg(events, event.organisationId, eq(events.id, event.id)));
      }
      return { made, more: waiting.length === 100 };
    });
    for (const d of made) await queueDelivery(jobs, d.organisationId, d.id);
    queued.push(...made);
    if (!more) break;
  }
  // Due a minute ago and still waiting, or claimed by a worker that stopped: queued again.
  const stale = await db
    .select({ organisationId: eventDeliveries.organisationId, id: eventDeliveries.id })
    .from(eventDeliveries)
    .where(
      or(
        and(
          eq(eventDeliveries.status, "pending"),
          lt(eventDeliveries.nextAttemptAt, new Date(now.getTime() - 60_000)),
        ),
        and(eq(eventDeliveries.status, "sending"), lt(eventDeliveries.claimedUntil, now)),
      ),
    )
    .orderBy(asc(eventDeliveries.nextAttemptAt))
    .limit(500);
  for (const d of stale) await queueDelivery(jobs, d.organisationId, d.id);
  return queued.length + stale.length;
}

export interface DeliveryDeps {
  db: Database;
  keyring: Keyring;
  jobs: DeliveryJobs;
  send: Send;
  publicUrl: string;
}

/** The body an event is sent with, from the outbox row. */
export function webhookBody(
  event: { id: string; kind: EventKind; data: Record<string, unknown>; createdAt: Date },
  workspace: { id: string; name: string },
  publicUrl: string,
): WebhookBody {
  const data = event.data as EventData;
  return {
    id: event.id,
    type: event.kind,
    createdAt: event.createdAt.toISOString(),
    workspace,
    data,
    summary: eventSummary(event.kind, data),
    url: new URL(data.path, publicUrl).toString(),
  };
}

/** What became of a delivery job. */
export type Delivered = "delivered" | "retrying" | "failed" | "paused" | "skipped" | "not_due";

/** A receiver's answer that will not change on a retry: the address is gone. */
const gone = (status: number) => status === 404 || status === 410;

/**
 * Send one delivery, if it is due and nobody else is sending it. A failure is tried again after
 * a while that doubles each time, or as long as the receiver asked; given up after
 * DELIVERY_ATTEMPTS, or at once when the address is gone. Failing CHANNEL_PAUSE_AFTER times in
 * a row pauses the channel, and what waits on it is sent when the pause runs out.
 */
export async function deliver(
  deps: DeliveryDeps,
  organisationId: string,
  deliveryId: string,
  now = new Date(),
): Promise<Delivered> {
  const { db } = deps;
  const [claimed] = await db
    .update(eventDeliveries)
    .set({ status: "sending", claimedUntil: new Date(now.getTime() + 60_000), updatedAt: now })
    .where(
      inOrg(
        eventDeliveries,
        organisationId,
        eq(eventDeliveries.id, deliveryId),
        lte(eventDeliveries.nextAttemptAt, now),
        or(
          eq(eventDeliveries.status, "pending"),
          and(eq(eventDeliveries.status, "sending"), lt(eventDeliveries.claimedUntil, now)),
        ),
      ),
    )
    .returning();
  if (!claimed) return "not_due";
  const settle = (set: Partial<typeof eventDeliveries.$inferInsert>) =>
    db
      .update(eventDeliveries)
      .set({ claimedUntil: null, updatedAt: now, ...set })
      .where(inOrg(eventDeliveries, organisationId, eq(eventDeliveries.id, deliveryId)));
  const [channel] = await db
    .select()
    .from(channels)
    .where(inOrg(channels, organisationId, eq(channels.id, claimed.channelId)));
  const [event] = await db
    .select()
    .from(events)
    .where(inOrg(events, organisationId, eq(events.id, claimed.eventId)));
  // A channel that no longer carries the kind is not sent it; a replay is asked for by name.
  if (!channel || !event || (!claimed.replayOf && !channel.events.includes(event.kind))) {
    await settle({ status: "skipped" });
    return "skipped";
  }
  if (channel.pausedUntil && channel.pausedUntil > now) {
    await settle({ status: "pending", nextAttemptAt: channel.pausedUntil });
    await queueDelivery(deps.jobs, organisationId, deliveryId, { at: channel.pausedUntil, now });
    return "paused";
  }
  const [workspace] = await db
    .select({ id: organisations.id, name: organisations.name })
    .from(organisations)
    .where(eq(organisations.id, organisationId));
  let config: ChannelConfig;
  try {
    config = openConfig(
      await deps.keyring.version(organisationId, channel.keyVersion),
      channel.configSealed,
      sealContext(organisationId, channel.id),
    );
  } catch {
    // A sealed address no key opens will not open on a retry either: given up, and said so.
    await settle({ status: "failed", lastResult: "The channel's address could not be opened" });
    return "failed";
  }
  const body = webhookBody(event, workspace ?? { id: organisationId, name: "" }, deps.publicUrl);
  const out = outgoing(channel.kind, body, {
    deliveryId: claimed.id,
    ...(config.secret ? { secret: config.secret } : {}),
    at: now,
  });
  let result: string;
  let retryAfter: number | null = null;
  let final = false;
  try {
    const answer = await deps.send(config.url, out);
    if (answer.status >= 200 && answer.status < 300) {
      metrics.webhookDeliveries.inc({ channel: channel.kind, status: "delivered" });
      await settle({
        status: "delivered",
        attempts: claimed.attempts + 1,
        lastResult: String(answer.status),
        deliveredAt: now,
      });
      await db
        .update(channels)
        .set({ failures: 0, pausedUntil: null, lastDeliveredAt: now })
        .where(inOrg(channels, organisationId, eq(channels.id, channel.id)));
      return "delivered";
    }
    result = String(answer.status);
    retryAfter = answer.retryAfter;
    final = gone(answer.status);
  } catch (error) {
    result = (error instanceof Error ? error.message : String(error)).slice(0, 200);
  }
  metrics.webhookDeliveries.inc({ channel: channel.kind, status: "failed" });
  const attempts = claimed.attempts + 1;
  const givenUp = final || attempts >= DELIVERY_ATTEMPTS;
  const wait = Math.max(retryDelaySeconds(attempts), Math.min(retryAfter ?? 0, 3600));
  const next = new Date(now.getTime() + wait * 1000);
  await settle(
    givenUp
      ? { status: "failed", attempts, lastResult: result }
      : { status: "pending", attempts, lastResult: result, nextAttemptAt: next },
  );
  // Failures in a row, counted in one statement so two workers failing at once both count.
  await db
    .update(channels)
    .set({
      failures: sql`${channels.failures} + 1`,
      pausedUntil: sql`case when ${channels.failures} + 1 >= ${CHANNEL_PAUSE_AFTER}
        then ${new Date(now.getTime() + CHANNEL_PAUSE_MINUTES * 60_000).toISOString()}::timestamptz
        else ${channels.pausedUntil} end`,
    })
    .where(inOrg(channels, organisationId, eq(channels.id, channel.id)));
  if (givenUp) return "failed";
  await queueDelivery(deps.jobs, organisationId, deliveryId, { at: next, now });
  return "retrying";
}

/** Start a paused channel again now: what waits on it is sent at once. */
export async function resumeChannel(
  db: Database,
  jobs: DeliveryJobs,
  organisationId: string,
  channelId: string,
  now = new Date(),
) {
  await db
    .update(channels)
    .set({ failures: 0, pausedUntil: null, updatedAt: now })
    .where(inOrg(channels, organisationId, eq(channels.id, channelId)));
  const waiting = await db
    .update(eventDeliveries)
    .set({ nextAttemptAt: now, updatedAt: now })
    .where(
      inOrg(
        eventDeliveries,
        organisationId,
        eq(eventDeliveries.channelId, channelId),
        eq(eventDeliveries.status, "pending"),
      ),
    )
    .returning({ id: eventDeliveries.id });
  for (const d of waiting) await queueDelivery(jobs, organisationId, d.id);
  return waiting.length;
}

/**
 * Send a past delivery's event to its channel again (#161, from the debug tools): a new
 * delivery of its own, so the log keeps both. The receiver sees the same event id.
 */
export async function replayDelivery(
  db: Database,
  jobs: DeliveryJobs,
  organisationId: string,
  deliveryId: string,
  replayedBy: string | null,
) {
  const [original] = await db
    .select()
    .from(eventDeliveries)
    .where(inOrg(eventDeliveries, organisationId, eq(eventDeliveries.id, deliveryId)));
  if (!original) return null;
  const [made] = await db
    .insert(eventDeliveries)
    .values({
      organisationId,
      channelId: original.channelId,
      eventId: original.eventId,
      replayOf: original.replayOf ?? original.id,
      replayedBy,
    })
    .returning();
  if (made) await queueDelivery(jobs, organisationId, made.id);
  return made ?? null;
}
