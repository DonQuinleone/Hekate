import { inOrg, schema } from "@hekate/db";
import {
  severityChoices,
  ticketInput,
  ticketReplyInput,
  type WorkspaceSupport,
} from "@hekate/shared";
import { desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "../openapi/validator.ts";
import { listPlans, workspacePlanOf } from "../plans.ts";
import {
  assertSupportOn,
  attachTo,
  createTicket,
  detailOf,
  messageCounts,
  readsEveryTicket,
  recentErrorOf,
  replyTo,
  rowOf,
  type SupportDeps,
  sendTicketAttachment,
  setState,
  ticketFor,
} from "../support.ts";
import type { TenantVariables } from "../tenancy.ts";

const { tickets } = schema;

const ticketParam = zValidator("param", z.object({ id: z.uuid() }));
const messageParam = zValidator("param", z.object({ id: z.uuid(), messageId: z.uuid() }));
const attachmentParam = zValidator("param", z.object({ id: z.uuid(), attachmentId: z.uuid() }));

/**
 * `/api/organisation/support` (#181): the workspace's tickets to the people who run the
 * instance. Any member may ask; each reads their own tickets, and owners and admins read every
 * one the workspace sent. Only with tickets in the app (HEKATE_SUPPORT=app).
 */
export const supportRoutes = (deps: SupportDeps) =>
  new Hono<{ Variables: TenantVariables }>()
    .use("*", async (_c, next) => {
      assertSupportOn(deps.modules);
      await next();
    })
    // The Support page: the tickets, the severities the plan allows, and a failure to attach.
    .get("/", async (c) => {
      const { db } = deps;
      const organisationId = c.var.organisationId;
      const everyone = readsEveryTicket(c.var.organisationRole);
      const rows = await db
        .select()
        .from(tickets)
        .where(
          inOrg(
            tickets,
            organisationId,
            everyone ? undefined : eq(tickets.requesterId, c.var.userId),
          ),
        )
        .orderBy(desc(tickets.updatedAt))
        .limit(200);
      const counts = await messageCounts(
        db,
        organisationId,
        rows.map((r) => r.id),
      );
      const billing = deps.modules.billing !== "off";
      const plan = await workspacePlanOf(db, organisationId, billing);
      return c.json({
        tickets: rows.map((r) => rowOf(r, counts.get(r.id) ?? 0)),
        severities: severityChoices(plan.entitlements, billing ? await listPlans(db) : []),
        recentError: await recentErrorOf(db, organisationId, c.var.userId),
      } satisfies WorkspaceSupport);
    })
    .post("/tickets", zValidator("json", ticketInput), async (c) => {
      const { ticket, messageId } = await createTicket(
        deps,
        { organisationId: c.var.organisationId, userId: c.var.userId },
        c.req.valid("json"),
      );
      return c.json({ ticket: await detailOf(deps.db, ticket), messageId }, 201);
    })
    .get("/tickets/:id", ticketParam, async (c) => {
      const ticket = await ticketFor(deps.db, c.var.organisationId, c.req.valid("param").id, {
        userId: c.var.userId,
        role: c.var.organisationRole,
      });
      return c.json({ ticket: await detailOf(deps.db, ticket) });
    })
    // A reply from the workspace puts the ticket back with support, a resolved one too.
    .post(
      "/tickets/:id/messages",
      ticketParam,
      zValidator("json", ticketReplyInput.omit({ state: true })),
      async (c) => {
        const viewer = { userId: c.var.userId, role: c.var.organisationRole };
        const ticket = await ticketFor(
          deps.db,
          c.var.organisationId,
          c.req.valid("param").id,
          viewer,
        );
        const messageId = await replyTo(
          deps,
          ticket,
          { author: "member", userId: c.var.userId },
          c.req.valid("json").body,
        );
        const fresh = await ticketFor(deps.db, c.var.organisationId, ticket.id, viewer);
        return c.json({ ticket: await detailOf(deps.db, fresh), messageId }, 201);
      },
    )
    .post("/tickets/:id/resolve", ticketParam, async (c) => {
      const viewer = { userId: c.var.userId, role: c.var.organisationRole };
      const ticket = await ticketFor(
        deps.db,
        c.var.organisationId,
        c.req.valid("param").id,
        viewer,
      );
      await setState(deps.db, ticket, "resolved");
      const fresh = await ticketFor(deps.db, c.var.organisationId, ticket.id, viewer);
      return c.json({ ticket: await detailOf(deps.db, fresh) });
    })
    .post("/tickets/:id/messages/:messageId/attachments", messageParam, async (c) => {
      const { id, messageId } = c.req.valid("param");
      const ticket = await ticketFor(deps.db, c.var.organisationId, id, {
        userId: c.var.userId,
        role: c.var.organisationRole,
      });
      const attachment = await attachTo(deps, c, ticket, messageId, c.var.userId);
      return c.json({ attachment }, 201);
    })
    .post("/tickets/:id/attachments/:attachmentId/download", attachmentParam, async (c) => {
      const { id, attachmentId } = c.req.valid("param");
      const ticket = await ticketFor(deps.db, c.var.organisationId, id, {
        userId: c.var.userId,
        role: c.var.organisationRole,
      });
      return sendTicketAttachment(
        deps,
        c,
        ticket,
        attachmentId,
        await deps.audit.member(c.var.userId),
      );
    });
