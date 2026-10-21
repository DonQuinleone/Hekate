import { describe, expect, it } from "vitest";
import {
  defaultInstanceSettings,
  instanceSettingsOf,
  settingsChanges,
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
      }).map((c) => c.action),
    ).toEqual([
      "settings.second_factor_on",
      "updates.channel",
      "maintenance.off",
      "defaults.guest_link_days",
    ]);
    expect(settingsChanges(on, on)).toEqual([]);
  });
});
