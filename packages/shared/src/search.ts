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

/** The frame rates a search offers, as people say them. */
export const searchFrameRates = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60] as const;

/** How close a file's measured frame rate must be to the one asked for (23.976 is 24000/1001). */
export const FRAME_RATE_TOLERANCE = 0.01;

/** A longest search by duration: a day, in seconds. */
const MAX_DURATION = 86_400;
/** A largest search by size: a petabyte, in bytes. */
const MAX_SIZE = 1e15;

/**
 * What narrows a search: one kind of thing, one project, one person (who uploaded a file,
 * wrote a comment or asked for a review), a kind of file, a tag (files only), and how recent;
 * and, by field (decision 263), a file's duration and size as ranges, its frame rate, and
 * what its comments say. All optional.
 */
export const searchFilters = z
  .object({
    kind: z.enum(searchKinds).optional(),
    projectId: z.uuid().optional(),
    personId: z.string().min(1).max(100).optional(),
    fileKind: z.enum(fileKinds).optional(),
    tagId: z.uuid().optional(),
    since: z.enum(searchSince).optional(),
    /** Seconds, at least and at most. */
    durationMin: z.coerce.number().min(0).max(MAX_DURATION).optional(),
    durationMax: z.coerce.number().min(0).max(MAX_DURATION).optional(),
    /** Bytes, at least and at most. */
    sizeMin: z.coerce.number().int().min(0).max(MAX_SIZE).optional(),
    sizeMax: z.coerce.number().int().min(0).max(MAX_SIZE).optional(),
    /** Frames per second, within `FRAME_RATE_TOLERANCE`. */
    frameRate: z.coerce.number().positive().max(1000).optional(),
    /** Words a comment says: comments that say them, and the files they are on. */
    commentText: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
export type SearchFilters = z.infer<typeof searchFilters>;

/** The filters that only a file has: its duration, size and frame rate. */
export const fileFields = (f: SearchFilters) =>
  f.durationMin !== undefined ||
  f.durationMax !== undefined ||
  f.sizeMin !== undefined ||
  f.sizeMax !== undefined ||
  f.frameRate !== undefined;

/** The words and filters of a search, as typed and as saved. */
export const searchRequest = searchFilters.extend({ q: z.string().trim().max(200) }).strict();
export type SearchRequest = z.infer<typeof searchRequest>;

/** Whether anything narrows the search beyond its words. */
export const narrowed = (f: SearchFilters) =>
  Boolean(
    f.kind ||
      f.projectId ||
      f.personId ||
      f.fileKind ||
      f.tagId ||
      f.since ||
      f.commentText ||
      fileFields(f),
  );

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
