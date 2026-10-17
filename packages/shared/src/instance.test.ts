import { describe, expect, it } from "vitest";
import { instanceSectionsFor, operatorInput, reachesInstance } from "./instance.ts";

describe("the instance side", () => {
  it("is open to operators and to workspace owners, and to nobody else", () => {
    expect(reachesInstance({ operator: true, owned: [] })).toBe(true);
    expect(reachesInstance({ operator: false, owned: [{ id: "w", name: "Studio" }] })).toBe(true);
    expect(reachesInstance({ operator: false, owned: [] })).toBe(false);
  });

  it("shows owners their workspaces alone", () => {
    expect(instanceSectionsFor({ operator: true })).toEqual([
      "overview",
      "workspaces",
      "operators",
    ]);
    expect(instanceSectionsFor({ operator: false })).toEqual(["workspaces"]);
  });

  it("makes an operator of an address", () => {
    expect(operatorInput.safeParse({ email: "ines@endlesshall.example" }).success).toBe(true);
    expect(operatorInput.safeParse({ email: "Ines" }).success).toBe(false);
  });
});
