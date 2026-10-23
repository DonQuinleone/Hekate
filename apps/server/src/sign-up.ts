import { type Database, schema, uuidv7 } from "@hekate/db";
import type { SignUpInvitation } from "@hekate/shared";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, like, lte } from "drizzle-orm";
import { z } from "zod";
import { hashInvitationToken, newInvitationToken } from "./invitation-token.ts";

/**
 * Links to make a workspace (#184): one someone asks for with open sign-up, which confirms
 * their email, or an operator's invitation. Kept in Better Auth's table of one-off
 * verifications, as its own links to confirm an email are: the token only as a hash, the link
 * removed as it is used, so it works once.
 */

const { authVerifications: verifications } = schema;

type Writer = Pick<Database, "insert" | "delete" | "select">;

const PREFIX = "sign-up:";
const identifierOf = (token: string) => `${PREFIX}${hashInvitationToken(token)}`;

/** What a link holds beside its token. */
const linkValue = z.object({ email: z.string(), invitedBy: z.string().nullable() });

export interface SignUpLinkRow {
  id: string;
  email: string;
  /** The operator who invited them; null for a link someone asked for themselves. */
  invitedBy: string | null;
  expiresAt: Date;
  createdAt: Date;
}

const rowOf = (r: typeof verifications.$inferSelect): SignUpLinkRow | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(r.value);
  } catch {
    return undefined;
  }
  const parsed = linkValue.safeParse(value);
  return parsed.success
    ? { id: r.id, ...parsed.data, expiresAt: r.expiresAt, createdAt: r.createdAt }
    : undefined;
};

/** A new link for `email`, lasting `lifetimeMs`; returns its token, which is not kept. */
export async function newSignUpLink(
  db: Writer,
  link: { email: string; invitedBy: string | null; lifetimeMs: number },
  now = new Date(),
) {
  const { token } = newInvitationToken();
  // Links that have run out are of no use to anyone: they go as new ones are made.
  await db
    .delete(verifications)
    .where(and(like(verifications.identifier, `${PREFIX}%`), lte(verifications.expiresAt, now)));
  await db.insert(verifications).values({
    id: uuidv7(),
    identifier: identifierOf(token),
    value: JSON.stringify({ email: link.email.toLowerCase(), invitedBy: link.invitedBy }),
    expiresAt: new Date(now.getTime() + link.lifetimeMs),
  });
  return token;
}

/** The link a token names, expired or not; undefined for one never made, used or revoked. */
export async function findSignUpLink(db: Pick<Database, "select">, token: string) {
  const [row] = await db
    .select()
    .from(verifications)
    .where(eq(verifications.identifier, identifierOf(token)));
  return row ? rowOf(row) : undefined;
}

/**
 * Uses the link, in the caller's transaction: true for the one request that removed it while it
 * was still good, so a link makes one workspace however many try at once.
 */
export async function claimSignUpLink(
  tx: Pick<Database, "delete">,
  id: string,
  now = new Date(),
): Promise<boolean> {
  const gone = await tx
    .delete(verifications)
    .where(
      and(
        eq(verifications.id, id),
        like(verifications.identifier, `${PREFIX}%`),
        gt(verifications.expiresAt, now),
      ),
    )
    .returning({ id: verifications.id });
  return gone.length > 0;
}

/** Operators' invitations still waiting, newest first, with who sent each. */
export async function listSignUpInvitations(
  db: Pick<Database, "select">,
  now = new Date(),
): Promise<SignUpInvitation[]> {
  const rows = await db
    .select()
    .from(verifications)
    .where(and(like(verifications.identifier, `${PREFIX}%`), gt(verifications.expiresAt, now)))
    .orderBy(desc(verifications.createdAt));
  const links = rows.flatMap((r) => rowOf(r) ?? []).filter((l) => l.invitedBy);
  const senders = links.length
    ? await db
        .select({ id: schema.users.id, name: schema.users.name })
        .from(schema.users)
        .where(
          inArray(
            schema.users.id,
            links.flatMap((l) => l.invitedBy ?? []),
          ),
        )
    : [];
  return links.map((l) => ({
    id: l.id,
    email: l.email,
    invitedBy: senders.find((s) => s.id === l.invitedBy)?.name ?? null,
    createdAt: l.createdAt.toISOString(),
    expiresAt: l.expiresAt.toISOString(),
  }));
}

/** Withdraws an operator's invitation; its email, or undefined when there was none. */
export async function revokeSignUpInvitation(db: Writer, id: string) {
  const [row] = await db
    .select()
    .from(verifications)
    .where(and(eq(verifications.id, id), like(verifications.identifier, `${PREFIX}%`)));
  const link = row ? rowOf(row) : undefined;
  if (!link?.invitedBy) return undefined;
  await db.delete(verifications).where(eq(verifications.id, id));
  return link.email;
}

/**
 * The plan a workspace that signs up tries (#177): the first, in the operators' order, that has
 * a price and is neither hidden nor retired. Undefined when there is none, and it starts on the
 * internal plan, as one an operator makes does.
 */
export async function trialPlan(db: Pick<Database, "select">) {
  const { plans } = schema;
  const [plan] = await db
    .select({ id: plans.id })
    .from(plans)
    .where(and(eq(plans.hidden, false), isNull(plans.retiredAt), isNotNull(plans.priceAmount)))
    .orderBy(asc(plans.position), asc(plans.name))
    .limit(1);
  return plan;
}
