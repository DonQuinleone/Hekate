import type { Item } from "./browser";

/**
 * What a new review asks about, by key (#501): `track:<id>`, `file:<id>`, `folder:<id>` (all
 * of it, files added later included) or `workspace` (every project, present and future).
 */
export const WORKSPACE_KEY = "workspace";

export const keyOf = (item: Item) => `${item.kind}:${item.id}`;

/** Every key beneath a folder: its folders, tracks and files, however deep. */
export function keysBeneath(
  children: (folderId: string | null) => Item[],
  folderId: string,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>([folderId]);
  const walk = (id: string) => {
    for (const item of children(id)) {
      if (item.kind === "version") continue;
      out.push(keyOf(item));
      if (item.kind === "folder" && !seen.has(item.id)) {
        seen.add(item.id);
        walk(item.id);
      }
    }
  };
  walk(folderId);
  return out;
}

/**
 * Every key something chosen already covers: all of them with the workspace, else what is
 * beneath each chosen folder. A covered row shows ticked and cannot be changed on its own.
 */
export function coveredKeys(
  chosen: ReadonlySet<string> | ReadonlyMap<string, unknown>,
  children: (folderId: string | null) => Item[],
): Set<string> | "all" {
  if (chosen.has(WORKSPACE_KEY)) return "all";
  const out = new Set<string>();
  for (const key of chosen.keys()) {
    if (!key.startsWith("folder:")) continue;
    for (const under of keysBeneath(children, key.slice("folder:".length))) out.add(under);
  }
  return out;
}

/** How a folder's box reads: on when chosen or covered, mixed when something beneath is chosen. */
export function folderTick(
  key: string,
  chosen: ReadonlySet<string> | ReadonlyMap<string, unknown>,
  covered: Set<string> | "all",
  beneath: readonly string[],
): "on" | "mixed" | "off" {
  if (covered === "all" || chosen.has(key) || covered.has(key)) return "on";
  return beneath.some((k) => chosen.has(k)) ? "mixed" : "off";
}

/**
 * The keys chosen once one is toggled: a key chosen is let go; one taken clears what it
 * covers (the workspace, everything; a folder, what is beneath it), since the review stores
 * the place and not the things in it.
 */
export function toggleScope<V>(
  chosen: ReadonlyMap<string, V>,
  key: string,
  fresh: V,
  children: (folderId: string | null) => Item[],
): Map<string, V> {
  const next = new Map(chosen);
  if (next.has(key)) {
    next.delete(key);
    return next;
  }
  if (key === WORKSPACE_KEY) next.clear();
  else {
    next.delete(WORKSPACE_KEY);
    if (key.startsWith("folder:")) {
      for (const under of keysBeneath(children, key.slice("folder:".length))) next.delete(under);
    }
  }
  next.set(key, fresh);
  return next;
}
