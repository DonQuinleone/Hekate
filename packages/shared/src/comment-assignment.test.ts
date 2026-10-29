import { describe, expect, it } from "vitest";
import {
  assigneeFor,
  assignmentWords,
  commentAssignment,
  trackCommentAssignmentInput,
} from "./comment-assignment.ts";

const engineerRole = "0199f000-0000-7000-8000-00000000000a";
const editorRole = "0199f000-0000-7000-8000-00000000000b";
const members = [
  { userId: "ines", roleId: engineerRole },
  { userId: "tomas", roleId: engineerRole },
  { userId: "alex", roleId: editorRole },
];
const toRole = (roleId: string) => ({ assign: { kind: "role" as const, roleId } });
const toMember = (userId: string) => ({ assign: { kind: "member" as const, userId } });
const nobody = { assign: null };

describe("assigneeFor", () => {
  it("gives nobody when no rule is set anywhere", () => {
    expect(assigneeFor(undefined, null, null, members)).toBeNull();
  });

  it("takes the project's default when the stage and the track say nothing", () => {
    expect(assigneeFor(undefined, null, toMember("alex"), members)).toBe("alex");
  });

  it("lets the track's rule stand over the project's, and the stage's over both", () => {
    expect(assigneeFor(undefined, toMember("tomas"), toMember("alex"), members)).toBe("tomas");
    expect(assigneeFor(toMember("ines"), toMember("tomas"), toMember("alex"), members)).toBe(
      "ines",
    );
  });

  it("stops at a rule that says nobody rather than falling through", () => {
    expect(assigneeFor(nobody, toMember("tomas"), toMember("alex"), members)).toBeNull();
    expect(assigneeFor(undefined, nobody, toMember("alex"), members)).toBeNull();
  });

  it("resolves a role to the member who has held it longest", () => {
    expect(assigneeFor(toRole(engineerRole), null, null, members)).toBe("ines");
    expect(assigneeFor(toRole(editorRole), null, null, members)).toBe("alex");
  });

  it("gives nobody for a role no one holds, or a member who has left", () => {
    expect(assigneeFor(toRole("0199f000-0000-7000-8000-0000000000ff"), null, null, members)).toBe(
      null,
    );
    expect(assigneeFor(toMember("gone"), null, null, members)).toBeNull();
    // A member who left does not hand the comment to the project's default instead.
    expect(assigneeFor(toMember("gone"), null, toMember("alex"), members)).toBeNull();
  });
});

describe("assignmentWords", () => {
  const names = {
    members: [{ userId: "ines", name: "Ines Arlow" }],
    roles: [{ id: engineerRole, name: "Engineer" }],
  };

  it("names the member, the role, nobody, or what it inherits", () => {
    expect(assignmentWords(toMember("ines"), names)).toBe("Ines Arlow");
    expect(assignmentWords(toRole(engineerRole), names)).toBe("Whoever is Engineer");
    expect(assignmentWords(nobody, names)).toBe("Nobody");
    expect(assignmentWords(null, names, "Project default")).toBe("Project default");
    expect(assignmentWords(undefined, names)).toBe("Nobody");
  });

  it("says when the member or role is no longer there", () => {
    expect(assignmentWords(toMember("gone"), names)).toBe("Someone no longer here");
    expect(assignmentWords(toRole(editorRole), names)).toBe("A role no longer here");
  });
});

describe("the shared shapes", () => {
  it("takes a member, a role or nobody, and nothing else", () => {
    expect(commentAssignment.safeParse(toMember("ines")).success).toBe(true);
    expect(commentAssignment.safeParse(toRole(engineerRole)).success).toBe(true);
    expect(commentAssignment.safeParse(nobody).success).toBe(true);
    expect(commentAssignment.safeParse({}).success).toBe(false);
    expect(commentAssignment.safeParse({ assign: { kind: "group", groupId: "x" } }).success).toBe(
      false,
    );
    expect(
      commentAssignment.safeParse({ assign: { kind: "role", roleId: "not-a-uuid" } }).success,
    ).toBe(false);
    expect(commentAssignment.safeParse({ assign: null, extra: true }).success).toBe(false);
  });

  it("lets a track keep the project's rule with null", () => {
    expect(trackCommentAssignmentInput.parse({ assignment: null })).toEqual({ assignment: null });
    expect(trackCommentAssignmentInput.safeParse({}).success).toBe(false);
  });
});
