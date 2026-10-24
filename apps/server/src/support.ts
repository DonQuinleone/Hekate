import { randomBytes } from "node:crypto";
import { type Database, inOrg, schema } from "@hekate/db";
import {
  attachmentName,
  errorReferencesIn,
  formatTicketReference,
  type InstanceModules,
  nextTicketState,
  type OrganisationRole,
  type SupportModule,
  severityAllowed,
  severityNames,
  TICKET_ATTACHMENT_MAX_BYTES,
  TICKET_ATTACHMENTS_MAX,
  type TicketAttachment,
  type TicketAuthor,
  type TicketDetail,
  type TicketInput,
  type TicketMessage,
  type TicketRow,
  type TicketState,
  ticketInput,
  ticketKindNames,
} from "@hekate/shared";
import { and, asc, count, desc, eq, gte, inArray, isNull, or } from "drizzle-orm";
import type { Context } from "hono";
import { type Actor, type Audit, requestInfo } from "./audit.ts";
import { CodedException, NotFound } from "./errors.ts";
import type { Subdomains } from "./hosts.ts";
import type { InstanceSettingsStore } from "./instance-settings.ts";
import { type Mailer, sendEmail } from "./mail.ts";
import { notifyNow } from "./notifications.ts";
import { workspacePlanOf } from "./plans.ts";
import { attachment } from "./routes/comments.ts";
import type { Storage } from "./storage.ts";

const { tickets, ticketMessages, ticketAttachments, users, organisations } = schema;

/**
 * Support (#181, #182): tickets from a workspace to the people who run the instance. The
 * workspace's routes and the desk's share what is here: making a ticket, its thread, its
 * attachments and the mail each side gets as the other writes.
 */
export interface SupportDeps {
  db: Database;
  storage: Storage;
  audit: Audit;
  mailer: Mailer;
  publicUrl: string;
  trustProxy: boolean;
  modules: InstanceModules;
  settings: InstanceSettingsStore;
  /** Each workspace's own address for the links its people are sent, with subdomains on (#437). */
  workspaceHosts?: Subdomains | null;
}

/** What the help menu and the Support page are told about the module. */
export async function supportModuleOf(
  modules: InstanceModules,
  settings: InstanceSettingsStore,
  publicUrl: string,
): Promise<SupportModule> {
  const desk = (await settings.get()).support;
  return {
    mode: modules.support,
    address: modules.supportAddress ?? null,
    docsUrl: modules.docsUrl,
    statusUrl: desk.statusUrl ?? modules.statusUrl ?? ownStatusUrl(publicUrl),
  };
}

/** The instance's own status page (#183), which every instance serves. */
export const ownStatusUrl = (publicUrl: string) => new URL("/status", publicUrl).toString();

/** Refused unless tickets are answered in the app (HEKATE_SUPPORT=app). */
export function assertSupportOn(modules: InstanceModules) {
  if (modules.support !== "app")
    throw new CodedException(
      409,
      "support_off",
      "Tickets are answered in the app only with the support module set to app (HEKATE_SUPPORT).",
    );
}

const billingOn = (modules: InstanceModules) => modules.billing !== "off";

/** Who may read a ticket: its requester, and the workspace's owners and admins. */
export const readsEveryTicket = (role: OrganisationRole) => role === "owner" || role === "admin";

/** A ticket of this workspace this member may read, or 404 (another's is never confirmed). */
export async function ticketFor(
  db: Pick<Database, "select">,
  organisationId: string,
  ticketId: string,
  viewer: { userId: string; role: OrganisationRole } | null,
) {
  const [row] = await db
    .select()
    .from(tickets)
    .where(inOrg(tickets, organisationId, eq(tickets.id, ticketId)));
  if (!row) throw new NotFound("Ticket");
  if (viewer && !readsEveryTicket(viewer.role) && row.requesterId !== viewer.userId)
    throw new NotFound("Ticket");
  return row;
}

type TicketRecord = typeof tickets.$inferSelect;

/** A ticket as a list shows it, with how many messages its thread holds. */
export function rowOf(
  t: TicketRecord,
  messages: number,
  workspace?: { id: string; name: string },
): TicketRow {
  return {
    id: t.id,
    reference: t.reference,
    subject: t.subject,
    kind: t.kind,
    severity: t.severity,
    state: t.state,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    messages,
    requester: { id: t.requesterId, name: t.requesterName },
    ...(workspace ? { workspace } : {}),
  };
}

/** How many messages each ticket holds. */
export async function messageCounts(
  db: Pick<Database, "select">,
  organisationId: string | null,
  ids: string[],
) {
  if (ids.length === 0) return new Map<string, number>();
  const rows = await db
    .select({ ticketId: ticketMessages.ticketId, n: count() })
    .from(ticketMessages)
    .where(
      organisationId
        ? inOrg(ticketMessages, organisationId, inArray(ticketMessages.ticketId, ids))
        : // Across workspaces deliberately: the desk's list counts every ticket it shows.
          inArray(ticketMessages.ticketId, ids),
    )
    .groupBy(ticketMessages.ticketId);
  return new Map(rows.map((r) => [r.ticketId, r.n]));
}

/** A ticket's thread, oldest first, with each message's attachments. */
export async function threadOf(
  db: Pick<Database, "select">,
  organisationId: string,
  ticketId: string,
): Promise<TicketMessage[]> {
  const messages = await db
    .select()
    .from(ticketMessages)
    .where(inOrg(ticketMessages, organisationId, eq(ticketMessages.ticketId, ticketId)))
    .orderBy(asc(ticketMessages.createdAt), asc(ticketMessages.id));
  const files =
    messages.length === 0
      ? []
      : await db
          .select()
          .from(ticketAttachments)
          .where(
            inOrg(
              ticketAttachments,
              organisationId,
              inArray(
                ticketAttachments.messageId,
                messages.map((m) => m.id),
              ),
            ),
          )
          .orderBy(asc(ticketAttachments.createdAt));
  return messages.map((m) => ({
    id: m.id,
    author: m.author,
    name: m.authorName,
    authorId: m.authorId,
    body: m.body,
    createdAt: m.createdAt.toISOString(),
    attachments: files
      .filter((f) => f.messageId === m.id)
      .map(
        (f): TicketAttachment => ({
          id: f.id,
          name: f.name,
          contentType: f.contentType,
          byteSize: f.byteSize,
        }),
      ),
  }));
}

/** A ticket with its thread, and the item it was asked from, by name. */
export async function detailOf(
  db: Pick<Database, "select">,
  t: TicketRecord,
): Promise<TicketDetail> {
  const thread = await threadOf(db, t.organisationId, t.id);
  let item: TicketDetail["item"] = null;
  if (t.itemKind && t.itemId) {
    const [named] =
      t.itemKind === "file"
        ? await db
            .select({ name: schema.files.name })
            .from(schema.files)
            .where(inOrg(schema.files, t.organisationId, eq(schema.files.id, t.itemId)))
        : await db
            .select({ name: schema.reviews.title })
            .from(schema.reviews)
            .where(inOrg(schema.reviews, t.organisationId, eq(schema.reviews.id, t.itemId)));
    item = { kind: t.itemKind, id: t.itemId, name: named?.name ?? null };
  }
  return {
    ...rowOf(t, thread.length),
    errorReference: t.errorReference,
    item,
    operatorAccess: t.operatorAccess,
    thread,
  };
}

/**
 * Makes the ticket under a new reference, unique across the instance. The unique index decides,
 * so two tickets sent at once can never share one; a clash is tried again with another.
 */
async function insertTicket(
  tx: Pick<Database, "insert">,
  values: Omit<typeof tickets.$inferInsert, "reference">,
) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const [made] = await tx
      .insert(tickets)
      .values({ ...values, reference: formatTicketReference(randomBytes(3)) })
      .onConflictDoNothing({ target: tickets.reference })
      .returning();
    if (made) return made;
  }
  throw new Error("Could not make a ticket reference");
}

/**
 * The error reports (#159) a ticket may carry: those that happened in this workspace, or to
 * this person outside any workspace. Another workspace's failure is never attached, nor
 * confirmed to exist.
 */
async function reportsOf(
  db: Pick<Database, "select">,
  organisationId: string,
  userId: string,
  references: string[],
) {
  if (references.length === 0) return [];
  const r = schema.errorReports;
  return db
    .select({ reference: r.reference, location: r.location, occurredAt: r.occurredAt })
    .from(r)
    .where(
      and(
        inArray(r.reference, references),
        or(
          eq(r.organisationId, organisationId),
          and(isNull(r.organisationId), eq(r.userId, userId)),
        ),
      ),
    );
}

/** The last failure this person saw in this workspace in the past day, offered to attach. */
export async function recentErrorOf(
  db: Pick<Database, "select">,
  organisationId: string,
  userId: string,
) {
  const r = schema.errorReports;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [last] = await db
    .select({ reference: r.reference, occurredAt: r.occurredAt })
    .from(r)
    .where(
      and(eq(r.organisationId, organisationId), eq(r.userId, userId), gte(r.occurredAt, since)),
    )
    .orderBy(desc(r.occurredAt))
    .limit(1);
  return last ? { reference: last.reference, occurredAt: last.occurredAt.toISOString() } : null;
}

const clock = (date: Date) =>
  date.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });

/** Sends a ticket from the workspace: its reference made, its severity held to the plan. */
export async function createTicket(
  deps: SupportDeps,
  who: { organisationId: string; userId: string },
  given: TicketInput,
) {
  const input = ticketInput.parse(given);
  const { db } = deps;
  const plan = await workspacePlanOf(db, who.organisationId, billingOn(deps.modules));
  if (!severityAllowed(plan.entitlements, input.severity))
    throw new CodedException(
      403,
      "severity_not_entitled",
      `${severityNames[input.severity]} is not on this workspace's plan.`,
    );
  if (input.item) {
    const { kind, id } = input.item;
    const [found] =
      kind === "file"
        ? await db
            .select({ id: schema.files.id })
            .from(schema.files)
            .where(inOrg(schema.files, who.organisationId, eq(schema.files.id, id)))
        : await db
            .select({ id: schema.reviews.id })
            .from(schema.reviews)
            .where(inOrg(schema.reviews, who.organisationId, eq(schema.reviews.id, id)));
    if (!found) throw new NotFound(kind === "file" ? "File" : "Review");
  }
  // The reference they chose to attach must be theirs to attach; those quoted in the words
  // are attached where they are, and left alone where they are not.
  const chosen = input.errorReference ? [input.errorReference] : [];
  const quoted = errorReferencesIn(`${input.subject}\n${input.message}`).filter(
    (r) => !chosen.includes(r),
  );
  const reports = await reportsOf(db, who.organisationId, who.userId, [...chosen, ...quoted]);
  if (input.errorReference && !reports.some((r) => r.reference === input.errorReference))
    throw new CodedException(
      422,
      "unknown_error_reference",
      `No error ${input.errorReference} happened in this workspace in the last 30 days.`,
    );
  const [person] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, who.userId));
  const name = person?.name ?? "Someone";
  const made = await db.transaction(async (tx) => {
    const ticket = await insertTicket(tx, {
      organisationId: who.organisationId,
      subject: input.subject,
      kind: input.kind,
      severity: input.severity,
      state: "waiting",
      requesterId: who.userId,
      requesterName: name,
      errorReference: input.errorReference ?? reports[0]?.reference ?? null,
      itemKind: input.item?.kind ?? null,
      itemId: input.item?.id ?? null,
      operatorAccess: input.item ? input.operatorAccess : false,
    });
    const [first] = await tx
      .insert(ticketMessages)
      .values({
        organisationId: who.organisationId,
        ticketId: ticket.id,
        author: "member",
        authorId: who.userId,
        authorName: name,
        body: input.message,
      })
      .returning({ id: ticketMessages.id });
    for (const report of reports)
      await tx.insert(ticketMessages).values({
        organisationId: who.organisationId,
        ticketId: ticket.id,
        author: "system",
        authorId: null,
        authorName: "Hekate",
        body: `Error ${report.reference} attached: it happened at ${report.location}, ${clock(report.occurredAt)} UTC. The operators see its whole story.`,
      });
    return { ticket, messageId: first?.id ?? "" };
  });
  await tellOperators(deps, made.ticket, { name, body: input.message }, "new").catch(
    (error: unknown) =>
      console.error(`Could not tell the operators of ticket ${made.ticket.reference}:`, error),
  );
  return made;
}

/**
 * A reply in a ticket's thread, from the workspace or an operator, moving its state on; the
 * other side hears of it by mail. An operator may set another state as they send.
 */
export async function replyTo(
  deps: SupportDeps,
  ticket: TicketRecord,
  from: { author: Exclude<TicketAuthor, "system">; userId: string },
  body: string,
  state?: TicketState,
) {
  const [person] = await deps.db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, from.userId));
  const next =
    state ?? nextTicketState(from.author === "operator" ? "operator_reply" : "workspace_reply");
  const now = new Date();
  const messageId = await deps.db.transaction(async (tx) => {
    const [message] = await tx
      .insert(ticketMessages)
      .values({
        organisationId: ticket.organisationId,
        ticketId: ticket.id,
        author: from.author,
        authorId: from.userId,
        authorName: person?.name ?? "Someone",
        body,
      })
      .returning({ id: ticketMessages.id });
    await tx
      .update(tickets)
      .set({
        state: next,
        resolvedAt: next === "resolved" ? now : null,
        ...(from.author === "operator" && !ticket.firstReplyAt ? { firstReplyAt: now } : {}),
        updatedAt: now,
      })
      .where(inOrg(tickets, ticket.organisationId, eq(tickets.id, ticket.id)));
    return message?.id ?? "";
  });
  const tell =
    from.author === "operator"
      ? tellRequester(deps, ticket, from.userId, body)
      : tellOperators(deps, ticket, { name: person?.name ?? "Someone", body }, "reply");
  await tell.catch((error: unknown) =>
    console.error(`Could not send the reply to ticket ${ticket.reference} on:`, error),
  );
  return messageId;
}

/** Sets where a ticket stands; resolving it records when. */
export async function setState(
  db: Pick<Database, "update">,
  ticket: TicketRecord,
  state: TicketState,
) {
  const now = new Date();
  await db
    .update(tickets)
    .set({
      state,
      resolvedAt: state === "resolved" ? (ticket.resolvedAt ?? now) : null,
      updatedAt: now,
    })
    .where(inOrg(tickets, ticket.organisationId, eq(tickets.id, ticket.id)));
}

/** Who hears of a ticket on the desk: the operator on call, else every operator; and those who answered it. */
async function deskRecipients(deps: SupportDeps, ticket: TicketRecord) {
  const { onCall } = (await deps.settings.get()).support;
  const operators = await deps.db
    .select({ id: users.id, email: users.email })
    .from(schema.instanceOperators)
    .innerJoin(users, eq(users.id, schema.instanceOperators.userId));
  const onDuty = operators.filter((o) => o.id === onCall);
  const chosen = onDuty.length > 0 ? onDuty : operators;
  const answered = await deps.db
    .selectDistinct({ id: ticketMessages.authorId })
    .from(ticketMessages)
    .where(
      inOrg(
        ticketMessages,
        ticket.organisationId,
        eq(ticketMessages.ticketId, ticket.id),
        eq(ticketMessages.author, "operator"),
      ),
    );
  const also = operators.filter((o) => answered.some((a) => a.id === o.id));
  return [...new Map([...chosen, ...also].map((o) => [o.email, o])).values()];
}

const excerpt = (text: string) => (text.length > 600 ? `${text.slice(0, 600).trimEnd()}…` : text);

/** The desk hears of a new ticket, or of the workspace's reply. */
async function tellOperators(
  deps: SupportDeps,
  ticket: TicketRecord,
  message: { name: string; body: string },
  what: "new" | "reply",
) {
  const [place] = await deps.db
    .select({ name: organisations.name })
    .from(organisations)
    .where(eq(organisations.id, ticket.organisationId));
  const workspace = place?.name ?? "A workspace";
  const emergency = ticket.severity === "emergency";
  const url = new URL(`/instance/support?ticket=${ticket.id}`, deps.publicUrl).toString();
  for (const operator of await deskRecipients(deps, ticket))
    await sendEmail(deps.mailer, operator.email, {
      subject: `${emergency ? "Emergency: " : ""}[${ticket.reference}] ${ticket.subject}`,
      heading:
        what === "new"
          ? `${message.name} of ${workspace} asked for help`
          : `${message.name} of ${workspace} replied to ${ticket.reference}`,
      body: [
        `${ticketKindNames[ticket.kind]}, marked ${severityNames[ticket.severity]}.`,
        `“${excerpt(message.body)}”`,
      ],
      action: { label: "Open the ticket", url },
      foot: emergency
        ? "You get this because you are on call, and Emergency tickets go to whoever is."
        : "You get this because you operate this instance's support desk.",
    });
}

/**
 * The person who asked hears of an operator's reply as a notification (#110): in their inbox
 * and by mail, at once or in their digest, as they choose for the `ticket` kind.
 */
async function tellRequester(
  deps: SupportDeps,
  ticket: TicketRecord,
  operatorId: string,
  body: string,
) {
  if (!ticket.requesterId) return;
  await notifyNow(
    {
      db: deps.db,
      mailer: deps.mailer,
      publicUrl: deps.publicUrl,
      subdomains: deps.workspaceHosts ?? null,
    },
    {
      organisationId: ticket.organisationId,
      kind: "ticket",
      recipients: [ticket.requesterId],
      actor: { userId: operatorId },
      text: `answered your ticket ${ticket.reference}: ${ticket.subject}`,
      detail: `“${excerpt(body)}”\n\nReply in the thread, or mark it resolved if that settles it.`,
      link: `/settings/support?ticket=${ticket.id}`,
    },
  );
}

/**
 * Attaches a file to a message its sender wrote, encrypted like any other blob. At most a few
 * a message, each up to its limit; refused before the body is read where it can be.
 */
export async function attachTo(
  deps: SupportDeps,
  c: Context,
  ticket: TicketRecord,
  messageId: string,
  userId: string,
) {
  const { db, storage } = deps;
  const named = attachmentName.safeParse(decodeURIComponent(c.req.header("x-file-name") ?? ""));
  if (!named.success)
    throw new CodedException(400, "bad_request", named.error.issues[0]?.message ?? "No name");
  const mayAttach = async (tx: Pick<Database, "select">, lock: boolean) => {
    const query = tx
      .select({ authorId: ticketMessages.authorId })
      .from(ticketMessages)
      .where(
        inOrg(
          ticketMessages,
          ticket.organisationId,
          eq(ticketMessages.id, messageId),
          eq(ticketMessages.ticketId, ticket.id),
        ),
      );
    const [message] = lock ? await query.for("update") : await query;
    if (!message) throw new NotFound("Message");
    if (message.authorId !== userId)
      throw new CodedException(403, "forbidden", "Only its sender can attach to a message");
    const [held] = await tx
      .select({ n: count() })
      .from(ticketAttachments)
      .where(
        inOrg(ticketAttachments, ticket.organisationId, eq(ticketAttachments.messageId, messageId)),
      );
    if ((held?.n ?? 0) >= TICKET_ATTACHMENTS_MAX)
      throw new CodedException(
        409,
        "too_many_attachments",
        `A message can carry at most ${TICKET_ATTACHMENTS_MAX} attachments`,
      );
  };
  await mayAttach(db, false);
  const bytes = Buffer.from(await c.req.arrayBuffer());
  if (bytes.length === 0) throw new CodedException(400, "bad_request", "The file is empty");
  if (bytes.length > TICKET_ATTACHMENT_MAX_BYTES)
    throw new CodedException(422, "too_large", "An attachment can be at most 10 MB");
  const type = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const contentType = /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,127}$/.test(type)
    ? type
    : "application/octet-stream";
  const blob = await storage.put(ticket.organisationId, bytes, { contentType });
  try {
    const row = await db.transaction(async (tx) => {
      // Again under the message's lock, so two at once cannot pass the limit together.
      await mayAttach(tx, true);
      const [made] = await tx
        .insert(ticketAttachments)
        .values({
          organisationId: ticket.organisationId,
          messageId,
          blobId: blob.id,
          name: named.data,
          contentType,
          byteSize: bytes.length,
        })
        .returning();
      return made;
    });
    return {
      id: row?.id ?? "",
      name: named.data,
      contentType,
      byteSize: bytes.length,
    } satisfies TicketAttachment;
  } catch (error) {
    // Nothing points at the bytes: take them back.
    await storage.remove(ticket.organisationId, blob.id).catch(() => undefined);
    throw error;
  }
}

/**
 * One of a ticket's attachments, sent to the person asking in the answer itself: never a URL,
 * so it works only in their session. The access log has it before the first byte leaves.
 */
export async function sendTicketAttachment(
  deps: SupportDeps,
  c: Context,
  ticket: TicketRecord,
  attachmentId: string,
  actor: Actor,
) {
  const { db, storage, audit } = deps;
  const [row] = await db
    .select({ file: ticketAttachments })
    .from(ticketAttachments)
    .innerJoin(ticketMessages, eq(ticketMessages.id, ticketAttachments.messageId))
    .where(
      inOrg(
        ticketAttachments,
        ticket.organisationId,
        eq(ticketAttachments.id, attachmentId),
        eq(ticketMessages.ticketId, ticket.id),
      ),
    );
  if (!row) throw new NotFound("Attachment");
  await audit.record(
    ticket.organisationId,
    actor,
    {
      action: "support.attachment_download",
      details: {
        ticketId: ticket.id,
        reference: ticket.reference,
        attachmentId,
        name: row.file.name,
      },
    },
    requestInfo(c, deps.trustProxy),
  );
  const { stream } = await storage.open(ticket.organisationId, row.file.blobId);
  return new Response(stream as unknown as ReadableStream, {
    headers: {
      "cache-control": "no-store, private",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
      "content-type": row.file.contentType,
      "content-length": String(row.file.byteSize),
      "content-disposition": attachment(row.file.name),
    },
  });
}

/** Reads a ticket for the operators, from any workspace. */
export async function ticketById(db: Pick<Database, "select">, ticketId: string) {
  // Across workspaces deliberately: the desk answers every workspace's tickets.
  const [row] = await db.select().from(tickets).where(eq(tickets.id, ticketId));
  if (!row) throw new NotFound("Ticket");
  return row;
}

export type { TicketRecord };
