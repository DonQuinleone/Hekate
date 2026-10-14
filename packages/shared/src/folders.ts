import { z } from "zod";

/**
 * Folders organise a project's files (docs/domain.md). They nest; a folder's name is
 * unique among its siblings.
 */
export const itemName = z
  .string()
  .trim()
  .min(1, "A name is needed")
  .max(200)
  .refine((n) => !/[/\\]/.test(n), "A name cannot contain a slash")
  .refine((n) => n !== "." && n !== "..", "That name is reserved");

export const createFolderInput = z.object({
  name: itemName,
  /** Null or left out: at the top of the project. */
  parentId: z.uuid().nullish(),
});
export type CreateFolderInput = z.input<typeof createFolderInput>;

/** Rename a folder, move it (null is the top of the project), or both. */
export const updateFolderInput = z
  .object({ name: itemName.optional(), parentId: z.uuid().nullable().optional() })
  .refine((u) => u.name !== undefined || u.parentId !== undefined, "Nothing to change");
export type UpdateFolderInput = z.input<typeof updateFolderInput>;

/** Rename a file, move it to a folder (null is the top of the project), or both. */
export const updateFileInput = z
  .object({ name: itemName.optional(), folderId: z.uuid().nullable().optional() })
  .refine((u) => u.name !== undefined || u.folderId !== undefined, "Nothing to change");
export type UpdateFileInput = z.input<typeof updateFileInput>;

export interface FolderNode {
  id: string;
  parentId: string | null;
  name: string;
}

/** A folder and everything inside it, at any depth. */
export function descendantsOf(folders: FolderNode[], id: string): Set<string> {
  const found = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of folders) {
      if (f.parentId && found.has(f.parentId) && !found.has(f.id)) {
        found.add(f.id);
        grew = true;
      }
    }
  }
  return found;
}

/**
 * Whether a folder may move under a new parent (null is the top): never into itself or
 * anything inside it, which would cut it off from the project.
 */
export function canMoveFolder(folders: FolderNode[], id: string, parentId: string | null) {
  return parentId === null || !descendantsOf(folders, id).has(parentId);
}

/** The folders from the top of the project down to this one, for breadcrumbs. */
export function folderPath(folders: FolderNode[], id: string | null): FolderNode[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const path: FolderNode[] = [];
  const seen = new Set<string>();
  let at = id ? byId.get(id) : undefined;
  while (at && !seen.has(at.id)) {
    seen.add(at.id);
    path.unshift(at);
    at = at.parentId ? byId.get(at.parentId) : undefined;
  }
  return path;
}
