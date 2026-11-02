/**
 * What a person opened lately in a workspace (#618): the sidebar's Recent (the last files,
 * tracks and reviews) and the project switcher's order. Kept in this browser for each person
 * and workspace, as Linear keeps its recent views; storage can be missing or refuse, and then
 * nothing is remembered beyond the visit.
 */
export type RecentKind = "file" | "track" | "review" | "project";
export interface Opened {
  kind: RecentKind;
  id: string;
  /** When it was last opened, in milliseconds. */
  at: number;
}

/** Kept per kind; the sidebar shows fewer. */
const KEPT = 12;
export const RECENT_SHOWN = 5;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What an address opens, if it is a page Recent remembers. */
export function openedAt(pathname: string): Pick<Opened, "kind" | "id"> | null {
  const [, head = "", id = "", rest] = pathname.split("/");
  if (!UUID.test(id)) return null;
  if (head === "files" && rest === undefined) return { kind: "file", id };
  if (head === "tracks" && rest === undefined) return { kind: "track", id };
  if (head === "reviews" && rest === undefined) return { kind: "review", id };
  if (head === "projects") return { kind: "project", id };
  return null;
}

/** The list with this opening at its head: once each, newest first, a few of each kind. */
export function withOpened(list: Opened[], next: Opened): Opened[] {
  const rest = list.filter((o) => !(o.kind === next.kind && o.id === next.id));
  const all = [next, ...rest].sort((a, b) => b.at - a.at);
  const counts = new Map<RecentKind, number>();
  return all.filter((o) => {
    const n = (counts.get(o.kind) ?? 0) + 1;
    counts.set(o.kind, n);
    return n <= KEPT;
  });
}

/** The sidebar's Recent: files, tracks and reviews, newest first, without the page open now. */
export function recentShown(list: Opened[], here: Pick<Opened, "kind" | "id"> | null): Opened[] {
  return list
    .filter((o) => o.kind !== "project")
    .filter((o) => !(here && o.kind === here.kind && o.id === here.id))
    .slice(0, RECENT_SHOWN);
}

const byName = new Intl.Collator("en-GB", { sensitivity: "base", numeric: true });

/**
 * The switcher's projects: the open one first, then the most recently opened, then the rest by
 * name, so the order is the same each time it opens.
 */
export function switcherOrder<P extends { id: string; name: string }>(
  projects: P[],
  currentId: string | undefined,
  list: Opened[],
): P[] {
  const last = new Map(list.filter((o) => o.kind === "project").map((o) => [o.id, o.at]));
  const rank = (p: P) => (p.id === currentId ? Number.POSITIVE_INFINITY : (last.get(p.id) ?? -1));
  return [...projects].sort((a, b) => rank(b) - rank(a) || byName.compare(a.name, b.name));
}

const keyOf = (userId: string, organisationId: string) =>
  `hekate.recent.${userId}.${organisationId}`;

/** What is remembered, or nothing where storage is missing or holds something else. */
export function readOpened(userId: string, organisationId: string): Opened[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(keyOf(userId, organisationId)) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (o): o is Opened =>
        typeof o === "object" &&
        o !== null &&
        ["file", "track", "review", "project"].includes((o as Opened).kind) &&
        typeof (o as Opened).id === "string" &&
        UUID.test((o as Opened).id) &&
        typeof (o as Opened).at === "number",
    );
  } catch {
    return [];
  }
}

export function writeOpened(userId: string, organisationId: string, list: Opened[]) {
  try {
    localStorage.setItem(keyOf(userId, organisationId), JSON.stringify(list));
  } catch {
    // Not remembered; Recent still holds it for this visit.
  }
}
