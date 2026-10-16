import { type Database, inOrg, schema } from "@hekate/db";
import {
  deleteAccountInput,
  fileColumnsInput,
  preferencesInput,
  preferencesOf,
  profileInput,
  secondFactorRequired,
  workspaceSettingsOf,
} from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { and, asc, desc, eq, gt, ne } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { deleteAccount } from "../account-deletion.ts";
import { type Audit, requestInfo } from "../audit.ts";
import type { Auth } from "../auth.ts";
import { CodedException } from "../errors.ts";
import { recoveryCodesLeft } from "../second-factor.ts";
import { membershipOf, type SecondFactorRule, type TenantVariables } from "../tenancy.ts";

export interface MeDeps {
  auth: Auth;
  audit: Audit;
  trustProxy: boolean;
}

export const meRoutes = (db: Database, rule: SecondFactorRule, deps: MeDeps) =>
  new Hono<{ Variables: TenantVariables }>()
    .get("/", async (c) => {
      const [user] = await db
        .select({
          id: schema.users.id,
          name: schema.users.name,
          email: schema.users.email,
          emailVerified: schema.users.emailVerified,
          locale: schema.users.locale,
          timeZone: schema.users.timeZone,
          preferences: schema.users.preferences,
          twoFactorEnabled: schema.users.twoFactorEnabled,
        })
        .from(schema.users)
        .where(eq(schema.users.id, c.var.userId));
      const [factor] = await db
        .select({ backupCodes: schema.twoFactors.backupCodes })
        .from(schema.twoFactors)
        .where(eq(schema.twoFactors.userId, c.var.userId));
      const organisations = await db
        .select({
          id: schema.organisations.id,
          name: schema.organisations.name,
          role: schema.members.role,
          settings: schema.organisations.settings,
        })
        .from(schema.members)
        .innerJoin(schema.organisations, eq(schema.members.organisationId, schema.organisations.id))
        .where(eq(schema.members.userId, c.var.userId))
        .orderBy(asc(schema.organisations.name));
      const active = organisations.find((o) => o.id === c.var.organisationId);
      const { twoFactorEnabled = false, ...profile } = user ?? {};
      return c.json({
        user: user && { ...profile, preferences: preferencesOf(user.preferences) },
        // Whether they have a second factor, whether this workspace asks for one, and how many
        // recovery codes they have left.
        secondFactor: {
          enabled: twoFactorEnabled,
          required: secondFactorRequired({
            instance: rule.instance,
            policy: workspaceSettingsOf(active?.settings).secondFactor,
            role: c.var.organisationRole,
          }),
          recoveryCodesLeft: twoFactorEnabled ? recoveryCodesLeft(factor?.backupCodes) : 0,
        },
        // Each workspace's language, for members who have not chosen their own.
        organisations: organisations.map(({ settings, ...o }) => ({
          ...o,
          locale: workspaceSettingsOf(settings).locale,
        })),
        activeOrganisationId: c.var.organisationId,
      });
    })
    // Name, language and time zone. The email address changes through sign-in's own flow,
    // which confirms the new address first.
    .patch("/", zValidator("json", profileInput), async (c) => {
      const input = c.req.valid("json");
      const [user] = await db
        .update(schema.users)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(schema.users.id, c.var.userId))
        .returning({
          id: schema.users.id,
          name: schema.users.name,
          email: schema.users.email,
          locale: schema.users.locale,
          timeZone: schema.users.timeZone,
        });
      return c.json({ user });
    })
    // Delete the account: the address and the password confirm it. What they did stays, as a
    // former member's (decision 047); a sole owner hands the workspace on first.
    .delete("/", zValidator("json", deleteAccountInput), async (c) => {
      const result = await deleteAccount(
        db,
        deps.auth,
        deps.audit,
        c.var.userId,
        c.req.valid("json"),
        requestInfo(c, deps.trustProxy),
      );
      if (result.status === "refused")
        throw new CodedException(403, "confirm_refused", "That address or password is not right.");
      if (result.status === "sole_owner")
        throw new CodedException(
          409,
          "sole_owner",
          `You are the only owner of ${result.workspaces.join(", ")}. Make someone else an owner first.`,
        );
      return c.body(null, 204);
    })
    // What they want to see and how the player behaves, merged into what they had. Under a
    // row lock, so two changes at once both land.
    .patch("/preferences", zValidator("json", preferencesInput), async (c) => {
      const change = c.req.valid("json");
      const preferences = await db.transaction(async (tx) => {
        const [row] = await tx
          .select({ preferences: schema.users.preferences })
          .from(schema.users)
          .where(eq(schema.users.id, c.var.userId))
          .for("update");
        const next = { ...preferencesOf(row?.preferences), ...change };
        await tx
          .update(schema.users)
          .set({ preferences: next, updatedAt: new Date() })
          .where(eq(schema.users.id, c.var.userId));
        return next;
      });
      return c.json({ preferences });
    })
    // Where this person is signed in. Tokens never leave the server.
    .get("/sessions", async (c) => {
      const rows = await db
        .select({
          id: schema.authSessions.id,
          ipAddress: schema.authSessions.ipAddress,
          userAgent: schema.authSessions.userAgent,
          createdAt: schema.authSessions.createdAt,
          lastUsedAt: schema.authSessions.updatedAt,
        })
        .from(schema.authSessions)
        .where(
          and(
            eq(schema.authSessions.userId, c.var.userId),
            gt(schema.authSessions.expiresAt, new Date()),
          ),
        )
        .orderBy(desc(schema.authSessions.updatedAt));
      return c.json({
        sessions: rows.map((r) => ({ ...r, current: r.id === c.var.sessionId })),
      });
    })
    // Sign out one other session, or every other one; this one stays.
    .delete(
      "/sessions/:id",
      zValidator("param", z.object({ id: z.string().min(1).max(100) })),
      async (c) => {
        const id = c.req.valid("param").id;
        if (id === c.var.sessionId) {
          throw new HTTPException(409, {
            message: "Sign out of this session from the account menu",
          });
        }
        const gone = await db
          .delete(schema.authSessions)
          .where(and(eq(schema.authSessions.id, id), eq(schema.authSessions.userId, c.var.userId)))
          .returning({ id: schema.authSessions.id });
        if (gone.length === 0) throw new HTTPException(404, { message: "Session not found" });
        return c.body(null, 204);
      },
    )
    .delete("/sessions", async (c) => {
      const gone = await db
        .delete(schema.authSessions)
        .where(
          and(
            eq(schema.authSessions.userId, c.var.userId),
            ne(schema.authSessions.id, c.var.sessionId),
          ),
        )
        .returning({ id: schema.authSessions.id });
      return c.json({ signedOut: gone.length });
    })
    .put("/organisation", zValidator("json", z.object({ organisationId: z.uuid() })), async (c) => {
      const { organisationId } = c.req.valid("json");
      if (!(await membershipOf(db, c.var.userId, organisationId))) {
        throw new HTTPException(403, { message: "You are not a member of that workspace" });
      }
      await db
        .update(schema.authSessions)
        .set({ activeOrganisationId: organisationId })
        .where(eq(schema.authSessions.id, c.var.sessionId));
      return c.json({ activeOrganisationId: organisationId });
    })
    // The file browser's columns, as this member arranged them in this workspace.
    .get("/file-columns", async (c) => {
      const [row] = await db
        .select({ columns: schema.members.fileColumns })
        .from(schema.members)
        .where(
          inOrg(schema.members, c.var.organisationId, eq(schema.members.userId, c.var.userId)),
        );
      return c.json({ columns: row?.columns ?? null });
    })
    .put("/file-columns", zValidator("json", fileColumnsInput), async (c) => {
      const { columns } = c.req.valid("json");
      await db
        .update(schema.members)
        .set({ fileColumns: columns, updatedAt: new Date() })
        .where(
          inOrg(schema.members, c.var.organisationId, eq(schema.members.userId, c.var.userId)),
        );
      return c.json({ columns });
    });
