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
    if (!made) throw new CodedException(409, "plan_key_taken", "Another plan has that key");
    return made;
  }
  const [saved] = await tx
    .update(plans)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(plans.id, id))
    .returning();
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
): Promise<{ name: string | null }> {
  if (!input.planId) {
    await tx.delete(workspacePlans).where(inOrg(workspacePlans, organisationId));
    await tx
      .update(organisations)
      .set({ ...limitsFrom(internalPlan), updatedAt: new Date() })
      .where(eq(organisations.id, organisationId));
    return { name: null };
  }
  const [plan] = await tx.select().from(plans).where(eq(plans.id, input.planId));
  if (!plan) throw new NotFound("Plan");
  if (plan.retiredAt) throw new CodedException(409, "plan_retired", "That plan is retired");
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
