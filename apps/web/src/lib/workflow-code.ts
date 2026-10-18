import {
  nodeTypes,
  outcomesOf,
  type WorkflowConnector,
  type WorkflowDefinition,
} from "@hekate/shared";
import conductorFirst from "@hekate/shared/workflow-templates/conductor-first.workflow.yaml?raw";
import parallelStakeholders from "@hekate/shared/workflow-templates/parallel-stakeholders.workflow.yaml?raw";
import simpleApproval from "@hekate/shared/workflow-templates/simple-approval.workflow.yaml?raw";

/**
 * The builder's code view (#145): a workflow as its file, the templates it can start from, what
 * applying a file would change, and the file's text coloured by what each piece is.
 */

/** The workflows Hekate offers to start from, as the files they ship as. */
export const workflowTemplates: readonly { id: string; name: string; text: string }[] = [
  { id: "simple-approval", name: "Simple approval", text: simpleApproval },
  { id: "conductor-first", name: "Conductor first", text: conductorFirst },
  { id: "parallel-stakeholders", name: "Parallel stakeholders", text: parallelStakeholders },
];

interface Named {
  name: string;
  definition: WorkflowDefinition;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What applying `after` over `before` would change, a sentence each, in the file's order. */
export function workflowChanges(before: Named, after: Named): string[] {
  const out: string[] = [];
  if (before.name !== after.name) out.push(`Renames it “${after.name}”.`);
  const was = new Map(before.definition.groups.map((g) => [g.id, g]));
  const is = new Map(after.definition.groups.map((g) => [g.id, g]));
  for (const g of after.definition.groups) {
    const old = was.get(g.id);
    if (!old) out.push(`Adds the group “${g.name}”.`);
    else if (old.name !== g.name) out.push(`Renames the group “${old.name}” “${g.name}”.`);
  }
  for (const g of before.definition.groups)
    if (!is.has(g.id)) out.push(`Removes the group “${g.name}”.`);

  const oldNodes = new Map(before.definition.nodes.map((n) => [n.id, n]));
  const newNodes = new Map(after.definition.nodes.map((n) => [n.id, n]));
  for (const n of after.definition.nodes) {
    const old = oldNodes.get(n.id);
    if (!old) {
      out.push(`Adds “${n.name}” (${nodeTypes[n.type].label.toLowerCase()}).`);
      continue;
    }
    const what = [
      old.type !== n.type && `makes it ${nodeTypes[n.type].label.toLowerCase()}`,
      old.name !== n.name && `renames it “${n.name}”`,
      !same(old.config, n.config) && "changes its settings",
      old.groupId !== n.groupId && "moves it to another group",
      (old.x !== n.x || old.y !== n.y) && "moves it on the canvas",
    ].filter((w): w is string => typeof w === "string");
    if (what.length > 0) out.push(`“${old.name}”: ${what.join(", ")}.`);
  }
  for (const n of before.definition.nodes)
    if (!newNodes.has(n.id)) out.push(`Removes “${n.name}”.`);

  const named = (nodes: Map<string, { name: string }>, id: string) =>
    `“${nodes.get(id)?.name ?? id}”`;
  const wire = (c: WorkflowConnector, nodes: typeof newNodes) => {
    const from = nodes.get(c.from);
    const label = from ? outcomesOf(from.type).find((o) => o.id === c.outcome)?.label : undefined;
    return `${named(nodes, c.from)}${label ? ` (${label})` : ""} to ${named(nodes, c.to)}`;
  };
  const oldWires = new Map(before.definition.connectors.map((c) => [c.id, c]));
  const newWires = new Map(after.definition.connectors.map((c) => [c.id, c]));
  for (const c of after.definition.connectors) {
    const old = oldWires.get(c.id);
    if (!old) out.push(`Connects ${wire(c, newNodes)}.`);
    else if (!same(old, c)) out.push(`Changes the connector from ${wire(c, newNodes)}.`);
  }
  for (const c of before.definition.connectors)
    if (!newWires.has(c.id)) out.push(`Removes the connector from ${wire(c, oldNodes)}.`);
  return out;
}

export type YamlPiece = "space" | "key" | "punctuation" | "text" | "number" | "word" | "comment";

/**
 * One line of a workflow file in pieces, each with what it is, for colouring: keys, the
 * punctuation between, text, numbers and lists of them, YAML's words (true, null) and comments.
 */
export function yamlPieces(line: string): { text: string; piece: YamlPiece }[] {
  const lead = line.match(/^\s*(-\s+)*/)?.[0] ?? "";
  const rest = line.slice(lead.length);
  const out: { text: string; piece: YamlPiece }[] = [];
  if (lead) out.push({ text: lead, piece: lead.trim() ? "punctuation" : "space" });
  if (rest.startsWith("#")) return [...out, { text: rest, piece: "comment" }];
  const keyed = rest.match(/^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s:#"'][^:#]*?)(\s*:)(\s.*|$)/);
  const value = keyed ? (keyed[3] ?? "") : rest;
  if (keyed) {
    out.push({ text: keyed[1] ?? "", piece: "key" });
    out.push({ text: keyed[2] ?? "", piece: "punctuation" });
  }
  // A comment starts at a # after a space, outside quotes.
  let quote: string | null = null;
  let cut = value.length;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i += 1;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      if (i === 0 || /[\s[,]/.test(value[i - 1] ?? "")) quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(value[i - 1] ?? ""))) {
      cut = i;
      break;
    }
  }
  const body = value.slice(0, cut);
  const word = body.trim();
  if (word) {
    const piece: YamlPiece = /^(true|false|null|~)$/i.test(word)
      ? "word"
      : /^-?\d+(\.\d+)?$/.test(word) || /^\[[\d\s.,-]*\]$/.test(word)
        ? "number"
        : "text";
    out.push({ text: body, piece });
  } else if (body) out.push({ text: body, piece: "space" });
  if (cut < value.length) out.push({ text: value.slice(cut), piece: "comment" });
  return out;
}
