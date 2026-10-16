import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, fileSettings, loadConfig, settings } from "./config.ts";
import { configurationReference } from "./config-reference.ts";

describe("configuration", () => {
  it("reports a secret file it cannot read with the rest, rather than stopping at it", () => {
    let error: unknown;
    try {
      loadConfig({ AUTH_SECRET_FILE: "/nonexistent/hekate/auth_secret", PORT: "nope" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const problems = (error as ConfigError).problems;
    expect(problems.find((p) => p.name === "AUTH_SECRET_FILE")?.message).toBe(
      "cannot read /nonexistent/hekate/auth_secret: no such file",
    );
    // Reported once, by its file; the other settings are still checked.
    expect(problems.some((p) => p.name === "AUTH_SECRET")).toBe(false);
    expect(problems.map((p) => p.name)).toEqual(
      expect.arrayContaining(["PORT", "DATABASE_URL", "MASTER_KEY"]),
    );
  });

  it("names every missing or invalid setting at once, in words", () => {
    let error: unknown;
    try {
      loadConfig({ PORT: "nope", HEKATE_SUPPORT: "mail" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const problems = (error as ConfigError).problems;
    expect(problems.map((p) => p.name)).toEqual([
      "PORT",
      "DATABASE_URL",
      "AUTH_SECRET",
      "MASTER_KEY",
      "HEKATE_SUPPORT_ADDRESS",
    ]);
    expect(problems.find((p) => p.name === "DATABASE_URL")?.message).toMatch(/^missing: /);
    expect((error as Error).message).toMatch(/^Hekate cannot start\. 5 settings need attention:/);
    expect((error as Error).message).toContain("docs/configuration.md");
  });

  it("starts with only the three secrets set", () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://hekate:secret@localhost:5432/hekate",
      AUTH_SECRET: "x".repeat(32),
      MASTER_KEY: Buffer.alloc(32, 1).toString("base64"),
    });
    expect(config.HEKATE_BILLING).toBe("off");
    expect(config.HEKATE_SUPPORT).toBe("off");
    expect(config.HEKATE_DOCS_URL).toBe("https://docs.hekate.studio");
  });

  it("describes every setting, and those that may come from a file are the secret ones", () => {
    for (const setting of settings()) expect(setting.info.description.length).toBeGreaterThan(10);
    expect(
      settings()
        .filter((s) => s.info.secret)
        .map((s) => s.name)
        .sort(),
    ).toEqual([...fileSettings].sort());
  });

  it("keeps docs/configuration.md in step with the settings", () => {
    const written = readFileSync(
      join(import.meta.dirname, "../../../docs/configuration.md"),
      "utf8",
    );
    // If this fails, run: pnpm --filter @hekate/server config:reference
    expect(written).toBe(configurationReference());
  });
});
