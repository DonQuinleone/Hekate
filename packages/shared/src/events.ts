import { z } from "zod";

/**
 * What happens in a workspace that its channels can carry (#161): Slack, Discord, Microsoft
 * Teams and webhooks. Each kind has a schema for what it says, so a receiver knows the shape;
 * an event names things and links to them in the app, and never carries media or a comment's
 * words.
 */
export const eventKinds = [
  "review.requested",
  "decision.recorded",
  "feedback.submitted",
  "version.arrived",
  "stage.started",
  "comment.mentioned",
  "guest.signed_in",
  "file.downloaded",
  "processing.failed",
] as const;
export type EventKind = (typeof eventKinds)[number];
export const eventKind = z.enum(eventKinds);

/** How each kind reads in the events matrix. */
export const eventLabels: Record<EventKind, string> = {
  "review.requested": "A review is requested",
  "decision.recorded": "A decision is recorded",
  "feedback.submitted": "Feedback is submitted",
  "version.arrived": "A new version arrives",
  "stage.started": "A stage starts",
  "comment.mentioned": "A comment mentions someone",
  "guest.signed_in": "A guest signs in",
  "file.downloaded": "A download happens",
  "processing.failed": "Processing fails",
};

const named = z.object({ id: z.uuid(), name: z.string() });
const reviewRef = z.object({
  id: z.uuid(),
  title: z.string(),
  kind: z.enum(["approval", "feedback", "share"]),
});

/** What every event says: where, who, and the page it leads to. */
const common = {
  project: named.nullable(),
  /** Who did it, by name; null when Hekate itself did, such as a failed job. */
  actor: z.object({ name: z.string(), guest: z.boolean() }).nullable(),
  /** The page in the app, from the instance's address: `/reviews/…`. */
  path: z.string().startsWith("/"),
};

export const eventData = {
  "review.requested": z.object({ ...common, review: reviewRef }),
  "decision.recorded": z.object({
    ...common,
    review: reviewRef,
    decision: z.enum(["approved", "changes_requested"]),
  }),
  "feedback.submitted": z.object({ ...common, review: reviewRef }),
  "version.arrived": z.object({ ...common, track: named, version: z.number().int().positive() }),
  "stage.started": z.object({ ...common, stage: z.string(), track: named }),
  "comment.mentioned": z.object({
    ...common,
    file: named,
    comment: z.object({ id: z.uuid() }),
    /** How many people it mentions; never who. */
    mentioned: z.number().int().positive(),
  }),
  "guest.signed_in": z.object(common),
  "file.downloaded": z.object({
    ...common,
    file: named,
    /** The original, or the copy for listening and viewing. */
    download: z.enum(["original", "proxy"]),
  }),
  "processing.failed": z.object({ ...common, file: named }),
} satisfies Record<EventKind, z.ZodType>;
export type EventData<K extends EventKind = EventKind> = z.infer<(typeof eventData)[K]>;

/** What a webhook receives: one event, the same however many times it is delivered. */
export interface WebhookBody<K extends EventKind = EventKind> {
  /** The event's id: a receiver that has seen it can ignore it. */
  id: string;
  type: K;
  createdAt: string;
  workspace: { id: string; name: string };
  data: EventData<K>;
  /** The event in a sentence, and the page in the app it leads to. */
  summary: string;
  url: string;
}

/** What a channel's test sends: no event, just word that the channel works. */
export interface PingBody {
  id: string;
  type: "ping";
  createdAt: string;
  workspace: { id: string; name: string };
  summary: string;
  url: string;
}

const quoted = (s: string) => `“${s}”`;
const decisionWords = { approved: "approved", changes_requested: "requested changes on" };

/** The event in one sentence, as a channel posts it. */
export function eventSummary(kind: EventKind, data: EventData): string {
  const who = data.actor?.name ?? "Hekate";
  const where = data.project ? ` in ${data.project.name}` : "";
  const d = data as Record<string, unknown>;
  const review = d.review as z.infer<typeof reviewRef> | undefined;
  const file = d.file as { name: string } | undefined;
  const track = d.track as { name: string } | undefined;
  switch (kind) {
    case "review.requested":
      return `${who} asked for ${review?.kind === "share" ? "a share" : "a review"}, ${quoted(review?.title ?? "")}${where}`;
    case "decision.recorded":
      return `${who} ${decisionWords[(d.decision as keyof typeof decisionWords) ?? "approved"]} ${quoted(review?.title ?? "")}${where}`;
    case "feedback.submitted":
      return `${who} gave feedback on ${quoted(review?.title ?? "")}${where}`;
    case "version.arrived":
      return `${who} added version ${String(d.version)} of ${track?.name ?? "a track"}${where}`;
    case "stage.started":
      return `${String(d.stage)} started on ${track?.name ?? "a track"}${where}`;
    case "comment.mentioned":
      return `${who} mentioned ${d.mentioned === 1 ? "someone" : `${String(d.mentioned)} people`} on ${file?.name ?? "a file"}${where}`;
    case "guest.signed_in":
      return `${who} signed in as a guest${data.project ? ` to ${data.project.name}` : ""}`;
    case "file.downloaded":
      return `${who} downloaded ${d.download === "original" ? "the original of " : ""}${file?.name ?? "a file"}${where}`;
    case "processing.failed":
      return `${file?.name ?? "A file"} could not be processed${where}`;
  }
}

export const channelKinds = ["slack", "discord", "teams", "webhook"] as const;
export type ChannelKind = (typeof channelKinds)[number];
export const channelKindLabels: Record<ChannelKind, string> = {
  slack: "Slack",
  discord: "Discord",
  teams: "Microsoft Teams",
  webhook: "Webhook",
};

/** Where each kind's address comes from, for the channel dialog. */
export const channelUrlHints: Record<ChannelKind, { label: string; placeholder: string }> = {
  slack: { label: "Incoming webhook address", placeholder: "https://hooks.slack.com/services/…" },
  discord: { label: "Webhook address", placeholder: "https://discord.com/api/webhooks/…" },
  teams: { label: "Workflow webhook address", placeholder: "https://…logic.azure.com/workflows/…" },
  webhook: { label: "Address", placeholder: "https://hooks.example/hekate" },
};

/**
 * What is wrong with a channel's address, or null. Every address is HTTPS (plain HTTP only
 * where the instance allows private addresses, for a receiver on the same network); Slack's
 * and Discord's are their own hosts, so a mistyped one is caught before the first event.
 */
export function channelUrlProblem(
  kind: ChannelKind,
  raw: string,
  options: { allowHttp?: boolean } = {},
): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "That is not an address";
  }
  if (url.protocol !== "https:" && !(options.allowHttp && url.protocol === "http:"))
    return "The address must start with https://";
  if (url.username || url.password) return "Put no name or password in the address";
  if (kind === "slack" && url.hostname !== "hooks.slack.com")
    return "A Slack incoming webhook starts with https://hooks.slack.com/";
  if (
    kind === "discord" &&
    !(
      ["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"].includes(
        url.hostname,
      ) && url.pathname.startsWith("/api/webhooks/")
    )
  )
    return "A Discord webhook starts with https://discord.com/api/webhooks/";
  return null;
}

/**
 * How a channel's address is shown once saved: Slack, Discord and Teams addresses are their
 * own secret, so only the host; a webhook's without its query, which may hold a token.
 */
export function channelTarget(kind: ChannelKind, raw: string): string {
  const url = new URL(raw);
  return kind === "webhook" ? `${url.origin}${url.pathname}` : url.host;
}

const channelName = z.string().trim().min(1, "Name the channel").max(80);
const channelEvents = z
  .array(eventKind)
  .max(eventKinds.length)
  .transform((kinds) => eventKinds.filter((k) => kinds.includes(k)));

export const createChannelInput = z
  .object({
    kind: z.enum(channelKinds),
    name: channelName,
    url: z.string().trim().min(1, "Give the address").max(2000),
    events: channelEvents,
  })
  .strict();
export type CreateChannelInput = z.infer<typeof createChannelInput>;

export const updateChannelInput = z
  .object({
    name: channelName.optional(),
    url: z.string().trim().min(1).max(2000).optional(),
    events: channelEvents.optional(),
    /** Start delivering again now, rather than when the pause runs out. */
    resume: z.literal(true).optional(),
    /** A webhook's new signing secret, shown once. */
    newSecret: z.literal(true).optional(),
  })
  .strict();
export type UpdateChannelInput = z.infer<typeof updateChannelInput>;

/** A channel as settings show it. Its address is never sent back, only where it points. */
export interface ChannelRow {
  id: string;
  kind: ChannelKind;
  name: string;
  target: string;
  events: EventKind[];
  /** Paused after repeated failures until this time, or by nobody. */
  pausedUntil: string | null;
  /** Failures in a row since the last delivery that worked. */
  failures: number;
  lastDeliveredAt: string | null;
  createdAt: string;
}

export const deliveryStatuses = ["pending", "sending", "delivered", "failed", "skipped"] as const;
export type DeliveryStatus = (typeof deliveryStatuses)[number];

/** One event sent to one channel, and its attempts. */
export interface DeliveryRow {
  id: string;
  channelId: string;
  eventId: string;
  kind: EventKind;
  summary: string;
  status: DeliveryStatus;
  attempts: number;
  /** The receiver's last answer: an HTTP status, or what went wrong before one. */
  lastResult: string | null;
  createdAt: string;
  deliveredAt: string | null;
  /** A replay of an earlier delivery, rather than the event as it happened. */
  replay: boolean;
}

/** A channel fails this many times in a row, and pauses. */
export const CHANNEL_PAUSE_AFTER = 5;
/** For this long; then it tries again by itself, or sooner when someone resumes it. */
export const CHANNEL_PAUSE_MINUTES = 5;
/** A delivery is tried this many times before it is given up. */
export const DELIVERY_ATTEMPTS = 6;

/** How long before the next try after `attempts` failed: 30 s, doubling, at most an hour. */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1));
}

/** Each kind in a few words, for a channel's row. */
const eventShortLabels: Record<EventKind, string> = {
  "review.requested": "review requests",
  "decision.recorded": "decisions",
  "feedback.submitted": "feedback",
  "version.arrived": "new versions",
  "stage.started": "stages",
  "comment.mentioned": "mentions",
  "guest.signed_in": "guest sign-ins",
  "file.downloaded": "downloads",
  "processing.failed": "processing failures",
};

/** What a channel carries, in words for its row: "Decisions, new versions". */
export function eventsSummary(events: readonly EventKind[]): string {
  if (events.length === 0) return "No events";
  if (events.length === eventKinds.length) return "Every event";
  if (events.length > 3) return `${events.length} kinds of event`;
  const words = events.map((e) => eventShortLabels[e]).join(", ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
