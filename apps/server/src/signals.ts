import type { createDb, Database } from "@hekate/db";
import { sql } from "drizzle-orm";

/**
 * Word between replicas (#188, decision 188): a change one process makes that every other
 * process holds in memory is announced on one PostgreSQL channel, so each reads it again at
 * once rather than when its copy goes stale. The announcement rides the transaction that made
 * the change: PostgreSQL delivers it on commit, and never for a change rolled back.
 *
 * Reading again on a timer stays as the fallback; a listener that loses its connection is told
 * nothing it missed, so it reads everything again when it is back.
 */

export const SIGNAL_CHANNEL = "hekate_instance";

/** What changed: the instance's settings (#160) or its flags (#159). */
export type Signal = "settings" | "flags";
const signals: readonly Signal[] = ["settings", "flags"];

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Announce a change, delivered when the caller's transaction commits. */
export async function signal(tx: Tx | Database, what: Signal): Promise<void> {
  await tx.execute(sql`select pg_notify(${SIGNAL_CHANNEL}, ${what})`);
}

/**
 * Listen on the channel, calling `heard` for each change announced; on every connection,
 * the first included, every kind is heard at once, as anything may have changed meanwhile.
 * Returns a function that stops listening.
 */
export async function listenForSignals(
  client: ReturnType<typeof createDb>["sql"],
  heard: (what: Signal) => void,
): Promise<() => Promise<void>> {
  const { unlisten } = await client.listen(
    SIGNAL_CHANNEL,
    (payload) => {
      if ((signals as readonly string[]).includes(payload)) heard(payload as Signal);
    },
    () => {
      for (const what of signals) heard(what);
    },
  );
  return unlisten;
}
