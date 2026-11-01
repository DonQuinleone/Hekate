/** What the upload tray says of its files, folded to one line (#552). */
export interface TraySummary {
  /** Still on their way. */
  going: number;
  failed: number;
  done: number;
  /** How far along those still going are, by bytes, as a whole percentage. */
  percent: number;
}

export function traySummary(
  uploads: {
    progress: { sent: number; total: number };
    error?: string;
    done?: boolean;
  }[],
): TraySummary {
  const going = uploads.filter((u) => !u.error && !u.done);
  const sent = going.reduce((n, u) => n + u.progress.sent, 0);
  const total = going.reduce((n, u) => n + u.progress.total, 0);
  return {
    going: going.length,
    failed: uploads.filter((u) => u.error).length,
    done: uploads.filter((u) => u.done).length,
    percent: total === 0 ? (going.length ? 0 : 100) : Math.floor((sent / total) * 100),
  };
}
