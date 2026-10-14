import { describe, expect, it } from "vitest";
import {
  activeReviewers,
  createReviewInput,
  groupInput,
  type ReviewerFacts,
  reviewerState,
  reviewOutcome,
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

  it("completes feedback once everyone has submitted", () => {
    const done = { submitted: true };
    expect(reviewOutcome("feedback", null, [reviewer("a", done), reviewer("b")])).toBeNull();
    expect(reviewOutcome("feedback", null, [reviewer("a", done), reviewer("b", done)])).toBe(
      "submitted",
    );
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
