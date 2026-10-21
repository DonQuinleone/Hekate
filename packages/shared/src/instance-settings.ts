import { z } from "zod";
import { defaultWorkspaceSettings, guestLinkDays } from "./organisation.ts";
import { updateChannels } from "./releases.ts";

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
  /** What a new workspace starts with; its owner may change it after. */
  defaults: z.object({ guestLinkDays: z.literal(guestLinkDays) }),
  /** How long each log keeps its rows (#157), in days; null keeps them for good. */
  logs: z.object({
    audit: z.literal(logKeepDays).nullable(),
    auth: z.literal(logKeepDays).nullable(),
    mail: z.literal(logKeepDays).nullable(),
  }),
});
export type InstanceSettings = z.infer<typeof instanceSettingsSchema>;

/**
 * A save: the settings, where a client older than a part may leave it out. What it leaves out
 * stays as stored (`withStored`), never back to its default.
 */
export const instanceSettingsInput = instanceSettingsSchema.extend({
  defaults: instanceSettingsSchema.shape.defaults.optional(),
  logs: instanceSettingsSchema.shape.logs.optional(),
});
export type InstanceSettingsInput = z.infer<typeof instanceSettingsInput>;

/** A save over what is stored: the parts it leaves out kept as they are. */
export const withStored = (
  input: InstanceSettingsInput,
  stored: InstanceSettings,
): InstanceSettings => ({
  ...input,
  defaults: input.defaults ?? stored.defaults,
  logs: input.logs ?? stored.logs,
});

export const defaultInstanceSettings: InstanceSettings = {
  security: { requireSecondFactor: false },
  updates: { channel: "stable" },
  maintenance: { on: false, message: "" },
  defaults: { guestLinkDays: defaultWorkspaceSettings.guestLinkDays },
  // The audit log is kept for good unless an operator says otherwise: nothing already logged
  // goes because the instance was upgraded.
  logs: { audit: null, auth: 365, mail: 90 },
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
  for (const kind of ["audit", "auth", "mail"] as const)
    if (before.logs[kind] !== after.logs[kind])
      changes.push({ action: "logs.retention", details: { kind, days: after.logs[kind] } });
  return changes;
}

export interface InstanceModules {
  billing: "off" | "stripe" | "paddle" | "manual";
  support: "off" | "app" | "link" | "mail";
  docsUrl: string;
  statusUrl: string | null;
}

/** What everyone is told about the instance, signed in or not. */
export interface InstanceNotice {
  maintenance: { on: boolean; message: string };
}

/** What the environment sets, shown on the Settings page beside what the operator does. */
export interface InstanceEnvironment {
  publicUrl: string;
  /** REQUIRE_SECOND_FACTOR: on here, the setting cannot be turned off. */
  requireSecondFactor: boolean;
  /** OPERATOR_SECURITY_KEY. */
  operatorSecurityKey: boolean;
  /** Whether instance mail goes out over SMTP, or is only logged. */
  mail: "smtp" | "log";
  passwordLeakCheck: boolean;
  /** How long a session lasts, in days. */
  sessionDays: number;
  /** What is switched on at start: HEKATE_BILLING, HEKATE_SUPPORT, HEKATE_DOCS_URL, HEKATE_STATUS_URL. */
  modules: InstanceModules;
}
