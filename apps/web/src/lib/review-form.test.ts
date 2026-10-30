import { describe, expect, it } from "vitest";
import {
  addToStep,
  dropFromSteps,
  dueDateOf,
  itemsFromReview,
  mergeSteps,
  moveToStep,
  removeStep,
  renameStep,
  stepsFromReview,
} from "./review-form";

const steps = [
  { name: "Producer", people: ["member:a"] },
  { name: "", people: ["group:g", "guest:x@example.test"] },
];

describe("the steps of a new review (#500)", () => {
  it("adds someone once, moves them between steps and drops them", () => {
    expect(addToStep(steps, 1, "member:b")[1]?.people).toEqual([
      "group:g",
      "guest:x@example.test",
      "member:b",
    ]);
    expect(addToStep(steps, 1, "member:a")).toBe(steps);
    expect(moveToStep(steps, "member:a", 1)).toEqual([
      { name: "Producer", people: [] },
      { name: "", people: ["group:g", "guest:x@example.test", "member:a"] },
    ]);
    expect(dropFromSteps(steps, "group:g")[1]?.people).toEqual(["guest:x@example.test"]);
    expect(renameStep(steps, 1, "Label")[1]?.name).toBe("Label");
  });
  it("folds a removed step into the one before it, and never drops the last", () => {
    expect(removeStep(steps, 1)).toEqual([
      { name: "Producer", people: ["member:a", "group:g", "guest:x@example.test"] },
    ]);
    expect(removeStep(steps, 0)).toEqual([
      { name: "", people: ["group:g", "guest:x@example.test", "member:a"] },
    ]);
    expect(removeStep([steps[0] as (typeof steps)[number]], 0)).toEqual([{ name: "", people: [] }]);
    expect(mergeSteps(steps)).toEqual([
      { name: "", people: ["member:a", "group:g", "guest:x@example.test"] },
    ]);
  });
});

describe("filling the page in from a review (#502)", () => {
  const reviewer = (
    step: number,
    rest: Partial<{
      userId: string | null;
      email: string | null;
      group: { id: string; name: string | null } | null;
    }>,
  ) => ({ step, userId: null, email: null, group: null, ...rest });
  it("keeps the steps and their names, a group once per step, and skips a guest it cannot name", () => {
    const out = stepsFromReview({
      order: "sequence",
      stepNames: ["Label", null],
      reviewers: [
        reviewer(0, { userId: "u1", email: "u1@example.test" }),
        reviewer(1, { userId: "u2", group: { id: "g1", name: "Soloists" } }),
        reviewer(1, { email: "m@example.test", group: { id: "g1", name: "Soloists" } }),
        reviewer(1, { email: "c@example.test" }),
        reviewer(1, { email: null }),
      ],
    });
    expect(out).toEqual([
      { name: "Label", people: ["member:u1"] },
      { name: "", people: ["group:g1", "guest:c@example.test"] },
    ]);
  });
  it("gives a parallel review one step, whatever positions it was sent with", () => {
    expect(
      stepsFromReview({
        order: "parallel",
        stepNames: null,
        reviewers: [reviewer(0, { userId: "u1" }), reviewer(1, { userId: "u2" })],
      }),
    ).toEqual([{ name: "", people: ["member:u1", "member:u2"] }]);
  });
  it("chooses the items again, a track at the version it asked about", () => {
    const items = itemsFromReview({
      items: [
        {
          id: "i1",
          kind: "track",
          trackId: "t1",
          name: "Rag",
          follows: "version",
          version: { id: "v3", number: 3, variants: [] },
          fileId: null,
          openComments: 0,
        },
        {
          id: "i2",
          kind: "track",
          trackId: "t2",
          name: "Waltz",
          follows: "latest",
          version: { id: "v9", number: 9, variants: [] },
          fileId: null,
          openComments: 0,
        },
        {
          id: "i3",
          kind: "file",
          fileId: "f1",
          name: "Score",
          fileKind: "document",
          openComments: 0,
        },
      ],
    });
    expect([...items]).toEqual([
      ["track:t1", { versionId: "v3" }],
      ["track:t2", { versionId: null }],
      ["file:f1", { versionId: null }],
    ]);
  });
  it("chooses a whole folder and the whole workspace again, each once", () => {
    const scope = (id: string, kind: "folder" | "workspace", folderId: string | null) => ({
      id,
      kind,
      folderId,
      name: kind,
      fileId: null,
      covers: [],
      openComments: 0,
    });
    const items = itemsFromReview({
      items: [scope("i1", "folder", "d1"), scope("i2", "folder", "d2")],
    });
    expect([...items.keys()]).toEqual(["folder:d1", "folder:d2"]);
    expect([...itemsFromReview({ items: [scope("i3", "workspace", null)] }).keys()]).toEqual([
      "workspace",
    ]);
  });
  it("reads a due instant as the date it falls on here", () => {
    expect(dueDateOf(null)).toBe("");
    const local = new Date(2026, 10, 4, 17, 0, 0).toISOString();
    expect(dueDateOf(local)).toBe("2026-11-04");
  });
});
