import { Hono } from "hono";
import type { Status } from "../status.ts";

/**
 * `/api/status` (#183): the status page, for anyone, signed in or not, as the page at `/status`
 * must be readable by whoever cannot sign in. It names services, never a workspace, a person or
 * a version; read through a short cache, so asking it often costs the database little.
 */
export const statusRoutes = (status: Status) =>
  new Hono()
    .get("/", async (c) => {
      c.header("Cache-Control", "no-store");
      return c.json(await status.page());
    })
    // What the help menu and the Support page show: the state and what is open.
    .get("/now", async (c) => {
      c.header("Cache-Control", "no-store");
      return c.json(await status.now());
    });
