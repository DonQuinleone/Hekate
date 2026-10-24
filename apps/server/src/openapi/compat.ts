import type { JsonSchema } from "./schema.ts";

/**
 * What a new OpenAPI document breaks that the last one promised (decision 224). Within a
 * version, the API only grows: an operation, a parameter or a field may be added, a field made
 * optional, a type widened. This lists everything else, so `api:reference` refuses to write a
 * document that would break a script written against the one before, unless told the change is
 * meant (which then needs a new version).
 */

type Doc = { paths?: Record<string, Record<string, unknown>> };
type Operation = {
  parameters?: JsonSchema[];
  requestBody?: { content?: Record<string, { schema?: JsonSchema }> };
  responses?: Record<string, { content?: Record<string, unknown> }>;
  "x-hekate-scope"?: string;
};

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

const typesOf = (schema: JsonSchema): Set<string> | null => {
  if (typeof schema.type === "string") return new Set([schema.type]);
  if (Array.isArray(schema.type)) return new Set(schema.type as string[]);
  return null;
};

const branchesOf = (schema: JsonSchema): JsonSchema[] | null =>
  Array.isArray(schema.anyOf)
    ? (schema.anyOf as JsonSchema[])
    : Array.isArray(schema.oneOf)
      ? (schema.oneOf as JsonSchema[])
      : null;

const num = (v: unknown) => (typeof v === "number" ? v : null);

/**
 * Where a request schema takes less than it did: what a client that sent something valid
 * before could now be refused for. `at` names the place, for the message.
 */
export function narrowed(before: JsonSchema, after: JsonSchema, at: string): string[] {
  const found: string[] = [];
  const was = typesOf(before);
  const is = typesOf(after);
  if (was && is) {
    for (const t of was)
      if (!is.has(t) && !(t === "integer" && is.has("number")))
        found.push(`${at}: no longer takes ${t}`);
  } else if (was && !is && branchesOf(after) === null && Object.keys(after).length > 0)
    found.push(`${at}: its type changed`);
  if (Array.isArray(before.enum) && Array.isArray(after.enum)) {
    const now = new Set(after.enum.map((v) => JSON.stringify(v)));
    for (const v of before.enum)
      if (!now.has(JSON.stringify(v))) found.push(`${at}: no longer takes ${JSON.stringify(v)}`);
  } else if (!Array.isArray(before.enum) && Array.isArray(after.enum))
    found.push(`${at}: now takes only some values`);
  if ("const" in before && "const" in after && before.const !== after.const)
    found.push(`${at}: takes another value`);
  const limits: [string, "lower" | "upper"][] = [
    ["minLength", "lower"],
    ["maxLength", "upper"],
    ["minimum", "lower"],
    ["maximum", "upper"],
    ["minItems", "lower"],
    ["maxItems", "upper"],
  ];
  for (const [key, side] of limits) {
    const b = num(before[key]);
    const a = num(after[key]);
    if (a === null) continue;
    if (b === null || (side === "lower" ? a > b : a < b)) found.push(`${at}: ${key} is now ${a}`);
  }
  // An object: each property it took, still taken as it was; nothing newly required.
  const props = (before.properties ?? {}) as Record<string, JsonSchema>;
  const nowProps = (after.properties ?? {}) as Record<string, JsonSchema>;
  const strict = after.additionalProperties === false;
  for (const [name, inner] of Object.entries(props)) {
    const next = nowProps[name];
    if (!next) {
      if (strict) found.push(`${at}.${name}: no longer taken`);
      continue;
    }
    found.push(...narrowed(inner, next, `${at}.${name}`));
  }
  const required = new Set(Array.isArray(before.required) ? (before.required as string[]) : []);
  for (const name of Array.isArray(after.required) ? (after.required as string[]) : [])
    if (!required.has(name)) found.push(`${at}.${name}: now required`);
  if (before.additionalProperties !== false && strict && before.type === "object")
    found.push(`${at}: no longer takes other properties`);
  if (before.items && after.items)
    found.push(...narrowed(before.items as JsonSchema, after.items as JsonSchema, `${at}[]`));
  // Alternatives: each one taken before must still be taken by one now, compared alike.
  const wasBranches = branchesOf(before);
  const isBranches = branchesOf(after);
  if (wasBranches && isBranches) {
    for (const [i, branch] of wasBranches.entries()) {
      const fits = isBranches.some((candidate) => narrowed(branch, candidate, at).length === 0);
      if (!fits) found.push(`${at}: alternative ${i + 1} is no longer taken`);
    }
  } else if (!wasBranches && isBranches && was) {
    const fits = isBranches.some((candidate) => narrowed(before, candidate, at).length === 0);
    if (!fits) found.push(`${at}: no longer taken as it was`);
  }
  return found;
}

const keyOf = (p: JsonSchema) => `${String(p.in)} ${String(p.name)}`;

/** Every way `after` breaks what `before` promised, each said in a line. */
export function breakingChanges(before: Doc, after: Doc): string[] {
  const found: string[] = [];
  for (const [path, item] of Object.entries(before.paths ?? {})) {
    for (const method of METHODS) {
      const was = item[method] as Operation | undefined;
      if (!was) continue;
      const name = `${method.toUpperCase()} ${path}`;
      const is = after.paths?.[path]?.[method] as Operation | undefined;
      if (!is) {
        found.push(`${name}: removed`);
        continue;
      }
      if (was["x-hekate-scope"] !== is["x-hekate-scope"])
        found.push(
          `${name}: needs ${is["x-hekate-scope"]} where it needed ${was["x-hekate-scope"]}`,
        );
      const params = new Map((was.parameters ?? []).map((p) => [keyOf(p), p]));
      const nowParams = new Map((is.parameters ?? []).map((p) => [keyOf(p), p]));
      for (const [key, p] of params) {
        const next = nowParams.get(key);
        if (!next) {
          found.push(`${name}: parameter ${key} removed`);
          continue;
        }
        found.push(
          ...narrowed(
            (p.schema ?? {}) as JsonSchema,
            (next.schema ?? {}) as JsonSchema,
            `${name}: parameter ${key}`,
          ),
        );
      }
      for (const [key, p] of nowParams)
        if (p.required === true && params.get(key)?.required !== true)
          found.push(`${name}: parameter ${key} now required`);
      const body = was.requestBody?.content ?? {};
      const nowBody = is.requestBody?.content ?? {};
      for (const [type, content] of Object.entries(body)) {
        const next = nowBody[type];
        if (!next) {
          found.push(`${name}: no longer takes ${type}`);
          continue;
        }
        found.push(...narrowed(content.schema ?? {}, next.schema ?? {}, `${name}: body`));
      }
      if (Object.keys(body).length === 0 && Object.keys(nowBody).length > 0 && is.requestBody)
        found.push(`${name}: now needs a body`);
      const success = (o: Operation) =>
        Object.keys(o.responses ?? {}).find((s) => s.startsWith("2"));
      const ok = success(was);
      const nowOk = success(is);
      if (ok !== nowOk) found.push(`${name}: answers ${nowOk} where it answered ${ok}`);
      else if (ok) {
        const types = Object.keys(was.responses?.[ok]?.content ?? {});
        const nowTypes = new Set(Object.keys(is.responses?.[ok]?.content ?? {}));
        for (const t of types) if (!nowTypes.has(t)) found.push(`${name}: no longer answers ${t}`);
      }
    }
  }
  return found;
}
