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
      }).map((c) => c.action),
    ).toEqual(["settings.second_factor_on", "updates.channel", "maintenance.off"]);
    expect(settingsChanges(on, on)).toEqual([]);
  });
});
