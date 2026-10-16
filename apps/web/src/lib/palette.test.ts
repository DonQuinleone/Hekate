import { describe, expect, it } from "vitest";
import { type Hit, matches, readRecent, rememberRecent, score } from "./palette";

const hit = (label: string, group: Hit["group"] = "Files"): Hit => ({
  id: label,
  group,
  label,
  icon: "file",
  link: `/files/${label}`,
});

describe("score", () => {
  it("ranks a prefix over a word start over a mention over scattered letters", () => {
    expect(score("map", "Maple Leaf Rag")).toBe(4);
    expect(score("leaf", "Maple Leaf Rag")).toBe(3);
    expect(score("af r", "Maple Leaf Rag")).toBe(2);
    expect(score("mlr", "Maple Leaf Rag")).toBe(1);
    expect(score("ml", "Maple Leaf Rag")).toBe(0);
  });
});

describe("matches", () => {
  it("keeps the best first and drops what does not answer", () => {
    const hits = [hit("Inbox"), hit("Projects"), hit("Workspace settings")];
    expect(matches("set", hits).map((h) => h.label)).toEqual(["Workspace settings"]);
    expect(matches("", hits).map((h) => h.label)).toEqual([
      "Inbox",
      "Projects",
      "Workspace settings",
    ]);
  });
});

describe("recent", () => {
  const memory = () => {
    const data = new Map<string, string>();
    return {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    };
  };

  it("keeps the latest places once each, and never actions or pages", () => {
    const store = memory();
    rememberRecent(hit("a"), store);
    rememberRecent(hit("b"), store);
    rememberRecent(hit("a"), store);
    rememberRecent(hit("Inbox", "Jump to"), store);
    expect(readRecent(store).map((h) => [h.label, h.group])).toEqual([
      ["a", "Recent"],
      ["b", "Recent"],
    ]);
  });

  it("survives storage that is broken or refuses", () => {
    expect(readRecent({ getItem: () => "{not json" })).toEqual([]);
    expect(
      readRecent({
        getItem: () => JSON.stringify([{ id: "x", label: "x", link: "https://elsewhere" }]),
      }),
    ).toEqual([]);
    expect(() =>
      rememberRecent(hit("a"), {
        getItem: () => null,
        setItem: () => {
          throw new Error("quota");
        },
      }),
    ).not.toThrow();
  });
});
