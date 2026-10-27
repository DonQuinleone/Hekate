import { describe, expect, it } from "vitest";
import { defaultPreferences, preferencesInput, preferencesOf, profileInput } from "./account.ts";
import { defaultBoardDisplay } from "./board.ts";

describe("profile", () => {
  it("takes a known language and a real time zone, or neither", () => {
    expect(profileInput.safeParse({ locale: "en-GB", timeZone: "Europe/London" }).success).toBe(
      true,
    );
    expect(profileInput.safeParse({ locale: null, timeZone: null }).success).toBe(true);
    expect(profileInput.safeParse({ timeZone: "Mars/Olympus" }).success).toBe(false);
    expect(profileInput.safeParse({}).success).toBe(false);
  });
});

describe("preferences", () => {
  it("reads what is stored, falling back to the default for anything odd", () => {
    expect(preferencesOf(null)).toEqual(defaultPreferences);
    expect(preferencesOf({ skipSeconds: 10, preRoll: 7, showLoudness: "yes" })).toEqual({
      ...defaultPreferences,
      skipSeconds: 10,
    });
  });

  it("changes some at a time, and only to choices offered", () => {
    expect(preferencesInput.safeParse({ preRoll: 2 }).success).toBe(true);
    expect(preferencesInput.safeParse({ skipSeconds: 3 }).success).toBe(false);
    expect(preferencesInput.safeParse({ theme: "dracula" }).success).toBe(true);
    expect(preferencesInput.safeParse({ theme: "neon" }).success).toBe(false);
  });
});

describe("tools shown", () => {
  it("opens the keyboard map on ? and hides the metadata editor unless chosen", () => {
    expect(defaultPreferences.keyboardMapOnQuestion).toBe(true);
    expect(defaultPreferences.showMetadataEditor).toBe(false);
    expect(preferencesOf({ keyboardMapOnQuestion: false }).keyboardMapOnQuestion).toBe(false);
    expect(preferencesInput.safeParse({ showMetadataEditor: true }).success).toBe(true);
    expect(preferencesInput.safeParse({ keyboardMapOnQuestion: "no" }).success).toBe(false);
  });
});

describe("density", () => {
  it("is comfortable unless chosen compact", () => {
    expect(defaultPreferences.density).toBe("comfortable");
    expect(preferencesOf({ density: "compact" }).density).toBe("compact");
    expect(preferencesOf({ density: "cosy" }).density).toBe("comfortable");
    expect(preferencesInput.safeParse({ density: "cosy" }).success).toBe(false);
  });
});

describe("the board's arrangement", () => {
  const stage = { ...defaultBoardDisplay, groupBy: "stage" as const };
  it("is the person's own once they choose one, and not before", () => {
    expect(defaultPreferences.boardChosen).toBe(false);
    expect(preferencesOf({ board: stage, boardChosen: true })).toMatchObject({
      board: stage,
      boardChosen: true,
    });
    // Put back to the built-in arrangement by choice, it is still theirs.
    expect(preferencesOf({ board: defaultBoardDisplay, boardChosen: true }).boardChosen).toBe(true);
    expect(preferencesOf({ board: stage, boardChosen: false }).boardChosen).toBe(false);
  });

  it("counts one kept before the choice was recorded as chosen where it differs", () => {
    expect(preferencesOf({ board: stage }).boardChosen).toBe(true);
    expect(preferencesOf({ board: defaultBoardDisplay }).boardChosen).toBe(false);
    expect(preferencesOf({ theme: "dark" }).boardChosen).toBe(false);
  });
});
