import { type Database, schema } from "@hekate/db";
import { zValidator } from "@hono/zod-validator";
import { asc, count } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Auth } from "../auth.ts";

export const setupInput = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.email().max(254),
  password: z.string().min(12).max(256),
  organisation: z.string().trim().min(1).max(120),
});

const slugify = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "studio";

async function hasUsers(db: Database) {
  const [row] = await db.select({ n: count() }).from(schema.users);
  return (row?.n ?? 0) > 0;
}

/**
 * First-run setup: creates the first account, its organisation (or adopts the one an earlier,
 * pre-authentication install created) and makes the account its owner. Closed once any account exists.
 * Setup is serialised in-process; the unique email constraint is the backstop across processes.
 */
export const setupRoutes = (db: Database, auth: Auth) => {
  let running: Promise<unknown> = Promise.resolve();
  return new Hono()
    .get("/", async (c) => c.json({ needed: !(await hasUsers(db)) }))
    .post("/", zValidator("json", setupInput), async (c) => {
      const input = c.req.valid("json");
      const run = running.then(async () => {
        if (await hasUsers(db))
          throw new HTTPException(409, { message: "Hekate is already set up" });
        const ctx = await auth.$context;
        const user = await ctx.internalAdapter.createUser(
          { name: input.name, email: input.email.toLowerCase(), emailVerified: true },
          { method: "admin" },
        );
        await ctx.internalAdapter.linkAccount({
          userId: user.id,
          providerId: "credential",
          accountId: user.id,
          password: await ctx.password.hash(input.password),
        });
        const [existing] = await db
          .select()
          .from(schema.organisations)
          .orderBy(asc(schema.organisations.createdAt))
          .limit(1);
        const organisation =
          existing ??
          (await db
            .insert(schema.organisations)
            .values({ name: input.organisation, slug: slugify(input.organisation) })
            .returning()
            .then((rows) => rows[0]));
        if (!organisation) throw new Error("Could not create the organisation");
        await db.insert(schema.members).values({
          organisationId: organisation.id,
          userId: user.id,
          role: "owner",
        });
        return organisation;
      });
      running = run.catch(() => {});
      const organisation = await run;
      // Sign the new owner in and pass Better Auth's session cookie through.
      const signIn = await auth.api.signInEmail({
        body: { email: input.email.toLowerCase(), password: input.password },
        headers: c.req.raw.headers,
        asResponse: true,
      });
      const res = c.json({ organisation: { id: organisation.id, name: organisation.name } }, 201);
      for (const cookie of signIn.headers.getSetCookie()) res.headers.append("set-cookie", cookie);
      return res;
    });
};
