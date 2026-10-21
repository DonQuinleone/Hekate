import type { CheckState } from "./health.ts";
import type { Release } from "./releases.ts";

/**
 * A workspace's Operations page (#165): for its owner, what the instance pages show an operator,
 * reduced to what an owner may see. Jobs are this workspace's; the rest is the instance's.
 */
export interface WorkspaceOperations {
  version: string;
  /** The commit the image was built from, or "dev". */
  build: string;
  /** "stale" when no worker has finished a job lately: none may be running. */
  worker: CheckState;
  /** This workspace's jobs: waiting, running, and failed for good in the last day. */
  queue: { waiting: number; running: number; failed: number } | null;
  encryption: {
    /** The workspace key's version, and when it was made; null before the first file. */
    keyVersion: number | null;
    keySince: string | null;
    /** Keys and secrets still wrapped by an earlier version, re-wrapped in the background. */
    behind: number;
  };
  /** Whether Prometheus may read /metrics, and when this process was last read. */
  metrics: { on: boolean; lastReadAt: string | null };
  /** The newest release on the instance's channel, when release checks are on. */
  release: { checkOn: boolean; newer: Release | null };
}
