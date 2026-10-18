import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { workflowFileName, workflowFromYaml, workflowToYaml } from "./workflow-files.ts";
import { type WorkflowDefinition, workflowDefinition } from "./workflows.ts";

const templates = new URL("./workflow-templates/", import.meta.url);
const read = (source: string) => {
  const result = workflowFromYaml(source);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result;
};
const refused = (source: string) => {
  const result = workflowFromYaml(source);
  if (result.ok) throw new Error("It was read.");
  return result.errors;
};
const file = (...lines: string[]) => `${lines.join("\n")}\n`;
const head = ["hekate: workflow/1", "name: Review"];

describe("the templates", () => {
  const names = readdirSync(templates).filter((f) => f.endsWith(".workflow.yaml"));

  it("are the three the builder offers", () => {
    expect(names.sort()).toEqual([
      "conductor-first.workflow.yaml",
      "parallel-stakeholders.workflow.yaml",
      "simple-approval.workflow.yaml",
    ]);
  });

  it.each(names)("%s reads without a problem and writes back the same", (name) => {
    const source = readFileSync(new URL(name, templates), "utf8");
    const result = read(source);
    expect(result.problems).toEqual([]);
    expect(workflowToYaml(result.name, result.definition)).toBe(source);
    expect(workflowFileName(result.name)).toBe(name);
  });
});

describe("a workflow written and read back", () => {
  const flow: WorkflowDefinition = workflowDefinition.parse({
    groups: [{ id: "round-1", name: "Round: one" }],
    nodes: [
      { id: "start", type: "upload", name: "A version is uploaded", x: 0, y: 0, config: {} },
      {
        id: "notes",
        type: "feedback",
        name: "Soloists' notes",
        x: 320.5,
        y: -40,
        groupId: "round-1",
        config: {
          who: "Mira Solberg (guest), Ines Arlow <ines@example.test>",
          due: "3",
          "odd key": "true",
          message: 'Line one\nline two, "quoted" # not a comment',
        },
      },
      { id: "edit", type: "task", name: "yes", x: 640, y: 0, config: { status: "  padded  " } },
      { id: "done", type: "finish", name: "Approved", x: 960, y: 0, config: {} },
    ],
    connectors: [
      { id: "c1", from: "start", outcome: "happened", to: "notes" },
      {
        id: "audio",
        from: "notes",
        outcome: "done",
        to: "edit",
        condition: { test: "kind", is: "audio" },
      },
      {
        id: "c3",
        from: "notes",
        outcome: "overdue",
        to: "done",
        condition: { test: "tag", is: "Rush: now", not: true },
      },
      { id: "c4", from: "edit", outcome: "done", to: "notes", until: { times: 4 } },
      {
        id: "c5",
        from: "edit",
        outcome: "overdue",
        to: "done",
        condition: { test: "by", is: "guest" },
      },
    ],
  });

  it("is the same workflow, whatever its text holds", () => {
    const yaml = workflowToYaml("Album: “Joplin Rags”", flow);
    const back = read(yaml);
    expect(back.name).toBe("Album: “Joplin Rags”");
    expect(back.definition).toEqual(flow);
    expect(workflowToYaml(back.name, back.definition)).toBe(yaml);
  });

  it("writes conditions and loops as people read them", () => {
    const yaml = workflowToYaml("Review", flow);
    expect(yaml).toContain("    when: kind audio\n");
    expect(yaml).toContain('    unless: "tag Rush: now"\n');
    expect(yaml).toContain("    when: by guest\n");
    expect(yaml).toContain("    until: 4\n");
    expect(yaml).toContain("    from: notes.done\n");
    expect(yaml).toContain("    name: Soloists' notes\n");
    expect(yaml).toContain('    name: "yes"\n');
  });

  it("writes an empty workflow so it reads back", () => {
    const empty = { nodes: [], connectors: [], groups: [] };
    expect(read(workflowToYaml("Nothing yet", empty)).definition).toEqual(empty);
  });
});

describe("reading a file written by hand", () => {
  it("takes YAML's other ways of writing the same thing", () => {
    const result = read(
      file(
        "---",
        "# Comments are fine, here and after values.",
        "hekate: 'workflow/1'",
        "name: Hand made   # the name",
        "nodes:",
        "- id: start",
        "  event: upload",
        "  name: A version is uploaded",
        "",
        "- id: ask",
        "  action: approval",
        "  name: 'It''s approval'",
        "  with:",
        "  at: [ 400 , 10 ]",
        "-",
        "  id: done",
        "  action: finish",
        "  name: Approved",
        "connectors:",
        "  - from: start.happened",
        "    to: ask",
        "  - id: c1",
        "    from: ask.approved",
        "    to: done",
      ),
    );
    expect(result.name).toBe("Hand made");
    expect(result.definition.nodes.map((n) => [n.id, n.name, n.x, n.y])).toEqual([
      ["start", "A version is uploaded", 0, 0],
      ["ask", "It's approval", 400, 10],
      ["done", "Approved", 640, 0],
    ]);
    // A connector without an id is given the first one free.
    expect(result.definition.connectors.map((c) => c.id)).toEqual(["c2", "c1"]);
  });

  it("lists the builder's problems with their lines, without refusing", () => {
    const result = read(
      file(
        ...head,
        "nodes:",
        "  - id: start",
        "    event: upload",
        "    name: A version is uploaded",
        "  - id: ask",
        "    action: approval",
        "    name: Approval",
        "connectors:",
        "  - from: ask.changes",
        "    to: start",
      ),
    );
    expect(result.problems).toContainEqual(
      expect.objectContaining({ level: "error", line: 7, nodeId: "ask" }),
    );
  });
});

describe("a file that cannot be read", () => {
  it("is refused at the line that is wrong", () => {
    expect(refused(file(...head, "nodes:", "  - id: start", "\tevent: upload"))).toEqual([
      { line: 5, message: "Indent with spaces, not tabs." },
    ]);
    expect(refused(file(...head, "nodes:", "  - id: start", "      event: upload"))).toEqual([
      { line: 5, message: "This line is indented further than the ones before it." },
    ]);
    expect(refused(file(...head, "name: Again"))[0]).toEqual({
      line: 3,
      message: "“name” is given twice.",
    });
    expect(refused(file(...head, 'nodes: "open'))[0]?.line).toBe(3);
    expect(refused(file(...head, "nodes: &anchor"))[0]?.line).toBe(3);
    expect(refused("")[0]?.message).toBe("The file is empty.");
  });

  it("is not a workflow without its format line, or with another", () => {
    expect(refused(file("name: Review", "nodes: []"))[0]?.message).toMatch(/hekate: workflow\/1/);
    expect(refused(file("hekate: workflow/2", "name: Review", "nodes: []"))).toEqual([
      { line: 1, message: "This file is workflow/2; this Hekate reads workflow/1." },
    ]);
  });

  it("names every mistake in the workflow, each with its line", () => {
    const errors = refused(
      file(
        ...head,
        "colour: red",
        "nodes:",
        "  - id: start",
        "    event: approval",
        "    name: Start",
        "  - id: ask",
        "    action: approval",
        "    event: upload",
        "    name: Ask",
        "  - id: wait",
        "    action: wait",
        "    name: Wait",
        "    at: [1]",
        "connectors:",
        "  - from: wait.done",
        "    to: nowhere",
        "  - from: wait",
        "    to: wait",
        "  - from: wait.elapsed",
        "    to: wait",
        "    when: colour blue",
        "    until: often",
      ),
    );
    expect(errors.map((e) => e.line)).toEqual([3, 6, 9, 15, 17, 18, 19, 23, 24]);
    expect(errors[0]?.message).toMatch(/“colour” is not part of a workflow file/);
    expect(errors[1]?.message).toMatch(/There is no event called “approval”/);
    expect(errors[4]?.message).toBe("wait has no outcome “done”: it ends by elapsed.");
    expect(errors[5]?.message).toBe("There is no node with the id nowhere.");
  });

  it("names a node's mistake once, not again at each connector naming it", () => {
    const errors = refused(
      file(
        ...head,
        "nodes:",
        "  - id: start",
        "    event: upload",
        "    name: Start",
        "  - id: ask",
        "    action: approve",
        "    name: Ask",
        "connectors:",
        "  - from: start.happened",
        "    to: ask",
        "  - from: ask.approved",
        "    to: start",
      ),
    );
    expect(errors).toEqual([
      { line: 8, message: expect.stringMatching(/no action called “approve”/) },
    ]);
  });

  it("refuses an id given twice at its second use, coordinates left blank, and deep nesting", () => {
    const twice = refused(
      file(
        ...head,
        "nodes:",
        "  - id: start",
        "    event: upload",
        "    name: Start",
        "  - id: start",
        "    action: finish",
        "    name: Done",
        "connectors:",
        "  - id: c1",
        "    from: start.happened",
        "    to: start",
        "  - id: c1",
        "    from: start.happened",
        "    to: start",
      ),
    );
    expect(twice).toEqual([
      { line: 7, message: "Two nodes are called start." },
      { line: 14, message: "Two connectors are called c1." },
    ]);
    const blank = refused(
      file(
        ...head,
        "nodes:",
        "  - id: start",
        "    event: upload",
        "    name: Start",
        '    at: ["", " "]',
      ),
    );
    expect(blank).toEqual([{ line: 7, message: expect.stringMatching(/^at: is where/) }]);
    expect(refused(`${"- ".repeat(8000)}x\n`)).toEqual([
      { line: 1, message: "This is nested too deeply." },
    ]);
  });

  it("is refused by the model's own limits, at the line", () => {
    const errors = refused(
      file(...head, "nodes:", "  - id: not an id", "    event: upload", "    name: Start"),
    );
    expect(errors).toEqual([{ line: 4, message: expect.stringMatching(/Letters, digits/) }]);
    const kind = refused(
      file(
        ...head,
        "nodes:",
        "  - id: start",
        "    event: upload",
        "    name: Start",
        "  - id: done",
        "    action: finish",
        "    name: Done",
        "connectors:",
        "  - from: start.happened",
        "    to: done",
        "    when: kind smell",
      ),
    );
    expect(kind[0]?.line).toBe(13);
  });
});

describe("the file's name", () => {
  it("is the workflow's, made safe", () => {
    expect(workflowFileName("Album review")).toBe("album-review.workflow.yaml");
    expect(workflowFileName("Délivery: “final”!")).toBe("delivery-final.workflow.yaml");
    expect(workflowFileName("✓")).toBe("workflow.workflow.yaml");
  });
});
