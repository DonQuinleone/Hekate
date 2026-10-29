import { readFileSync } from "node:fs";
import { join } from "node:path";
import { apiErrorBody, apiErrorCodes, apiScopes, scopeFor } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import { breakingChanges } from "./compat.ts";
import { apiTags, operationKey, publicRoutes, requestExampleOf, tagOf } from "./document.ts";
import { apiOperations } from "./operations.ts";
import { referenceApi, referenceDocument } from "./reference.ts";
import { jsonSchemaOf, openapiPath, samplePath } from "./schema.ts";

type Operation = {
  operationId: string;
  tags: string[];
  summary: string;
  security: Record<string, string[]>[];
  "x-hekate-scope": string;
  parameters?: { name: string; in: string; required: boolean; schema: unknown }[];
  requestBody?: { content: Record<string, { schema?: unknown; example?: unknown }> };
  responses: Record<string, unknown>;
};

const doc = referenceDocument();
const operations = Object.entries(doc.paths).flatMap(([path, item]) =>
  Object.entries(item).map(([method, op]) => ({
    path,
    method: method.toUpperCase(),
    op: op as Operation,
  })),
);
const operationAt = (method: string, path: string) =>
  (doc.paths[path] as Record<string, Operation> | undefined)?.[method.toLowerCase()];

describe("the public API's OpenAPI document (#197)", () => {
  // The routes as the router holds them, in an app built as the document's is.
  const listed = publicRoutes(referenceApi());

  it("lists every route a token may reach, with the scope it needs, and nothing else", () => {
    expect(listed.length).toBeGreaterThan(150);
    for (const route of listed) {
      const op = operationAt(route.method, route.path);
      expect(op, `${route.method} ${route.path}`).toBeDefined();
      expect(op?.["x-hekate-scope"]).toBe(route.scope);
      expect(op?.security).toEqual([{ token: [route.scope] }]);
    }
    expect(operations).toHaveLength(listed.length);
    // Each operation is one a token may make, and needs the scope it names.
    for (const { path, method, op } of operations) {
      const sample = `/api${samplePath(path.replace(/\{(\w+)\}/g, ":$1"))}`;
      expect(scopeFor(method, sample), `${method} ${path}`).toBe(op["x-hekate-scope"]);
      expect(apiScopes).toContain(op["x-hekate-scope"]);
    }
    // Never a call no token may make: playback, accounts, settings, tokens, the instance.
    const paths = Object.keys(doc.paths);
    for (const closed of [/playback/, /^\/me\b/, /tokens/, /^\/instance/, /^\/auth/, /\/view$/])
      expect(paths.filter((p) => closed.test(p))).toEqual([]);
  });

  it("has words for every operation, and none for an operation that is not there", () => {
    const keys = new Set(listed.map((r) => operationKey(r.method, r.path)));
    expect(Object.keys(apiOperations).filter((k) => !keys.has(k))).toEqual([]);
    expect([...keys].filter((k) => !apiOperations[k])).toEqual([]);
    for (const { op } of operations) {
      expect(op.summary).not.toMatch(/^(GET|POST|PUT|PATCH|DELETE) /);
      expect(op.summary).not.toMatch(/—/);
    }
  });

  it("describes each body, query and path as the route's zod schemas take them", () => {
    for (const route of listed) {
      const op = operationAt(route.method, route.path) as Operation;
      const where = `${route.method} ${route.path}`;
      if (route.validators.json)
        expect(op.requestBody?.content["application/json"]?.schema, where).toEqual(
          jsonSchemaOf(route.validators.json),
        );
      else expect(op.requestBody?.content["application/json"], where).toBeUndefined();
      const inPath = (op.parameters ?? []).filter((p) => p.in === "path").map((p) => p.name);
      expect(inPath, where).toEqual(openapiPath(route.route).parameters.map((p) => p.name));
      if (route.validators.param) {
        const declared = jsonSchemaOf(route.validators.param).properties as Record<string, unknown>;
        for (const p of (op.parameters ?? []).filter((x) => x.in === "path"))
          if (declared[p.name]) expect(p.schema, `${where} ${p.name}`).toEqual(declared[p.name]);
      }
      const query = route.validators.query ? jsonSchemaOf(route.validators.query) : null;
      const inQuery = (op.parameters ?? []).filter((p) => p.in === "query");
      expect(inQuery.map((p) => p.name).sort(), where).toEqual(
        Object.keys((query?.properties ?? {}) as object).sort(),
      );
      for (const p of inQuery)
        expect(p.required, `${where} ${p.name}`).toBe(
          ((query?.required ?? []) as string[]).includes(p.name),
        );
    }
  });

  it("gives every body an example its route takes", () => {
    const refused: string[] = [];
    for (const route of listed) {
      if (!route.validators.json) continue;
      const op = operationAt(route.method, route.path) as Operation;
      const example = op.requestBody?.content["application/json"]?.example;
      expect(example, `${route.method} ${route.path}`).toBeDefined();
      expect(example).toEqual(
        requestExampleOf(route, apiOperations[operationKey(route.method, route.path)]),
      );
      const parsed = route.validators.json.safeParse(example);
      if (!parsed.success)
        refused.push(
          `${route.method} ${route.path}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`,
        );
    }
    expect(refused).toEqual([]);
  });

  it("answers every refusal in the error shape, with the codes a script acts on", () => {
    expect(doc.components.schemas.Error).toEqual(jsonSchemaOf(apiErrorBody));
    for (const response of Object.values(doc.components.responses)) {
      const example = response.content["application/json"].example;
      const parsed = apiErrorBody.parse(example);
      expect(parsed).toEqual(example);
      expect(Object.keys(apiErrorCodes)).toContain(parsed.error.code);
    }
    for (const { path, op } of operations) {
      expect(op.responses["401"]).toEqual({ $ref: "#/components/responses/Unauthorised" });
      expect(op.responses["403"]).toEqual({ $ref: "#/components/responses/Forbidden" });
      expect(op.responses["429"]).toEqual({ $ref: "#/components/responses/RateLimited" });
      expect(op.responses["500"]).toEqual({ $ref: "#/components/responses/Failure" });
      if (path.includes("{"))
        expect(op.responses["404"]).toEqual({ $ref: "#/components/responses/NotFound" });
      expect(Object.keys(op.responses).filter((s) => s.startsWith("2"))).toHaveLength(1);
    }
  });

  it("holds together as OpenAPI 3.1: references resolve, ids are unique, tags are listed", () => {
    expect(doc.openapi).toBe("3.1.0");
    const ids = operations.map((o) => o.op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    const tags = new Set(apiTags.map(([name]) => name));
    for (const { op } of operations) for (const t of op.tags) expect(tags).toContain(t);
    // Every tag is used.
    for (const t of tags)
      expect(
        operations.some((o) => o.op.tags.includes(t)),
        t,
      ).toBe(true);
    const text = JSON.stringify(doc);
    for (const [, ref] of text.matchAll(/"\$ref":"#\/([^"]+)"/g)) {
      let at: unknown = doc;
      for (const part of (ref ?? "").split("/")) at = (at as Record<string, unknown>)?.[part];
      expect(at, ref).toBeDefined();
    }
    // British, and no em-dashes, in what people read.
    expect(text).not.toMatch(/—/);
    expect(text).not.toMatch(/\b(organization|authorization screen|color)\b/i);
  });

  it("groups operations by what they are about", () => {
    expect(tagOf("/projects/{id}/folders")).toBe("Folders");
    expect(tagOf("/files/{id}/comments/export")).toBe("Comments");
    expect(tagOf("/files/{id}/downloads")).toBe("Downloads");
    expect(tagOf("/reviews/{id}/decisions")).toBe("Reviews");
    expect(tagOf("/tracks/{id}/versions")).toBe("Versions and variants");
    expect(tagOf("/tracks/{id}")).toBe("Tracks");
    expect(tagOf("/files/{id}/tags")).toBe("Files");
    expect(tagOf("/projects/{id}")).toBe("Projects");
  });

  it("keeps docs/openapi.json in step with the routes", () => {
    const committed = JSON.parse(
      readFileSync(join(import.meta.dirname, "../../../../docs/openapi.json"), "utf8"),
    );
    // Run `pnpm --filter @hekate/server api:reference` after changing a public route.
    expect(committed).toEqual(JSON.parse(JSON.stringify(doc)));
    expect(breakingChanges(committed, doc)).toEqual([]);
  });
});
