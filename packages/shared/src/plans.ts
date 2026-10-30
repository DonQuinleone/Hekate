import { z } from "zod";

/**
 * Plans and entitlements (#177). A plan is what a workspace may be on: its price, its limits,
 * the features it includes and the support severities it unlocks. Without the billing module
 * every workspace is on the internal plan, which limits nothing and includes everything. Every
 * gated route and screen asks `entitled`.
 */

/** The features a plan may include or leave out. */
export const planFeatures = [
  "sso",
  "directory",
  "forensicMarking",
  "namedOperator",
  "ownStorage",
] as const;
export type PlanFeature = (typeof planFeatures)[number];

export const featureNames: Record<PlanFeature, string> = {
  sso: "Single sign-on",
  directory: "Signing in with a directory",
  forensicMarking: "Forensic marking",
  namedOperator: "A named operator",
  ownStorage: "Your own storage",
};

/** How urgent a support request may be marked, least first (#181). */
export const supportSeverities = ["low", "normal", "high", "urgent", "emergency"] as const;
export type SupportSeverity = (typeof supportSeverities)[number];

/** What a plan gives a workspace. A null limit is none. */
export interface Entitlements {
  storageQuota: number | null;
  memberLimit: number | null;
  projectLimit: number | null;
  features: PlanFeature[];
  severities: SupportSeverity[];
}

/** The plan every workspace is on without the billing module: nothing limited, all included. */
export const internalPlan: Entitlements = {
  storageQuota: null,
  memberLimit: null,
  projectLimit: null,
  features: [...planFeatures],
  severities: [...supportSeverities],
};

/** Whether a plan includes a feature. */
export const entitled = (plan: Entitlements, feature: PlanFeature) =>
  plan.features.includes(feature);

/** Whether a support request may be marked this urgent on a plan. */
export const severityAllowed = (plan: Entitlements, severity: SupportSeverity) =>
  plan.severities.includes(severity);

/** The refusal of a feature a workspace's plan leaves out. */
export const notEntitledMessage = (feature: PlanFeature) =>
  `${featureNames[feature]} is not on this workspace's plan.`;

/** The same refusal where the plan is known by name: settings say which plan leaves it out. */
export const notOnPlanMessage = (feature: PlanFeature, plan: string | null) =>
  plan ? `${featureNames[feature]} is not on the ${plan} plan.` : notEntitledMessage(feature);

/** A plan as the instance's operators keep it. */
export interface Plan extends Entitlements {
  id: string;
  /** Short and stable, for gateways and reports: `studio`. */
  key: string;
  name: string;
  /** In the currency's minor unit (pence); null for a plan by agreement. */
  price: { amount: number; currency: string; interval: "month" | "year" } | null;
  /** Kept from new workspaces' choices, still on the workspaces already on it. */
  hidden: boolean;
  retiredAt: string | null;
  /** How many workspaces are on it. */
  workspaces: number;
}

const limit = z.number().int().positive().nullable();

export const planInput = z.object({
  key: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/, {
      error: "Letters, digits and hyphens, up to 32",
    }),
  name: z.string().trim().min(1, "Name the plan").max(60),
  price: z
    .object({
      amount: z.number().int().nonnegative().max(100_000_000),
      currency: z
        .string()
        .trim()
        .toUpperCase()
        .regex(/^[A-Z]{3}$/, { error: "A three-letter currency code, such as GBP" }),
      interval: z.enum(["month", "year"]),
    })
    .nullable(),
  storageQuota: z.number().int().positive().max(1e15).nullable(),
  memberLimit: limit,
  projectLimit: limit,
  features: z.array(z.enum(planFeatures)).max(planFeatures.length),
  severities: z.array(z.enum(supportSeverities)).max(supportSeverities.length),
  hidden: z.boolean().default(false),
});
export type PlanInput = z.input<typeof planInput>;

/** Where a workspace stands with its plan. */
export const workspacePlanStatuses = ["trial", "active", "past_due", "cancelled"] as const;
export type WorkspacePlanStatus = (typeof workspacePlanStatuses)[number];

/** Putting a workspace on a plan; null leaves it on the internal plan. */
export const workspacePlanInput = z.object({
  planId: z.uuid().nullable(),
  status: z.enum(workspacePlanStatuses).default("active"),
  trialEndsAt: z.iso.datetime({ offset: true }).nullable().default(null),
  renewsAt: z.iso.datetime({ offset: true }).nullable().default(null),
});

/** A workspace's plan, as its own pages and the instance's show it. */
export interface WorkspacePlan {
  /** Null on the internal plan. */
  plan: { id: string; key: string; name: string } | null;
  status: WorkspacePlanStatus | null;
  trialEndsAt: string | null;
  renewsAt: string | null;
  /** When a subscription cancelled at the end of its period ends (#179). */
  cancelsAt: string | null;
  entitlements: Entitlements;
}

/** A plan's line, as a list shows it: "1 TB · 25 members · single sign-on". */
export function planSummary(plan: Entitlements, bytes: (n: number) => string): string {
  const parts = [
    plan.storageQuota === null ? "no storage quota" : bytes(plan.storageQuota),
    plan.memberLimit === null
      ? "no member limit"
      : `${plan.memberLimit} ${plan.memberLimit === 1 ? "member" : "members"}`,
    plan.projectLimit === null
      ? null
      : `${plan.projectLimit} ${plan.projectLimit === 1 ? "project" : "projects"}`,
    ...plan.features.map((f) => featureNames[f].toLowerCase()),
  ];
  return parts.filter(Boolean).join(" · ");
}
