import type { Database } from "@hekate/db";
import { type HealthChecks, readiness } from "@hekate/shared";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { version } from "../version.ts";

/**
 * `/api/health` (#156): `/` the database and the release, as the image's HEALTHCHECK asks;
 * `/live` that the process answers; `/ready` whether it can serve, with each part's state.
 */
export const health = (db: Database, checks: () => Promise<HealthChecks>) =>
  new Hono()
    .get("/", async (c) => {
      let database: "ok" | "unreachable" = "ok";
      try {
        await db.execute(sql`select 1`);
      } catch {
        database = "unreachable";
      }
      return c.json(
        { status: database === "ok" ? "ok" : "degraded", version, database } as const,
        database === "ok" ? 200 : 503,
      );
    })
    .get("/live", (c) => c.json({ status: "ok", version } as const))
    .get("/ready", async (c) => {
      const answer = readiness(version, await checks());
      return c.json(answer, answer.status === "ready" ? 200 : 503);
    });
