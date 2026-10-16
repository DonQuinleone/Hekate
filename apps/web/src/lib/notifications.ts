import type { IconName } from "~/components/icons";
import type { AppNotification } from "./queries";

/** The small mark on a notification's face: what kind of thing happened. */
export const notificationIcon: Record<AppNotification["kind"], IconName> = {
  review_requested: "review",
  decision: "check",
  reply: "comment",
  mention: "comment",
  version: "upload",
  processing_failed: "warning",
  guest_opened: "eye",
  due_soon: "clock",
};

const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Notifications in groups by when they arrived: today, yesterday, this week, earlier. */
export function byDay(list: AppNotification[], now = Date.now()) {
  const today = startOfDay(now);
  const yesterday = today - 86_400_000;
  const week = today - 6 * 86_400_000;
  const groups: [string, AppNotification[]][] = [
    ["Today", []],
    ["Yesterday", []],
    ["Earlier this week", []],
    ["Older", []],
  ];
  for (const n of list) {
    const at = new Date(n.createdAt).getTime();
    const index = at >= today ? 0 : at >= yesterday ? 1 : at >= week ? 2 : 3;
    groups[index]?.[1].push(n);
  }
  return groups.filter(([, items]) => items.length > 0);
}

/** One notification as a sentence, with the person's name where there is one. */
export const sentenceOf = (n: Pick<AppNotification, "actorName" | "text">) =>
  n.actorName ? { who: n.actorName, what: n.text } : { who: null, what: n.text };
