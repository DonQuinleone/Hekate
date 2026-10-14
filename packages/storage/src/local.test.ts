import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { storageConformance } from "./conformance.ts";
import { localBackend } from "./local.ts";

const root = mkdtempSync(join(tmpdir(), "hekate-storage-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

storageConformance("local", () => localBackend({ name: "local", root }));

describe("local backend", () => {
  it("leaves no temporary files and prunes empty directories", async () => {
    const backend = localBackend({ name: "local", root: join(root, "tidy") });
    await backend.put("org/a/b/c", Buffer.from("x"));
    await backend.delete("org/a/b/c");
    expect(readdirSync(join(root, "tidy"))).toEqual([".tmp"]);
    expect(readdirSync(join(root, "tidy", ".tmp"))).toEqual([]);
  });

  it("reports an unwritable root at start-up", async () => {
    const backend = localBackend({ name: "broken", root: "/proc/hekate-cannot-write-here" });
    await expect(backend.check()).rejects.toThrow(/broken/);
  });
});
