import { describe, expect, it } from "vitest";
import {
  acceptanceProblem,
  approvalProblem,
  lapsed,
  mayTakeProjects,
  nameMatches,
  readyToMove,
  transferRequestInput,
} from "./project-transfer.ts";

describe("project transfer rules", () => {
  const waiting = {
    status: "pending" as const,
    requestedBy: "u1",
    approvedAt: null,
    acceptedAt: null,
  };

  it("takes a second member who may delete the project to approve it", () => {
    expect(approvalProblem(waiting, { userId: "u2", mayDelete: true })).toBeNull();
    expect(approvalProblem(waiting, { userId: "u1", mayDelete: true })).toMatch(/second member/);
    expect(approvalProblem(waiting, { userId: "u2", mayDelete: false })).toMatch(/role/);
    expect(
      approvalProblem({ ...waiting, approvedAt: new Date() }, { userId: "u2", mayDelete: true }),
    ).toMatch(/already approved/);
    expect(
      approvalProblem({ ...waiting, status: "refused" }, { userId: "u2", mayDelete: true }),
    ).toMatch(/no longer waiting/);
  });

  it("takes an owner or admin of the gaining workspace to accept it", () => {
    expect(acceptanceProblem(waiting, { role: "owner" })).toBeNull();
    expect(acceptanceProblem(waiting, { role: "admin" })).toBeNull();
    expect(acceptanceProblem(waiting, { role: "member" })).toMatch(/owner or admin/);
    expect(acceptanceProblem(waiting, { role: null })).toMatch(/owner or admin/);
    expect(acceptanceProblem({ ...waiting, acceptedAt: new Date() }, { role: "owner" })).toMatch(
      /already accepted/,
    );
    expect(mayTakeProjects("member")).toBe(false);
  });

  it("moves once both have signed it off, and lapses when no one acts", () => {
    expect(readyToMove({ approvedAt: new Date(), acceptedAt: null })).toBe(false);
    expect(readyToMove({ approvedAt: new Date(), acceptedAt: new Date() })).toBe(true);
    const now = new Date("2026-10-19T12:00:00Z");
    expect(lapsed({ status: "pending", expiresAt: new Date("2026-10-19T11:59:59Z") }, now)).toBe(
      true,
    );
    expect(lapsed({ status: "pending", expiresAt: new Date("2026-10-19T12:00:01Z") }, now)).toBe(
      false,
    );
    expect(lapsed({ status: "moved", expiresAt: new Date(0) }, now)).toBe(false);
  });

  it("reads the typed name loosely, and the destination strictly", () => {
    expect(nameMatches("  joplin rags ", "Joplin Rags")).toBe(true);
    expect(nameMatches("Joplin Rag", "Joplin Rags")).toBe(false);
    expect(
      transferRequestInput.parse({ to: { address: " Endless-Hall " }, name: "Joplin Rags" }).to,
    ).toEqual({ address: "endless-hall" });
    expect(
      transferRequestInput.safeParse({ to: { id: "x", address: "y" }, name: "Joplin Rags" })
        .success,
    ).toBe(false);
  });
});
