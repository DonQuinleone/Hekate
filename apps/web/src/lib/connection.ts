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
 * whether the latest one failed (no answer, or not the health check's). A server that answers
 * without its database is reached, but cannot serve; the version stays the last one known.
 */
export function connectionOf(health: Health | undefined, failed: boolean): Connection {
  if (failed) return { state: "unreachable", version: health?.version ?? null };
  if (!health) return { state: "checking" };
  if (health.status !== "ok" || health.database !== "ok")
    return { state: "degraded", version: health.version };
  return { state: "connected", version: health.version };
}

export const connectionWords: Record<Connection["state"], string> = {
  checking: "Connecting",
  connected: "Connected",
  degraded: "Database unreachable",
  unreachable: "API unreachable",
};
