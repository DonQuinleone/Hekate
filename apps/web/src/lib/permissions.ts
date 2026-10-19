import {
  type ReviewerPermissions,
  type ReviewerPermissionsChange,
  type ReviewerTool,
  type ReviewKind,
  reviewerTools,
  type StandingGrant,
} from "@hekate/shared";
import { formatDates } from "./locale";

const moment = formatDates({
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
const at = (iso: string) => moment.format(new Date(iso));

const toolNames: Record<ReviewerTool, string> = {
  spectrogram: "spectrogram",
  meters: "meters",
  loops: "loops",
  compare: "compare",
  qa: "QA",
  score: "score",
};

/**
 * Where a reviewer's permissions depart from the defaults, in a few words each, for one
 * line under their name: what someone checking the review needs to notice. A member's
 * comments and tools follow their project role, so only a guest's are mentioned.
 */
export function permissionSummary(
  p: ReviewerPermissions,
  kind: ReviewKind,
  guest = true,
): string[] {
  const notes: string[] = [];
  if (guest && p.comments === "own_and_replies") notes.push("Sees own comments and replies");
  if (guest && p.comments === "own") notes.push("Sees only own comments");
  // A share never takes comments, so saying so of each person says nothing.
  if (guest && !p.comment && kind !== "share") notes.push("Cannot comment");
  if (kind === "approval" && !p.decide) notes.push("No decision");
  if (p.invite) notes.push("May invite others");
  const missing = (Object.keys(toolNames) as ReviewerTool[]).filter((t) => !p.tools.includes(t));
  if (guest && missing.length > 0) notes.push(`No ${missing.map((t) => toolNames[t]).join(", ")}`);
  if (guest && p.history) notes.push("Sees earlier versions");
  if (guest && p.items) notes.push(`${p.items.length} ${p.items.length === 1 ? "item" : "items"}`);
  if (guest && p.maxPlays)
    notes.push(`${p.maxPlays} ${p.maxPlays === 1 ? "play" : "plays"} a file`);
  if (guest && p.download && p.download !== "none") notes.push(`Downloads the ${p.download}`);
  if (p.startsAt) notes.push(`From ${at(p.startsAt)}`);
  if (p.expiresAt) notes.push(`Until ${at(p.expiresAt)}`);
  return notes;
}

/** For a guest's list: when a review opens or closes to them, if that matters now. */
export function accessNote(
  review: { opensAt: string | null; closesAt: string | null; accessOpen: boolean },
  now = new Date(),
): string | null {
  if (review.accessOpen) return review.closesAt ? `open until ${at(review.closesAt)}` : null;
  if (review.opensAt && Date.parse(review.opensAt) > now.getTime())
    return `opens ${at(review.opensAt)}`;
  return review.closesAt ? `closed ${at(review.closesAt)}` : "closed";
}

/** A moment as a `datetime-local` field shows it, in this browser's time zone. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** And back: what the field holds, as an instant; empty is none. */
export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * What a project's People page keeps for someone (#55): only where the permissions chosen depart
 * from the workspace's defaults, so a later change to a default still reaches them. Nothing
 * departs, nothing is kept (null).
 */
export function standingChange(
  defaults: ReviewerPermissions,
  chosen: ReviewerPermissionsChange,
): StandingGrant | null {
  const change: StandingGrant = {};
  const sameTools = (a: readonly ReviewerTool[], b: readonly ReviewerTool[]) =>
    reviewerTools.every((t) => a.includes(t) === b.includes(t));
  if (chosen.comment !== undefined && chosen.comment !== defaults.comment)
    change.comment = chosen.comment;
  if (chosen.decide !== undefined && chosen.decide !== defaults.decide)
    change.decide = chosen.decide;
  if (chosen.invite !== undefined && chosen.invite !== defaults.invite)
    change.invite = chosen.invite;
  if (chosen.comments !== undefined && chosen.comments !== defaults.comments)
    change.comments = chosen.comments;
  if (chosen.tools !== undefined && !sameTools(chosen.tools, defaults.tools))
    change.tools = reviewerTools.filter((t) => chosen.tools?.includes(t));
  if (chosen.download !== undefined && chosen.download !== defaults.download)
    change.download = chosen.download;
  if (chosen.history !== undefined && chosen.history !== defaults.history)
    change.history = chosen.history;
  if (chosen.maxPlays !== undefined && chosen.maxPlays !== defaults.maxPlays)
    change.maxPlays = chosen.maxPlays;
  return Object.keys(change).length > 0 ? change : null;
}
