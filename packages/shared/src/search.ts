import { z } from "zod";
import { fileKinds } from "./files.ts";

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

export const searchSince = ["week", "month", "year"] as const;
export type SearchSince = (typeof searchSince)[number];

/**
 * What narrows a search: one kind of thing, one project, one person (who uploaded a file,
 * wrote a comment or asked for a review), a kind of file, a tag (files only), and how recent.
 * All optional.
 */
export const searchFilters = z
  .object({
    kind: z.enum(searchKinds).optional(),
    projectId: z.uuid().optional(),
    personId: z.string().min(1).max(100).optional(),
    fileKind: z.enum(fileKinds).optional(),
    tagId: z.uuid().optional(),
    since: z.enum(searchSince).optional(),
  })
  .strict();
export type SearchFilters = z.infer<typeof searchFilters>;

/** The words and filters of a search, as typed and as saved. */
export const searchRequest = searchFilters.extend({ q: z.string().trim().max(200) }).strict();
export type SearchRequest = z.infer<typeof searchRequest>;

/** Whether anything narrows the search beyond its words. */
export const narrowed = (f: SearchFilters) =>
  Boolean(f.kind || f.projectId || f.personId || f.fileKind || f.tagId || f.since);

/** The oldest moment a `since` filter lets through. */
export function sinceDate(since: SearchSince, now = Date.now()): Date {
  const day = 24 * 60 * 60 * 1000;
  const days = since === "week" ? 7 : since === "month" ? 30 : 365;
  return new Date(now - days * day);
}

/** A search someone kept, to run again from the search page. */
export const savedSearchInput = z
  .object({ name: z.string().trim().min(1).max(60), search: searchRequest })
  .strict();
export type SavedSearchInput = z.infer<typeof savedSearchInput>;
