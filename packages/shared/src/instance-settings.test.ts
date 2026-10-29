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
      storageQuota: null,
      memberLimit: null,
    });
    expect(instanceSettingsOf({ defaults: { guestLinkDays: 30 } }).defaults.guestLinkDays).toBe(30);
    // Written before dates had a format (#481): ISO 8601 and the 24-hour clock.
    expect(instanceSettingsOf({ logs: {} }).dates).toEqual({
      dateFormat: "iso",
      timeFormat: "24h",
    });
    expect(instanceSettingsOf({ dates: { dateFormat: "month-day-year" } }).dates).toEqual({
      dateFormat: "month-day-year",
      timeFormat: "24h",
    });
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
        defaults: { guestLinkDays: 14, storageQuota: 1e12, memberLimit: 25 },
        dates: { dateFormat: "day-month-year", timeFormat: "12h" },
        logs: { audit: 730, auth: 365, mail: 90, webhooks: 90, api: 30 },
        billing: {
          currency: "EUR",
          dunning: { warn: 5, warnAgain: 14, suspend: 30 },
          trialDays: 30,
        },
        registration: { mode: "closed" },
        support: { statusUrl: "https://status.example", onCall: "user-1" },
        queues: { paused: ["media-proxy"] },
      }),
    ).toEqual([
      { action: "settings.second_factor_on", details: {} },
      { action: "updates.channel", details: { channel: "beta" } },
      { action: "maintenance.off", details: { message: "" } },
      { action: "defaults.guest_link_days", details: { days: 14 } },
      { action: "defaults.storage_quota", details: { bytes: 1e12 } },
      { action: "defaults.member_limit", details: { members: 25 } },
      { action: "dates.format", details: { dateFormat: "day-month-year", timeFormat: "12h" } },
      { action: "billing.currency", details: { currency: "EUR" } },
      { action: "billing.dunning", details: { warn: 5, warnAgain: 14, suspend: 30 } },
      { action: "billing.trial_days", details: { days: 30 } },
      { action: "logs.retention", details: { kind: "audit", days: 730 } },
      { action: "logs.retention", details: { kind: "webhooks", days: 90 } },
      { action: "support.status_page", details: { url: "https://status.example" } },
      { action: "support.on_call", details: { userId: "user-1" } },
    ]);
    expect(settingsChanges(on, on)).toEqual([]);
  });

  it("keeps what a save leaves out as stored, never back to its default", () => {
    const stored = {
      ...defaultInstanceSettings,
      defaults: { guestLinkDays: 30 as const, storageQuota: 1e12, memberLimit: 25 },
    };
    const { defaults: _, ...older } = defaultInstanceSettings;
    expect(withStored(older, stored).defaults).toEqual(stored.defaults);
    // A client from before the limits (#175) leaves them as stored.
    expect(withStored({ ...older, defaults: { guestLinkDays: 14 } }, stored).defaults).toEqual({
      guestLinkDays: 14,
      storageQuota: 1e12,
      memberLimit: 25,
    });
    // No limit is a choice too.
    expect(
      withStored(
        { ...older, defaults: { guestLinkDays: 14, storageQuota: null, memberLimit: 25 } },
        stored,
      ).defaults.storageQuota,
    ).toBeNull();
    // Kept for good is a choice too: a save that leaves out the logs keeps it.
    const forever = {
      ...defaultInstanceSettings,
      logs: { audit: null, auth: null, mail: 30 as const, webhooks: null, api: null },
    };
    const { logs: __, ...olderStill } = older;
    expect(withStored(olderStill, forever).logs).toEqual({
      audit: null,
      auth: null,
      mail: 30,
      webhooks: null,
      api: null,
    });
    // A client from before the webhook log, or the API log (#198), leaves their retention as
    // stored.
    expect(
      withStored({ ...olderStill, logs: { audit: 730, auth: null, mail: 30 } }, forever).logs,
    ).toEqual({ audit: 730, auth: null, mail: 30, webhooks: null, api: null });
    // The Settings page never sends the desk's settings (#182); they stay as the desk saved them.
    const desk = { ...defaultInstanceSettings, support: { statusUrl: null, onCall: "user-1" } };
    const { support: ___, ...fromSettings } = older;
    expect(withStored(fromSettings, desk).support).toEqual({ statusUrl: null, onCall: "user-1" });
    expect(instanceSettingsOf({ logs: {} }).support).toEqual({ statusUrl: null, onCall: null });
    // Nor the paused queues (decision 250): they stay as Queues saved them, and read as none
    // from settings written before them.
    const paused = { ...defaultInstanceSettings, queues: { paused: ["media-proxy"] } };
    const { queues: ____, ...beforeQueues } = older;
    expect(withStored(beforeQueues, paused).queues).toEqual({ paused: ["media-proxy"] });
    expect(instanceSettingsOf({ logs: {} }).queues).toEqual({ paused: [] });
    // A client from before dates had a format (#481) leaves the instance's choice as stored.
    const dated = {
      ...defaultInstanceSettings,
      dates: { dateFormat: "day-month-year" as const, timeFormat: "12h" as const },
    };
    const { dates: _____, ...beforeDates } = older;
    expect(withStored(beforeDates, dated).dates).toEqual(dated.dates);
  });

  it("reads billing's rules over the defaults, and keeps them through an older client's save (#180)", () => {
    expect(instanceSettingsOf({}).billing).toEqual({
      currency: "GBP",
      dunning: { warn: 7, warnAgain: 14, suspend: 21 },
      trialDays: 14,
    });
    expect(instanceSettingsOf({ billing: { dunning: { suspend: 30 } } }).billing.dunning).toEqual({
      warn: 7,
      warnAgain: 14,
      suspend: 30,
    });
    // Out of order: the whole is read as the defaults, never half-applied.
    expect(
      instanceSettingsOf({ billing: { dunning: { warn: 20, warnAgain: 14, suspend: 21 } } }),
    ).toEqual(defaultInstanceSettings);
    const stored = {
      ...defaultInstanceSettings,
      billing: { currency: "EUR", dunning: { warn: 5, warnAgain: 10, suspend: 15 }, trialDays: 0 },
    };
    const { billing: _, ...older } = stored;
    expect(withStored(older, stored).billing).toEqual(stored.billing);
  });

  it("reads registration as closed until an operator opens it, and keeps it through an older client's save (#184)", () => {
    expect(instanceSettingsOf({}).registration).toEqual({ mode: "closed" });
    expect(instanceSettingsOf({ registration: { mode: "open" } }).registration.mode).toBe("open");
    // Something not known is read as the defaults, never as open.
    expect(instanceSettingsOf({ registration: { mode: "everyone" } })).toEqual(
      defaultInstanceSettings,
    );
    const stored = { ...defaultInstanceSettings, registration: { mode: "invite" as const } };
    const { registration: _, ...older } = stored;
    expect(withStored(older, stored).registration).toEqual({ mode: "invite" });
    expect(withStored({ ...older, registration: { mode: "open" } }, stored).registration).toEqual({
      mode: "open",
    });
    expect(settingsChanges(stored, { ...stored, registration: { mode: "open" } })).toEqual([
      { action: "registration.mode", details: { mode: "open" } },
    ]);
  });
});
