import { describe, expect, it } from "vitest";
import { reportLines, sentence } from "./croom";

const report = {
  unknownEvents: [{ type: "frobnicate_widget", count: 1 }],
  unknownFields: [{ type: "update_venue", field: "postcode", count: 2 }],
  ignored: [
    { type: "add_view", count: 2, reason: "The desktop app's own window layout" },
    { type: "set_active_view", count: 1, reason: "The desktop app's own window layout" },
  ],
  problems: [
    "Take 1 of “Maple Leaf Rag” is already in this project, so the file's own take 1 was not imported",
  ],
  support: ["upsert_stage_element: names a stage plan that is not in the project"],
};

describe("the import preview's report", () => {
  it("says every line as a sentence, with no id outside the details for support", () => {
    const lines = reportLines(report);
    const shown = [...lines.lookOver, ...lines.notBrought.map((l) => l.what)];
    for (const line of shown) {
      expect(line).toMatch(/\.$/);
      expect(line).not.toMatch(/[a-z]+_[a-z]+/);
    }
    // One reason, one line, whichever events it came from.
    expect(lines.notBrought[0]).toEqual({ what: "The desktop app's own window layout.", count: 3 });
    expect(lines.notBrought.map((l) => l.what)).toEqual([
      "The desktop app's own window layout.",
      "A change this import does not know, from a newer ControlRoom.",
      "Details of a venue this import does not read.",
    ]);
    expect(lines.support.map((l) => l.what)).toEqual([
      "Unknown event frobnicate_widget",
      "Unread field update_venue.postcode",
      "Set aside add_view",
      "Set aside set_active_view",
      "upsert_stage_element: names a stage plan that is not in the project",
    ]);
  });

  it("ends a sentence once", () => {
    expect(sentence("It was left out")).toBe("It was left out.");
    expect(sentence("Look it over.")).toBe("Look it over.");
  });
});
