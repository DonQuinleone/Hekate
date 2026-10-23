import { describe, expect, it } from "vitest";
import { helpTopics, topicsFor } from "~/lib/help-topics";
import { lockedLine, ticketDot } from "./support";

describe("support (#181)", () => {
  it("finds written answers by their words, titles first", () => {
    expect(topicsFor("")).toEqual(helpTopics);
    expect(topicsFor("will not PLAY").map((t) => t.title)).toEqual(["A file will not play"]);
    expect(topicsFor("guest").map((t) => t.title)[0]).toBe("Guests and their links");
    expect(topicsFor("nothing about this")).toEqual([]);
  });

  it("says which plan unlocks the severities this one leaves out", () => {
    const choice = (
      severity: "low" | "normal" | "high" | "urgent" | "emergency",
      plan: string | null,
    ) => ({ severity, allowed: plan === null, plan });
    expect(lockedLine([choice("low", null), choice("normal", null)])).toBeNull();
    expect(
      lockedLine([
        choice("low", null),
        choice("normal", null),
        choice("high", "Studio"),
        choice("urgent", "Label"),
        choice("emergency", "Label"),
      ]),
    ).toBe("High comes with the Studio plan. Urgent and Emergency come with the Label plan.");
    expect(lockedLine([{ severity: "emergency", allowed: false, plan: null }])).toBe(
      "Emergency is not on this plan.",
    );
  });

  it("marks what waits on support in signal, and what is done as settled", () => {
    expect(ticketDot("waiting")).toBe("changes_requested");
    expect(ticketDot("answered")).toBe("in_review");
    expect(ticketDot("resolved")).toBe("approved");
  });
});
