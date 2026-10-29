import { describe, expect, it } from "vitest";
import {
  categoryInput,
  deferChoices,
  deferralAfter,
  triageInput,
  triageQueue,
} from "./categories.ts";

describe("categories", () => {
  it("asks a deferring category for its stage, and keeps one only there", () => {
    expect(categoryInput.safeParse({ name: "Noise", handling: "deferred" }).success).toBe(false);
    expect(
      categoryInput.parse({ name: "Edit", handling: "normal", stage: "Noise reduction" }).stage,
    ).toBeNull();
  });

  it("defers by the category unless the triage says otherwise", () => {
    const noise = { handling: "deferred" as const, stage: "Noise reduction" };
    const edit = { handling: "normal" as const, stage: null };
    expect(deferralAfter(null, { categoryId: "c" }, noise)).toBe("Noise reduction");
    expect(deferralAfter("Noise reduction", { categoryId: "c" }, edit)).toBeNull();
    expect(deferralAfter(null, { categoryId: "c", deferredTo: null }, noise)).toBeNull();
    expect(deferralAfter("Mastering", {}, null)).toBe("Mastering");
    expect(deferralAfter(null, { deferredTo: "Mastering" }, null)).toBe("Mastering");
  });

  it("needs something to change", () => {
    expect(
      triageInput.safeParse({ commentIds: ["0190a6f0-0000-7000-8000-00000000000a"] }).success,
    ).toBe(false);
  });

  it("queues what is left to triage in playing order, the whole file last", () => {
    const t = (id: string, start: number | null, more = {}) => ({
      id,
      anchor: start === null ? null : { kind: "time" as const, start, end: start },
      resolved: false,
      deferredTo: null,
      information: false,
      ...more,
    });
    expect(
      triageQueue([
        t("whole", null),
        t("late", 30),
        t("early", 2),
        t("done", 1, { resolved: true }),
        t("later", 3, { deferredTo: "Noise reduction" }),
        t("note", 4, { information: true }),
      ]).map((x) => x.id),
    ).toEqual(["early", "late", "whole"]);
  });
});

describe("deferChoices", () => {
  const categories = [
    { name: "Noise", stage: "Noise reduction" },
    { name: "Edit", stage: null },
    { name: "Print", stage: "Mastering" },
  ];
  const stages = {
    trackId: "t1",
    workflows: [
      {
        id: "w1",
        name: "Album review",
        stages: [
          { nodeId: "notes", name: "Soloists' notes", current: false },
          { nodeId: "edit", name: "Engineer edits", current: true },
        ],
      },
      { id: "w2", name: "Mastering", stages: [{ nodeId: "m", name: "Mastering", current: false }] },
      { id: "w3", name: "Empty", stages: [] },
    ],
  };

  it("lists each workflow's stages, then the stages categories name that no workflow has", () => {
    expect(deferChoices(stages, categories, null)).toEqual([
      {
        label: "Album review",
        stages: [
          { name: "Soloists' notes", current: false, note: null },
          { name: "Engineer edits", current: true, note: null },
        ],
      },
      { label: "Mastering", stages: [{ name: "Mastering", current: false, note: null }] },
      {
        label: "Named by a category",
        stages: [{ name: "Noise reduction", current: false, note: "Noise category" }],
      },
    ]);
  });

  it("keeps the stage a thread already waits for when nothing names it", () => {
    expect(deferChoices(undefined, [], "Old stage")).toEqual([
      {
        label: "Deferred now",
        stages: [{ name: "Old stage", current: false, note: "No workflow has this stage" }],
      },
    ]);
    expect(deferChoices(undefined, categories, "noise reduction")).toEqual([
      {
        label: "Named by a category",
        stages: [
          { name: "Noise reduction", current: false, note: "Noise category" },
          { name: "Mastering", current: false, note: "Print category" },
        ],
      },
    ]);
  });

  it("offers nothing when no workflow runs and no category names a stage", () => {
    expect(
      deferChoices({ trackId: null, workflows: [] }, [{ name: "Edit", stage: null }], null),
    ).toEqual([]);
  });
});
