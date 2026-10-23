import { describe, expect, it } from "vitest";
import {
  errorReferencesIn,
  formatTicketReference,
  median,
  nextTicketState,
  pressing,
  severityChoices,
  supportDeskInput,
  ticketInput,
  ticketsQuery,
} from "./support.ts";

describe("support (#181, #182)", () => {
  it("makes a ticket's reference from three bytes, unlike an error's", () => {
    expect(formatTicketReference(new Uint8Array([0x7f, 0x3a, 0x2c]))).toBe("T-7F3A-2C");
    expect(() => formatTicketReference(new Uint8Array([1]))).toThrow(RangeError);
  });

  it("finds the error references quoted in a message, each once", () => {
    expect(
      errorReferencesIn("It said hk-7f3a-2c, then HK7F3A2C again, and HK-2B91-E0 at the end."),
    ).toEqual(["HK-7F3A-2C", "HK-2B91-E0"]);
    expect(errorReferencesIn("No reference, only T-7F3A-2C and HK-12.")).toEqual([]);
  });

  it("moves a ticket on as each side acts", () => {
    expect(nextTicketState("workspace_reply")).toBe("waiting");
    expect(nextTicketState("operator_reply")).toBe("answered");
    expect(nextTicketState("resolve")).toBe("resolved");
  });

  it("marks High and above as pressing", () => {
    expect(pressing("normal")).toBe(false);
    expect(pressing("high")).toBe(true);
    expect(pressing("emergency")).toBe(true);
  });

  it("says which plan unlocks a severity the workspace's does not allow", () => {
    const plans = [
      { name: "Label", severities: ["low", "normal", "high", "urgent", "emergency"] as const },
      { name: "Studio", severities: ["low", "normal", "high"] as const },
      { name: "Custom", severities: ["low", "normal", "high", "urgent", "emergency"] as const },
    ].map((p, i) => ({
      ...p,
      severities: [...p.severities],
      hidden: p.name === "Custom",
      retiredAt: null,
      price: { amount: [19_000, 4900, 0][i] ?? 0 },
    }));
    expect(severityChoices({ severities: ["low", "normal"] }, plans)).toEqual([
      { severity: "low", allowed: true, plan: null },
      { severity: "normal", allowed: true, plan: null },
      { severity: "high", allowed: false, plan: "Studio" },
      { severity: "urgent", allowed: false, plan: "Label" },
      { severity: "emergency", allowed: false, plan: "Label" },
    ]);
  });

  it("takes a ticket with its reference read as pasted", () => {
    const parsed = ticketInput.parse({
      subject: " Score page 7 will not render ",
      kind: "problem",
      severity: "normal",
      message: "Pages 1 to 6 and then a blank.",
      errorReference: "hk7f3a2c",
    });
    expect(parsed).toMatchObject({
      subject: "Score page 7 will not render",
      errorReference: "HK-7F3A-2C",
      item: null,
      operatorAccess: false,
    });
    expect(ticketInput.safeParse({ ...parsed, errorReference: "nothing like one" }).success).toBe(
      false,
    );
    expect(ticketInput.safeParse({ ...parsed, severity: "critical" }).success).toBe(false);
    expect(ticketInput.safeParse({ ...parsed, message: "  " }).success).toBe(false);
  });

  it("lists open tickets unless asked otherwise, and keeps the desk's addresses web addresses", () => {
    expect(ticketsQuery.parse({})).toEqual({ state: "open" });
    expect(ticketsQuery.safeParse({ state: "closed" }).success).toBe(false);
    expect(supportDeskInput.safeParse({ statusUrl: "status page", onCall: null }).success).toBe(
      false,
    );
  });

  it("finds the middle of some durations", () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});
