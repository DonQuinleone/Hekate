import { describe, expect, it } from "vitest";
import { inspectFileParam, inspectSessionParam, inspectTarget } from "./inspect.ts";

const file = "0199e3a6-8f1c-7a02-8e44-2b7d0c9f3a15";
const project = "0199e3a1-7c2f-7b40-9a51-4f2d8c1e09aa";

describe("what to inspect", () => {
  it("takes a file by its id or its link", () => {
    expect(inspectTarget("file", ` ${file.toUpperCase()} `)).toBe(file);
    expect(
      inspectTarget("file", `https://review.example/projects/${project}/files/${file}?t=12`),
    ).toBe(file);
    // A link with the project last still names the file after /files/.
    expect(inspectTarget("file", `/files/${file}#project=${project}`)).toBe(file);
    expect(inspectTarget("file", "Solace - Score.pdf")).toBeNull();
    expect(inspectFileParam.safeParse({ id: file }).success).toBe(true);
  });

  it("takes a review by its id, its page or the inbox item", () => {
    expect(inspectTarget("review", `https://review.example/reviews/${file}`)).toBe(file);
    expect(inspectTarget("review", `https://review.example/inbox?item=${file}`)).toBe(file);
    expect(inspectTarget("review", file)).toBe(file);
  });

  it("takes a member's sign-in id or a guest's session", () => {
    expect(inspectTarget("session", "Q2xLzE9Vf0mT3xYa8bPq1cR7dS5eW4uH")).toBe(
      "Q2xLzE9Vf0mT3xYa8bPq1cR7dS5eW4uH",
    );
    expect(inspectTarget("session", file.toUpperCase())).toBe(file);
    expect(inspectTarget("session", "not a session")).toBeNull();
    expect(inspectTarget("session", "x".repeat(65))).toBeNull();
    expect(inspectSessionParam.safeParse({ id: "a/b" }).success).toBe(false);
  });

  it("refuses what is empty or far too long", () => {
    expect(inspectTarget("file", "   ")).toBeNull();
    expect(inspectTarget("file", `${file}${" ".repeat(2000)}x`)).toBeNull();
  });
});
