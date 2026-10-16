import { z } from "zod";

export const searchKinds = [
  "projects",
  "tracks",
  "files",
  "reviews",
  "people",
  "comments",
] as const;
export type SearchKind = (typeof searchKinds)[number];

/** One thing a search found, as `GET /api/search` returns it. */
export const searchResult = z.object({
  kind: z.enum(searchKinds),
  id: z.string(),
  label: z.string(),
  /** Where it lives: its project, or the file a comment is on. */
  hint: z.string().nullable(),
  /** Where it opens in the app, as a path. */
  link: z.string().startsWith("/"),
  projectId: z.string().nullable(),
});
export type SearchResult = z.infer<typeof searchResult>;

export const searchResponse = z.object({ results: z.array(searchResult) });
export type SearchResponse = z.infer<typeof searchResponse>;
