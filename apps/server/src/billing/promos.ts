import { type Database, schema } from "@hekate/db";
import { type PromoCode, type PromoCodeInput, promoRefusal } from "@hekate/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import { CodedException, NotFound } from "../errors.ts";
import type { Discount } from "./gateway.ts";

const { promoCodes, promoRedemptions, organisations, plans } = schema;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Reader = Pick<Database, "select">;

/**
 * Promo codes (#178): the instance's, kept by its operators. A use is held while its checkout
 * is open, so the first so many who use a code are the ones who get it, and given back when
 * the checkout is closed or lapses unpaid. Every change to a code's count is made under a lock
 * on its row.
 */

export const promoOf = (row: typeof promoCodes.$inferSelect): PromoCode => ({
  id: row.id,
  code: row.code,
  percentOff: row.percentOff,
  amountOff: row.amountOff,
  currency: row.currency,
  months: row.months,
  maxUses: row.maxUses,
  uses: row.uses,
  until: row.until?.toISOString() ?? null,
  planIds: row.planIds,
  endedAt: row.endedAt?.toISOString() ?? null,
});

export const discountOf = (promo: PromoCode): Discount => ({
  promoId: promo.id,
  code: promo.code,
  percentOff: promo.percentOff,
  amountOff: promo.amountOff,
  currency: promo.currency,
  months: promo.months,
});

const refused = (message: string) => new CodedException(409, "promo_refused", message);

/** A code as typed, held for the change being made; refused when there is no such code. */
export async function findPromo(tx: Tx, code: string): Promise<PromoCode> {
  const [row] = await tx
    .select()
    .from(promoCodes)
    .where(eq(promoCodes.code, code.trim().toUpperCase()))
    .for("update");
  if (!row) throw refused("There is no such code.");
  return promoOf(row);
}

/** Refuse a code that does not apply to this plan now. */
export function assertApplies(promo: PromoCode, planId: string, currency: string) {
  const refusal = promoRefusal(promo, { planId, currency, now: new Date() });
  if (refusal) throw refused(refusal);
}

/** Count a use of a code: held by a checkout, or taken at once by a subscription changed. */
export async function useOf(
  tx: Tx,
  promo: PromoCode,
  use: { organisationId: string; planId: string; checkoutId: string | null },
) {
  await tx
    .update(promoCodes)
    .set({ uses: sql`${promoCodes.uses} + 1`, updatedAt: new Date() })
    .where(eq(promoCodes.id, promo.id));
  await tx.insert(promoRedemptions).values({
    promoCodeId: promo.id,
    ...use,
    status: use.checkoutId ? "held" : "taken",
  });
}

/** A checkout paid: the use it held is taken. */
export async function takeHeld(tx: Tx, checkoutId: string) {
  await tx
    .update(promoRedemptions)
    .set({ status: "taken", updatedAt: new Date() })
    .where(and(eq(promoRedemptions.checkoutId, checkoutId), eq(promoRedemptions.status, "held")));
}

/** A checkout closed or lapsed unpaid: the use it held is given back. Returns its workspace. */
export async function releaseHeld(tx: Tx, checkoutId: string): Promise<string | null> {
  const [released] = await tx
    .update(promoRedemptions)
    .set({ status: "released", updatedAt: new Date() })
    .where(and(eq(promoRedemptions.checkoutId, checkoutId), eq(promoRedemptions.status, "held")))
    .returning({
      promoCodeId: promoRedemptions.promoCodeId,
      organisationId: promoRedemptions.organisationId,
    });
  if (!released) return null;
  await tx
    .update(promoCodes)
    .set({ uses: sql`greatest(${promoCodes.uses} - 1, 0)`, updatedAt: new Date() })
    .where(eq(promoCodes.id, released.promoCodeId));
  return released.organisationId;
}

/** Every code, newest first. */
export async function listPromos(db: Reader): Promise<PromoCode[]> {
  const rows = await db.select().from(promoCodes).orderBy(desc(promoCodes.createdAt));
  return rows.map(promoOf);
}

const columns = (input: PromoCodeInput) => ({
  code: input.code.trim().toUpperCase(),
  percentOff: input.percentOff ?? null,
  amountOff: input.amountOff ?? null,
  currency: input.amountOff ? (input.currency?.toUpperCase() ?? null) : null,
  months: input.months ?? null,
  maxUses: input.maxUses ?? null,
  until: input.until ? new Date(input.until) : null,
  planIds: input.planIds ?? [],
});

/** True when a statement failed on the named unique index. */
function violates(error: unknown, index: string): boolean {
  const cause = (error as { cause?: { code?: string; constraint_name?: string } }).cause;
  return cause?.code === "23505" && cause.constraint_name === index;
}

/**
 * Save a code, new or changed. A change applies to uses from now: subscriptions that have the
 * code keep the discount they were given.
 */
export async function savePromo(db: Database, input: PromoCodeInput, id?: string) {
  const taken = (error: unknown) => {
    if (violates(error, "promo_codes_code_unique"))
      throw new CodedException(409, "promo_code_taken", "Another code is written the same way.");
    throw error;
  };
  if (!id) {
    const [made] = await db.insert(promoCodes).values(columns(input)).returning().catch(taken);
    if (!made) throw new Error("The code was not written");
    return promoOf(made);
  }
  const [saved] = await db
    .update(promoCodes)
    .set({ ...columns(input), updatedAt: new Date() })
    .where(eq(promoCodes.id, id))
    .returning()
    .catch(taken);
  if (!saved) throw new NotFound("Promo code");
  return promoOf(saved);
}

/** End a code now: nobody uses it again; subscriptions that have it keep it. */
export async function endPromo(db: Pick<Database, "update">, id: string) {
  const [ended] = await db
    .update(promoCodes)
    .set({ endedAt: new Date(), updatedAt: new Date() })
    .where(eq(promoCodes.id, id))
    .returning();
  if (!ended) throw new NotFound("Promo code");
  return promoOf(ended);
}

/** Who used a code, newest first: each workspace, the plan, and whether its checkout was paid. */
export async function usesOf(db: Reader, id: string) {
  const rows = await db
    .select({
      workspace: { id: organisations.id, name: organisations.name },
      plan: plans.name,
      status: promoRedemptions.status,
      at: promoRedemptions.createdAt,
    })
    .from(promoRedemptions)
    .innerJoin(organisations, eq(organisations.id, promoRedemptions.organisationId))
    .leftJoin(plans, eq(plans.id, promoRedemptions.planId))
    // Across workspaces deliberately: the code is the instance's.
    .where(eq(promoRedemptions.promoCodeId, id))
    .orderBy(desc(promoRedemptions.createdAt));
  return rows.map((r) => ({ ...r, at: r.at.toISOString() }));
}
