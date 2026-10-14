import type { Database } from "@hekate/db";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { version } from "../version.ts";

export const health = (db: Database) =>
  new Hono().get("/", async (c) => {
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
  });
