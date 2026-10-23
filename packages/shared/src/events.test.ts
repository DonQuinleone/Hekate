import { describe, expect, it } from "vitest";
import {
  channelTarget,
  channelUrlProblem,
  createChannelInput,
  eventData,
  eventKinds,
  eventLabels,
  eventSummary,
  eventsSummary,
  retryDelaySeconds,
} from "./events.ts";

const project = { id: "0190a6f0-0000-7000-8000-000000000001", name: "Joplin Rags" };
const mira = { name: "Mira Solberg", guest: false };

describe("events (#161)", () => {
  it("gives every kind a schema and a line in the matrix", () => {
    for (const kind of eventKinds) {
      expect(eventData[kind]).toBeDefined();
      expect(eventLabels[kind]).toMatch(/^[A-Z]/);
    }
  });

  it("says each event in a sentence", () => {
    const review = { id: project.id, title: "Album masters", kind: "approval" as const };
    expect(
      eventSummary("decision.recorded", {
        project,
        actor: mira,
        path: "/reviews/r",
        review,
        decision: "changes_requested",
      }),
    ).toBe("Mira Solberg requested changes on “Album masters” in Joplin Rags");
    expect(
      eventSummary("version.arrived", {
        project,
        actor: mira,
        path: "/tracks/t",
        track: { id: project.id, name: "Bethena" },
        version: 3,
      }),
    ).toBe("Mira Solberg added version 3 of Bethena in Joplin Rags");
    expect(
      eventSummary("processing.failed", {
        project,
        actor: null,
        path: "/files/f",
        file: { id: project.id, name: "Bethena.wav" },
      }),
    ).toBe("Bethena.wav could not be processed in Joplin Rags");
    expect(
      eventSummary("guest.signed_in", {
        project: null,
        actor: { name: "Ines Arlow", guest: true },
        path: "/settings/log",
      }),
    ).toBe("Ines Arlow signed in as a guest");
  });

  it("refuses addresses that are not HTTPS, carry a password, or are not the service's own", () => {
    expect(channelUrlProblem("webhook", "https://hooks.example/hekate")).toBeNull();
    expect(channelUrlProblem("webhook", "not an address")).toBe("That is not an address");
    expect(channelUrlProblem("webhook", "http://hooks.example/hekate")).toMatch(/https/);
    expect(channelUrlProblem("webhook", "http://hooks.internal/x", { allowHttp: true })).toBeNull();
    expect(channelUrlProblem("webhook", "https://user:pass@hooks.example/")).toMatch(/password/);
    expect(channelUrlProblem("slack", "https://hooks.slack.com/services/T/B/x")).toBeNull();
    expect(channelUrlProblem("slack", "https://hooks.example/services/T/B/x")).toMatch(/Slack/);
    expect(channelUrlProblem("discord", "https://discord.com/api/webhooks/1/x")).toBeNull();
    expect(channelUrlProblem("discord", "https://discord.com/channels/1")).toMatch(/Discord/);
    expect(
      channelUrlProblem("teams", "https://prod-01.westeurope.logic.azure.com/workflows/x"),
    ).toBeNull();
  });

  it("shows where a channel points, never its secret part", () => {
    expect(channelTarget("slack", "https://hooks.slack.com/services/T/B/secret")).toBe(
      "hooks.slack.com",
    );
    expect(channelTarget("webhook", "https://hooks.example/hekate?token=secret")).toBe(
      "https://hooks.example/hekate",
    );
  });

  it("keeps a channel's events in their order, once each", () => {
    const parsed = createChannelInput.parse({
      kind: "slack",
      name: "#masters",
      url: "https://hooks.slack.com/services/T/B/x",
      events: ["version.arrived", "decision.recorded", "version.arrived"],
    });
    expect(parsed.events).toEqual(["decision.recorded", "version.arrived"]);
    expect(eventsSummary(parsed.events)).toBe("Decisions, new versions");
    expect(eventsSummary([...eventKinds])).toBe("Every event");
    expect(eventsSummary([])).toBe("No events");
    expect(eventsSummary(eventKinds.slice(0, 5))).toBe("5 kinds of event");
  });

  it("waits longer after each failure, never more than an hour", () => {
    expect([1, 2, 3, 4].map(retryDelaySeconds)).toEqual([30, 60, 120, 240]);
    expect(retryDelaySeconds(20)).toBe(3600);
  });
});
