import { type Database, inOrg, schema } from "@hekate/db";
import {
  applyWorkspaceSettings,
  atLeast,
  auditQuery,
  customProfileInput,
  emailTemplateId,
  emailTestInput,
  inviteInput,
  organisationRole,
  organisationStorageInput,
  organisationUpdateInput,
  secondFactorRequired,
  workspaceSettingsInput,
  workspaceSettingsOf,
} from "@hekate/shared";
import { and, asc, count, desc, eq, gt, inArray, isNull, max, sql } from "drizzle-orm";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { revokeMemberTokens } from "../api-tokens.ts";
import { type Audit, csvHeader, csvRow, requestInfo } from "../audit.ts";
import { brandingOf, emailBrandOf } from "../branding.ts";
import { assertProfileRef, customProfilesOf, deleteCustomProfile } from "../delivery-profiles.ts";
import { render } from "../email/render.ts";
import { sampleData, workspaceEmail } from "../email/templates.ts";
import { NotFound } from "../errors.ts";
import { revokeGuest } from "../guests.ts";
import { type LinkRoots, linkBase } from "../hosts.ts";
import { INVITATION_LIFETIME_MS, newInvitationToken } from "../invitation-token.ts";
import { type Mailer, sendEmail } from "../mail.ts";
import { zValidator } from "../openapi/validator.ts";
import type { Storage } from "../storage.ts";
import { requireRole, type TenantVariables } from "../tenancy.ts";
import { assertMemberRoom } from "../usage.ts";

const {
  members,
  users,
  invitations,
  organisations,
  guests,
  guestLinks,
  guestSessions,
  files,
  reviews,
  deliveryProfiles,
} = schema;
const idParam = zValidator("param", z.object({ id: z.uuid() }));

/** True when a statement failed on the named unique index. */
function violates(error: unknown, index: string): boolean {
  const cause = (error as { cause?: { code?: string; constraint_name?: string } }).cause;
  return cause?.code === "23505" && cause.constraint_name === index;
}

const profileTaken = () =>
  new HTTPException(409, { message: "The workspace already has a profile with that name" });

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
  /** Links in mail: the workspace's own address with subdomains on (#437). */
  links: LinkRoots,
  storage: Storage,
  audit: Audit,
  trustProxy: boolean,
) =>
  new Hono<{ Variables: TenantVariables }>()
    // Only owners rename the workspace; the organisation comes from the session, never the body.
    .patch("/", requireRole("owner"), zValidator("json", organisationUpdateInput), async (c) => {
      const { name } = c.req.valid("json");
      const organisationId = c.var.organisationId;
      const who = await audit.member(c.var.userId);
      const row = await db.transaction(async (tx) => {
        // Locked, so the old name in the log is the one this rename replaced.
        const [before] = await tx
          .select({ name: organisations.name })
          .from(organisations)
          .where(eq(organisations.id, organisationId))
          .for("update");
        if (!before) throw new NotFound("Workspace");
        const [after] = await tx
          .update(organisations)
          .set({ name })
          .where(eq(organisations.id, organisationId))
          .returning({ id: organisations.id, name: organisations.name });
        if (!after) throw new NotFound("Workspace");
        await audit.record(
          organisationId,
          who,
          { action: "organisation.rename", details: { from: before.name, to: after.name } },
          requestInfo(c, trustProxy),
          tx,
        );
        return after;
      });
      return c.json({ organisation: row });
    })
    // Every member reads the settings: they decide how dates read and what a review grants.
    .get("/settings", async (c) => {
      const [row] = await db
        .select({ settings: organisations.settings })
        .from(organisations)
        .where(eq(organisations.id, c.var.organisationId));
      if (!row) throw new NotFound("Workspace");
      return c.json({ settings: workspaceSettingsOf(row.settings) });
    })
    .patch(
      "/settings",
      requireRole("admin"),
      zValidator("json", workspaceSettingsInput),
      async (c) => {
        const change = c.req.valid("json");
        const organisationId = c.var.organisationId;
        // Asking others for a second factor, or a hardware security key, starts with having one:
        // nobody locks themselves out.
        const asksFactor =
          change.secondFactor &&
          secondFactorRequired({
            instance: false,
            policy: change.secondFactor,
            role: c.var.organisationRole,
          });
        if (asksFactor || change.securityKeyForAdmins) {
          const [user] = await db
            .select({ enabled: schema.users.twoFactorEnabled })
            .from(schema.users)
            .where(eq(schema.users.id, c.var.userId));
          const keys = await db
            .select({ id: schema.passkeys.id })
            .from(schema.passkeys)
            .where(eq(schema.passkeys.userId, c.var.userId));
          if (change.securityKeyForAdmins && keys.length === 0)
            throw new HTTPException(422, {
              message: "Add a passkey or hardware security key to your own account first.",
            });
          if (asksFactor && !user?.enabled && keys.length === 0)
            throw new HTTPException(422, {
              message: "Add a second factor to your own account first.",
            });
        }
        const who = await audit.member(c.var.userId);
        const settings = await db.transaction(async (tx) => {
          await assertProfileRef(tx, organisationId, change.deliveryProfile);
          // Locked, so two admins changing different settings at once both keep their change.
          const [row] = await tx
            .select({ settings: organisations.settings })
            .from(organisations)
            .where(eq(organisations.id, organisationId))
            .for("update");
          if (!row) throw new NotFound("Workspace");
          const next = applyWorkspaceSettings(workspaceSettingsOf(row.settings), change);
          await tx
            .update(organisations)
            .set({ settings: next, updatedAt: new Date() })
            .where(eq(organisations.id, organisationId));
          await audit.record(
            organisationId,
            who,
            { action: "organisation.settings", details: { change } },
            requestInfo(c, trustProxy),
            tx,
          );
          return next;
        });
        return c.json({ settings });
      },
    )
    // The workspace's own delivery profiles (#144): every member reads them, since their
    // projects measure against them; admins make, change and remove them.
    .get("/delivery-profiles", async (c) =>
      c.json({ profiles: await customProfilesOf(db, c.var.organisationId) }),
    )
    .post(
      "/delivery-profiles",
      requireRole("admin"),
      zValidator("json", customProfileInput),
      async (c) => {
        const { label, ...spec } = c.req.valid("json");
        try {
          const [made] = await db
            .insert(deliveryProfiles)
            .values({ organisationId: c.var.organisationId, label, spec })
            .returning();
          if (!made) throw new Error("Profile insert returned no row");
          return c.json({ profile: { id: made.id, label: made.label, ...made.spec } }, 201);
        } catch (error) {
          if (violates(error, "delivery_profiles_label_idx")) throw profileTaken();
          throw error;
        }
      },
    )
    .put(
      "/delivery-profiles/:id",
      requireRole("admin"),
      idParam,
      zValidator("json", customProfileInput),
      async (c) => {
        const { label, ...spec } = c.req.valid("json");
        try {
          const [changed] = await db
            .update(deliveryProfiles)
            .set({ label, spec, updatedAt: new Date() })
            .where(
              inOrg(
                deliveryProfiles,
                c.var.organisationId,
                eq(deliveryProfiles.id, c.req.valid("param").id),
              ),
            )
            .returning();
          if (!changed) throw new NotFound("Profile");
          return c.json({ profile: { id: changed.id, label: changed.label, ...changed.spec } });
        } catch (error) {
          if (violates(error, "delivery_profiles_label_idx")) throw profileTaken();
          throw error;
        }
      },
    )
    // Whatever chose it measures against the next choice up from now on.
    .delete("/delivery-profiles/:id", requireRole("admin"), idParam, async (c) => {
      const gone = await db.transaction((tx) =>
        deleteCustomProfile(tx, c.var.organisationId, c.req.valid("param").id),
      );
      if (!gone) throw new NotFound("Profile");
      return c.body(null, 204);
    })
    // A template as the workspace sends it, with sample content: subject, plain text and HTML
    // for a light or a dark client.
    .get(
      "/email/:template",
      requireRole("admin"),
      zValidator("param", z.object({ template: emailTemplateId })),
      zValidator("query", z.object({ scheme: z.enum(["light", "dark"]).default("light") })),
      async (c) => {
        const { template } = c.req.valid("param");
        const [workspace] = await db
          .select({
            name: organisations.name,
            slug: organisations.slug,
            settings: organisations.settings,
          })
          .from(organisations)
          .where(eq(organisations.id, c.var.organisationId));
        if (!workspace) throw new NotFound("Workspace");
        const sample = sampleData(workspace.name, linkBase(links, workspace.slug))[template];
        const email = workspaceEmail(
          template,
          sample,
          workspaceSettingsOf(workspace.settings).emailSubjects,
        );
        // With the workspace's logo and accent (#185): the logo at this origin, as the preview
        // is shown in this app.
        const brand = emailBrandOf(await brandingOf(db, c.var.organisationId));
        if (brand) email.brand = brand;
        c.header("cache-control", "no-store");
        return c.json(render(email, c.req.valid("query").scheme));
      },
    )
    // Send a template to yourself, with sample content, to see it in your own mail client.
    .post("/email/test", requireRole("admin"), zValidator("json", emailTestInput), async (c) => {
      const { template } = c.req.valid("json");
      const [workspace] = await db
        .select({
          name: organisations.name,
          slug: organisations.slug,
          settings: organisations.settings,
        })
        .from(organisations)
        .where(eq(organisations.id, c.var.organisationId));
      const [me] = await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, c.var.userId));
      if (!workspace || !me) throw new NotFound("Workspace");
      const sample = sampleData(workspace.name, linkBase(links, workspace.slug))[template];
      const email = workspaceEmail(
        template,
        sample,
        workspaceSettingsOf(workspace.settings).emailSubjects,
      );
      try {
        await sendEmail(
          mailer,
          me.email,
          { ...email, subject: `Test: ${email.subject}` },
          c.var.organisationId,
        );
      } catch {
        throw new HTTPException(502, { message: "The mail server did not take the message" });
      }
      return c.json({ to: me.email });
    })
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
          throw new HTTPException(409, { message: "A workspace needs at least one owner" });
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
        throw new HTTPException(409, { message: "A workspace needs at least one owner" });
      }
      // Their roles in the organisation's projects go with them.
      await db.transaction(async (tx) => {
        // Lock the membership first, as role assignment does, so neither can slip past the other.
        await tx
          .select({ id: members.id })
          .from(members)
          .where(inOrg(members, c.var.organisationId, eq(members.id, id)))
          .for("update");
        await tx
          .delete(schema.projectMembers)
          .where(
            inOrg(
              schema.projectMembers,
              c.var.organisationId,
              eq(schema.projectMembers.userId, member.userId),
            ),
          );
        await tx.delete(members).where(inOrg(members, c.var.organisationId, eq(members.id, id)));
        // Their API tokens here stop working with them (#198).
        await revokeMemberTokens(tx, c.var.organisationId, member.userId, c.var.userId);
      });
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

      const { token, hash } = newInvitationToken();
      const invitation = await db.transaction(async (tx) => {
        // A new invitation replaces any pending one for the same address.
        await tx
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
        // Each invitation waiting takes a place under the member limit (#175).
        await assertMemberRoom(tx, c.var.organisationId, "invitation");
        const [made] = await tx
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
        return made;
      });
      const [organisation] = await db
        .select({
          name: organisations.name,
          slug: organisations.slug,
          settings: organisations.settings,
        })
        .from(organisations)
        .where(eq(organisations.id, c.var.organisationId));
      const [inviter] = await db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, c.var.userId));
      // At the workspace's own address with subdomains on (#437): its sign-in names it.
      const link = `${linkBase(links, organisation?.slug)}/invite/${token}`;
      await sendEmail(
        mailer,
        email,
        workspaceEmail(
          "invitation",
          {
            workspace: organisation?.name ?? "Hekate",
            inviter: inviter?.name ?? "Someone",
            url: link,
            days: Math.round(INVITATION_LIFETIME_MS / (24 * 60 * 60 * 1000)),
          },
          workspaceSettingsOf(organisation?.settings).emailSubjects,
        ),
        c.var.organisationId,
      );
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
    // The workspace's guests: who they are, when they were last sent a link, and whether a
    // link or a signed-in browser still works for them.
    .get("/guests", requireRole("admin"), async (c) => {
      const organisationId = c.var.organisationId;
      // Raw SQL takes the time as text; PostgreSQL reads it as a timestamptz.
      const now = new Date().toISOString();
      const lastLink = db
        .select({ guestId: guestLinks.guestId, at: max(guestLinks.createdAt).as("at") })
        .from(guestLinks)
        .where(eq(guestLinks.organisationId, organisationId))
        .groupBy(guestLinks.guestId)
        .as("last_link");
      const rows = await db
        .select({
          id: guests.id,
          name: guests.name,
          email: guests.email,
          label: guests.label,
          lastLinkAt: lastLink.at,
          live: sql<boolean>`exists (
            select 1 from ${guestLinks} where ${guestLinks.guestId} = ${guests.id}
              and ${guestLinks.organisationId} = ${organisationId}
              and ${guestLinks.usedAt} is null and ${guestLinks.revokedAt} is null
              and ${guestLinks.expiresAt} > ${now}
          ) or exists (
            select 1 from ${guestSessions} where ${guestSessions.guestId} = ${guests.id}
              and ${guestSessions.organisationId} = ${organisationId}
              and ${guestSessions.revokedAt} is null and ${guestSessions.expiresAt} > ${now}
          )`,
        })
        .from(guests)
        .leftJoin(lastLink, eq(lastLink.guestId, guests.id))
        .where(inOrg(guests, organisationId))
        .orderBy(asc(guests.name));
      return c.json({ guests: rows });
    })
    // End every link and signed-in browser a guest has, across the workspace.
    .post("/guests/:id/revoke", requireRole("admin"), idParam, async (c) => {
      const { id } = c.req.valid("param");
      const organisationId = c.var.organisationId;
      const who = await audit.member(c.var.userId);
      await db.transaction(async (tx) => {
        // The same lock a new link takes, so none can be issued while this revokes.
        const [guest] = await tx
          .select({ id: guests.id })
          .from(guests)
          .where(inOrg(guests, organisationId, eq(guests.id, id)))
          .for("update");
        if (!guest) throw new NotFound("Guest");
        await revokeGuest(tx, organisationId, guest.id);
        await audit.record(
          organisationId,
          who,
          { action: "guest.revoke", details: { guestId: guest.id } },
          requestInfo(c, trustProxy),
          tx,
        );
      });
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
    )
    .get("/audit", requireRole("admin"), zValidator("query", auditQuery), async (c) => {
      const organisationId = c.var.organisationId;
      const page = await audit.query(organisationId, c.req.valid("query"));
      // What each entry touched, by name, so repeated renders or downloads tell apart. A
      // file or review deleted since keeps its id and has no name.
      const fileIds = [...new Set(page.events.flatMap((e) => (e.fileId ? [e.fileId] : [])))];
      const reviewIds = [...new Set(page.events.flatMap((e) => (e.reviewId ? [e.reviewId] : [])))];
      const [fileNames, reviewTitles] = await Promise.all([
        fileIds.length
          ? db
              .select({ id: files.id, name: files.name })
              .from(files)
              .where(inOrg(files, organisationId, inArray(files.id, fileIds)))
          : [],
        reviewIds.length
          ? db
              .select({ id: reviews.id, name: reviews.title })
              .from(reviews)
              .where(inOrg(reviews, organisationId, inArray(reviews.id, reviewIds)))
          : [],
      ]);
      const fileName = new Map(fileNames.map((f) => [f.id, f.name]));
      const reviewTitle = new Map(reviewTitles.map((r) => [r.id, r.name]));
      return c.json({
        ...page,
        events: page.events.map((e) => ({
          ...e,
          fileName: e.fileId ? (fileName.get(e.fileId) ?? null) : null,
          reviewTitle: e.reviewId ? (reviewTitle.get(e.reviewId) ?? null) : null,
        })),
      });
    })
    .get(
      "/audit.csv",
      requireRole("admin"),
      zValidator("query", auditQuery.omit({ before: true, limit: true })),
      async (c) => {
        const filters = c.req.valid("query");
        const organisationId = c.var.organisationId;
        // Exporting the log is itself recorded, before any of it leaves.
        await audit.record(
          organisationId,
          await audit.member(c.var.userId),
          { action: "audit.export", details: { filters } },
          requestInfo(c, trustProxy),
        );
        const encoder = new TextEncoder();
        let before: string | undefined;
        let started = false;
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            if (!started) {
              started = true;
              controller.enqueue(encoder.encode(csvHeader()));
            }
            const page = await audit.query(organisationId, {
              ...filters,
              limit: 200,
              ...(before ? { before } : {}),
            });
            for (const event of page.events) controller.enqueue(encoder.encode(csvRow(event)));
            if (page.nextBefore) before = page.nextBefore;
            else controller.close();
          },
        });
        const stamp = new Date().toISOString().slice(0, 10);
        return c.body(body, 200, {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="hekate-access-log-${stamp}.csv"`,
          "cache-control": "no-store",
        });
      },
    );
