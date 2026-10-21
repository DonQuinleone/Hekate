/**
 * Stopping without dropping anyone (#193). Told to stop (SIGTERM), a process:
 *
 * 1. says it is not ready, so the load balancer takes it out of rotation;
 * 2. keeps serving for the drain, while the load balancer notices;
 * 3. stops taking connections and lets the requests under way finish, until the deadline,
 *    then closes what is left (an upload's part closed early is sent again, to another replica);
 * 4. stops the job workers, whose jobs finish or, past their grace, go back to the queue for
 *    another worker (pg-boss fails them, and their retry runs them again);
 * 5. closes the database.
 *
 * The whole fits within SHUTDOWN_TIMEOUT_SECONDS, which the orchestrator's own grace period
 * (Compose's stop_grace_period, Kubernetes' terminationGracePeriodSeconds) must exceed.
 */

let stopping = false;

/** Whether this process has been told to stop. */
export const isStopping = () => stopping;

export interface ShutdownSteps {
  /** Wait, still serving, for the load balancer to notice. */
  drain(ms: number): Promise<void>;
  /** Stop taking connections; finish what is under way within `ms`, then close the rest. */
  stopServing(ms: number): Promise<void>;
  /** Stop the job workers, giving running jobs `ms` to finish, and close the database. */
  stopWork(ms: number): Promise<void>;
}

/** The least each later step is given, however late the earlier ones ran. */
const FLOOR_MS = 1_000;

/**
 * Stop in order, within `timeoutMs` in all: the drain first, then the requests under way, then
 * the jobs, each given what is left of the time.
 */
export async function shutDown(
  steps: ShutdownSteps,
  { drainMs, timeoutMs }: { drainMs: number; timeoutMs: number },
  now: () => number = Date.now,
): Promise<void> {
  const deadline = now() + timeoutMs;
  const left = () => Math.max(FLOOR_MS, deadline - now());
  // Readiness answers no from now on.
  stopping = true;
  // The drain never eats the time the later steps need: the whole stays within the timeout.
  await steps.drain(Math.max(0, Math.min(drainMs, timeoutMs - 2 * FLOOR_MS)));
  // Requests get half of what remains, jobs the rest: a job given up is only retried.
  await steps.stopServing(Math.max(FLOOR_MS, Math.floor((deadline - now()) / 2)));
  await steps.stopWork(left());
}
