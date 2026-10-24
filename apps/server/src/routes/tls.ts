import { type Database, schema } from "@hekate/db";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { hostKind, type Subdomains } from "../hosts.ts";
import { zValidator } from "../openapi/validator.ts";

/**
 * `/api/tls/ask` (#176): Caddy's on-demand TLS asks here before it gets a certificate for a
 * name, so it gets one for the root and for each workspace that exists, and for nothing else
 * anyone points at it. 200 is yes; 404 is no. It says no more than whether a name answers,
 * which opening the address would say too.
 */
export const tlsRoutes = (db: Database, subdomains: Subdomains | null) =>
  new Hono().get(
    "/ask",
    zValidator("query", z.object({ domain: z.string().trim().toLowerCase().max(253) })),
    async (c) => {
      const { domain } = c.req.valid("query");
      if (!subdomains) return c.body(null, 404);
      const host = hostKind(domain, subdomains);
      if (host.kind === "root") return c.body(null, 200);
      if (host.kind !== "workspace") return c.body(null, 404);
      const [row] = await db
        .select({ id: schema.organisations.id })
        .from(schema.organisations)
        .where(eq(schema.organisations.slug, host.slug));
      return c.body(null, row ? 200 : 404);
    },
  );
