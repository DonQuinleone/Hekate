import { type WorkflowDefinition, workflowFromYaml } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import { workflowChanges, workflowTemplates, yamlPieces } from "./workflow-code";

const flow: WorkflowDefinition = {
  groups: [{ id: "round", name: "First round" }],
  nodes: [
    { id: "start", type: "upload", name: "A version is uploaded", x: 0, y: 0, config: {} },
    {
      id: "ask",
      type: "approval",
      name: "Label approval",
      x: 320,
      y: 0,
      config: { who: "Reviewer" },
      groupId: "round",
    },
    { id: "done", type: "finish", name: "Approved", x: 640, y: 0, config: {} },
  ],
  connectors: [
    { id: "c1", from: "start", outcome: "happened", to: "ask" },
    { id: "c2", from: "ask", outcome: "approved", to: "done" },
  ],
};

describe("the templates", () => {
  it("are offered by name, and each reads", () => {
    expect(workflowTemplates.map((t) => t.name)).toEqual([
      "Simple approval",
      "Conductor first",
      "Parallel stakeholders",
    ]);
    for (const t of workflowTemplates) {
      const read = workflowFromYaml(t.text);
      expect(read.ok && read.name).toBe(t.name);
    }
  });
});

describe("what applying a file changes", () => {
  it("is nothing for the same workflow", () => {
    expect(
      workflowChanges({ name: "A", definition: flow }, { name: "A", definition: flow }),
    ).toEqual([]);
  });

  it("says what is added, changed and removed, in plain words", () => {
    const after: WorkflowDefinition = {
      groups: [{ id: "round", name: "Round one" }],
      nodes: [
        { id: "start", type: "upload", name: "A version is uploaded", x: 0, y: 40, config: {} },
        {
          id: "ask",
          type: "approval",
          name: "The label",
          x: 320,
          y: 0,
          config: { who: "Producer" },
        },
        { id: "tell", type: "notify", name: "Tell the producer", x: 640, y: 120, config: {} },
      ],
      connectors: [
        { id: "c1", from: "start", outcome: "happened", to: "ask" },
        { id: "c3", from: "ask", outcome: "changes", to: "tell" },
      ],
    };
    expect(
      workflowChanges(
        { name: "Review", definition: flow },
        { name: "Delivery", definition: after },
      ),
    ).toEqual([
      "Renames it “Delivery”.",
      "Renames the group “First round” “Round one”.",
      "“A version is uploaded”: moves it on the canvas.",
      "“Label approval”: renames it “The label”, changes its settings, moves it to another group.",
      "Adds “Tell the producer” (notify).",
      "Removes “Approved”.",
      "Connects “The label” (changes requested) to “Tell the producer”.",
      "Removes the connector from “Label approval” (all approved) to “Approved”.",
    ]);
  });
});

describe("colouring a line of the file", () => {
  const pieces = (line: string) => yamlPieces(line).map((p) => [p.piece, p.text]);

  it("tells keys, text, numbers and comments apart", () => {
    expect(pieces("  - id: start")).toEqual([
      ["punctuation", "  - "],
      ["key", "id"],
      ["punctuation", ":"],
      ["text", " start"],
    ]);
    expect(pieces("    at: [320, 0]  # where")).toEqual([
      ["space", "    "],
      ["key", "at"],
      ["punctuation", ":"],
      ["number", " [320, 0]  "],
      ["comment", "# where"],
    ]);
    expect(pieces('      message: "Notes: in # here"')).toEqual([
      ["space", "      "],
      ["key", "message"],
      ["punctuation", ":"],
      ["text", ' "Notes: in # here"'],
    ]);
    expect(pieces("# A Hekate workflow")).toEqual([["comment", "# A Hekate workflow"]]);
    expect(pieces("nodes:")).toEqual([
      ["key", "nodes"],
      ["punctuation", ":"],
    ]);
    expect(pieces("  active: true")[3]).toEqual(["word", " true"]);
  });

  it("keeps every character, so the colours sit under the text exactly", () => {
    for (const line of ["  - from: notes.done", "name: Soloists' notes # x", "  - plain", ""])
      expect(
        yamlPieces(line)
          .map((p) => p.text)
          .join(""),
      ).toBe(line);
  });
});
