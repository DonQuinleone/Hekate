import { afterEach, describe, expect, it } from "vitest";
import { formatDates, localeKey, relativeFormat, setLocale } from "./locale";

const moment = new Date("2026-10-14T23:30:00Z");

describe("dates as the member reads them", () => {
  afterEach(() => setLocale(null, null));

  it("follows the language and time zone chosen, and changes when they do", () => {
    const day = formatDates({ day: "numeric", month: "short" });
    setLocale("en-GB", "UTC");
    expect(day.format(moment)).toBe("14 Oct");
    // The same moment is already the 15th in Tokyo, and reads month first in American English.
    setLocale("en-US", "Asia/Tokyo");
    expect(day.format(moment)).toBe("Oct 15");
    expect(localeKey()).toBe("en-US|Asia/Tokyo");
  });

  it("keeps a calendar day as it is when the format names its own time zone", () => {
    // A session recorded on the 14th stays the 14th for a member in Kiritimati (UTC+14).
    const day = formatDates({ day: "numeric", month: "short", timeZone: "UTC" });
    setLocale("en-GB", "Pacific/Kiritimati");
    expect(day.format(new Date("2026-10-14T12:00:00Z"))).toBe("14 Oct");
  });

  it("words relative times in the chosen language", () => {
    setLocale("de-DE", null);
    expect(relativeFormat({ numeric: "auto" }).format(-1, "day")).toBe("gestern");
  });
});
