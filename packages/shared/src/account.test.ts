import { describe, expect, it } from "vitest";
import { defaultPreferences, preferencesInput, preferencesOf, profileInput } from "./account.ts";

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
