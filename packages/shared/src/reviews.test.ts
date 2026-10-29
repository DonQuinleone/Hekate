import { describe, expect, it } from "vitest";
import {
  activeReviewers,
  approvalsNeeded,
  createReviewInput,
  foldersBeneath,
  gateCounts,
  gateState,
  groupInput,
  mayCoverWorkspace,
  type ReviewDecision,
  type ReviewerFacts,
  type ReviewerState,
  reviewerState,
  reviewOutcome,
  reviewSteps,
  reviewTitleFor,
  shareGrant,
} from "./reviews.ts";

// Each reviewer its own step, in the order made, unless a test puts several on one.
let steps = 0;
const reviewer = (id: string, facts: Partial<ReviewerFacts> = {}): ReviewerFacts => ({
  id,
  step: steps++,
  submitted: false,
  decision: null,
  viewed: false,
  started: false,
  ...facts,
});
const approved = { submitted: true, decision: "approved" as const };
const changes = { submitted: true, decision: "changes_requested" as const };

describe("who acts", () => {
  it("lets an approval go on without those asked for no decision", () => {
    const people = [
      reviewer("observer", { observer: true }),
      reviewer("composer", approved),
      reviewer("soloist"),
    ];
    expect([...activeReviewers("sequence", people)]).toEqual(["soloist"]);
    expect(reviewerState("sequence", people, people[0] as ReviewerFacts)).toBe("observing");
    expect(reviewOutcome("approval", "all", people)).toBeNull();
    const done = [
      people[0] as ReviewerFacts,
      people[1] as ReviewerFacts,
      reviewer("soloist", approved),
    ];
    expect(reviewOutcome("approval", "all", done)).toBe("approved");
    // With nobody left to decide, nothing settles it.
    expect(reviewOutcome("approval", "all", [reviewer("x", { observer: true })])).toBeNull();
  });

  it("asks everyone at once, or one after another", () => {
    const people = [reviewer("composer", approved), reviewer("accompanist"), reviewer("soloist")];
    expect([...activeReviewers("parallel", people)]).toEqual(["accompanist", "soloist"]);
    expect([...activeReviewers("sequence", people)]).toEqual(["accompanist"]);
    expect(people.map((p) => reviewerState("sequence", people, p))).toEqual([
      "submitted",
      "invited",
      "waiting",
    ]);
  });

  it("asks a group's members together, and moves on once all of them have responded", () => {
    const people = [
      reviewer("producer", approved),
      reviewer("soprano", { step: 50 }),
      reviewer("tenor", { step: 50, ...approved }),
      reviewer("conductor", { step: 51 }),
    ];
    expect([...activeReviewers("sequence", people)]).toEqual(["soprano"]);
    expect(people.map((p) => reviewerState("sequence", people, p))).toEqual([
      "submitted",
      "invited",
      "submitted",
      "waiting",
    ]);
    const after = people.map((p) => (p.id === "soprano" ? { ...p, ...approved } : p));
    expect([...activeReviewers("sequence", after)]).toEqual(["conductor"]);
    expect([
      ...activeReviewers(
        "sequence",
        after.map((p) => ({ ...p, submitted: true })),
      ),
    ]).toEqual([]);
  });

  it("tracks viewing and starting", () => {
    const people = [
      reviewer("a", { viewed: true }),
      reviewer("b", { viewed: true, started: true }),
    ];
    expect(people.map((p) => reviewerState("parallel", people, p))).toEqual([
      "viewed",
      "in_progress",
    ]);
  });
});

describe("outcomes", () => {
  it("needs everyone to approve under the all rule", () => {
    expect(reviewOutcome("approval", "all", [reviewer("a", approved), reviewer("b")])).toBeNull();
    expect(
      reviewOutcome("approval", "all", [reviewer("a", approved), reviewer("b", approved)]),
    ).toBe("approved");
    expect(
      reviewOutcome("approval", "all", [reviewer("a", approved), reviewer("b", changes)]),
    ).toBe("changes_requested");
  });

  it("needs only one approval under the any rule, and waits on everyone otherwise", () => {
    expect(reviewOutcome("approval", "any", [reviewer("a", changes), reviewer("b")])).toBeNull();
    expect(
      reviewOutcome("approval", "any", [reviewer("a", changes), reviewer("b", approved)]),
    ).toBe("approved");
    expect(reviewOutcome("approval", "any", [reviewer("a", changes), reviewer("b", changes)])).toBe(
      "changes_requested",
    );
  });

  it("needs a share of approvals under the share rule, and fails once it cannot be reached", () => {
    const three = (a: Partial<ReviewerFacts>, b: Partial<ReviewerFacts>) => [
      reviewer("a", a),
      reviewer("b", b),
      reviewer("c"),
    ];
    // Two thirds of three is two.
    expect(reviewOutcome("approval", "share", three(approved, {}), 66)).toBeNull();
    expect(reviewOutcome("approval", "share", three(approved, approved), 66)).toBe("approved");
    expect(reviewOutcome("approval", "share", three(changes, changes), 66)).toBe(
      "changes_requested",
    );
    // Those only following are not counted.
    expect(
      reviewOutcome(
        "approval",
        "share",
        [reviewer("a", approved), reviewer("b", { observer: true })],
        100,
      ),
    ).toBe("approved");
  });

  it("rounds a share up to whole people, and never to nobody", () => {
    expect(approvalsNeeded(3, 66)).toBe(2);
    expect(approvalsNeeded(3, 67)).toBe(3);
    expect(approvalsNeeded(4, 50)).toBe(2);
    expect(approvalsNeeded(10, 1)).toBe(1);
    expect(approvalsNeeded(1, 100)).toBe(1);
  });

  it("completes feedback once everyone has submitted", () => {
    const done = { submitted: true };
    expect(reviewOutcome("feedback", null, [reviewer("a", done), reviewer("b")])).toBeNull();
    expect(reviewOutcome("feedback", null, [reviewer("a", done), reviewer("b", done)])).toBe(
      "submitted",
    );
  });

  it("never settles a share: it runs until it is stopped (#138)", () => {
    expect(reviewOutcome("share", null, [reviewer("a", { viewed: true })])).toBeNull();
  });
});

describe("review input", () => {
  const base = {
    title: "Mix approval",
    items: [{ trackId: "0190a6f0-0000-7000-8000-00000000000a" }],
    reviewers: ["composer"],
  };
  it("defaults approvals to everyone approving, and gives feedback no rule", () => {
    expect(createReviewInput.parse({ ...base, kind: "approval" }).rule).toBe("all");
    expect(createReviewInput.parse({ ...base, kind: "feedback", rule: "any" }).rule).toBeNull();
    expect(createReviewInput.parse({ ...base, kind: "feedback" }).order).toBe("parallel");
  });
  it("takes guests by email, case aside, and refuses asking them twice", () => {
    const guest = { name: "Mira Solberg", email: "Conductor@Example.test", label: "Conductor" };
    const parsed = createReviewInput.parse({
      ...base,
      kind: "feedback",
      reviewers: ["composer", guest],
    });
    expect(parsed.reviewers[1]).toEqual({ ...guest, email: "conductor@example.test" });
    expect(
      createReviewInput.safeParse({
        ...base,
        kind: "feedback",
        reviewers: [guest, { ...guest, email: "conductor@example.test" }],
      }).success,
    ).toBe(false);
  });
  it("takes steps of several people, and refuses anyone in two steps", () => {
    const parsed = createReviewInput.parse({
      ...base,
      kind: "approval",
      order: "sequence",
      reviewers: [["a", "b"], "c"],
    });
    expect(parsed.reviewers).toEqual([["a", "b"], "c"]);
    expect(
      createReviewInput.safeParse({ ...base, kind: "approval", reviewers: [["a", "b"], "a"] })
        .success,
    ).toBe(false);
    expect(
      createReviewInput.safeParse({ ...base, kind: "approval", reviewers: [[]] }).success,
    ).toBe(false);
  });
  it("needs a share with the share rule, and keeps it only there", () => {
    expect(createReviewInput.safeParse({ ...base, kind: "approval", rule: "share" }).success).toBe(
      false,
    );
    expect(
      createReviewInput.parse({ ...base, kind: "approval", rule: "share", share: 66 }).share,
    ).toBe(66);
    expect(createReviewInput.parse({ ...base, kind: "approval", share: 66 }).share).toBeNull();
  });
  it("gives a share no rule, order, due date or reminder (#138)", () => {
    const parsed = createReviewInput.parse({
      ...base,
      kind: "share",
      rule: "any",
      order: "sequence",
      dueAt: "2026-10-31T17:00:00Z",
    });
    expect(parsed).toMatchObject({
      rule: null,
      share: null,
      order: "parallel",
      dueAt: null,
      remind: false,
    });
    expect(
      shareGrant({ comment: true, decide: true, invite: true, download: "proxy" as const }),
    ).toEqual({ comment: false, decide: false, invite: false, download: "proxy" });
  });
  it("leaves the title to what is reviewed, and reminds by default", () => {
    const { title: _, ...untitled } = base;
    const parsed = createReviewInput.parse({ ...untitled, kind: "feedback" });
    expect(parsed.title).toBeUndefined();
    expect(parsed.remind).toBe(true);
    expect(reviewTitleFor(["Maple Leaf Rag"])).toBe("Maple Leaf Rag");
    expect(reviewTitleFor(["Maple Leaf Rag", "The Entertainer", "Solace"])).toBe(
      "Maple Leaf Rag and 2 more",
    );
  });
  it("refuses an empty review and asking someone twice", () => {
    expect(createReviewInput.safeParse({ ...base, kind: "approval", items: [] }).success).toBe(
      false,
    );
    expect(
      createReviewInput.safeParse({ ...base, kind: "approval", reviewers: ["a", "a"] }).success,
    ).toBe(false);
  });
});

describe("groups", () => {
  it("takes members and guests, each once", () => {
    const soloists = groupInput.parse({
      name: " Soloists ",
      members: ["u1", { name: "Ines Arlow", email: "Ines@Example.test", label: "Soprano" }],
    });
    expect(soloists.name).toBe("Soloists");
    expect(soloists.members[1]).toMatchObject({ email: "ines@example.test" });
    expect(groupInput.safeParse({ name: "Empty", members: [] }).success).toBe(false);
    expect(groupInput.safeParse({ name: "Twice", members: ["u1", "u1"] }).success).toBe(false);
  });

  it("can be asked in a review, once", () => {
    const base = {
      kind: "feedback",
      title: "Mix",
      items: [{ fileId: "0199e3a1-6c2b-7f00-8000-00000000000a" }],
    };
    const groupId = "0199e3a1-6c2b-7f00-8000-00000000000a";
    expect(createReviewInput.safeParse({ ...base, reviewers: [{ groupId }, "u1"] }).success).toBe(
      true,
    );
    expect(
      createReviewInput.safeParse({ ...base, reviewers: [{ groupId }, { groupId }] }).success,
    ).toBe(false);
  });
});

describe("review steps and the gate", () => {
  const r = (
    id: string,
    step: number,
    state: ReviewerState,
    decision: ReviewDecision | null = null,
  ) => ({
    id,
    step,
    state,
    decision,
  });

  it("draws a parallel review as one step", () => {
    const steps = reviewSteps("parallel", [r("a", 0, "submitted"), r("b", 1, "viewed")]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ responded: 1, state: "current" });
  });

  it("marks each step of a sequence done, current or ahead", () => {
    const steps = reviewSteps("sequence", [
      r("a", 0, "submitted"),
      r("b", 1, "invited"),
      r("c", 1, "observing"),
      r("d", 2, "waiting"),
    ]);
    expect(steps.map((s) => [s.step, s.state, s.responded])).toEqual([
      [0, "done", 1],
      [1, "current", 0],
      [2, "ahead", 0],
    ]);
    // Only following along does not hold a step up.
    expect(reviewSteps("sequence", [r("c", 0, "observing")])[0]?.state).toBe("done");
  });

  it("opens the gate on the outcome, and waits for every step before that", () => {
    const done = [{ state: "done" as const }];
    expect(gateState("completed", "approved", done)).toBe("done");
    expect(gateState("completed", "submitted", done)).toBe("done");
    expect(gateState("completed", "changes_requested", done)).toBe("failed");
    expect(gateState("open", null, done)).toBe("current");
    expect(gateState("open", null, [...done, { state: "current" }])).toBe("ahead");
    expect(gateState("cancelled", null, done)).toBe("ahead");
  });

  it("counts what the gate waits on, leaving out those who only follow", () => {
    const reviewers = [
      r("a", 0, "submitted", "approved"),
      r("b", 0, "submitted", "changes_requested"),
      r("c", 0, "viewed"),
      r("d", 0, "observing"),
    ];
    expect(gateCounts("approval", reviewers)).toEqual({
      total: 3,
      approved: 1,
      changes: 1,
      submitted: 2,
      toCome: 1,
    });
    expect(gateCounts("feedback", reviewers).toCome).toBe(1);
  });
});

describe("a review's scope (#501)", () => {
  const folders = [
    { id: "mixes", parentId: null },
    { id: "stems", parentId: "mixes" },
    { id: "day-2", parentId: "stems" },
    { id: "artwork", parentId: null },
  ];

  it("reaches a folder and every folder beneath it, and nothing beside", () => {
    expect([...foldersBeneath(folders, "mixes")].sort()).toEqual(["day-2", "mixes", "stems"]);
    expect([...foldersBeneath(folders, "stems")].sort()).toEqual(["day-2", "stems"]);
    expect([...foldersBeneath(folders, "artwork")]).toEqual(["artwork"]);
  });

  it("reaches nothing from a folder that is not among those given", () => {
    expect(foldersBeneath(folders, "elsewhere").size).toBe(0);
  });

  it("survives a cycle in the parents", () => {
    const looped = [
      { id: "a", parentId: "b" },
      { id: "b", parentId: "a" },
    ];
    expect([...foldersBeneath(looped, "a")].sort()).toEqual(["a", "b"]);
  });

  it("lets owners and admins cover the workspace, and members who manage reviews everywhere", () => {
    const manage = ["view", "request_reviews", "manage_reviewers"];
    const request = ["view", "request_reviews"];
    expect(mayCoverWorkspace("owner", [null])).toBe(true);
    expect(mayCoverWorkspace("admin", [])).toBe(true);
    expect(mayCoverWorkspace("member", [manage, manage])).toBe(true);
    expect(mayCoverWorkspace("member", [manage, request])).toBe(false);
    expect(mayCoverWorkspace("member", [manage, null])).toBe(false);
    expect(mayCoverWorkspace("member", [])).toBe(false);
  });

  it("takes a folder or the workspace as an item, the workspace alone", () => {
    const base = { kind: "feedback", reviewers: ["u1"] };
    const folder = createReviewInput.safeParse({
      ...base,
      items: [{ folderId: "0193a4c8-0000-7000-8000-000000000001" }],
    });
    expect(folder.success).toBe(true);
    expect(createReviewInput.safeParse({ ...base, items: [{ workspace: true }] }).success).toBe(
      true,
    );
    const mixed = createReviewInput.safeParse({
      ...base,
      items: [{ workspace: true }, { fileId: "0193a4c8-0000-7000-8000-000000000002" }],
    });
    expect(mixed.success).toBe(false);
    expect(createReviewInput.safeParse({ ...base, items: [{ workspace: false }] }).success).toBe(
      false,
    );
  });
});
