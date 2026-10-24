import { z } from "zod";

/**
 * Pure pieces of the OpenAPI document (#197): JSON Schema from the routes' zod schemas, the
 * path as OpenAPI writes it, a success status read from a handler, and an example made from a
 * schema where no hand-written one is given.
 */

/** A JSON Schema, as zod writes one and OpenAPI 3.1 reads it. */
export type JsonSchema = { [key: string]: unknown };

const SAFE = Number.MAX_SAFE_INTEGER;

/** Drops what only adds noise: zod's long patterns behind a named format, and the safe-integer bounds. */
function tidy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(tidy);
  if (!value || typeof value !== "object") return value;
  const out: JsonSchema = {};
  const schema = value as JsonSchema;
  for (const [key, inner] of Object.entries(schema)) {
    if (key === "$schema") continue;
    if (key === "pattern" && typeof schema.format === "string") continue;
    if ((key === "maximum" && inner === SAFE) || (key === "minimum" && inner === -SAFE)) continue;
    out[key] = tidy(inner);
  }
  // `anyOf` of one branch, or of branches that are each one constant of one type, reads simpler.
  const anyOf = out.anyOf;
  if (Array.isArray(anyOf)) {
    const flat = (anyOf as JsonSchema[]).flatMap((b) =>
      Array.isArray(b.anyOf) && Object.keys(b).length === 1 ? (b.anyOf as JsonSchema[]) : [b],
    );
    out.anyOf = flat;
    const consts = flat.filter((b) => "const" in b && Object.keys(b).length === 2);
    const types = new Set(consts.map((b) => b.type));
    if (consts.length === flat.length && types.size === 1 && flat.length > 1) {
      delete out.anyOf;
      out.type = [...types][0];
      out.enum = consts.map((b) => b.const);
    }
  }
  return out;
}

/** What a request must send, from its zod schema: the input side, before any transform. */
export const jsonSchemaOf = (schema: z.ZodType): JsonSchema =>
  tidy(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" })) as JsonSchema;

/** A path parameter as Hono writes it: `:id`, or `:format{pdf|xlsx}` with its choices. */
export interface PathParameter {
  name: string;
  /** The choices a `{a|b}` pattern allows, when it is that simple. */
  choices: string[] | null;
}

/** A Hono path as OpenAPI writes it (`/files/:id` is `/files/{id}`), with its parameters. */
export function openapiPath(path: string): { path: string; parameters: PathParameter[] } {
  const parameters: PathParameter[] = [];
  const written = path.replace(/:([A-Za-z0-9_]+)(\{([^}]*)\})?/g, (_m, name: string, _p, re) => {
    const choices = typeof re === "string" && /^[A-Za-z0-9_-]+(\|[A-Za-z0-9_-]+)*$/.test(re);
    parameters.push({ name, choices: choices ? (re as string).split("|") : null });
    return `{${name}}`;
  });
  return { path: written, parameters };
}

/** A path with a sample in each parameter, as `scopeFor` and the router read a real one. */
export const samplePath = (path: string) =>
  path.replace(/:([A-Za-z0-9_]+)(\{([^}]*)\})?/g, (_m, _n, _p, re) =>
    typeof re === "string" ? (re.split("|")[0] ?? "x") : "x",
  );

/**
 * The status a handler answers when it succeeds, read from its source: 201 where it makes
 * something, 202 where it queues work, 204 where it answers with nothing, else 200. A hand-written operation may say
 * otherwise.
 */
export function successStatus(source: string): 200 | 201 | 202 | 204 {
  if (/,\s*201\s*,?\s*\)|\?\s*201\s*:/.test(source)) return 201;
  if (/,\s*202\s*,?\s*\)/.test(source)) return 202;
  if (/\b204\b/.test(source) && !/\.json\(/.test(source)) return 204;
  return 200;
}

const samples: Record<string, unknown> = {
  uuid: "01929b8e-5c1a-7d3e-9f40-2b6c8d1e4a57",
  "date-time": "2026-10-23T09:30:00.000Z",
  date: "2026-10-23",
  time: "09:30:00",
  email: "tomas@endlesshall.example",
  uri: "https://review.endlesshall.example/",
  url: "https://review.endlesshall.example/",
};

/** Sample words for a string by its property's name, so an example reads like a real call. */
const named: [RegExp, string][] = [
  [/^email$/i, "tomas@endlesshall.example"],
  [/colou?r$/i, "#5b8def"],
  [/^(name|title)$/i, "Final mixes"],
  [/^(body|text|note|message|description)$/i, "The horns could come up a little at bar 12."],
  [/^(url|link|href)$/i, "https://review.endlesshall.example/"],
];

/**
 * An example value for a JSON Schema: its own example, default or constant first, then a sample
 * of its format or type. Objects get their required properties (or, with none required, their
 * first), so the example shows the least a call needs.
 */
export function exampleOf(schema: JsonSchema, name = "", depth = 0): unknown {
  if (depth > 8) return null;
  if (Array.isArray(schema.examples) && schema.examples.length > 0) return schema.examples[0];
  if ("default" in schema) return schema.default;
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches = schema[key];
    if (Array.isArray(branches)) {
      const branch = (branches as JsonSchema[]).find((b) => b.type !== "null") ?? branches[0];
      return branch ? exampleOf(branch as JsonSchema, name, depth + 1) : null;
    }
  }
  if (Array.isArray(schema.allOf) && schema.allOf[0])
    return exampleOf(schema.allOf[0] as JsonSchema, name, depth + 1);
  const type = Array.isArray(schema.type)
    ? (schema.type as string[]).find((t) => t !== "null")
    : schema.type;
  switch (type) {
    case "object": {
      const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
      const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
      const keys = required.length > 0 ? required : Object.keys(properties).slice(0, 1);
      return Object.fromEntries(
        keys
          .filter((k) => properties[k])
          .map((k) => [k, exampleOf(properties[k] as JsonSchema, k, depth + 1)]),
      );
    }
    case "array": {
      const items = (schema.items ?? {}) as JsonSchema;
      const count = Math.max(1, typeof schema.minItems === "number" ? schema.minItems : 1);
      return Array.from({ length: count }, () => exampleOf(items, name, depth + 1));
    }
    case "integer":
    case "number": {
      const min = typeof schema.minimum === "number" ? schema.minimum : null;
      const exclusive =
        typeof schema.exclusiveMinimum === "number" ? schema.exclusiveMinimum : null;
      return min ?? (exclusive === null ? 1 : exclusive + 1);
    }
    case "boolean":
      return true;
    case "string": {
      if (typeof schema.format === "string" && schema.format in samples)
        return samples[schema.format];
      const word = named.find(([pattern]) => pattern.test(name))?.[1] ?? "Masters";
      const max = typeof schema.maxLength === "number" ? schema.maxLength : null;
      return max !== null && word.length > max ? word.slice(0, max) : word;
    }
    case "null":
      return null;
    default:
      return null;
  }
}
