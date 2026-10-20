/**
 * Readiness and liveness (#156), for Compose, Kubernetes and the image's HEALTHCHECK. Each
 * check is a state and no more: the endpoints are public, so they name no host, bucket or
 * address.
 */

export type CheckState = "ok" | "failed" | "stale" | "off";

export interface HealthChecks {
  /** PostgreSQL answers. */
  database: CheckState;
  /** Every storage backend can be written to. */
  storage: CheckState;
  /** A worker has finished a job lately; "stale" when none has (none may be running). */
  worker: CheckState;
  /** The SMTP server answers; "off" when mail goes to the log. */
  mail: CheckState;
}

export interface Readiness {
  status: "ready" | "not_ready";
  version: string;
  checks: HealthChecks;
}

/**
 * Ready to serve when the database and storage are: nothing works without them. A worker or
 * mail that is down is reported, but keeps no request from being served, so a load balancer
 * does not take every replica out at once for want of mail.
 */
export function readiness(version: string, checks: HealthChecks): Readiness {
  const serves = checks.database === "ok" && checks.storage === "ok";
  return { status: serves ? "ready" : "not_ready", version, checks };
}
