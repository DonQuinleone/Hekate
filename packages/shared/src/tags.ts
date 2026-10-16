import { z } from "zod";

/** A tag's name: trimmed, inner spaces collapsed, 1 to 40 characters. */
export const tagName = z
  .string()
  .transform((v) => v.trim().replace(/\s+/g, " "))
  .pipe(z.string().min(1, "A tag needs a name").max(40, "At most 40 characters"));

/** A new tag, or a tag renamed. Tags belong to the workspace, so every project shares them. */
export const tagInput = z.object({ name: tagName }).strict();
export type TagInput = z.input<typeof tagInput>;

/** The tags a file carries, all at once: the set replaces what it had. */
export const fileTagsInput = z
  .object({
    tagIds: z
      .array(z.uuid())
      .max(20, "At most 20 tags on a file")
      .refine((ids) => new Set(ids).size === ids.length, "Each tag once"),
  })
  .strict();
export type FileTagsInput = z.infer<typeof fileTagsInput>;

/** What someone can mark for themselves: folders, tracks and files. */
export const markKinds = ["folder", "track", "file"] as const;
export type MarkKind = (typeof markKinds)[number];

export const markItem = z.object({ kind: z.enum(markKinds), id: z.uuid() }).strict();
export type MarkItem = z.infer<typeof markItem>;

/**
 * Personal marks on things in a project, for one or many at once: pinned to the top of
 * their folder, kept as a favourite, or seen. Only files are seen; a track is seen when its
 * latest file is.
 */
export const markInput = z
  .object({
    items: z.array(markItem).min(1).max(500),
    pinned: z.boolean().optional(),
    favourite: z.boolean().optional(),
    viewed: z.boolean().optional(),
  })
  .strict()
  .refine(
    (m) => m.pinned !== undefined || m.favourite !== undefined || m.viewed !== undefined,
    "Say what to mark",
  )
  .refine(
    (m) => m.viewed === undefined || m.items.every((i) => i.kind === "file"),
    "Only files are marked as viewed",
  );
export type MarkInput = z.infer<typeof markInput>;

/** One thing's marks, as `GET /api/projects/:id/marks` returns them. */
export interface Mark {
  kind: MarkKind;
  id: string;
  pinned: boolean;
  favourite: boolean;
  viewed: boolean;
}

/** The ways the file browser narrows what it shows, beyond tags. */
export const browserFilters = ["comments", "unviewed", "mine", "favourites"] as const;
export type BrowserFilter = (typeof browserFilters)[number];
