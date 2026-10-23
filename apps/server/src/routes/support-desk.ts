import { inOrg, schema } from "@hekate/db";
import {
  type CannedReply,
  cannedReplyInput,
  median,
  type OperatorTicketDetail,
  type SupportDesk,
  type SupportFigures,
  supportDeskInput,
  ticketReplyInput,
  ticketStateInput,
  ticketsQuery,
} from "@hekate/shared";
import { zValidator } from "@hono/zod-validator";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  isNotNull,
  max,
  ne,
  or,
  type SQL,
} from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { requestInfo } from "../audit.ts";
import { CodedException, NotFound } from "../errors.ts";
import { recordInstanceEvent } from "../instance-events.ts";
import { escapeLike } from "../logs.ts";
import { listPlans, workspacePlanOf } from "../plans.ts";
import { signal } from "../signals.ts";
import {
  assertSupportOn,
  attachTo,
  detailOf,
  messageCounts,
  replyTo,
  rowOf,
  type SupportDeps,
  sendTicketAttachment,
  setState,
  type TicketRecord,
  ticketById,
} from "../support.ts";

const { tickets, organisations, cannedReplies, users } = schema;

interface DeskVariables {
  userId: string;
  sessionId: string;
}

export interface DeskDeps extends SupportDeps {
  /** Where workspaces answer with subdomains on (#176), as `*.review.example`. */
  subdomains: string | null;
}

const idParam = zValidator("param", z.object({ id: z.uuid() }));
const messageParam = zValidator("param", z.object({ id: z.uuid(), messageId: z.uuid() }));
const attachmentParam = zValidator("param", z.object({ id: z.uuid(), attachmentId: z.uuid() }));

const monthStart = () => {
  const day = new Date();
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1));
};

/**
 * `/api/instance/support` (#182): the desk. Tickets across workspaces with their filters, a
 * ticket with who asked and the workspace it came from, replies, states, canned replies and
 * the desk's settings. The operators', behind `operatorsOnly`, with tickets in the app.
 */
export const supportDeskRoutes = (deps: DeskDeps) => {
  const { db } = deps;
  const event = (
    c: Context<{ Variables: DeskVariables }>,
    action: string,
    target: string,
    details: Record<string, unknown>,
  ) =>
    recordInstanceEvent(db, {
      actorId: c.var.userId,
      action,
      target,
      details,
      ipAddress: requestInfo(c, deps.trustProxy).ipAddress ?? null,
    });
  return (
    new Hono<{ Variables: DeskVariables }>()
      .use("*", async (_c, next) => {
        assertSupportOn(deps.modules);
        await next();
      })
      // The tickets, filtered, with the desk's figures and the workspaces that have asked.
      .get("/", zValidator("query", ticketsQuery), async (c) => {
        const { state, severity, workspace, q } = c.req.valid("query");
        const like = q ? `%${escapeLike(q)}%` : null;
        const conditions: (SQL | undefined)[] = [
          state === "open"
            ? ne(tickets.state, "resolved")
            : state === "waiting"
              ? eq(tickets.state, "waiting")
              : undefined,
          severity ? eq(tickets.severity, severity) : undefined,
          workspace ? eq(tickets.organisationId, workspace) : undefined,
          like
            ? or(
                ilike(tickets.subject, like),
                ilike(tickets.reference, like),
                ilike(tickets.requesterName, like),
                ilike(organisations.name, like),
              )
            : undefined,
        ];
        // Across workspaces deliberately: the desk answers every workspace's tickets.
        const rows = await db
          .select({
            ticket: tickets,
            workspace: { id: organisations.id, name: organisations.name },
          })
          .from(tickets)
          .innerJoin(organisations, eq(organisations.id, tickets.organisationId))
          .where(and(...conditions))
          .orderBy(desc(tickets.updatedAt))
          .limit(200);
        const counts = await messageCounts(
          db,
          null,
          rows.map((r) => r.ticket.id),
        );
        const since = monthStart();
        // Across workspaces deliberately: the desk's own figures.
        const [[open], [waiting], [resolved], replied, asking] = await Promise.all([
          db.select({ n: count() }).from(tickets).where(ne(tickets.state, "resolved")),
          db.select({ n: count() }).from(tickets).where(eq(tickets.state, "waiting")),
          db.select({ n: count() }).from(tickets).where(gte(tickets.resolvedAt, since)),
          db
            .select({ createdAt: tickets.createdAt, firstReplyAt: tickets.firstReplyAt })
            .from(tickets)
            .where(and(isNotNull(tickets.firstReplyAt), gte(tickets.firstReplyAt, since))),
          db
            .selectDistinct({ id: organisations.id, name: organisations.name })
            .from(tickets)
            .innerJoin(organisations, eq(organisations.id, tickets.organisationId))
            .orderBy(organisations.name),
        ]);
        const hours = median(
          replied.map(
            (r) => ((r.firstReplyAt?.getTime() ?? 0) - r.createdAt.getTime()) / 3_600_000,
          ),
        );
        return c.json({
          tickets: rows.map((r) => rowOf(r.ticket, counts.get(r.ticket.id) ?? 0, r.workspace)),
          figures: {
            open: open?.n ?? 0,
            waiting: waiting?.n ?? 0,
            firstReplyHours: hours === null ? null : Math.round(hours * 10) / 10,
            resolved: resolved?.n ?? 0,
          } satisfies SupportFigures,
          workspaces: asking,
        });
      })
      .get("/tickets/:id", idParam, async (c) =>
        c.json({
          ticket: await operatorDetail(deps, await ticketById(db, c.req.valid("param").id)),
        }),
      )
      // An operator's answer: the ticket waits on the workspace, unless they set it otherwise.
      .post("/tickets/:id/messages", idParam, zValidator("json", ticketReplyInput), async (c) => {
        const ticket = await ticketById(db, c.req.valid("param").id);
        const { body, state } = c.req.valid("json");
        const messageId = await replyTo(
          deps,
          ticket,
          { author: "operator", userId: c.var.userId },
          body,
          state,
        );
        await event(c, "support.replied", ticket.reference, {
          ticketId: ticket.id,
          organisationId: ticket.organisationId,
        });
        return c.json(
          { ticket: await operatorDetail(deps, await ticketById(db, ticket.id)), messageId },
          201,
        );
      })
      .put("/tickets/:id/state", idParam, zValidator("json", ticketStateInput), async (c) => {
        const ticket = await ticketById(db, c.req.valid("param").id);
        const { state } = c.req.valid("json");
        if (state !== ticket.state) {
          await setState(db, ticket, state);
          await event(c, "support.state", ticket.reference, {
            ticketId: ticket.id,
            organisationId: ticket.organisationId,
            state,
          });
        }
        return c.json({ ticket: await operatorDetail(deps, await ticketById(db, ticket.id)) });
      })
      .post("/tickets/:id/messages/:messageId/attachments", messageParam, async (c) => {
        const { id, messageId } = c.req.valid("param");
        const ticket = await ticketById(db, id);
        const attachment = await attachTo(deps, c, ticket, messageId, c.var.userId);
        return c.json({ attachment }, 201);
      })
      // An operator's download is in the workspace's access log, under their name.
      .post("/tickets/:id/attachments/:attachmentId/download", attachmentParam, async (c) => {
        const { id, attachmentId } = c.req.valid("param");
        const ticket = await ticketById(db, id);
        const actor = await deps.audit.member(c.var.userId);
        return sendTicketAttachment(deps, c, ticket, attachmentId, {
          ...actor,
          label: `${actor.label} (operator)`,
        });
      })
      // Canned replies: the desk's, to start an answer from.
      .get("/replies", async (c) => c.json({ replies: await repliesOf(deps) }))
      .post("/replies", zValidator("json", cannedReplyInput), async (c) => {
        const input = c.req.valid("json");
        await db.insert(cannedReplies).values({ ...input, createdBy: c.var.userId });
        await event(c, "support.reply_saved", input.title, {});
        return c.json({ replies: await repliesOf(deps) }, 201);
      })
      .put("/replies/:id", idParam, zValidator("json", cannedReplyInput), async (c) => {
        const input = c.req.valid("json");
        const [saved] = await db
          .update(cannedReplies)
          .set({ ...input, updatedAt: new Date() })
          .where(eq(cannedReplies.id, c.req.valid("param").id))
          .returning({ id: cannedReplies.id });
        if (!saved) throw new NotFound("Reply");
        await event(c, "support.reply_saved", input.title, { replyId: saved.id });
        return c.json({ replies: await repliesOf(deps) });
      })
      .delete("/replies/:id", idParam, async (c) => {
        const [gone] = await db
          .delete(cannedReplies)
          .where(eq(cannedReplies.id, c.req.valid("param").id))
          .returning({ title: cannedReplies.title });
        if (!gone) throw new NotFound("Reply");
        await event(c, "support.reply_removed", gone.title, {});
        return c.json({ replies: await repliesOf(deps) });
      })
      // The desk's settings: its status page and who is on call.
      .get("/desk", async (c) => c.json(await deskOf(deps)))
      .put("/desk", zValidator("json", supportDeskInput), async (c) => {
        const input = c.req.valid("json");
        if (input.onCall) {
          const [operator] = await db
            .select({ id: schema.instanceOperators.userId })
            .from(schema.instanceOperators)
            .where(eq(schema.instanceOperators.userId, input.onCall));
          if (!operator)
            throw new CodedException(422, "not_operator", "Only an operator can be on call");
        }
        await db.transaction(async (tx) => {
          const { before, after } = await deps.settings.write(
            tx,
            (stored) => ({ ...stored, support: input }),
            c.var.userId,
          );
          await signal(tx, "settings");
          if (before.support.statusUrl !== after.support.statusUrl)
            await recordInstanceEvent(tx, {
              actorId: c.var.userId,
              action: "support.status_page",
              target: "The support desk",
              details: { url: after.support.statusUrl },
              ipAddress: requestInfo(c, deps.trustProxy).ipAddress ?? null,
            });
          if (before.support.onCall !== after.support.onCall)
            await recordInstanceEvent(tx, {
              actorId: c.var.userId,
              action: "support.on_call",
              target: "The support desk",
              details: { userId: after.support.onCall },
              ipAddress: requestInfo(c, deps.trustProxy).ipAddress ?? null,
            });
        });
        deps.settings.forget();
        return c.json(await deskOf(deps));
      })
  );
};

async function repliesOf(deps: SupportDeps): Promise<CannedReply[]> {
  return deps.db
    .select({ id: cannedReplies.id, title: cannedReplies.title, body: cannedReplies.body })
    .from(cannedReplies)
    .orderBy(asc(cannedReplies.title));
}

async function deskOf(deps: SupportDeps): Promise<SupportDesk> {
  const { support } = await deps.settings.get();
  const operators = await deps.db
    .select({ id: users.id, name: users.name })
    .from(schema.instanceOperators)
    .innerJoin(users, eq(users.id, schema.instanceOperators.userId))
    .orderBy(asc(users.name));
  const billing = deps.modules.billing !== "off";
  return {
    statusUrl: support.statusUrl,
    environmentStatusUrl: deps.modules.statusUrl,
    onCall: operators.some((o) => o.id === support.onCall) ? support.onCall : null,
    operators,
    plans: billing
      ? (await listPlans(deps.db))
          .filter((p) => !p.retiredAt)
          .map((p) => ({ id: p.id, name: p.name, severities: p.severities }))
      : [],
    billing,
  };
}

/** A ticket as the desk sees it: who asked, and the workspace it came from. */
async function operatorDetail(deps: DeskDeps, t: TicketRecord): Promise<OperatorTicketDetail> {
  const { db } = deps;
  const detail = await detailOf(db, t);
  const [person] = t.requesterId
    ? await db
        .select({ name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, t.requesterId))
    : [];
  const [membership] = t.requesterId
    ? await db
        .select({ role: schema.members.role })
        .from(schema.members)
        .where(inOrg(schema.members, t.organisationId, eq(schema.members.userId, t.requesterId)))
    : [];
  const [seen] = t.requesterId
    ? await db
        .select({ at: max(schema.authSessions.updatedAt) })
        .from(schema.authSessions)
        .where(eq(schema.authSessions.userId, t.requesterId))
    : [];
  const [place] = await db
    .select({ id: organisations.id, name: organisations.name, slug: organisations.slug })
    .from(organisations)
    .where(eq(organisations.id, t.organisationId));
  const [reviews] = await db
    .select({ n: count() })
    .from(schema.reviews)
    .where(inOrg(schema.reviews, t.organisationId, eq(schema.reviews.status, "open")));
  const plan = await workspacePlanOf(db, t.organisationId, deps.modules.billing !== "off");
  const slug = place?.slug ?? "";
  return {
    ...detail,
    workspace: { id: t.organisationId, name: place?.name ?? "" },
    who: {
      id: person ? t.requesterId : null,
      name: person?.name ?? t.requesterName,
      email: person?.email ?? null,
      role: membership?.role ?? null,
      lastSeenAt: seen?.at ? new Date(seen.at).toISOString() : null,
    },
    place: {
      id: t.organisationId,
      name: place?.name ?? "",
      address: deps.subdomains ? deps.subdomains.replaceAll("*", slug) : slug,
      plan: plan.plan?.name ?? null,
      openReviews: reviews?.n ?? 0,
    },
  };
}
