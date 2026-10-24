// The API reference pages (#197), written at build time from docs/openapi.json, the document the
// server writes from its routes: one page per group, each operation with its scope, parameters,
// body, an example call and, where there is one, an example answer.

type Schema = { [key: string]: unknown };
type Parameter = {
  name: string;
  in: string;
  required: boolean;
  description?: string;
  schema?: Schema;
};
type Operation = {
  summary: string;
  description?: string;
  tags: string[];
  "x-hekate-scope": string;
  parameters?: Parameter[];
  requestBody?: {
    description?: string;
    content: Record<string, { schema?: Schema; example?: unknown }>;
  };
  responses: Record<
    string,
    { description?: string; content?: Record<string, { example?: unknown }> }
  >;
};
export type OpenApi = {
  info: { version: string };
  tags: { name: string; description: string }[];
  paths: Record<string, Record<string, Operation>>;
};

export interface ReferencePage {
  slug: string;
  title: string;
  description: string;
  order: number;
  body: string;
}

const INSTANCE = "https://review.endlesshall.example";
const SAMPLE_ID = "01929b8e-5c1a-7d3e-9f40-2b6c8d1e4a57";

export const slugOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");

/** A schema's type in a few words: `string (uuid)`, `one of approval, feedback`, `array of string`. */
export function typeLabel(schema: Schema | undefined): string {
  if (!schema || Object.keys(schema).length === 0) return "any";
  if ("const" in schema) return `\`${JSON.stringify(schema.const)}\``;
  if (Array.isArray(schema.enum))
    return `one of ${schema.enum.map((v) => `\`${String(v)}\``).join(", ")}`;
  const branches = (schema.anyOf ?? schema.oneOf) as Schema[] | undefined;
  if (Array.isArray(branches)) {
    const shown = branches.filter((b) => b.type !== "null").map(typeLabel);
    const nullable = branches.some((b) => b.type === "null");
    return `${[...new Set(shown)].join(" or ")}${nullable ? ", or null" : ""}`;
  }
  const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
  const nullable = types.includes("null");
  const type = types.find((t) => t !== "null") ?? "any";
  let label = type;
  if (type === "array") label = `array of ${typeLabel(schema.items as Schema | undefined)}`;
  else if (typeof schema.format === "string") label = `${type} (${schema.format})`;
  const limits: string[] = [];
  if (typeof schema.minLength === "number" && typeof schema.maxLength === "number")
    limits.push(`${schema.minLength} to ${schema.maxLength} characters`);
  else if (typeof schema.maxLength === "number")
    limits.push(`at most ${schema.maxLength} characters`);
  if (typeof schema.minimum === "number") limits.push(`at least ${schema.minimum}`);
  if (typeof schema.maximum === "number") limits.push(`at most ${schema.maximum}`);
  if ("default" in schema) limits.push(`default \`${JSON.stringify(schema.default)}\``);
  return `${label}${limits.length ? `, ${limits.join(", ")}` : ""}${nullable ? ", or null" : ""}`;
}

/** The example call, as a script would make it with curl. */
export function curlOf(method: string, path: string, op: Operation): string {
  const query = (op.parameters ?? [])
    .filter((p) => p.in === "query" && p.required)
    .map((p) => {
      const s = p.schema ?? {};
      const value = Array.isArray(s.enum) ? s.enum[0] : "default" in s ? s.default : "1";
      return `${p.name}=${encodeURIComponent(String(value))}`;
    });
  const filled = path.replace(/\{(\w+)\}/g, (_m, name: string) => {
    const p = op.parameters?.find((x) => x.in === "path" && x.name === name);
    const choices = p?.schema?.enum;
    return Array.isArray(choices) ? String(choices[0]) : SAMPLE_ID;
  });
  const url = `${INSTANCE}/api/v1${filled}${query.length ? `?${query.join("&")}` : ""}`;
  const lines = [
    `curl${method === "GET" ? "" : ` -X ${method}`} "${url}"`,
    `  -H "Authorization: Bearer $HEKATE_TOKEN"`,
  ];
  const json = op.requestBody?.content["application/json"];
  if (json) {
    lines.push(`  -H "Content-Type: application/json"`);
    lines.push(`  -d '${JSON.stringify(json.example ?? {}).replaceAll("'", "'\\''")}'`);
  } else if (op.requestBody) {
    const [type] = Object.keys(op.requestBody.content);
    for (const header of (op.parameters ?? []).filter((p) => p.in === "header"))
      lines.push(`  -H "${header.name}: …"`);
    lines.push(`  -H "Content-Type: ${type}"`, `  --data-binary @file`);
  }
  const produced = Object.values(op.responses).find((r) => r.content)?.content ?? {};
  if (Object.keys(produced).some((t) => t !== "application/json")) lines.push("  -o answer");
  return lines.join(" \\\n");
}

function operationSection(method: string, path: string, op: Operation): string {
  const [success] = Object.entries(op.responses).filter(([s]) => s.startsWith("2"));
  const status = success?.[0] ?? "200";
  const description = (op.description ?? "").replace(/\n*Needs the `[^`]+` scope\.$/, "").trim();
  const out = [
    `## ${op.summary}`,
    "",
    `\`${method} /api/v1${path}\` · scope \`${op["x-hekate-scope"]}\` · answers \`${status}\``,
    "",
  ];
  if (description) out.push(description, "");
  const params = op.parameters ?? [];
  if (params.length) {
    out.push("| Parameter | In | Required | Type |", "| --- | --- | --- | --- |");
    for (const p of params)
      out.push(
        `| \`${p.name}\` | ${p.in} | ${p.required ? "yes" : "no"} | ${cell(p.description ? `${typeLabel(p.schema)}. ${p.description}` : typeLabel(p.schema))} |`,
      );
    out.push("");
  }
  const json = op.requestBody?.content["application/json"];
  if (json?.schema) {
    const props = (json.schema.properties ?? {}) as Record<string, Schema>;
    const required = new Set((json.schema.required ?? []) as string[]);
    if (Object.keys(props).length) {
      out.push("| Field | Required | Type |", "| --- | --- | --- |");
      for (const [name, s] of Object.entries(props))
        out.push(`| \`${name}\` | ${required.has(name) ? "yes" : "no"} | ${cell(typeLabel(s))} |`);
      out.push("");
    }
  } else if (op.requestBody) {
    out.push(
      `The body: ${op.requestBody.description ?? Object.keys(op.requestBody.content).join(", ")}`,
      "",
    );
  }
  out.push("```sh", curlOf(method, path, op), "```", "");
  const answer = success?.[1];
  const example = answer?.content?.["application/json"]?.example;
  if (example !== undefined)
    out.push(
      `It answers \`${status}\`:`,
      "",
      "```json",
      JSON.stringify(example, null, 2),
      "```",
      "",
    );
  else if (answer?.content && !answer.content["application/json"])
    out.push(
      `It answers \`${status}\` with ${Object.keys(answer.content)
        .map((t) => `\`${t}\``)
        .join(" or ")}.`,
      "",
    );
  return out.join("\n");
}

/** Every group's page, in the document's order. */
export function apiReferencePages(doc: OpenApi): ReferencePage[] {
  return doc.tags.map((tag, i) => {
    const sections: string[] = [];
    for (const [path, item] of Object.entries(doc.paths))
      for (const [method, op] of Object.entries(item))
        if (op.tags.includes(tag.name))
          sections.push(operationSection(method.toUpperCase(), path, op));
    return {
      slug: slugOf(tag.name),
      title: tag.name,
      description: tag.description,
      order: i + 1,
      body: [
        `${tag.description} Each call goes to your instance's \`/api/v1\` with an API token; the [API guide](../../../use/api/) covers authentication, versions, errors and limits.`,
        "",
        ...sections,
      ].join("\n"),
    };
  });
}

/** A page as Starlight reads it. */
export const pageText = (page: ReferencePage) =>
  `---\ntitle: ${JSON.stringify(page.title)}\ndescription: ${JSON.stringify(page.description)}\nsidebar:\n  order: ${page.order}\n---\n\n<!-- Written from docs/openapi.json at build time; run pnpm --filter @hekate/server api:reference to change it. -->\n\n${page.body}`;
