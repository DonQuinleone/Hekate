import { z } from "zod";
import { updateChannels } from "./releases.ts";

/**
 * Instance settings (#160): what an operator decides for the whole instance, kept in one row
 * and read by every process as it runs, so a change needs no restart. What the environment
 * sets is shown beside them, read-only.
 */

export const instanceSettingsInput = z.object({
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
});
export type InstanceSettings = z.infer<typeof instanceSettingsInput>;

export const defaultInstanceSettings: InstanceSettings = {
  security: { requireSecondFactor: false },
  updates: { channel: "stable" },
  maintenance: { on: false, message: "" },
};

/** Stored settings over the defaults, so one written before a setting existed still reads. */
export function instanceSettingsOf(stored: unknown): InstanceSettings {
  const value = (stored ?? {}) as Partial<Record<keyof InstanceSettings, object>>;
  const merged = {
    security: { ...defaultInstanceSettings.security, ...value.security },
    updates: { ...defaultInstanceSettings.updates, ...value.updates },
    maintenance: { ...defaultInstanceSettings.maintenance, ...value.maintenance },
  };
  const parsed = instanceSettingsInput.safeParse(merged);
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
  return changes;
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
}
