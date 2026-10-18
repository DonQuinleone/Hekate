/** The end of a chosen day, where the person sharing is: when a share closes to them (#138). */
export const endOfDay = (day: string) => new Date(`${day}T23:59:59`).toISOString();

/**
 * One of a share's people as the share's page lists them (#138): whether they opened it and
 * when, and, for those who run it, how often they played and downloaded what it shares.
 */
export function shareLine(
  person: { viewedAt: string | null; usage: { plays: number; downloads: number } | null },
  ago: (at: string) => string,
): string {
  const opened = person.viewedAt ? `Opened ${ago(person.viewedAt)}` : "Not opened";
  if (!person.usage) return opened;
  const { plays, downloads } = person.usage;
  return [
    opened,
    `${plays} ${plays === 1 ? "play" : "plays"}`,
    ...(downloads > 0 ? [`${downloads} ${downloads === 1 ? "download" : "downloads"}`] : []),
  ].join(" · ");
}
