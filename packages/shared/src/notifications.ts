import { z } from "zod";

/**
 * What tells a member something happened (docs/domain.md, Notifications). Each kind can reach
 * them in the app, by mail, or both, as they choose; some always reach them in the app.
 */
export const notificationKinds = [
  /** A review asks for your decision or feedback. */
  "review_requested",
  /** A reviewer decided, or submitted feedback, on a review you asked for. */
  "decision",
  /** Someone replied in a thread you started or took part in. */
  "reply",
  /** Someone mentioned you in a comment. */
  "mention",
  /** A new version of a track you follow. */
  "version",
  /** A file you uploaded could not be processed. */
  "processing_failed",
  /** A guest opened a review you asked for. */
  "guest_opened",
] as const;
export type NotificationKind = (typeof notificationKinds)[number];
export const notificationKind = z.enum(notificationKinds);

export interface NotificationChannels {
  app: boolean;
  mail: boolean;
}

/** How each kind reaches someone who has not chosen. */
export const notificationDefaults: Record<NotificationKind, NotificationChannels> = {
  review_requested: { app: true, mail: true },
  decision: { app: true, mail: true },
  reply: { app: true, mail: true },
  mention: { app: true, mail: true },
  version: { app: true, mail: false },
  processing_failed: { app: true, mail: true },
  guest_opened: { app: false, mail: false },
};

/** Reviews asked of you and mentions always reach you in the app, whatever you choose. */
export const alwaysInApp: readonly NotificationKind[] = ["review_requested", "mention"];

export const mailModes = ["instant", "digest"] as const;
export type MailMode = (typeof mailModes)[number];
export const digestFrequencies = ["hourly", "daily"] as const;
export type DigestFrequency = (typeof digestFrequencies)[number];
/** A daily digest goes out at this hour, UTC. */
export const DAILY_DIGEST_HOUR_UTC = 8;

export const notificationPreferencesInput = z.object({
  mailMode: z.enum(mailModes),
  digest: z.enum(digestFrequencies),
  kinds: z.partialRecord(
    notificationKind,
    z.object({ app: z.boolean(), mail: z.boolean() }).strict(),
  ),
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesInput>;

export const defaultNotificationPreferences: NotificationPreferences = {
  mailMode: "instant",
  digest: "daily",
  kinds: {},
};

/**
 * How one kind reaches someone, from their choices over the defaults. A kind that always
 * reaches you in the app stays on there, whatever was saved.
 */
export function channelsFor(
  preferences: Pick<NotificationPreferences, "kinds">,
  kind: NotificationKind,
): NotificationChannels {
  const chosen = preferences.kinds[kind] ?? notificationDefaults[kind];
  return { app: chosen.app || alwaysInApp.includes(kind), mail: chosen.mail };
}

export const followInput = z.union([
  z.object({ trackId: z.uuid() }).strict(),
  z.object({ reviewId: z.uuid() }).strict(),
]);
export type FollowInput = z.infer<typeof followInput>;

/**
 * The members a comment mentions: each `@` followed by someone's full name, matched without
 * regard to case and only where the name ends at a word boundary. Longer names win, so
 * "@Ines Arlow" is not also read as a mention of someone called "Ines".
 */
export function mentionedIn<P extends { id: string; name: string }>(
  body: string,
  people: P[],
): P[] {
  const lower = body.toLowerCase();
  const found = new Map<string, P>();
  const taken: [number, number][] = [];
  const byLength = [...people]
    .filter((p) => p.name.trim())
    .sort((a, b) => b.name.length - a.name.length);
  for (const person of byLength) {
    const needle = `@${person.name.trim().toLowerCase()}`;
    let at = lower.indexOf(needle);
    while (at !== -1) {
      const end = at + needle.length;
      const next = lower[end];
      const bounded = next === undefined || !/[\p{L}\p{N}_]/u.test(next);
      const overlaps = taken.some(([s, e]) => at < e && end > s);
      if (bounded && !overlaps) {
        found.set(person.id, person);
        taken.push([at, end]);
      }
      at = lower.indexOf(needle, at + 1);
    }
  }
  return [...found.values()];
}
