import { describe, expect, it } from "vitest";
import { fileSummary } from "./files";

const file = (name: string, kind: "document" | "image" | "other", pageCount?: number) => ({
  name,
  kind,
  contentType: "application/octet-stream",
  mediaInfo: null,
  streamStatus: "ready" as const,
  pageCount,
});

describe("fileSummary", () => {
  it("says what a document, a picture or another file is (#149)", () => {
    expect(fileSummary(file("Booklet - proof 2.pdf", "document", 4))).toBe("PDF · 4 pages");
    expect(fileSummary(file("Cover note.pdf", "document", 1))).toBe("PDF · 1 page");
    expect(fileSummary(file("Notes.txt", "document"))).toBe("TXT");
    expect(fileSummary(file("Cover.png", "image", 1))).toBe("PNG picture");
    expect(fileSummary(file("Print files.zip", "other"))).toBe("ZIP file");
    expect(fileSummary(file("README", "other"))).toBe("application/octet-stream");
  });
});
