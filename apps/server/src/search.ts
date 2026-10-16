/**
 * A search box's words as a PostgreSQL full-text query: every word must match, each as a
 * prefix, so "map le" finds "Maple Leaf Rag" as it is typed. Anything that is not a letter
 * or a digit separates words and never reaches the query syntax. Null when nothing is left.
 */
export function prefixQuery(text: string): string | null {
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 8);
  if (words.length === 0) return null;
  return words.map((w) => `${w}:*`).join(" & ");
}

/** A short piece of a long text, for a search result. */
export const excerpt = (text: string, length = 80) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > length ? `${line.slice(0, length - 1).trimEnd()}…` : line;
};
