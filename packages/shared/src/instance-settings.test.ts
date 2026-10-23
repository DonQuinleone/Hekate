import { describe, expect, it } from "vitest";
import {
  defaultInstanceSettings,
  instanceSettingsOf,
  settingsChanges,
  withStored,
} from "./instance-settings.ts";

describe("instance settings", () => {
  it("reads stored settings over the defaults, and the defaults from nothing", () => {
    expect(instanceSettingsOf(null)).toEqual(defaultInstanceSettings);
    expect(instanceSettingsOf({ maintenance: { on: true } })).toEqual({
      ...defaultInstanceSettings,
      maintenance: { on: true, message: "" },
    });
    expect(instanceSettingsOf({ security: { requireSecondFactor: "yes" } })).toEqual(
      defaultInstanceSettings,
    );
    // Written before new workspaces had defaults: they read as the defaults.
    expect(instanceSettingsOf({ maintenance: { on: false, message: "" } }).defaults).toEqual({
      guestLinkDays: 3,
    });
    expect(instanceSettingsOf({ defaults: { guestLinkDays: 30 } }).defaults.guestLinkDays).toBe(30);
  });

  it("records one event for each thing that changed", () => {
    const on = { ...defaultInstanceSettings, maintenance: { on: true, message: "Back at six" } };
    expect(settingsChanges(defaultInstanceSettings, on)).toEqual([
      { action: "maintenance.on", details: { message: "Back at six" } },
    ]);
    expect(
      settingsChanges(on, { ...on, maintenance: { on: true, message: "Back at seven" } }),
    ).toEqual([{ action: "maintenance.message", details: { message: "Back at seven" } }]);
    expect(
      settingsChanges(on, {
        security: { requireSecondFactor: true },
        updates: { channel: "beta" },
        maintenance: { on: false, message: "" },
        defaults: { guestLinkDays: 14 },
        logs: { audit: 730, auth: 365, mail: 90, webhooks: 90 },
      }),
    ).toEqual([
      { action: "settings.second_factor_on", details: {} },
      { action: "updates.channel", details: { channel: "beta" } },
      { action: "maintenance.off", details: { message: "" } },
      { action: "defaults.guest_link_days", details: { days: 14 } },
      { action: "logs.retention", details: { kind: "audit", days: 730 } },
      { action: "logs.retention", details: { kind: "webhooks", days: 90 } },
    ]);
    expect(settingsChanges(on, on)).toEqual([]);
  });

  it("keeps what a save leaves out as stored, never back to its default", () => {
    const stored = { ...defaultInstanceSettings, defaults: { guestLinkDays: 30 as const } };
    const { defaults: _, ...older } = defaultInstanceSettings;
    expect(withStored(older, stored).defaults).toEqual({ guestLinkDays: 30 });
    expect(withStored({ ...older, defaults: { guestLinkDays: 14 } }, stored).defaults).toEqual({
      guestLinkDays: 14,
    });
    // Kept for good is a choice too: a save that leaves out the logs keeps it.
    const forever = {
      ...defaultInstanceSettings,
      logs: { audit: null, auth: null, mail: 30 as const, webhooks: null },
    };
    const { logs: __, ...olderStill } = older;
    expect(withStored(olderStill, forever).logs).toEqual({
      audit: null,
      auth: null,
      mail: 30,
      webhooks: null,
    });
    // A client from before the webhook log leaves its retention as stored.
    expect(
      withStored({ ...olderStill, logs: { audit: 730, auth: null, mail: 30 } }, forever).logs,
    ).toEqual({ audit: 730, auth: null, mail: 30, webhooks: null });
  });
});
