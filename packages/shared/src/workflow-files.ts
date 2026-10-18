import {
  ACTION_TYPES,
  EVENT_TYPES,
  nodeTypes,
  outcomesOf,
  type WorkflowCondition,
  type WorkflowConnector,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowProblem,
  workflowInput,
  workflowProblems,
} from "./workflows.ts";

/**
 * Workflows as files (#145): what is shown in the builder's code view, copied, downloaded,
 * shared between projects and instances, and imported, as a Grafana dashboard is. The format is
 * YAML, documented for people in `docs/site/src/content/docs/use/workflow-files.md`:
 *
 *   hekate: workflow/1
 *   name: Album review
 *   groups:
 *     round: First round
 *   nodes:
 *     - id: start
 *       event: upload
 *       name: A version is uploaded
 *       at: [0, 0]
 *     - id: notes
 *       action: feedback
 *       name: Conductor's notes
 *       group: round
 *       with:
 *         who: Conductor
 *       at: [320, 0]
 *   connectors:
 *     - id: c1
 *       from: start.happened
 *       to: notes
 *       when: kind audio
 *       until: 3
 *
 * This package may depend on nothing but zod, so it reads only the part of YAML the format
 * needs: mappings and sequences by indentation, plain, single- and double-quoted text (the
 * latter with JSON's escapes), sequences in brackets, and comments. Anything else is refused
 * with its line, as is a file the builder's rules cannot draw.
 */

export const WORKFLOW_FILE_FORMAT = "workflow/1";

/** Where a file is described for people, written at its head. */
const HEADER = "# A Hekate workflow: https://donquinleone.github.io/Hekate/use/workflow-files/";

export interface WorkflowFileError {
  /** The line it is on, from 1; null for the file as a whole. */
  line: number | null;
  message: string;
}

export type WorkflowFileProblem = WorkflowProblem & { line: number | null };

export type WorkflowFileRead =
  | {
      ok: true;
      name: string;
      definition: WorkflowDefinition;
      /** The builder's problems with it, which a draft may have; they keep it from running. */
      problems: WorkflowFileProblem[];
    }
  | { ok: false; errors: WorkflowFileError[] };

/* ---------- Writing ---------- */

const reserved = /^(true|false|null|yes|no|on|off|y|n|~)$/i;
/** Text left bare when nothing in it can be read as anything else; quoted otherwise. */
const text = (s: string) =>
  /^[A-Za-z_][A-Za-z0-9_ .,'()/&+-]*$/.test(s) && !s.endsWith(" ") && !reserved.test(s)
    ? s
    : JSON.stringify(s);
const key = (s: string) => (/^[A-Za-z0-9_-]+$/.test(s) ? s : JSON.stringify(s));

const conditionLine = (c: WorkflowCondition) =>
  `${c.not ? "unless" : "when"}: ${text(`${c.test} ${c.is}`)}`;

/** A workflow as its file. Reading it back gives the same workflow, and writing that the same file. */
export function workflowToYaml(name: string, flow: WorkflowDefinition): string {
  const lines = [HEADER, `hekate: ${WORKFLOW_FILE_FORMAT}`, `name: ${text(name)}`];
  if (flow.groups.length > 0) {
    lines.push("groups:");
    for (const g of flow.groups) lines.push(`  ${key(g.id)}: ${text(g.name)}`);
  }
  lines.push(flow.nodes.length > 0 ? "nodes:" : "nodes: []");
  for (const n of flow.nodes) {
    lines.push(`  - id: ${n.id}`);
    lines.push(`    ${nodeTypes[n.type].kind}: ${n.type}`);
    lines.push(`    name: ${text(n.name)}`);
    if (n.groupId) lines.push(`    group: ${n.groupId}`);
    const settings = Object.entries(n.config);
    if (settings.length > 0) {
      lines.push("    with:");
      for (const [k, v] of settings) lines.push(`      ${key(k)}: ${text(v)}`);
    }
    lines.push(`    at: [${n.x}, ${n.y}]`);
  }
  lines.push(flow.connectors.length > 0 ? "connectors:" : "connectors: []");
  for (const c of flow.connectors) {
    lines.push(`  - id: ${c.id}`);
    lines.push(`    from: ${c.from}.${c.outcome}`);
    lines.push(`    to: ${c.to}`);
    if (c.condition) lines.push(`    ${conditionLine(c.condition)}`);
    if (c.until) lines.push(`    until: ${c.until.times}`);
  }
  return `${lines.join("\n")}\n`;
}

/** The name a workflow's file is saved under: "album-review.workflow.yaml". */
export function workflowFileName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${slug || "workflow"}.workflow.yaml`;
}

/* ---------- Reading YAML ---------- */

type Value =
  | { t: "map"; line: number; entries: { key: string; line: number; value: Value }[] }
  | { t: "seq"; line: number; items: Value[] }
  | { t: "text"; line: number; value: string }
  | { t: "empty"; line: number };

interface Line {
  no: number;
  indent: number;
  text: string;
}

class FileError extends Error {
  line: number;
  constructor(line: number, message: string) {
    super(message);
    this.line = line;
  }
}

const commentOnly = (s: string) => /^\s*(#.*)?$/.test(s);

/** A quoted text at the start of `s`: its value and what follows it. */
function quoted(s: string, line: number): { value: string; rest: string } {
  if (s.startsWith('"')) {
    let i = 1;
    while (i < s.length && s[i] !== '"') i += s[i] === "\\" ? 2 : 1;
    if (i >= s.length) throw new FileError(line, "This quoted text is not closed.");
    try {
      return { value: JSON.parse(s.slice(0, i + 1)) as string, rest: s.slice(i + 1) };
    } catch {
      throw new FileError(line, "This quoted text has an escape that cannot be read.");
    }
  }
  let value = "";
  let i = 1;
  for (;;) {
    if (i >= s.length) throw new FileError(line, "This quoted text is not closed.");
    if (s[i] === "'") {
      if (s[i + 1] !== "'") break;
      value += "'";
      i += 2;
    } else {
      value += s[i];
      i += 1;
    }
  }
  return { value, rest: s.slice(i + 1) };
}

/** One bare text: up to a comment, trimmed. */
function bare(s: string, line: number): string {
  const comment = s.search(/(^|\s)#/);
  const value = (comment === -1 ? s : s.slice(0, comment)).trim();
  if (/^[{&*!|>%@`]/.test(value))
    throw new FileError(line, "This part of YAML is not read here: put the value in quotes.");
  return value;
}

/** The value written after a key or a dash on the same line. */
function inline(s: string, line: number): Value {
  if (commentOnly(s)) return { t: "empty", line };
  const start = s.trimStart();
  if (start.startsWith('"') || start.startsWith("'")) {
    const { value, rest } = quoted(start, line);
    if (!commentOnly(rest)) throw new FileError(line, "There is more after the quoted text.");
    return { t: "text", line, value };
  }
  if (start.startsWith("[")) {
    const items: Value[] = [];
    let rest = start.slice(1).trimStart();
    if (rest.startsWith("]")) rest = rest.slice(1);
    else
      for (;;) {
        let value: string;
        if (rest.startsWith('"') || rest.startsWith("'")) {
          const q = quoted(rest, line);
          value = q.value;
          rest = q.rest.trimStart();
        } else {
          const end = rest.search(/[,\]]/);
          if (end === -1) throw new FileError(line, "This list is not closed with ].");
          value = rest.slice(0, end).trim();
          if (value === "" || /[[{"']/.test(value))
            throw new FileError(line, "Each item of this list should be a single value.");
          rest = rest.slice(end);
        }
        items.push({ t: "text", line, value });
        if (rest.startsWith("]")) {
          rest = rest.slice(1);
          break;
        }
        if (!rest.startsWith(",")) throw new FileError(line, "This list is not closed with ].");
        rest = rest.slice(1).trimStart();
      }
    if (!commentOnly(rest)) throw new FileError(line, "There is more after the list.");
    return { t: "seq", line, items };
  }
  return { t: "text", line, value: bare(start, line) };
}

/** A "key: value" line split in two, or null when the line is not one. */
function keyed(s: string, line: number): { key: string; rest: string } | null {
  if (s.startsWith('"') || s.startsWith("'")) {
    const q = quoted(s, line);
    const m = q.rest.match(/^\s*:(?:\s+|$)(.*)$/);
    return m ? { key: q.value, rest: m[1] ?? "" } : null;
  }
  const m = s.match(/^([^\s:#][^:#]*?)\s*:(?:\s+|$)(.*)$/);
  return m ? { key: m[1] ?? "", rest: m[2] ?? "" } : null;
}

const isItem = (s: string) => s === "-" || s.startsWith("- ");

/** How deep a file's mappings and lists may nest. */
const MAX_DEPTH = 16;

/** The YAML a workflow file is written in, as values with the line each starts on. */
function parseYaml(source: string): Value {
  const lines: Line[] = [];
  source.split(/\r?\n/).forEach((raw, i) => {
    const no = i + 1;
    const lead = raw.match(/^[ \t]*/)?.[0] ?? "";
    const rest = raw.slice(lead.length);
    if (commentOnly(rest)) return;
    if (lead.includes("\t")) throw new FileError(no, "Indent with spaces, not tabs.");
    if (lines.length === 0 && rest.trimEnd() === "---") return;
    lines.push({ no, indent: lead.length, text: rest.trimEnd() });
  });
  if (lines.length === 0) throw new FileError(1, "The file is empty.");
  let i = 0;
  const current = () => lines[i] as Line;
  const deeper = (indent: number) => {
    if (i < lines.length && current().indent > indent)
      throw new FileError(current().no, "This line is indented further than the ones before it.");
  };

  // A workflow file nests four deep; a file nested far deeper is refused before it can exhaust
  // the stack.
  let depth = 0;
  const block = (indent: number): Value => {
    if (depth >= MAX_DEPTH) throw new FileError(current().no, "This is nested too deeply.");
    depth += 1;
    try {
      return isItem(current().text) ? sequence(indent) : mapping(indent);
    } finally {
      depth -= 1;
    }
  };

  /** What follows a key or a dash with nothing after it: a nested block, or nothing. */
  const nested = (indent: number, line: number, sameIndentList: boolean): Value => {
    if (i < lines.length && current().indent > indent) return block(current().indent);
    if (sameIndentList && i < lines.length && current().indent === indent && isItem(current().text))
      return sequence(indent);
    return { t: "empty", line };
  };

  const mapping = (indent: number): Value => {
    const first = current().no;
    const entries: { key: string; line: number; value: Value }[] = [];
    while (i < lines.length && current().indent === indent && !isItem(current().text)) {
      const { no, text } = current();
      const kv = keyed(text, no);
      if (!kv) throw new FileError(no, "Expected “name: value” here.");
      if (entries.some((e) => e.key === kv.key))
        throw new FileError(no, `“${kv.key}” is given twice.`);
      i += 1;
      const value = commentOnly(kv.rest) ? nested(indent, no, true) : inline(kv.rest, no);
      entries.push({ key: kv.key, line: no, value });
      deeper(indent);
    }
    return { t: "map", line: first, entries };
  };

  const sequence = (indent: number): Value => {
    const first = current().no;
    const items: Value[] = [];
    while (i < lines.length && current().indent === indent && isItem(current().text)) {
      const { no, text } = current();
      const after = text.slice(1);
      const rest = after.trimStart();
      const offset = indent + 1 + after.length - rest.length;
      if (commentOnly(rest)) {
        i += 1;
        items.push(nested(indent, no, false));
      } else if (isItem(rest) || keyed(rest, no)) {
        // A mapping or list that starts on the dash's line carries on below at its column.
        lines[i] = { no, indent: offset, text: rest };
        items.push(block(offset));
      } else {
        i += 1;
        items.push(inline(rest, no));
      }
      deeper(indent);
    }
    return { t: "seq", line: first, items };
  };

  const top = block(current().indent);
  if (i < lines.length) throw new FileError(current().no, "This line is out of place.");
  return top;
}

/* ---------- Reading a workflow ---------- */

const kinds = {
  event: EVENT_TYPES as readonly string[],
  action: ACTION_TYPES as readonly string[],
};
const or = (words: readonly string[]) =>
  words.length > 1 ? `${words.slice(0, -1).join(", ")} or ${words.at(-1)}` : (words[0] ?? "");

/** A workflow file read back, or why it cannot be, each reason with its line. */
export function workflowFromYaml(source: string): WorkflowFileRead {
  let top: Value;
  try {
    top = parseYaml(source);
  } catch (e) {
    if (e instanceof FileError)
      return { ok: false, errors: [{ line: e.line, message: e.message }] };
    throw e;
  }
  const errors: WorkflowFileError[] = [];
  const fail = (line: number | null, message: string) => errors.push({ line, message });
  /** The line each part of the workflow came from, by its path ("nodes.2.name"). */
  const lineOf = new Map<string, number>();

  const asMap = (v: Value, what: string) => {
    if (v.t === "map") return v;
    fail(v.line, `${what} should be lines of “name: value”.`);
    return null;
  };
  const asList = (v: Value, what: string) => {
    if (v.t === "seq") return v.items;
    if (v.t === "empty") return [];
    fail(v.line, `${what} should be a list, each item starting with a dash.`);
    return null;
  };
  const asText = (v: Value, what: string) => {
    if (v.t === "text") return v.value;
    fail(v.line, v.t === "empty" ? `${what} is empty.` : `${what} should be a single value.`);
    return null;
  };
  const fields = (
    map: Extract<Value, { t: "map" }>,
    allowed: readonly string[],
    where: string,
  ): Map<string, { line: number; value: Value }> => {
    const out = new Map<string, { line: number; value: Value }>();
    for (const e of map.entries) {
      if (allowed.includes(e.key)) out.set(e.key, { line: e.line, value: e.value });
      else fail(e.line, `“${e.key}” is not part of ${where}; it may have ${or(allowed)}.`);
    }
    return out;
  };

  const file = asMap(top, "A workflow file");
  if (!file) return { ok: false, errors };
  const head = fields(file, ["hekate", "name", "groups", "nodes", "connectors"], "a workflow file");
  const format = head.get("hekate");
  if (!format) {
    fail(1, `This is not a Hekate workflow: it should start with hekate: ${WORKFLOW_FILE_FORMAT}.`);
    return { ok: false, errors };
  }
  const version = asText(format.value, "hekate");
  if (version !== null && version !== WORKFLOW_FILE_FORMAT)
    fail(format.line, `This file is ${version}; this Hekate reads ${WORKFLOW_FILE_FORMAT}.`);

  const nameField = head.get("name");
  const name = nameField ? asText(nameField.value, "The name") : null;
  if (!nameField) fail(null, "The workflow has no name: add name: and what it is called.");
  if (nameField) lineOf.set("name", nameField.line);

  const groups: WorkflowDefinition["groups"] = [];
  const groupsField = head.get("groups");
  if (groupsField && groupsField.value.t !== "empty") {
    const map = asMap(groupsField.value, "groups");
    for (const e of map?.entries ?? []) {
      const groupName = asText(e.value, `The group ${e.key}`);
      lineOf.set(`groups.${groups.length}`, e.line);
      if (groupName !== null) groups.push({ id: e.key, name: groupName });
    }
  }

  const nodes: WorkflowNode[] = [];
  const nodeLine = new Map<string, number>();
  // Every id a node is given, read or not, so a node refused for one mistake is not reported
  // again by each connector that names it.
  const named = new Set<string>();
  const nodesField = head.get("nodes");
  if (!nodesField) fail(null, "The workflow has no nodes: add nodes: and list them.");
  for (const item of nodesField ? (asList(nodesField.value, "nodes") ?? []) : []) {
    const map = asMap(item, "A node");
    if (!map) continue;
    const f = fields(map, ["id", "event", "action", "name", "group", "with", "at"], "a node");
    const at = `nodes.${nodes.length}`;
    lineOf.set(at, map.line);
    const id = f.get("id");
    const called = f.get("name");
    if (!id) fail(map.line, "This node has no id.");
    if (!called) fail(map.line, "This node has no name.");
    const event = f.get("event");
    const action = f.get("action");
    if (event && action) fail(action.line, "A node is an event or an action, not both.");
    if (!event && !action) fail(map.line, "This node needs event: or action: and its type.");
    const kind = event ? "event" : "action";
    const typeField = event ?? action;
    const type = typeField ? asText(typeField.value, `The ${kind}`) : null;
    if (typeField && type !== null && !kinds[kind].includes(type))
      fail(typeField.line, `There is no ${kind} called “${type}”: it may be ${or(kinds[kind])}.`);
    const config: Record<string, string> = {};
    const settings = f.get("with");
    if (settings && settings.value.t !== "empty")
      for (const e of asMap(settings.value, "with")?.entries ?? []) {
        const v = asText(e.value, `The setting ${e.key}`);
        lineOf.set(`${at}.config.${e.key}`, e.line);
        if (v !== null) config[e.key] = v;
      }
    let x = nodes.length * 320;
    let y = 0;
    const place = f.get("at");
    if (place) {
      const where = place.value.t === "seq" ? place.value.items : [];
      const [px, py] = where.map((w) =>
        w.t === "text" && w.value.trim() !== "" ? Number(w.value) : Number.NaN,
      );
      if (where.length !== 2 || !Number.isFinite(px) || !Number.isFinite(py))
        fail(place.line, "at: is where the node sits on the canvas, as [x, y] in pixels.");
      else {
        x = px as number;
        y = py as number;
      }
    }
    const nodeId = id ? asText(id.value, "The id") : null;
    const nodeName = called ? asText(called.value, "The name") : null;
    if (id && nodeId !== null) {
      if (named.has(nodeId)) fail(id.line, `Two nodes are called ${nodeId}.`);
      named.add(nodeId);
    }
    if (id) lineOf.set(`${at}.id`, id.line);
    if (called) lineOf.set(`${at}.name`, called.line);
    const group = f.get("group");
    const groupId = group ? asText(group.value, "The group") : null;
    if (group) lineOf.set(`${at}.groupId`, group.line);
    if (nodeId !== null && nodeName !== null && type !== null && kinds[kind].includes(type)) {
      nodes.push({
        id: nodeId,
        type: type as WorkflowNode["type"],
        name: nodeName,
        x,
        y,
        config,
        ...(groupId !== null ? { groupId } : {}),
      });
      if (!nodeLine.has(nodeId)) nodeLine.set(nodeId, map.line);
    }
  }

  const connectors: (Omit<WorkflowConnector, "id"> & { id?: string })[] = [];
  const connectorLine: number[] = [];
  const wireIds = new Set<string>();
  const connectorsField = head.get("connectors");
  for (const item of connectorsField ? (asList(connectorsField.value, "connectors") ?? []) : []) {
    const map = asMap(item, "A connector");
    if (!map) continue;
    const f = fields(map, ["id", "from", "to", "when", "unless", "until"], "a connector");
    const at = `connectors.${connectors.length}`;
    const fromField = f.get("from");
    const toField = f.get("to");
    if (!fromField) fail(map.line, "This connector has no from: (the node and its outcome).");
    if (!toField) fail(map.line, "This connector has no to: (the node it leads to).");
    const from = fromField ? asText(fromField.value, "from") : null;
    const to = toField ? asText(toField.value, "to") : null;
    const [fromId, outcome, ...extra] = (from ?? "").split(".");
    let ok = from !== null && to !== null;
    if (fromField && from !== null && (!fromId || !outcome || extra.length > 0)) {
      fail(fromField.line, "from: names a node and its outcome, as notes.done.");
      ok = false;
    } else if (fromField && fromId) {
      const source = nodes.find((n) => n.id === fromId);
      const outs = source ? outcomesOf(source.type).map((o) => o.id) : [];
      if (!source) {
        if (!named.has(fromId)) fail(fromField.line, `There is no node with the id ${fromId}.`);
        ok = false;
      } else if (outs.length === 0) {
        fail(fromField.line, `Nothing follows ${fromId}: a ${source.type} has no outcomes.`);
        ok = false;
      } else if (outcome && !outs.includes(outcome)) {
        fail(fromField.line, `${fromId} has no outcome “${outcome}”: it ends by ${or(outs)}.`);
        ok = false;
      }
    }
    if (toField && to !== null && !nodes.some((n) => n.id === to)) {
      if (!named.has(to)) fail(toField.line, `There is no node with the id ${to}.`);
      ok = false;
    }
    const when = f.get("when");
    const unless = f.get("unless");
    if (when && unless) fail(unless.line, "A connector has when: or unless:, not both.");
    let condition: WorkflowCondition | undefined;
    const test = when ?? unless;
    if (test) {
      const said = asText(test.value, "The condition");
      const m = said?.match(/^(kind|tag|by)\s+(.+)$/);
      if (said !== null && !m) {
        fail(
          test.line,
          "A condition is kind, tag or by and what it is: kind audio, tag Rush, by guest.",
        );
        ok = false;
      } else if (m) {
        condition = {
          test: m[1],
          is: m[2],
          ...(unless ? { not: true } : {}),
        } as WorkflowCondition;
        lineOf.set(`${at}.condition`, test.line);
      }
    }
    let until: WorkflowConnector["until"];
    const bound = f.get("until");
    if (bound) {
      const times = asText(bound.value, "until");
      if (times !== null && !/^\d+$/.test(times)) {
        fail(bound.line, "until: is how many times a loop may be taken, as a whole number.");
        ok = false;
      } else if (times !== null) until = { times: Number(times) };
      lineOf.set(`${at}.until`, bound.line);
    }
    const id = f.get("id");
    const connectorId = id ? asText(id.value, "The id") : undefined;
    if (id && connectorId) {
      if (wireIds.has(connectorId)) fail(id.line, `Two connectors are called ${connectorId}.`);
      wireIds.add(connectorId);
    }
    if (id) lineOf.set(`${at}.id`, id.line);
    if (!ok || from === null || to === null || !fromId || !outcome) continue;
    lineOf.set(at, map.line);
    connectorLine.push(map.line);
    connectors.push({
      ...(connectorId !== undefined && connectorId !== null ? { id: connectorId } : {}),
      from: fromId,
      outcome,
      to,
      ...(condition ? { condition } : {}),
      ...(until ? { until } : {}),
    });
  }
  if (errors.length > 0) return { ok: false, errors };

  // A connector written without an id is given the first free one.
  const used = new Set(connectors.flatMap((c) => (c.id ? [c.id] : [])));
  let next = 1;
  const wired = connectors.map((c) => {
    if (c.id) return c as WorkflowConnector;
    while (used.has(`c${next}`)) next += 1;
    used.add(`c${next}`);
    return { ...c, id: `c${next}` };
  });

  const parsed = workflowInput.pick({ name: true, definition: true }).safeParse({
    name,
    definition: { nodes, connectors: wired, groups },
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.map(String);
      if (path[0] === "definition") path.shift();
      let line: number | null = null;
      for (let n = path.length; n > 0 && line === null; n -= 1)
        line = lineOf.get(path.slice(0, n).join(".")) ?? null;
      fail(line, issue.message);
    }
    return { ok: false, errors };
  }
  const { definition } = parsed.data;
  const problems = workflowProblems(definition).map((p) => ({
    ...p,
    line:
      (p.nodeId ? nodeLine.get(p.nodeId) : undefined) ??
      (p.connectorId ? connectorLine[wired.findIndex((c) => c.id === p.connectorId)] : undefined) ??
      null,
  }));
  return { ok: true, name: parsed.data.name, definition, problems };
}
