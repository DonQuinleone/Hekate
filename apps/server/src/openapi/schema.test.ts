import { createApiTokenInput } from "@hekate/shared";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { exampleOf, jsonSchemaOf, openapiPath, samplePath, successStatus } from "./schema.ts";
import { invalidRequest } from "./validator.ts";

describe("the OpenAPI document's pieces (#197)", () => {
  it("writes a route's path as OpenAPI does, with its parameters", () => {
    expect(openapiPath("/files/:id/comments/:commentId/attachments")).toEqual({
      path: "/files/{id}/comments/{commentId}/attachments",
      parameters: [
        { name: "id", choices: null },
        { name: "commentId", choices: null },
      ],
    });
    expect(openapiPath("/projects/:id/patch/:format{pdf|xlsx}")).toEqual({
      path: "/projects/{id}/patch/{format}",
      parameters: [
        { name: "id", choices: null },
        { name: "format", choices: ["pdf", "xlsx"] },
      ],
    });
    expect(samplePath("/projects/:id/patch/:format{pdf|xlsx}")).toBe("/projects/x/patch/pdf");
  });

  it("reads a schema's input side, without zod's noise", () => {
    expect(jsonSchemaOf(createApiTokenInput)).toEqual({
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 80 },
        scopes: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: {
            type: "string",
            enum: [
              "files:read",
              "files:write",
              "reviews:read",
              "reviews:write",
              "comments",
              "downloads",
              "workflows",
              "org:read",
            ],
          },
        },
        expiresInDays: { anyOf: [{ type: "number", enum: [30, 90, 365] }, { type: "null" }] },
      },
      required: ["name", "scopes", "expiresInDays"],
      additionalProperties: false,
    });
    const id = jsonSchemaOf(z.object({ id: z.uuid(), n: z.int() }));
    expect(id.properties).toEqual({
      id: { type: "string", format: "uuid" },
      n: { type: "integer" },
    });
  });

  it("makes an example a route would take, from its schema", () => {
    const schema = jsonSchemaOf(
      z.object({
        name: z.string().min(1).max(4),
        projectId: z.uuid(),
        at: z.iso.datetime(),
        kind: z.enum(["approval", "feedback"]),
        count: z.int().min(3),
        tags: z.array(z.string()).min(2),
        note: z.string().optional(),
      }),
    );
    const example = exampleOf(schema);
    expect(example).toEqual({
      name: "Fina",
      projectId: "01929b8e-5c1a-7d3e-9f40-2b6c8d1e4a57",
      at: "2026-10-23T09:30:00.000Z",
      kind: "approval",
      count: 3,
      tags: ["Masters", "Masters"],
    });
    // With nothing required, the first field shows the least a call sends.
    expect(exampleOf(jsonSchemaOf(z.object({ resolved: z.boolean().optional() })))).toEqual({
      resolved: true,
    });
  });

  it("reads the status a handler answers with from its source", () => {
    expect(successStatus("return c.json({ folder }, 201);")).toBe(201);
    expect(successStatus("return c.json(\n  { folder },\n  201,\n);")).toBe(201);
    expect(successStatus("return c.json({ file }, created ? 201 : 200);")).toBe(201);
    expect(successStatus("return c.json({ queued }, 202);")).toBe(202);
    expect(successStatus("return c.body(null, 204);")).toBe(204);
    expect(successStatus("return c.json({ project });")).toBe(200);
  });

  it("says what was wrong with a request in the API's error shape", () => {
    const parsed = z.object({ name: z.string().min(1, "Give it a name") }).safeParse({ name: "" });
    expect(parsed.success).toBe(false);
    expect(invalidRequest(parsed.error?.issues ?? [])).toEqual({
      error: {
        code: "invalid_request",
        message: "name: Give it a name",
        issues: [{ path: "name", message: "Give it a name" }],
      },
    });
  });
});
