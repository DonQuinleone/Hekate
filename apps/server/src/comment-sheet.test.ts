import type { ExportThread } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import { commentSheet, commentSheetLines } from "./comment-sheet.ts";

const thread = (t: Partial<ExportThread>): ExportThread => ({
  anchor: { kind: "time", start: 6.2, end: 6.2 },
  channel: null,
  author: "Mira Solberg",
  body: "Pedal noise",
  resolved: false,
  replies: [],
  ...t,
});

const input = {
  file: { name: "Maple Leaf Rag - Dry v2.wav", version: "V2 · Dry" },
  workspace: "Endless Hall Records",
  project: "Joplin Rags",
  requestedBy: { name: "Tomas Varga", role: "Engineer" },
  generatedAt: new Date("2026-10-18T09:30:00Z"),
  scope: "open" as const,
  threads: [
    thread({ channel: "L", replies: [{ author: "Ines Arlow", body: "Gone in the wet mix." }] }),
    thread({ anchor: null, author: "Alex Rivera", body: "Lovely overall.", resolved: true }),
    thread({
      anchor: { kind: "bar", from: { bar: 9, beat: 1 }, to: { bar: 12 }, at: 14.2 },
      body: "The left hand rushes.",
    }),
  ],
};

describe("the comment sheet", () => {
  it("stamps the sheet and numbers each open thread with its place, author and replies", () => {
    const text = commentSheetLines(input).map((l) => l.text);
    expect(text[0]).toBe("Comments");
    expect(text[1]).toBe("Maple Leaf Rag - Dry v2.wav (V2 · Dry)");
    expect(text[2]).toBe(
      "Endless Hall Records · Joplin Rags · Tomas Varga, Engineer · 2026-10-18 09:30 UTC",
    );
    expect(text).toContain("2 open threads");
    expect(text).toContain("001 · 00:06.200 · L · Mira Solberg");
    expect(text).toContain("Reply from Ines Arlow: Gone in the wet mix.");
    expect(text.some((t) => t.startsWith("002 · BARS 9–12"))).toBe(true);
    expect(text).not.toContain("Lovely overall.");
  });

  it("prints every thread when asked, the settled ones saying so", () => {
    const text = commentSheetLines({ ...input, scope: "all" }).map((l) => l.text);
    expect(text).toContain("3 threads");
    expect(text).toContain("002 · Whole file · Alex Rivera · Resolved");
  });

  it("says when there is nothing to print, and names the file it makes", () => {
    const empty = commentSheetLines({ ...input, threads: [] }).map((l) => l.text);
    expect(empty).toContain("Nothing to print.");
    const out = commentSheet(input);
    expect(out.filename).toBe("Maple Leaf Rag - Dry v2 comments.pdf");
    expect(out.body.subarray(0, 5).toString()).toBe("%PDF-");
  });
});
