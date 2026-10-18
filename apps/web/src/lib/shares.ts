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

/**
 * What a share gives the person it is shared with (#138), in a sentence or two: how often
 * and until when, then what they may keep. A limit on plays leads, so nobody reads it as
 * unlimited.
 */
export function shareNote(
  permissions: { expiresAt: string | null; maxPlays: number | null; download: string } | null,
  date: (at: string) => string,
): string {
  const n = permissions?.maxPlays;
  const lead = n
    ? `Up to ${n} ${n === 1 ? "play" : "plays"} of each file`
    : "Listen as often as you like";
  const until = permissions?.expiresAt ? date(permissions.expiresAt) : "it is withdrawn";
  const keep =
    permissions?.download && permissions.download !== "none"
      ? ` You may download the ${permissions.download}; each copy is marked for you.`
      : "";
  return `${lead} until ${until}.${keep}`;
}
