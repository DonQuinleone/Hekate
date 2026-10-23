import { z } from "zod";
import { type BillingRules, billingRules, defaultBillingRules } from "./billing.ts";
import type { BounceProvider } from "./mail-bounces.ts";
import { defaultWorkspaceSettings, guestLinkDays } from "./organisation.ts";
import { registrationModes } from "./registration.ts";
import { updateChannels } from "./releases.ts";
import { workspaceLimits } from "./usage.ts";

/** How long a log may keep its rows, in days (#157). */
export const logKeepDays = [30, 90, 365, 730] as const;
export type LogKeepDays = (typeof logKeepDays)[number];

/**
 * Instance settings (#160): what an operator decides for the whole instance, kept in one row
 * and read by every process as it runs, so a change needs no restart. What the environment
 * sets is shown beside them, read-only.
 */

const instanceSettingsSchema = z.object({
  security: z.object({
    /** Every account needs a second factor, whatever a workspace's own setting says. */
    requireSecondFactor: z.boolean(),
  }),
  /** Which releases System information offers (#158): releases, or their candidates too. */
  updates: z.object({ channel: z.enum(updateChannels) }),
  /** Maintenance mode (#154): everyone sees a notice; uploads and jobs wait; nothing is lost. */
  maintenance: z.object({
    on: z.boolean(),
    /** What the notice says beyond that it is on: "Back by 18:00". */
    message: z.string().trim().max(280),
  }),
  /**
   * What a new workspace starts with: how long its guest links last, which its owner may change,
   * and its limits (#175), which only an operator may.
   */
  defaults: z.object({
    guestLinkDays: z.literal(guestLinkDays),
    storageQuota: workspaceLimits.shape.storageQuota,
    memberLimit: workspaceLimits.shape.memberLimit,
  }),
  /** How long each log keeps its rows (#157), in days; null keeps them for good. */
  logs: z.object({
    audit: z.literal(logKeepDays).nullable(),
    auth: z.literal(logKeepDays).nullable(),
    mail: z.literal(logKeepDays).nullable(),
    /** Events and their deliveries to the workspaces' channels (#161). */
    webhooks: z.literal(logKeepDays).nullable(),
    /** Calls made with API tokens (#198). */
    api: z.literal(logKeepDays).nullable(),
  }),
  /** Billing's rules (#180): the instance's currency, dunning's days and a trial's length. */
  billing: billingRules,
  /** Who may make a workspace (#184): operators only, anyone they invite, or anyone. */
  registration: z.object({ mode: z.enum(registrationModes) }),
  /**
   * The support desk's own settings (#182): its status page, over HEKATE_STATUS_URL, and the
   * operator on call, who hears of each new ticket first and is paged for an Emergency.
   */
  support: z.object({
    statusUrl: z.url().max(500).nullable(),
    onCall: z.string().min(1).max(64).nullable(),
  }),
});
export type InstanceSettings = z.infer<typeof instanceSettingsSchema>;

/**
 * A save: the settings, where a client older than a part may leave it out. What it leaves out
 * stays as stored (`withStored`), never back to its default.
 */
export const instanceSettingsInput = instanceSettingsSchema.extend({
  defaults: instanceSettingsSchema.shape.defaults
    .extend({
      storageQuota: workspaceLimits.shape.storageQuota.optional(),
      memberLimit: workspaceLimits.shape.memberLimit.optional(),
    })
    .optional(),
  logs: instanceSettingsSchema.shape.logs
    .extend({
      webhooks: instanceSettingsSchema.shape.logs.shape.webhooks.optional(),
      api: instanceSettingsSchema.shape.logs.shape.api.optional(),
    })
    .optional(),
  billing: billingRules.optional(),
  registration: instanceSettingsSchema.shape.registration.optional(),
  // Saved from the Support page's desk, never from Settings.
  support: instanceSettingsSchema.shape.support.optional(),
});
export type InstanceSettingsInput = z.infer<typeof instanceSettingsInput>;

/** A save over what is stored: the parts it leaves out kept as they are. */
export const withStored = (
  input: InstanceSettingsInput,
  stored: InstanceSettings,
): InstanceSettings => ({
  ...input,
  defaults: input.defaults
    ? {
        guestLinkDays: input.defaults.guestLinkDays,
        storageQuota:
          input.defaults.storageQuota === undefined
            ? stored.defaults.storageQuota
            : input.defaults.storageQuota,
        memberLimit:
          input.defaults.memberLimit === undefined
            ? stored.defaults.memberLimit
            : input.defaults.memberLimit,
      }
    : stored.defaults,
  logs: input.logs
    ? {
        ...input.logs,
        webhooks: input.logs.webhooks === undefined ? stored.logs.webhooks : input.logs.webhooks,
        api: input.logs.api === undefined ? stored.logs.api : input.logs.api,
      }
    : stored.logs,
  billing: input.billing ?? stored.billing,
  registration: input.registration ?? stored.registration,
  support: input.support ?? stored.support,
});

export const defaultInstanceSettings: InstanceSettings = {
  security: { requireSecondFactor: false },
  updates: { channel: "stable" },
  maintenance: { on: false, message: "" },
  // No limits unless an operator sets them: a self-hosted instance is not held back.
  defaults: {
    guestLinkDays: defaultWorkspaceSettings.guestLinkDays,
    storageQuota: null,
    memberLimit: null,
  },
  // The audit log is kept for good unless an operator says otherwise: nothing already logged
  // goes because the instance was upgraded.
  logs: { audit: null, auth: 365, mail: 90, webhooks: 30, api: 30 },
  billing: defaultBillingRules,
  // As before registration was a setting: operators make the workspaces.
  registration: { mode: "closed" },
  support: { statusUrl: null, onCall: null },
};

/** Stored settings over the defaults, so one written before a setting existed still reads. */
export function instanceSettingsOf(stored: unknown): InstanceSettings {
  const value = (stored ?? {}) as Partial<Record<keyof InstanceSettings, object>>;
  const merged = {
    security: { ...defaultInstanceSettings.security, ...value.security },
    updates: { ...defaultInstanceSettings.updates, ...value.updates },
    maintenance: { ...defaultInstanceSettings.maintenance, ...value.maintenance },
    defaults: { ...defaultInstanceSettings.defaults, ...value.defaults },
    logs: { ...defaultInstanceSettings.logs, ...value.logs },
    billing: {
      ...defaultInstanceSettings.billing,
      ...value.billing,
      dunning: {
        ...defaultInstanceSettings.billing.dunning,
        ...(value.billing as Partial<BillingRules> | undefined)?.dunning,
      },
    },
    registration: { ...defaultInstanceSettings.registration, ...value.registration },
    support: { ...defaultInstanceSettings.support, ...value.support },
  };
  const parsed = instanceSettingsSchema.safeParse(merged);
  return parsed.success ? parsed.data : defaultInstanceSettings;
}

/** The instance events a change of settings records, one for each thing that changed. */
export function settingsChanges(
  before: InstanceSettings,
  after: InstanceSettings,
): { action: string; details: Record<string, unknown> }[] {
  const changes: { action: string; details: Record<string, unknown> }[] = [];
  if (before.security.requireSecondFactor !== after.security.requireSecondFactor)
    changes.push({
      action: after.security.requireSecondFactor
        ? "settings.second_factor_on"
        : "settings.second_factor_off",
      details: {},
    });
  if (before.updates.channel !== after.updates.channel)
    changes.push({ action: "updates.channel", details: { channel: after.updates.channel } });
  if (before.maintenance.on !== after.maintenance.on)
    changes.push({
      action: after.maintenance.on ? "maintenance.on" : "maintenance.off",
      details: { message: after.maintenance.message },
    });
  else if (after.maintenance.on && before.maintenance.message !== after.maintenance.message)
    changes.push({
      action: "maintenance.message",
      details: { message: after.maintenance.message },
    });
  if (before.defaults.guestLinkDays !== after.defaults.guestLinkDays)
    changes.push({
      action: "defaults.guest_link_days",
      details: { days: after.defaults.guestLinkDays },
    });
  if (before.defaults.storageQuota !== after.defaults.storageQuota)
    changes.push({
      action: "defaults.storage_quota",
      details: { bytes: after.defaults.storageQuota },
    });
  if (before.defaults.memberLimit !== after.defaults.memberLimit)
    changes.push({
      action: "defaults.member_limit",
      details: { members: after.defaults.memberLimit },
    });
  if (before.billing.currency !== after.billing.currency)
    changes.push({ action: "billing.currency", details: { currency: after.billing.currency } });
  const { dunning: was } = before.billing;
  const { dunning: is } = after.billing;
  if (was.warn !== is.warn || was.warnAgain !== is.warnAgain || was.suspend !== is.suspend)
    changes.push({ action: "billing.dunning", details: { ...is } });
  if (before.billing.trialDays !== after.billing.trialDays)
    changes.push({ action: "billing.trial_days", details: { days: after.billing.trialDays } });
  if (before.registration.mode !== after.registration.mode)
    changes.push({ action: "registration.mode", details: { mode: after.registration.mode } });
  for (const kind of ["audit", "auth", "mail", "webhooks", "api"] as const)
    if (before.logs[kind] !== after.logs[kind])
      changes.push({ action: "logs.retention", details: { kind, days: after.logs[kind] } });
  if (before.support.statusUrl !== after.support.statusUrl)
    changes.push({ action: "support.status_page", details: { url: after.support.statusUrl } });
  if (before.support.onCall !== after.support.onCall)
    changes.push({ action: "support.on_call", details: { userId: after.support.onCall } });
  return changes;
}

export interface InstanceModules {
  billing: "off" | "stripe" | "paddle" | "manual";
  support: "off" | "app" | "link" | "mail";
  /** HEKATE_SUPPORT_ADDRESS: the desk with `link`, the mailbox with `mail` (#181). */
  supportAddress?: string | null;
  docsUrl: string;
  statusUrl: string | null;
}

/** What everyone is told about the instance, signed in or not. */
export interface InstanceNotice {
  maintenance: { on: boolean; message: string };
}

/** The ways instance mail can go out (#71), as the environment sets them. */
export const instanceMails = ["smtp", "microsoft", "mailcoach", "log"] as const;
export type InstanceMail = (typeof instanceMails)[number];

/** What the environment sets, shown on the Settings page beside what the operator does. */
export interface InstanceEnvironment {
  publicUrl: string;
  /** WORKSPACE_SUBDOMAINS (#176): where workspaces answer, as `*.review.example`; null when off. */
  subdomains?: string | null;
  /** REQUIRE_SECOND_FACTOR: on here, the setting cannot be turned off. */
  requireSecondFactor: boolean;
  /** OPERATOR_SECURITY_KEY. */
  operatorSecurityKey: boolean;
  /** How instance mail goes out (#71): SMTP, Microsoft 365, Mailcoach, or only to the log. */
  mail: InstanceMail;
  /**
   * Bounce reports (#161): the provider the instance's SMTP host is, where it reports, and
   * whether MAIL_WEBHOOK_SECRET is set to check them. Null where the provider sends none Hekate reads.
   */
  bounces: { provider: BounceProvider; url: string; secretSet: boolean } | null;
  passwordLeakCheck: boolean;
  /** How long a session lasts, in days. */
  sessionDays: number;
  /** What is switched on at start: HEKATE_BILLING, HEKATE_SUPPORT, HEKATE_DOCS_URL, HEKATE_STATUS_URL. */
  modules: InstanceModules;
}
