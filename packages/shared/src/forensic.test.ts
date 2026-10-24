import { describe, expect, it } from "vitest";
import { chanceWords, forensicSettingsInput } from "./forensic.ts";
import { defaultWorkspaceSettings, workspaceSettingsOf } from "./organisation.ts";

describe("forensic marking", () => {
  it("says the chance of a mistake in words, never claiming more than the bound", () => {
    expect(chanceWords(0.5)).toBe("more than one in ten");
    expect(chanceWords(0.05)).toBe("less than one in ten");
    // 2 in a billion is not less than one in a billion: rounded down to a hundred million.
    expect(chanceWords(2e-9)).toBe("less than one in a hundred million");
    expect(chanceWords(9e-7)).toBe("less than one in a million");
    expect(chanceWords(1e-15)).toBe("less than one in 10^15");
    expect(chanceWords(0)).toBe("less than one in 10^30");
    expect(chanceWords(1e-300)).toBe("less than one in 10^30");
  });

  it("is off until the owners turn it on", () => {
    expect(defaultWorkspaceSettings.forensicAudio).toBe(false);
    expect(workspaceSettingsOf({}).forensicAudio).toBe(false);
    expect(workspaceSettingsOf({ forensicAudio: true }).forensicAudio).toBe(true);
    expect(workspaceSettingsOf({ forensicAudio: "yes" }).forensicAudio).toBe(false);
    expect(forensicSettingsInput.safeParse({ audio: false }).success).toBe(true);
    expect(forensicSettingsInput.safeParse({ audio: false, video: true }).success).toBe(false);
  });
});
