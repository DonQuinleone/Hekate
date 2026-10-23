import { type Database, inOrg, schema } from "@hekate/db";
import { type MailSuppression, workspaceMailInput } from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { type Audit, requestInfo } from "../audit.ts";
import type { Keyring } from "../keyring.ts";
import { mayFetch } from "../sso.ts";
import { requireRole, type TenantVariables } from "../tenancy.ts";
import {
  MailRefused,
  mergedMail,
  type RoutedMailDeps,
  removeWorkspaceMail,
  saveWorkspaceMail,
  testWorkspaceMail,
  workspaceMailOf,
} from "../workspace-mail.ts";

export interface WorkspaceMailRouteDeps {
  db: Database;
  keyring: Keyring;
  audit: Audit;
  trusted: string[];
  trustProxy: boolean;
  /** The instance's address, for the bounce reports' webhook. */
  publicUrl: string;
  /** For tests: the mailer a workspace's details come to. */
  build?: RoutedMailDeps["build"];
}

/**
 * `/api/organisation/mail` (#161): the workspace's own mail, which sends what is sent for it
 * instead of the instance's. Admins only. The secret goes in and never comes back.
 */
export const workspaceMailRoutes = (deps: WorkspaceMailRouteDeps) => {
  const { db, keyring, audit } = deps;
  const refused = (error: unknown): never => {
    if (error instanceof MailRefused) throw new HTTPException(422, { message: error.message });
    throw error;
  };
  return (
    new Hono<{ Variables: TenantVariables }>()
      .use("*", requireRole("admin"))
      .get("/", async (c) =>
        c.json({ mail: await workspaceMailOf(db, keyring, c.var.organisationId, deps.publicUrl) }),
      )
      .put("/", zValidator("json", workspaceMailInput), async (c) => {
        const organisationId = c.var.organisationId;
        const mail = await mergedMail(db, keyring, organisationId, c.req.valid("json")).catch(
          refused,
        );
        // Mailcoach is reached over HTTPS from the server: only somewhere public, unless trusted.
        if (mail.url && !(await mayFetch(mail.url, deps.trusted)))
          throw new HTTPException(422, {
            message:
              "That address is on a private network, or cannot be found. The operator can allow a private one with WEBHOOK_TRUSTED_ORIGINS.",
          });
        await saveWorkspaceMail(db, keyring, organisationId, mail);
        await audit.record(
          organisationId,
          await audit.member(c.var.userId),
          {
            action: "organisation.mail",
            details: { provider: mail.provider, from: mail.from, secret: "sealed" },
          },
          requestInfo(c, deps.trustProxy),
        );
        return c.json({ mail: await workspaceMailOf(db, keyring, organisationId, deps.publicUrl) });
      })
      // Back to the instance's mail.
      .delete("/", async (c) => {
        const organisationId = c.var.organisationId;
        await removeWorkspaceMail(db, organisationId);
        await audit.record(
          organisationId,
          await audit.member(c.var.userId),
          { action: "organisation.mail", details: { provider: "instance" } },
          requestInfo(c, deps.trustProxy),
        );
        return c.body(null, 204);
      })
      // What its provider reported (#161): addresses its mail no longer sends to.
      .get("/suppressions", async (c) => {
        const rows = await db
          .select()
          .from(schema.workspaceMailSuppressions)
          .where(inOrg(schema.workspaceMailSuppressions, c.var.organisationId))
          .orderBy(desc(schema.workspaceMailSuppressions.updatedAt))
          .limit(500);
        const suppressions: MailSuppression[] = rows.map((r) => ({
          id: r.id,
          address: r.address,
          kind: r.kind,
          provider: r.provider,
          detail: r.detail,
          at: r.updatedAt.toISOString(),
        }));
        return c.json({ suppressions });
      })
      // Send to an address again: put right at the recipient's end, or reported in error.
      .delete("/suppressions/:id", zValidator("param", z.object({ id: z.uuid() })), async (c) => {
        const organisationId = c.var.organisationId;
        const [gone] = await db
          .delete(schema.workspaceMailSuppressions)
          .where(
            inOrg(
              schema.workspaceMailSuppressions,
              organisationId,
              eq(schema.workspaceMailSuppressions.id, c.req.valid("param").id),
            ),
          )
          .returning({ address: schema.workspaceMailSuppressions.address });
        if (!gone) throw new HTTPException(404, { message: "No such address" });
        await audit.record(
          organisationId,
          await audit.member(c.var.userId),
          { action: "organisation.mail", details: { sendsAgainTo: gone.address } },
          requestInfo(c, deps.trustProxy),
        );
        return c.body(null, 204);
      })
      // Sending again now, rather than when the pause runs out.
      .post("/resume", async (c) => {
        const organisationId = c.var.organisationId;
        await db
          .update(schema.workspaceMail)
          .set({ failures: 0, pausedUntil: null, updatedAt: new Date() })
          .where(inOrg(schema.workspaceMail, organisationId));
        return c.json({ mail: await workspaceMailOf(db, keyring, organisationId, deps.publicUrl) });
      })
      // One message to whoever asks, through the saved details alone: its failure is the answer.
      .post("/test", async (c) => {
        const organisationId = c.var.organisationId;
        const [me] = await db
          .select({ email: schema.users.email })
          .from(schema.users)
          .where(eq(schema.users.id, c.var.userId));
        const [workspace] = await db
          .select({ name: schema.organisations.name })
          .from(schema.organisations)
          .where(eq(schema.organisations.id, organisationId));
        if (!me) throw new HTTPException(404, { message: "No such account" });
        try {
          await testWorkspaceMail(
            { db, keyring, trusted: deps.trusted, ...(deps.build ? { build: deps.build } : {}) },
            organisationId,
            {
              to: me.email,
              subject: `A test from ${workspace?.name ?? "Hekate"}`,
              text: `This came through ${workspace?.name ?? "the workspace"}'s own mail. Members, guests and invitations are sent this way from now on.`,
              organisationId,
            },
          );
          return c.json({ ok: true, result: `Sent to ${me.email}` });
        } catch (error) {
          if (error instanceof MailRefused)
            throw new HTTPException(422, { message: error.message });
          return c.json({
            ok: false,
            result: `Not sent: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`,
          });
        }
      })
  );
};
