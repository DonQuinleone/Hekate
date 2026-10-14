import { type Database, inOrg, schema } from "@hekate/db";
import { atLeast, inviteInput, organisationRole, organisationStorageInput } from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import { and, asc, count, desc, eq, gt, isNull } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { NotFound } from "../errors.ts";
import { INVITATION_LIFETIME_MS, newInvitationToken } from "../invitation-token.ts";
import type { Mailer } from "../mail.ts";
import type { Storage } from "../storage.ts";
import { requireRole, type TenantVariables } from "../tenancy.ts";

const { members, users, invitations, organisations } = schema;
const idParam = zValidator("param", z.object({ id: z.uuid() }));

async function ownerCount(db: Database, organisationId: string) {
  const [row] = await db
    .select({ n: count() })
    .from(members)
    .where(and(eq(members.organisationId, organisationId), eq(members.role, "owner")));
  return row?.n ?? 0;
}

export const organisationRoutes = (
  db: Database,
  mailer: Mailer,
  publicUrl: string,
  storage: Storage,
) =>
  new Hono<{ Variables: TenantVariables }>()
    .get("/members", async (c) => {
      const rows = await db
        .select({
          id: members.id,
          userId: users.id,
          name: users.name,
          email: users.email,
          role: members.role,
          joinedAt: members.createdAt,
        })
        .from(members)
        .innerJoin(users, eq(members.userId, users.id))
        .where(eq(members.organisationId, c.var.organisationId))
        .orderBy(asc(users.name));
      return c.json({ members: rows });
    })
    .patch(
      "/members/:id",
      requireRole("admin"),
      idParam,
      zValidator("json", z.object({ role: organisationRole })),
      async (c) => {
        const { id } = c.req.valid("param");
        const { role } = c.req.valid("json");
        const [member] = await db
          .select()
          .from(members)
          .where(inOrg(members, c.var.organisationId, eq(members.id, id)));
        if (!member) throw new NotFound("Member");
        const touchesOwner = member.role === "owner" || role === "owner";
        if (touchesOwner && c.var.organisationRole !== "owner") {
          throw new HTTPException(403, {
            message: "Only an owner can grant or remove the owner role",
          });
        }
        if (
          member.role === "owner" &&
          role !== "owner" &&
          (await ownerCount(db, c.var.organisationId)) <= 1
        ) {
          throw new HTTPException(409, { message: "An organisation needs at least one owner" });
        }
        const [updated] = await db
          .update(members)
          .set({ role })
          .where(eq(members.id, id))
          .returning();
        return c.json({ member: updated });
      },
    )
    .delete("/members/:id", idParam, async (c) => {
      const { id } = c.req.valid("param");
      const [member] = await db
        .select()
        .from(members)
        .where(inOrg(members, c.var.organisationId, eq(members.id, id)));
      if (!member) throw new NotFound("Member");
      const self = member.userId === c.var.userId;
      if (!self && !atLeast(c.var.organisationRole, "admin")) {
        throw new HTTPException(403, { message: "You do not have permission to do that" });
      }
      if (member.role === "owner" && !self && c.var.organisationRole !== "owner") {
        throw new HTTPException(403, { message: "Only an owner can remove an owner" });
      }
      if (member.role === "owner" && (await ownerCount(db, c.var.organisationId)) <= 1) {
        throw new HTTPException(409, { message: "An organisation needs at least one owner" });
      }
      await db.delete(members).where(eq(members.id, id));
      return c.body(null, 204);
    })
    .get("/invitations", requireRole("admin"), async (c) => {
      const rows = await db
        .select({
          id: invitations.id,
          email: invitations.email,
          role: invitations.role,
          expiresAt: invitations.expiresAt,
          createdAt: invitations.createdAt,
        })
        .from(invitations)
        .where(
          inOrg(
            invitations,
            c.var.organisationId,
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
            gt(invitations.expiresAt, new Date()),
          ),
        )
        .orderBy(desc(invitations.createdAt));
      return c.json({ invitations: rows });
    })
    .post("/invitations", requireRole("admin"), zValidator("json", inviteInput), async (c) => {
      const { email: rawEmail, role } = c.req.valid("json");
      const email = rawEmail.toLowerCase();
      if (role === "owner" && c.var.organisationRole !== "owner") {
        throw new HTTPException(403, { message: "Only an owner can invite another owner" });
      }
      const [existing] = await db
        .select({ id: members.id })
        .from(members)
        .innerJoin(users, eq(members.userId, users.id))
        .where(and(eq(members.organisationId, c.var.organisationId), eq(users.email, email)));
      if (existing) throw new HTTPException(409, { message: "That person is already a member" });

      // A new invitation replaces any pending one for the same address.
      await db
        .update(invitations)
        .set({ revokedAt: new Date() })
        .where(
          inOrg(
            invitations,
            c.var.organisationId,
            eq(invitations.email, email),
            isNull(invitations.acceptedAt),
            isNull(invitations.revokedAt),
          ),
        );

      const { token, hash } = newInvitationToken();
      const [invitation] = await db
        .insert(invitations)
        .values({
          organisationId: c.var.organisationId,
          email,
          role,
          tokenHash: hash,
          invitedBy: c.var.userId,
          expiresAt: new Date(Date.now() + INVITATION_LIFETIME_MS),
        })
        .returning({
          id: invitations.id,
          email: invitations.email,
          role: invitations.role,
          expiresAt: invitations.expiresAt,
        });
      const [organisation] = await db
        .select({ name: organisations.name })
        .from(organisations)
        .where(eq(organisations.id, c.var.organisationId));
      const [inviter] = await db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, c.var.userId));
      const link = `${publicUrl.replace(/\/$/, "")}/invite/${token}`;
      await mailer.send({
        to: email,
        subject: `${inviter?.name ?? "Someone"} invited you to ${organisation?.name ?? "Hekate"}`,
        text: `${inviter?.name ?? "Someone"} invited you to join ${organisation?.name ?? "their organisation"} on Hekate.\n\nAccept the invitation: ${link}\n\nThe link works once and expires in 7 days.`,
      });
      return c.json({ invitation, link }, 201);
    })
    .delete("/invitations/:id", requireRole("admin"), idParam, async (c) => {
      const { id } = c.req.valid("param");
      const [row] = await db
        .update(invitations)
        .set({ revokedAt: new Date() })
        .where(
          inOrg(
            invitations,
            c.var.organisationId,
            eq(invitations.id, id),
            isNull(invitations.revokedAt),
          ),
        )
        .returning({ id: invitations.id });
      if (!row) throw new NotFound("Invitation");
      return c.body(null, 204);
    })
    .get("/storage", requireRole("admin"), async (c) => {
      const [organisation] = await db
        .select({ backend: organisations.storageBackend })
        .from(organisations)
        .where(eq(organisations.id, c.var.organisationId));
      return c.json({
        /** The organisation's choice; null follows the instance default. */
        backend: organisation?.backend ?? null,
        defaultBackend: storage.backends.defaultBackend,
        available: storage.backends.names(),
      });
    })
    .put(
      "/storage",
      requireRole("owner"),
      zValidator("json", organisationStorageInput),
      async (c) => {
        const { backend } = c.req.valid("json");
        if (backend !== null && !storage.backends.has(backend)) {
          throw new HTTPException(400, {
            message: `Storage backend "${backend}" is not configured`,
          });
        }
        // Existing objects stay where they are; only new objects use the new backend.
        await db
          .update(organisations)
          .set({ storageBackend: backend })
          .where(eq(organisations.id, c.var.organisationId));
        return c.json({ backend });
      },
    );
