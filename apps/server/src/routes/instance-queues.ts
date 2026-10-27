import type { Database } from "@hekate/db";
import { type QueuesView, queueJobParam, queueParam, queuePauseInput } from "@hekate/shared";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { requestInfo } from "../audit.ts";
import { CodedException, NotFound } from "../errors.ts";
import { recordInstanceEvent } from "../instance-events.ts";
import type { InstanceSettingsStore } from "../instance-settings.ts";
import type { JobName, Jobs, QueueAdmin } from "../jobs.ts";
import { zValidator } from "../openapi/validator.ts";
import {
  drainQueue,
  isQueue,
  pausedAfter,
  queueJob,
  queueNames,
  queueRows,
  recentJobs,
  retryFailures,
} from "../queues.ts";
import { signal } from "../signals.ts";

interface QueueVariables {
  userId: string;
}

export interface QueueDeps {
  db: Database;
  /** The queue itself; without it (a process that runs no queue, some tests) Queues only reads. */
  admin?: QueueAdmin;
  jobs: Pick<Jobs, "send">;
  settings: InstanceSettingsStore;
  trustProxy: boolean;
}

const nameParam = zValidator("param", queueParam);
const jobParam = zValidator("param", queueJobParam);
const pauseBody = zValidator("json", queuePauseInput);

/**
 * `/api/instance/queues` (decision 250): every pg-boss queue, its recent jobs, and what an
 * operator does about them. Behind `operatorsOnly`; each action is an instance event.
 */
export const queueRoutes = (deps: QueueDeps) => {
  const { db } = deps;
  const adminOf = () => {
    if (!deps.admin)
      throw new HTTPException(503, { message: "The queue cannot be reached from here." });
    return deps.admin;
  };
  const queueOf = (name: string): JobName => {
    if (!isQueue(name)) throw new NotFound("Queue");
    return name;
  };
  const record = (
    c: Context<{ Variables: QueueVariables }>,
    action: string,
    target: string,
    details: Record<string, unknown> = {},
  ) =>
    recordInstanceEvent(db, {
      actorId: c.var.userId,
      action,
      target,
      details,
      ipAddress: requestInfo(c, deps.trustProxy).ipAddress ?? null,
    });
  /** Pauses or resumes queues in the settings, which every worker reads again on commit. */
  const pause = async (
    c: Context<{ Variables: QueueVariables }>,
    name: JobName | "all",
    on: boolean,
  ) => {
    await db.transaction(async (tx) => {
      await deps.settings.write(
        tx,
        (stored) => ({
          ...stored,
          queues: { paused: pausedAfter(stored.queues.paused, name, on) },
        }),
        c.var.userId,
      );
      // Every replica's workers stop or take up the queue when this commits (#188).
      await signal(tx, "settings");
    });
    deps.settings.forget();
    await record(
      c,
      name === "all"
        ? on
          ? "queues.paused"
          : "queues.resumed"
        : on
          ? "queue.paused"
          : "queue.resumed",
      name === "all" ? "Every queue" : name,
    );
  };
  const view = async (): Promise<QueuesView> => {
    const settings = await deps.settings.get();
    const queues = await queueRows(db, adminOf(), settings.queues.paused);
    if (!queues) throw new HTTPException(503, { message: "The job queue could not be read." });
    return {
      queues,
      recent: await recentJobs(db, adminOf()),
      maintenance: settings.maintenance.on,
    };
  };
  return (
    new Hono<{ Variables: QueueVariables }>()
      .get("/", async (c) => c.json(await view()))
      // Every failure in every queue run again.
      .post("/retry", async (c) => {
        const done = await retryFailures(db, { admin: adminOf(), jobs: deps.jobs }, queueNames);
        await record(c, "queues.retried", "Every queue", { ...done });
        return c.json(done);
      })
      .post("/pause", pauseBody, async (c) => {
        await pause(c, "all", c.req.valid("json").paused);
        return c.json(await view());
      })
      .post("/:name/retry", nameParam, async (c) => {
        const name = queueOf(c.req.valid("param").name);
        const done = await retryFailures(db, { admin: adminOf(), jobs: deps.jobs }, [name]);
        await record(c, "queue.retried", name, { ...done });
        return c.json(done);
      })
      .post("/:name/pause", nameParam, pauseBody, async (c) => {
        await pause(c, queueOf(c.req.valid("param").name), c.req.valid("json").paused);
        return c.json(await view());
      })
      // Every job waiting in the queue removed, none of them run.
      .post("/:name/drain", nameParam, async (c) => {
        const name = queueOf(c.req.valid("param").name);
        const drained = await drainQueue(db, adminOf(), name);
        await record(c, "queue.drained", name, { drained });
        return c.json({ drained });
      })
      .get("/:name/jobs/:id", jobParam, async (c) => {
        const { name, id } = c.req.valid("param");
        const job = await queueJob(db, adminOf(), queueOf(name), id);
        if (!job) throw new NotFound("Job");
        return c.json(job);
      })
      .post("/:name/jobs/:id/retry", jobParam, async (c) => {
        const { name, id } = c.req.valid("param");
        const queue = queueOf(name);
        const done = await retryFailures(db, { admin: adminOf(), jobs: deps.jobs }, [queue], [id]);
        if (done.retried + done.cleared === 0)
          throw new CodedException(409, "not_failed", "Only a failed job can be run again.");
        await record(c, "queue.job_retried", queue, { jobId: id, ...done });
        return c.json(done);
      })
  );
};
