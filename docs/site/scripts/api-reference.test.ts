import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  apiReferencePages,
  curlOf,
  type OpenApi,
  pageText,
  slugOf,
  typeLabel,
} from "./api-reference.ts";

const doc = JSON.parse(
  readFileSync(join(import.meta.dirname, "../../openapi.json"), "utf8"),
) as OpenApi;

describe("the API reference pages (#197)", () => {
  const pages = apiReferencePages(doc);

  it("writes a page for each group, and every operation on exactly one", () => {
    expect(pages.map((p) => p.title)).toEqual(doc.tags.map((t) => t.name));
    const operations = Object.entries(doc.paths).flatMap(([path, item]) =>
      Object.keys(item).map((method) => `\`${method.toUpperCase()} /api/v1${path}\``),
    );
    for (const operation of operations)
      expect(
        pages.filter((p) => p.body.includes(`${operation} ·`)),
        operation,
      ).toHaveLength(1);
    expect(pages.find((p) => p.slug === "versions-and-variants")?.order).toBe(5);
  });

  it("shows each call with its scope, an example to copy, and its answer where there is one", () => {
    const folders = pages.find((p) => p.slug === "folders")?.body ?? "";
    expect(folders).toContain("## Make a folder");
    expect(folders).toContain(
      "`POST /api/v1/projects/{id}/folders` · scope `files:write` · answers `201`",
    );
    expect(folders).toContain(`-d '{"name":"Masters"}'`);
    expect(folders).toContain('"parentId": null');
    const text = pageText(pages[0] ?? { slug: "", title: "", description: "", order: 1, body: "" });
    expect(text).toMatch(/^---\ntitle: "Projects"\n/);
    expect(text).toContain("sidebar:\n  order: 1");
    // British, and no em-dashes.
    for (const page of pages) expect(page.body).not.toMatch(/—/);
  });

  it("says a field's type in a few words", () => {
    expect(typeLabel({ type: "string", format: "uuid" })).toBe("string (uuid)");
    expect(typeLabel({ type: ["string", "null"], minLength: 1, maxLength: 80 })).toBe(
      "string, 1 to 80 characters, or null",
    );
    expect(typeLabel({ type: "string", enum: ["approval", "feedback"] })).toBe(
      "one of `approval`, `feedback`",
    );
    expect(typeLabel({ type: "array", items: { type: "string", format: "uuid" } })).toBe(
      "array of string (uuid)",
    );
    expect(typeLabel({ anyOf: [{ type: "integer" }, { type: "null" }] })).toBe("integer, or null");
    expect(slugOf("Tags and categories")).toBe("tags-and-categories");
  });

  it("makes a curl call that sends the token, the body and the path's samples", () => {
    const op = doc.paths["/projects/{id}/patch/{format}"]?.get;
    expect(op).toBeDefined();
    if (op)
      expect(curlOf("GET", "/projects/{id}/patch/{format}", op)).toBe(
        'curl "https://review.endlesshall.example/api/v1/projects/01929b8e-5c1a-7d3e-9f40-2b6c8d1e4a57/patch/pdf" \\\n  -H "Authorization: Bearer $HEKATE_TOKEN" \\\n  -o answer',
      );
    const chunk = doc.paths["/uploads/{id}/chunks/{index}"]?.put;
    if (chunk)
      expect(curlOf("PUT", "/uploads/{id}/chunks/{index}", chunk)).toContain("--data-binary @file");
  });
});
