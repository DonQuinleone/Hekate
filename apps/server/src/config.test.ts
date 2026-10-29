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
    // Every lane, the role left to WORKER (#189).
    expect(config.ROLE).toBeUndefined();
    // DATABASE_URL serves for everything, past no pooler (#412).
    expect(config.DATABASE_DIRECT_URL).toBeUndefined();
    expect(config.WORKER_LANES).toBeNull();
  });

  it("holds the demo to this machine, whose keys are published (decision 265)", () => {
    const secrets = {
      DATABASE_URL: "postgres://hekate:secret@localhost:5432/hekate",
      AUTH_SECRET: "x".repeat(32),
      MASTER_KEY: Buffer.alloc(32, 1).toString("base64"),
    };
    expect(loadConfig(secrets).HEKATE_DEMO).toBe(false);
    expect(loadConfig({ ...secrets, HEKATE_DEMO: "1" }).HEKATE_DEMO).toBe(true);
    expect(
      loadConfig({ ...secrets, HEKATE_DEMO: "1", PUBLIC_URL: "http://127.0.0.1:8080" }).HEKATE_DEMO,
    ).toBe(true);
    let error: unknown;
    try {
      loadConfig({ ...secrets, HEKATE_DEMO: "1", PUBLIC_URL: "https://review.example.test" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).problems).toEqual([
      { name: "HEKATE_DEMO", message: expect.stringContaining("not review.example.test") },
    ]);
  });

  it("takes payments through Stripe only with its keys, and test-mode keys only (#178)", () => {
    const base = {
      DATABASE_URL: "postgres://hekate:secret@localhost:5432/hekate",
      AUTH_SECRET: "x".repeat(32),
      MASTER_KEY: Buffer.alloc(32, 1).toString("base64"),
      HEKATE_BILLING: "stripe",
    };
    const problems = (env: Record<string, string>) => {
      try {
        loadConfig({ ...base, ...env });
        return [];
      } catch (error) {
        return (error as ConfigError).problems.map((p) => p.name);
      }
    };
    expect(problems({})).toEqual(["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]);
    expect(
      problems({ STRIPE_SECRET_KEY: "sk_live_abc", STRIPE_WEBHOOK_SECRET: "whsec_abc" }),
    ).toEqual(["STRIPE_SECRET_KEY"]);
    const config = loadConfig({
      ...base,
      STRIPE_SECRET_KEY: "rk_test_abc",
      STRIPE_WEBHOOK_SECRET: "whsec_abc",
    });
    expect([config.STRIPE_SECRET_KEY, config.STRIPE_TAX]).toEqual(["rk_test_abc", false]);
  });

  it("sends mail one way, each provider's settings whole (#71)", () => {
    const base = {
      DATABASE_URL: "postgres://hekate:secret@localhost:5432/hekate",
      AUTH_SECRET: "x".repeat(32),
      MASTER_KEY: Buffer.alloc(32, 1).toString("base64"),
    };
    const problems = (env: Record<string, string>) => {
      try {
        loadConfig({ ...base, ...env });
        return [];
      } catch (error) {
        return (error as ConfigError).problems.map((p) => `${p.name}: ${p.message}`);
      }
    };
    const graph = {
      MAIL_GRAPH_TENANT: "endlesshall.onmicrosoft.com",
      MAIL_GRAPH_CLIENT_ID: "app",
      MAIL_GRAPH_CLIENT_SECRET: "secret",
    };
    expect(problems(graph)).toEqual([]);
    expect(problems({ MAIL_GRAPH_TENANT: "endlesshall.onmicrosoft.com" })).toEqual([
      "MAIL_GRAPH_CLIENT_ID: required with MAIL_GRAPH_TENANT",
      "MAIL_GRAPH_CLIENT_SECRET: required with MAIL_GRAPH_TENANT",
    ]);
    expect(problems({ MAIL_MAILCOACH_URL: "https://endlesshall.mailcoach.app" })).toEqual([
      "MAIL_MAILCOACH_TOKEN: required with MAIL_MAILCOACH_URL",
    ]);
    expect(problems({ ...graph, SMTP_URL: "smtp://mail.example:587" })).toEqual([
      "MAIL_GRAPH_TENANT: mail goes out one way: set only one of SMTP_URL, MAIL_GRAPH_TENANT",
    ]);
  });

  it("reads a worker's role and lanes, and names a lane that is not one (#189)", () => {
    const secrets = {
      DATABASE_URL: "postgres://hekate:secret@localhost:5432/hekate",
      AUTH_SECRET: "x".repeat(32),
      MASTER_KEY: Buffer.alloc(32, 1).toString("base64"),
    };
    const config = loadConfig({ ...secrets, ROLE: "worker", WORKER_LANES: "transcode:4,pages" });
    expect(config.ROLE).toBe("worker");
    expect([...(config.WORKER_LANES ?? [])]).toEqual([
      ["transcode", 4],
      ["pages", null],
    ]);
    expect(() => loadConfig({ ...secrets, ROLE: "both", WORKER_LANES: "render" })).toThrow(
      /ROLE +must be one of all, api, worker[\s\S]*WORKER_LANES +"render" is not a lane/,
    );
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
