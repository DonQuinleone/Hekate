import { describe, expect, it } from "vitest";
import {
  instanceSectionsFor,
  instanceWorkspacesQuery,
  newWorkspaceInput,
  operatorInput,
  reachesInstance,
  workspaceSlug,
  workspaceStateOf,
} from "./instance.ts";

describe("the instance side", () => {
  it("is open to operators and to workspace owners, and to nobody else", () => {
    expect(reachesInstance({ operator: true, owned: [] })).toBe(true);
    expect(reachesInstance({ operator: false, owned: [{ id: "w", name: "Studio" }] })).toBe(true);
    expect(reachesInstance({ operator: false, owned: [] })).toBe(false);
  });

  it("shows owners their workspaces alone", () => {
    expect(instanceSectionsFor({ operator: true, billing: false })).toEqual([
      "overview",
      "workspaces",
      "operators",
      "support",
      "health",
      "queues",
      "logs",
      "debug",
      "system",
      "settings",
      "operations",
    ]);
    expect(instanceSectionsFor({ operator: false, billing: true })).toEqual(["workspaces"]);
    // Billing, for operators, only where the instance charges (#180).
    expect(instanceSectionsFor({ operator: true, billing: true })).toContain("billing");
    // Support, for every operator: its incidents (#183) whether or not tickets are on (#182).
    expect(instanceSectionsFor({ operator: true, billing: false, support: false })).toContain(
      "support",
    );
    expect(instanceSectionsFor({ operator: true, billing: true, support: true })).toEqual([
      "overview",
      "workspaces",
      "operators",
      "billing",
      "support",
      "health",
      "queues",
      "logs",
      "debug",
      "system",
      "settings",
      "operations",
    ]);
    expect(instanceSectionsFor({ operator: false, billing: true, support: true })).toEqual([
      "workspaces",
    ]);
  });

  it("makes an operator of an address", () => {
    expect(operatorInput.safeParse({ email: "ines@endlesshall.example" }).success).toBe(true);
    expect(operatorInput.safeParse({ email: "Ines" }).success).toBe(false);
  });

  it("takes a subdomain as an address would", () => {
    expect(workspaceSlug.parse(" Lantern ")).toBe("lantern");
    expect(workspaceSlug.safeParse("north-choir").success).toBe(true);
    for (const bad of ["-lantern", "lantern-", "lantern pictures", "lantern.example", ""])
      expect(workspaceSlug.safeParse(bad).success).toBe(false);
    expect(workspaceSlug.safeParse("a".repeat(41)).success).toBe(false);
    // Names that would stand for the instance itself (#176).
    for (const kept of ["www", "API", "instance", "mail"])
      expect(workspaceSlug.safeParse(kept).success).toBe(false);
  });

  it("makes a workspace with a name, a subdomain and its first owner's address", () => {
    const input = {
      name: "Lantern Pictures",
      slug: "lantern",
      ownerEmail: "owner@lantern.example",
    };
    expect(newWorkspaceInput.safeParse(input).success).toBe(true);
    expect(newWorkspaceInput.safeParse({ ...input, name: " " }).success).toBe(false);
    expect(newWorkspaceInput.safeParse({ ...input, ownerEmail: "owner" }).success).toBe(false);
  });

  it("pages the list by the last id, fifty at a time unless asked", () => {
    expect(instanceWorkspacesQuery.parse({})).toEqual({ limit: 50 });
    expect(instanceWorkspacesQuery.safeParse({ after: "not-an-id" }).success).toBe(false);
    expect(instanceWorkspacesQuery.safeParse({ state: "trial" }).success).toBe(false);
  });

  it("calls a workspace suspended from the moment it is", () => {
    expect(workspaceStateOf({ suspendedAt: null })).toBe("active");
    expect(workspaceStateOf({ suspendedAt: new Date() })).toBe("suspended");
  });
});
