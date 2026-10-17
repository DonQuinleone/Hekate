import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const packageDir = join(import.meta.dirname, "..");

describe("migrations", () => {
  // A schema change (or a default it reads from @hekate/shared) without a generated
  // migration would otherwise go unnoticed until the next migration picked it up.
  it("match the schema", () => {
    const out = mkdtempSync(join(tmpdir(), "hekate-migrations-"));
    try {
      cpSync(join(packageDir, "migrations"), out, { recursive: true });
      const before = new Set(readdirSync(out));
      // drizzle-kit exits 0 even when it fails, so only its own all-clear counts as a pass.
      const output = execFileSync(
        join(packageDir, "node_modules/.bin/drizzle-kit"),
        ["generate", "--name", "drift-check"],
        {
          cwd: packageDir,
          // It reads the out directory relative to the package, whatever the path.
          env: { ...process.env, DRIZZLE_OUT: relative(packageDir, out) },
          encoding: "utf8",
          // A rename question would wait for an answer that never comes.
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 60_000,
        },
      );
      if (output.includes("No schema changes, nothing to migrate")) return;
      const generated = readdirSync(out)
        .filter((name) => !before.has(name))
        .map((name) => `${name}:\n${readFileSync(join(out, name), "utf8")}`);
      expect.fail(
        generated.length > 0
          ? `The schema differs from the migrations; run pnpm db:generate. It would add\n${generated.join("\n")}`
          : `drizzle-kit did not finish:\n${output}`,
      );
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 90_000);
});
