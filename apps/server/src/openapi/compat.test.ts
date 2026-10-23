import { describe, expect, it } from "vitest";
import { breakingChanges, narrowed } from "./compat.ts";

const op = (body: object, extra: object = {}) => ({
  "x-hekate-scope": "files:write",
  parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
  requestBody: { content: { "application/json": { schema: body } } },
  responses: { "201": { content: { "application/json": {} } } },
  ...extra,
});
const doc = (operation: object) => ({ paths: { "/projects/{id}/folders": { post: operation } } });

const folder = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1, maxLength: 120 },
    colour: { type: "string", enum: ["signal", "blue"] },
  },
  required: ["name"],
  additionalProperties: false,
};

describe("what a new API document breaks (decision 224)", () => {
  it("lets the API grow: new operations, optional fields, wider types", () => {
    const grown = {
      paths: {
        ...doc(
          op({
            ...folder,
            properties: {
              ...folder.properties,
              name: { type: "string", minLength: 1, maxLength: 200 },
              colour: { type: "string", enum: ["signal", "blue", "green"] },
              parentId: { type: ["string", "null"] },
            },
          }),
        ).paths,
        "/tags": { get: op({}) },
      },
    };
    expect(breakingChanges(doc(op(folder)), grown)).toEqual([]);
    expect(breakingChanges(doc(op(folder)), doc(op(folder)))).toEqual([]);
  });

  it("names each way a script written against the old one would be refused", () => {
    const before = doc(op(folder));
    expect(breakingChanges(before, { paths: {} })).toEqual([
      "POST /projects/{id}/folders: removed",
    ]);
    expect(breakingChanges(before, doc(op(folder, { "x-hekate-scope": "files:read" })))).toEqual([
      "POST /projects/{id}/folders: needs files:read where it needed files:write",
    ]);
    expect(breakingChanges(before, doc(op({ ...folder, required: ["name", "colour"] })))).toEqual([
      "POST /projects/{id}/folders: body.colour: now required",
    ]);
    expect(
      breakingChanges(
        before,
        doc(
          op({
            ...folder,
            properties: { ...folder.properties, colour: { type: "string", enum: ["signal"] } },
          }),
        ),
      ),
    ).toEqual(['POST /projects/{id}/folders: body.colour: no longer takes "blue"']);
    expect(
      breakingChanges(before, doc(op({ ...folder, properties: { name: folder.properties.name } }))),
    ).toEqual(["POST /projects/{id}/folders: body.colour: no longer taken"]);
    expect(
      breakingChanges(
        before,
        doc(op(folder, { responses: { "200": { content: { "application/json": {} } } } })),
      ),
    ).toEqual(["POST /projects/{id}/folders: answers 200 where it answered 201"]);
    expect(
      breakingChanges(
        before,
        doc(
          op(folder, {
            parameters: [
              ...op(folder).parameters,
              { name: "dryRun", in: "query", required: true, schema: { type: "boolean" } },
            ],
          }),
        ),
      ),
    ).toEqual(["POST /projects/{id}/folders: parameter query dryRun now required"]);
  });

  it("compares limits, types and alternatives", () => {
    expect(
      narrowed({ type: "string", maxLength: 120 }, { type: "string", maxLength: 60 }, "name"),
    ).toEqual(["name: maxLength is now 60"]);
    expect(narrowed({ type: "integer" }, { type: "number" }, "n")).toEqual([]);
    expect(narrowed({ type: ["string", "null"] }, { type: "string" }, "x")).toEqual([
      "x: no longer takes null",
    ]);
    const either = { anyOf: [{ type: "string" }, { type: "object", properties: {} }] };
    expect(narrowed(either, either, "item")).toEqual([]);
    expect(narrowed(either, { anyOf: [{ type: "string" }] }, "item")).toEqual([
      "item: alternative 2 is no longer taken",
    ]);
  });
});
