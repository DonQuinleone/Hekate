import { describe, expect, it } from "vitest";
import {
  type ErrorReport,
  errorReferenceParam,
  errorReportText,
  formatErrorReference,
  parseErrorReference,
} from "./error-reports.ts";

describe("error references", () => {
  it("reads as HK, four digits and two", () => {
    expect(formatErrorReference(new Uint8Array([0x7f, 0x3a, 0x2c]))).toBe("HK-7F3A-2C");
    expect(formatErrorReference(new Uint8Array([0, 1, 2, 3]))).toBe("HK-0001-02");
    expect(() => formatErrorReference(new Uint8Array([1, 2]))).toThrow(RangeError);
  });

  it("takes one however it was pasted", () => {
    for (const pasted of ["HK-7F3A-2C", " hk-7f3a-2c ", "7F3A2C", "hk7f3a-2c", "HK-7F-3A-2C"]) {
      expect(parseErrorReference(pasted)).toBe("HK-7F3A-2C");
    }
  });

  it("refuses what cannot be one", () => {
    for (const pasted of ["", "HK-7F3A", "HK-7F3A-2C9", "HK-7G3A-2C", "req_01HX"]) {
      expect(parseErrorReference(pasted)).toBeNull();
    }
    expect(errorReferenceParam.safeParse({ reference: "x".repeat(33) }).success).toBe(false);
    expect(errorReferenceParam.parse({ reference: "7f3a2c" })).toEqual({ reference: "HK-7F3A-2C" });
  });

  it("copies a report as text, leaving out what it does not have", () => {
    const report: ErrorReport = {
      reference: "HK-7F3A-2C",
      occurredAt: "2026-10-17T20:41:09.000Z",
      source: "worker",
      location: "document-render",
      message: "xref entry 41 points outside the file",
      workspace: "Endless Hall Records",
      workspaceId: "0199",
      status: null,
      stack: "PdfError: xref entry 41 points outside the file",
      requestId: null,
      jobId: "j-8f1c",
      context: { fileId: "f-1" },
      who: null,
    };
    expect(errorReportText(report).split("\n")).toEqual([
      "HK-7F3A-2C · 2026-10-17T20:41:09.000Z · worker · document-render",
      "xref entry 41 points outside the file",
      "Workspace: Endless Hall Records (0199)",
      "Job: j-8f1c",
      'Data: {"fileId":"f-1"}',
      "PdfError: xref entry 41 points outside the file",
    ]);
  });
});
