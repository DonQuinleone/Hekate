import { describe, expect, it } from "vitest";
import {
  channelsFor,
  mentionAt,
  mentionedIn,
  mentionRanges,
  notificationCatalogue,
  notificationChannelKeys,
  notificationChannelLabels,
  notificationKinds,
  notificationPreferencesInput,
} from "./notifications.ts";

describe("the event catalogue", () => {
  it("names every kind once, and describes it in a line of its own (#504)", () => {
    const titles = notificationKinds.map((kind) => notificationCatalogue[kind].title);
    expect(new Set(titles).size).toBe(notificationKinds.length);
    for (const kind of notificationKinds) {
      const { title, description } = notificationCatalogue[kind];
      // A name, not a sentence: it heads the row and names the row's switches.
      expect(title, kind).toMatch(/^[A-Z][^.]{1,40}$/);
      expect(description, kind).toMatch(/^[A-Z].*\.$/);
      expect(description, kind).not.toBe(title);
    }
  });

  it("heads the channels App and Mail, whatever the event says", () => {
    expect(notificationChannelKeys).toEqual(["app", "mail"]);
    expect(notificationChannelKeys.map((c) => notificationChannelLabels[c])).toEqual([
      "App",
      "Mail",
    ]);
  });
});

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

describe("mentions as they are typed and shown", () => {
  const people = [
    { id: "ines", name: "Ines Arlow" },
    { id: "ines-short", name: "Ines" },
    { id: "tomas", name: "Tomas Varga" },
  ];

  it("finds where each mention sits, longest name first", () => {
    const body = "@Ines Arlow and @tomas varga, and @Ines.";
    expect(mentionRanges(body, people).map((r) => [r.start, r.end, r.person.id])).toEqual([
      [0, 11, "ines"],
      [16, 28, "tomas"],
      [34, 39, "ines-short"],
    ]);
    expect(mentionRanges("email@Ines Arlow", people)).toHaveLength(1);
  });

  it("knows the mention being typed at the caret", () => {
    expect(mentionAt("Ask @To", 7)).toEqual({ start: 4, query: "To" });
    expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionAt("Ask @Tomas Va", 13)).toEqual({ start: 4, query: "Tomas Va" });
    // Not after a word, not across a line, not when the caret is before it.
    expect(mentionAt("mail@example", 12)).toBeNull();
    expect(mentionAt("@Tomas\nnext", 11)).toBeNull();
    expect(mentionAt("Ask @To", 3)).toBeNull();
    expect(mentionAt("No mention here", 15)).toBeNull();
  });
});
