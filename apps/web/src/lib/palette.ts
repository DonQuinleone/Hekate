import type { IconName } from "~/components/icons";

export type HitGroup =
  | "Jump to"
  | "Recent"
  | "Actions"
  | "Projects"
  | "Tracks"
  | "Files"
  | "Reviews"
  | "People"
  | "Comments";

/** One thing the palette offers: somewhere to go, or something to do. */
export interface Hit {
  id: string;
  group: HitGroup;
  label: string;
  /** Where it lives, or what it does. */
  hint?: string | null;
  icon: IconName;
  /** A key the action also answers to, such as "G H". */
  shortcut?: string;
  /** A path in the app; or `run` for an action that is not a place. */
  link?: string;
  run?: () => void;
}

/** How well `text` answers `query`: a prefix beats a word start beats a mention beats scattered letters. */
export function score(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const t = text.toLowerCase();
  if (t.startsWith(q)) return 4;
  if (t.split(/[\s·:,/-]+/).some((w) => w.startsWith(q))) return 3;
  if (t.includes(q)) return 2;
  // Scattered letters count only once the query is long enough to mean something.
  if (q.length < 3) return 0;
  let i = 0;
  for (const ch of t) if (ch === q[i]) i += 1;
  return i === q.length ? 1 : 0;
}

/** The hits that answer a query, best first, keeping their order among equals. */
export const matches = (query: string, hits: Hit[], limit = 8) =>
  hits
    .map((hit, i) => ({ hit, i, s: score(query, hit.label) }))
    .filter((h) => h.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit)
    .map((h) => h.hit);

/** Recents are kept per person and workspace, so nothing from one reaches another. */
const recentKey = (scope: string) => `hekate.palette.recent.${scope}`;
const RECENT_MAX = 5;
type Stored = Pick<Hit, "id" | "label" | "hint" | "icon" | "link">;

/** What was opened from the palette lately, newest first; storage may be missing or refuse. */
export function readRecent(
  scope: string,
  storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage,
): Hit[] {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(recentKey(scope)) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (h): h is Stored =>
          typeof h === "object" &&
          h !== null &&
          typeof h.id === "string" &&
          typeof h.label === "string" &&
          typeof h.link === "string" &&
          h.link.startsWith("/"),
      )
      .slice(0, RECENT_MAX)
      .map((h) => ({ ...h, group: "Recent" as const }));
  } catch {
    return [];
  }
}

/** Remember a place opened from the palette, at the top, once. */
export function rememberRecent(
  hit: Hit,
  scope: string,
  storage: Pick<Storage, "getItem" | "setItem"> | undefined = globalThis.localStorage,
) {
  if (!hit.link || hit.group === "Jump to" || hit.group === "Actions") return;
  try {
    const kept = readRecent(scope, storage).filter((h) => h.link !== hit.link);
    const next: Stored[] = [
      { id: hit.id, label: hit.label, hint: hit.hint ?? null, icon: hit.icon, link: hit.link },
      ...kept.map(({ id, label, hint, icon, link }) => ({ id, label, hint, icon, link })),
    ].slice(0, RECENT_MAX);
    storage?.setItem(recentKey(scope), JSON.stringify(next));
  } catch {
    // A browser that refuses storage simply has no recents.
  }
}
