import { describe, expect, it } from "vitest";
import { exportFileName, mayExportWorkspace, workspaceExportInput } from "./workspace-export.ts";

describe("a workspace's export (#186)", () => {
  it("takes an age public key, or none", () => {
    const key = `age1${"q".repeat(58)}`;
    expect(workspaceExportInput.parse({})).toEqual({});
    expect(workspaceExportInput.parse({ recipient: ` ${key.toUpperCase()} ` })).toEqual({
      recipient: key,
    });
    expect(workspaceExportInput.safeParse({ recipient: "age1short" }).success).toBe(false);
    expect(workspaceExportInput.safeParse({ recipient: key, more: 1 }).success).toBe(false);
  });

  it("names the archive by the workspace's address and its day", () => {
    const day = new Date("2026-10-20T18:04:00Z");
    expect(exportFileName("endless-hall", day)).toBe("endless-hall-export-2026-10-20.tar.age");
    expect(exportFileName('"; rm', day)).toBe("rm-export-2026-10-20.tar.age");
  });

  it("is for owners only", () => {
    expect(mayExportWorkspace("owner")).toBe(true);
    expect(mayExportWorkspace("admin")).toBe(false);
    expect(mayExportWorkspace("member")).toBe(false);
  });
});
