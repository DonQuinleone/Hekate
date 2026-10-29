import { schema } from "@hekate/db";
import { isNull } from "drizzle-orm";

/**
 * A take's file is the take's, not the folder's (decision 274). It is uploaded from its track
 * and heard from the track's takes, the player's other takes and its session's take log, so it
 * is left out of a project's files: the listing, what a folder is said to hold, and a search's
 * files. `files.take_id` marks it, written by everything that makes a take (the track's takes,
 * an import, the take log's matching); a file that stops being a take comes back to its folder.
 * Comments on it are still found, and its bytes still count in the project's storage.
 */
export const isListedFile = (file: { takeId: string | null }): boolean => file.takeId === null;

/** The same rule as a condition on the files table, for the queries that list files. */
export const listedFile = isNull(schema.files.takeId);
