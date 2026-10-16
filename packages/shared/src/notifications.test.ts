import { describe, expect, it } from "vitest";
import { channelsFor, mentionedIn, notificationPreferencesInput } from "./notifications.ts";

describe("notification preferences", () => {
  it("falls back to the defaults and keeps the always-on kinds in the app", () => {
    expect(channelsFor({ kinds: {} }, "version")).toEqual({ app: true, mail: false });
    expect(channelsFor({ kinds: { decision: { app: false, mail: false } } }, "decision")).toEqual({
      app: false,
      mail: false,
    });
    expect(channelsFor({ kinds: { mention: { app: false, mail: false } } }, "mention")).toEqual({
      app: true,
      mail: false,
    });
  });

  it("refuses unknown kinds and stray fields", () => {
    const base = { mailMode: "digest", digest: "hourly" };
    expect(notificationPreferencesInput.safeParse({ ...base, kinds: {} }).success).toBe(true);
    expect(
      notificationPreferencesInput.safeParse({
        ...base,
        kinds: { gossip: { app: true, mail: true } },
      }).success,
    ).toBe(false);
    expect(
      notificationPreferencesInput.safeParse({
        ...base,
        kinds: { reply: { app: true, mail: true, sms: true } },
      }).success,
    ).toBe(false);
  });
});

describe("mentionedIn", () => {
  const people = [
    { id: "ines", name: "Ines" },
    { id: "ines-arlow", name: "Ines Arlow" },
    { id: "tomas", name: "Tomas Varga" },
  ];

  it("finds full names after an @, the longest first", () => {
    expect(mentionedIn("@Ines Arlow, the pedal at bar 12?", people).map((p) => p.id)).toEqual([
      "ines-arlow",
    ]);
    expect(
      mentionedIn("@ines and @TOMAS VARGA please listen", people)
        .map((p) => p.id)
        .sort(),
    ).toEqual(["ines", "tomas"]);
  });

  it("ignores names that run on, and plain names without an @", () => {
    expect(mentionedIn("@Inesa said so; Tomas Varga agrees", people)).toEqual([]);
  });
});
