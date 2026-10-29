import {
  type CreateReviewInput,
  capital,
  type FileKind,
  type GuestInput,
  type ItemWords,
  type ReviewerInput,
  type ReviewItemInput,
} from "@hekate/shared";
import { type Item, itemsIn } from "./browser";
import type { Folder, ProjectFile, Track } from "./queries";

/** The end of a chosen day, where the person sharing is: when a share closes to them (#138). */
export const endOfDay = (day: string) => new Date(`${day}T23:59:59`).toISOString();

/**
 * One of a share's people as the share's page lists them (#138): whether they opened it and
 * when, and, for those who run it, how often they played and downloaded what it shares.
 */
export function shareLine(
  person: { viewedAt: string | null; usage: { plays: number; downloads: number } | null },
  ago: (at: string) => string,
): string {
  const opened = person.viewedAt ? `Opened ${ago(person.viewedAt)}` : "Not opened";
  if (!person.usage) return opened;
  const { plays, downloads } = person.usage;
  return [
    opened,
    `${plays} ${plays === 1 ? "play" : "plays"}`,
    ...(downloads > 0 ? [`${downloads} ${downloads === 1 ? "download" : "downloads"}`] : []),
  ].join(" · ");
}

/**
 * What a share gives the person it is shared with (#138), in a sentence or two: how often
 * and until when, then what they may keep. A limit on plays leads, so nobody reads it as
 * unlimited.
 */
export function shareNote(
  permissions: { expiresAt: string | null; maxPlays: number | null; download: string } | null,
  date: (at: string) => string,
): string {
  const n = permissions?.maxPlays;
  const lead = n
    ? `Up to ${n} ${n === 1 ? "play" : "plays"} of each file`
    : "Listen as often as you like";
  const until = permissions?.expiresAt ? date(permissions.expiresAt) : "it is withdrawn";
  const keep =
    permissions?.download && permissions.download !== "none"
      ? ` You may download the ${permissions.download}; each copy is marked for you.`
      : "";
  return `${lead} until ${until}.${keep}`;
}

/**
 * Sharing one item (#489): what the people it is shared with may do, as a share sheet asks
 * it. Viewing is a share (#138), which has no comments by design; commenting, and downloading
 * with it, are a feedback review, which asks for comments and no sign-off.
 */
export const shareAccesses = ["view", "comment", "download"] as const;
export type ShareAccess = (typeof shareAccesses)[number];

export const shareAccessCopy: Record<ShareAccess, { label: string; hint: string }> = {
  view: { label: "Can view", hint: "They listen or look. Nothing is asked of them." },
  comment: { label: "Can comment", hint: "They leave comments on it. No sign-off is asked." },
  download: {
    label: "Can download",
    hint: "They comment, and download the original, watermarked for them.",
  },
};

/** How long a link works: a week unless chosen otherwise; null is until it is withdrawn. */
export const linkLives = [7, 14, 30, null] as const;
export type LinkLife = (typeof linkLives)[number];

export const linkLifeWords = (life: LinkLife) =>
  life === null ? "Link works until withdrawn" : `Link works for ${life} days`;

/** A life as its menu names it. */
export const linkLifeChoice = (life: LinkLife) =>
  life === null ? "Until withdrawn" : `${life} days`;

/** When a link of that life ends, from now; null never. */
export const linkEnd = (life: LinkLife, now: Date): string | null =>
  life === null ? null : new Date(now.getTime() + life * 86_400_000).toISOString();

/**
 * Someone the sheet is given by email alone (#489): a guest needs a name, and the address's
 * local part is the best there is ("anna.berg" reads as Anna Berg). They can be renamed on
 * the project's People page.
 */
export function guestFromEmail(email: string): GuestInput {
  const address = email.trim().toLowerCase();
  const local = address.split("@")[0] ?? "";
  const name = local
    .split(/[._\-+]+/)
    .filter((part) => /[a-z]/i.test(part))
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return { name: name || address, email: address };
}

/** A person as the sheet keys them: a member by user id, a group, or a guest by email. */
export type PersonKey = `member:${string}` | `group:${string}` | `guest:${string}`;

export const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A key as the reviews API asks for the person; a guest not yet known is named from their address. */
export function reviewerFromKey(
  key: string,
  known: ReadonlyMap<string, GuestInput>,
): ReviewerInput {
  const [type, id = ""] = key.split(/:(.*)/s) as [string, string];
  if (type === "member") return id;
  if (type === "group") return { groupId: id };
  return known.get(id) ?? guestFromEmail(id);
}

/** What the sheet is opened from (#489): one item, named and known by kind. */
export interface ShareTarget {
  kind: "file" | "track" | "folder" | "version";
  id: string;
  name: string;
  /** A version's track. */
  trackId?: string;
  /** What it is, under the name: "Audio", "Track", "Version 3". The kind, when left out. */
  what?: string;
}

/** A file's kind, as the sheet names it under the file's name. */
export const fileKindWords: Record<FileKind, string> = {
  audio: "Audio",
  video: "Video",
  document: "Document",
  image: "Image",
  other: "File",
};

/** A browser's item as the sheet is opened on it: a version is named with its track. */
export function shareTargetOf(
  item: Item,
  words: ItemWords,
  versionLabel: (n: number) => string,
): ShareTarget {
  switch (item.kind) {
    case "folder":
      return { kind: "folder", id: item.id, name: item.folder.name };
    case "track":
      return { kind: "track", id: item.id, name: item.track.name, what: capital(words.track) };
    case "version":
      return {
        kind: "version",
        id: item.version.id,
        trackId: item.track.id,
        name: `${item.track.name} ${versionLabel(item.version.number)}`,
        what: capital(words.version),
      };
    case "file":
      return {
        kind: "file",
        id: item.id,
        name: item.file.name,
        what: fileKindWords[item.file.kind],
      };
  }
}

/** Where the target opens in the app: the address the sheet offers to copy. */
export function targetPath(target: ShareTarget, projectId: string): string {
  switch (target.kind) {
    case "file":
      return `/files/${target.id}`;
    case "track":
      return `/tracks/${target.id}`;
    case "version":
      return `/tracks/${target.trackId ?? ""}?view=versions`;
    case "folder":
      return `/projects/${projectId}/files?folder=${target.id}`;
  }
}

/**
 * What a target asks the reviews API about: a track at its latest version, a version of
 * its track, a file, or everything in a folder (its tracks with a version, and its loose
 * files, at every depth; the folder itself is nothing to share).
 */
export function targetItems(
  target: ShareTarget,
  within: { folders: Folder[]; tracks: Track[]; files: ProjectFile[] },
): ReviewItemInput[] {
  if (target.kind === "file") return [{ fileId: target.id }];
  if (target.kind === "track") return [{ trackId: target.id }];
  if (target.kind === "version") return [{ trackId: target.trackId ?? "", versionId: target.id }];
  const { folders, tracks, files } = within;
  const under = (folderId: string): ReviewItemInput[] =>
    itemsIn(folders, tracks, files, folderId).flatMap((item) =>
      item.kind === "folder"
        ? under(item.id)
        : item.kind === "track"
          ? item.track.versions.length > 0
            ? [{ trackId: item.id }]
            : []
          : item.kind === "file"
            ? [{ fileId: item.id }]
            : [],
    );
  return under(target.id);
}

/** The request a sheet sends: its level, its people, its items and how long it works. */
export function shareRequest(input: {
  access: ShareAccess;
  life: LinkLife;
  items: ReviewItemInput[];
  reviewers: ReviewerInput[];
  now: Date;
}): CreateReviewInput {
  const { access, life, items, reviewers, now } = input;
  const expiresAt = linkEnd(life, now);
  if (access === "view") {
    return { kind: "share", items, reviewers, permissions: { download: "none", expiresAt } };
  }
  return {
    kind: "feedback",
    items,
    reviewers,
    permissions: {
      comment: true,
      download: access === "download" ? "original" : "none",
      expiresAt,
    },
  };
}
