import { type Database, inOrg, schema } from "@hekate/db";
import {
  type Entitlements,
  entitled,
  internalPlan,
  notEntitledMessage,
  type Plan,
  type PlanFeature,
  type PlanInput,
  type WorkspacePlan,
} from "@hekate/shared";
import { asc, count, eq } from "drizzle-orm";
import { CodedException, NotFound } from "./errors.ts";

const { plans, workspacePlans, organisations } = schema;

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Reader = Pick<Database, "select">;

/**
 * Plans and entitlements (#177). A plan's limits are copied to each workspace on it, where the
 * usage checks (#175) read them, so an operator can still give one workspace its own; its
 * features are asked through `entitled`. Without the billing module, every workspace is on the
 * internal plan, whatever was assigned while it was on.
 */

const entitlementsOf = (row: typeof plans.$inferSelect): Entitlements => ({
  storageQuota: row.storageQuota,
  memberLimit: row.memberLimit,
  projectLimit: row.projectLimit,
  features: row.features,
  severities: row.severities,
});

const planOf = (row: typeof plans.$inferSelect, workspaces: number): Plan => ({
  id: row.id,
  key: row.key,
  name: row.name,
  price:
    row.priceAmount === null || !row.interval
      ? null
      : { amount: row.priceAmount, currency: row.currency, interval: row.interval },
  hidden: row.hidden,
  retiredAt: row.retiredAt?.toISOString() ?? null,
  workspaces,
  ...entitlementsOf(row),
});

/** Every plan, in its order, with how many workspaces are on each. */
export async function listPlans(db: Reader): Promise<Plan[]> {
  const [rows, counts] = await Promise.all([
    db.select().from(plans).orderBy(asc(plans.position), asc(plans.name)),
    // Across workspaces deliberately: the instance's own count of who is on what.
    db
      .select({ planId: workspacePlans.planId, n: count() })
      .from(workspacePlans)
      .groupBy(workspacePlans.planId),
  ]);
  return rows.map((r) => planOf(r, counts.find((c) => c.planId === r.id)?.n ?? 0));
}

const columns = (input: PlanInput) => ({
  key: input.key,
  name: input.name,
  priceAmount: input.price?.amount ?? null,
  currency: input.price?.currency ?? "GBP",
  interval: input.price?.interval ?? null,
  storageQuota: input.storageQuota,
  memberLimit: input.memberLimit,
  projectLimit: input.projectLimit,
  features: input.features,
  severities: input.severities,
  hidden: input.hidden ?? false,
});

/** The limits a plan gives, as the workspace's own columns hold them. */
const limitsFrom = (plan: Entitlements) => ({
  storageQuota: plan.storageQuota,
  memberLimit: plan.memberLimit,
  projectLimit: plan.projectLimit,
});

const keyTaken = () => new CodedException(409, "plan_key_taken", "Another plan has that key");
const retired = () => new CodedException(409, "plan_retired", "That plan is retired");

/** True when a statement failed on the named unique index. */
function violates(error: unknown, index: string): boolean {
  const cause = (error as { cause?: { code?: string; constraint_name?: string } }).cause;
  return cause?.code === "23505" && cause.constraint_name === index;
}

/**
 * Save a plan, new or changed. A change to its limits reaches every workspace on it at once,
 * in the same transaction: a plan's limits are its workspaces' limits.
 */
export async function savePlan(tx: Tx, input: PlanInput, id?: string) {
  const values = columns(input);
  if (!id) {
    const [made] = await tx
      .insert(plans)
      .values(values)
      .onConflictDoNothing({ target: plans.key })
      .returning();
    if (!made) throw keyTaken();
    return made;
  }
  // Locked first, as assignPlan locks it, so a workspace put on it meanwhile gets the new
  // limits or is among those the change reaches, never neither.
  const [current] = await tx
    .select({ retiredAt: plans.retiredAt })
    .from(plans)
    .where(eq(plans.id, id))
    .for("update");
  if (!current) return null;
  // Those still on a retired plan keep what they had.
  if (current.retiredAt) throw retired();
  const [saved] = await tx
    .update(plans)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(plans.id, id))
    .returning()
    .catch((error: unknown) => {
      if (violates(error, "plans_key_unique")) throw keyTaken();
      throw error;
    });
  if (!saved) return null;
  const on = await tx
    .select({ organisationId: workspacePlans.organisationId })
    .from(workspacePlans)
    .where(eq(workspacePlans.planId, id));
  for (const { organisationId } of on)
    await tx
      .update(organisations)
      .set({ ...limitsFrom(entitlementsOf(saved)), updatedAt: new Date() })
      .where(eq(organisations.id, organisationId));
  return saved;
}

/**
 * Put a workspace on a plan, or back on the internal plan (null), copying the plan's limits to
 * it. Returns the plan's name, or null for the internal plan.
 */
export async function assignPlan(
  tx: Tx,
  organisationId: string,
  input: {
    planId: string | null;
    status: WorkspacePlan["status"] & string;
    trialEndsAt: string | null;
    renewsAt: string | null;
  },
  /** The gateway's word on a subscription stands, even for a plan retired since (#178). */
  options: { retired?: boolean } = {},
): Promise<{ name: string | null }> {
  if (!input.planId) {
    await tx.delete(workspacePlans).where(inOrg(workspacePlans, organisationId));
    await tx
      .update(organisations)
      .set({ ...limitsFrom(internalPlan), updatedAt: new Date() })
      .where(eq(organisations.id, organisationId));
    return { name: null };
  }
  // Locked, as savePlan locks it: see there.
  const [plan] = await tx.select().from(plans).where(eq(plans.id, input.planId)).for("update");
  if (!plan) throw new NotFound("Plan");
  if (plan.retiredAt && !options.retired) throw retired();
  const values = {
    planId: plan.id,
    status: input.status,
    trialEndsAt: input.trialEndsAt ? new Date(input.trialEndsAt) : null,
    renewsAt: input.renewsAt ? new Date(input.renewsAt) : null,
    updatedAt: new Date(),
  };
  await tx
    .insert(workspacePlans)
    .values({ organisationId, ...values })
    .onConflictDoUpdate({ target: workspacePlans.organisationId, set: values });
  await tx
    .update(organisations)
    .set({ ...limitsFrom(entitlementsOf(plan)), updatedAt: new Date() })
    .where(eq(organisations.id, organisationId));
  return { name: plan.name };
}

/** A workspace's plan and what it gives: the internal plan without the billing module. */
export async function workspacePlanOf(
  db: Reader,
  organisationId: string,
  billing: boolean,
): Promise<WorkspacePlan> {
  const internal: WorkspacePlan = {
    plan: null,
    status: null,
    trialEndsAt: null,
    renewsAt: null,
    cancelsAt: null,
    entitlements: internalPlan,
  };
  if (!billing) return internal;
  const [row] = await db
    .select({ on: workspacePlans, plan: plans })
    .from(workspacePlans)
    .innerJoin(plans, eq(plans.id, workspacePlans.planId))
    .where(inOrg(workspacePlans, organisationId));
  if (!row) return internal;
  return {
    plan: { id: row.plan.id, key: row.plan.key, name: row.plan.name },
    status: row.on.status,
    trialEndsAt: row.on.trialEndsAt?.toISOString() ?? null,
    renewsAt: row.on.renewsAt?.toISOString() ?? null,
    cancelsAt: row.on.cancelsAt?.toISOString() ?? null,
    entitlements: entitlementsOf(row.plan),
  };
}

/** Refuse what a workspace's plan leaves out, with the plan's words for it. */
export async function assertEntitled(
  db: Reader,
  organisationId: string,
  billing: boolean,
  feature: PlanFeature,
) {
  const { entitlements } = await workspacePlanOf(db, organisationId, billing);
  if (!entitled(entitlements, feature))
    throw new CodedException(403, "not_entitled", notEntitledMessage(feature));
}
