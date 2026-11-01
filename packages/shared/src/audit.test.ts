import { describe, expect, it } from "vitest";
import {
  auditActions,
  currentAuditAction,
  formerAuditActions,
  storedAuditActions,
} from "./audit.ts";

describe("audit actions under a name since changed (decision 295)", () => {
  it("reads an older entry as the action it stands for", () => {
    expect(currentAuditAction("variation.replace")).toBe("variant.replace");
    expect(currentAuditAction("variant.replace")).toBe("variant.replace");
    expect(currentAuditAction("download")).toBe("download");
  });

  it("filters an action with the values its older entries hold", () => {
    expect(storedAuditActions("variant.replace")).toEqual(["variant.replace", "variation.replace"]);
    expect(storedAuditActions("download")).toEqual(["download"]);
  });

  it("names only actions the log knows, each standing for one that is current", () => {
    for (const [old, now] of Object.entries(formerAuditActions)) {
      expect(auditActions).toContain(old);
      expect(auditActions).toContain(now);
      expect(Object.keys(formerAuditActions)).not.toContain(now);
    }
  });
});
