import { ago } from "./comments";
import { formatDates } from "./locale";

const day = formatDates({ day: "numeric", month: "short", year: "numeric" });

/**
 * When something was last used, as a row's metadata says it (#707): "last used 2 hours ago",
 * or the day itself once it is further back than "last week" can say well ("last used last
 * month" reads as a stumble). Lower case, to follow a "·"; `sentence` starts a hint with it.
 */
export function lastUsed(iso: string, now = Date.now()): string {
  const words = ago(iso, now);
  return /^last /.test(words) ? `last used on ${day.format(new Date(iso))}` : `last used ${words}`;
}

/** The first letter made a capital, for words that start a line. */
export const sentence = (words: string) => `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
