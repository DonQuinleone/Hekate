import { type Database, schema } from "@hekate/db";
import { zValidator } from "@hono/zod-validator";
import { isAPIError } from "better-auth/api";
import { isPasswordCompromised } from "better-auth/plugins";
import { asc, count } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Auth } from "../auth.ts";
import { requireSetupCode, type SetupGate } from "../setup-code.ts";

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
 * The server's setup code guards it (decision 061), so whoever finds a fresh instance first
 * cannot claim it.
 */
export const setupRoutes = (db: Database, auth: Auth, leakCheck: boolean, gate?: SetupGate) => {
  let running: Promise<unknown> = Promise.resolve();
  return new Hono()
    .get("/", async (c) => c.json({ needed: !(await hasUsers(db)) }))
    .use("/", async (c, next) =>
      c.req.method === "POST" && gate ? requireSetupCode(gate)(c, next) : next(),
    )
    .post("/", zValidator("json", setupInput), async (c) => {
      const input = c.req.valid("json");
      const run = running.then(async () => {
        if (await hasUsers(db))
          throw new HTTPException(409, { message: "Hekate is already set up" });
        const ctx = await auth.$context;
        // The password first: one refused (a known breach, or the check unreachable) must
        // leave no account behind, or setup could never run again. Setup creates the account
        // itself, outside the sign-up route the breach check watches, so it asks directly.
        if (leakCheck) {
          const compromised = await isPasswordCompromised(input.password).catch(() => {
            throw new HTTPException(503, {
              message: "The password could not be checked against known breaches. Try again.",
            });
          });
          if (compromised)
            throw new HTTPException(400, {
              message: "That password appears in known data breaches. Choose another one.",
            });
        }
        const password = await ctx.password.hash(input.password).catch((error: unknown) => {
          if (isAPIError(error))
            throw new HTTPException(error.statusCode === 400 ? 400 : 503, {
              message: error.message || "That password cannot be used. Choose another.",
            });
          throw error;
        });
        const user = await ctx.internalAdapter.createUser(
          { name: input.name, email: input.email.toLowerCase(), emailVerified: true },
          { method: "admin" },
        );
        await ctx.internalAdapter.linkAccount({
          userId: user.id,
          providerId: "credential",
          accountId: user.id,
          password,
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
