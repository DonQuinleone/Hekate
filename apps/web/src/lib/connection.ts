import { useSyncExternalStore } from "react";

/** What the health check answered: the server's release, and whether it reaches its database. */
export interface Health {
  status: "ok" | "degraded";
  version: string;
  database: "ok" | "unreachable";
}

export type Connection =
  | { state: "checking" }
  | { state: "connected"; version: string }
  | { state: "degraded"; version: string }
  | { state: "unreachable"; version: string | null };

/**
 * How the app stands with its server, for the shell's foot: from the last health check, and
 * whether the latest one failed (no answer, or not the health check's) or the app's latest
 * request found no server. A server that answers without its database is reached, but cannot
 * serve; the version stays the last one known.
 */
export function connectionOf(health: Health | undefined, failed: boolean): Connection {
  if (failed) return { state: "unreachable", version: health?.version ?? null };
  if (!health) return { state: "checking" };
  if (health.status !== "ok" || health.database !== "ok")
    return { state: "degraded", version: health.version };
  return { state: "connected", version: health.version };
}

/** Each state in plain words, as the sidebar's foot, the phone's banner and the take log say it. */
export const connectionWords: Record<Connection["state"], string> = {
  checking: "Connecting",
  connected: "Connected",
  degraded: "Running slowly",
  unreachable: "Can't reach the server",
};

/** What is said beside a lost connection: it clears on its own. */
export const tryingAgain = "Trying again";

/**
 * What the app's own requests found lately, beside the health check: a request that got no
 * answer (or a proxy's word that the server is not there) loses the server at once, and any
 * answer finds it again. So the take log's writes, failing offline, turn the sidebar's foot in
 * the same moment as the take log's own line (#616).
 */
export type Reach = "unknown" | "reached" | "lost";
let reach: Reach = "unknown";
const listeners = new Set<() => void>();

export function noteReach(next: "reached" | "lost") {
  if (reach === next) return;
  reach = next;
  for (const listener of listeners) listener();
}

/** A proxy's answer that the server behind it is not there: the same as no answer. */
const lostStatuses = new Set([502, 504]);

/** Whether a response, or its absence, says the server was reached. Cancelled requests say nothing. */
export function reachOf(outcome: Response | unknown): "reached" | "lost" | null {
  if (outcome instanceof Response) return lostStatuses.has(outcome.status) ? "lost" : "reached";
  if (outcome instanceof DOMException && outcome.name === "AbortError") return null;
  return "lost";
}

/** `fetch` for the API client: each request's outcome feeds the connection. */
export const watchedFetch: typeof fetch = async (input, init) => {
  try {
    const res = await fetch(input, init);
    const said = reachOf(res);
    if (said) noteReach(said);
    return res;
  } catch (error) {
    const said = reachOf(error);
    if (said) noteReach(said);
    throw error;
  }
};

/** What the app's requests found lately, kept up to date. */
export const useReach = (): Reach =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => reach,
    () => reach,
  );
