import { describe, expect, it } from "vitest";
import { readiness } from "./health.ts";

describe("readiness", () => {
  const all = { database: "ok", storage: "ok", worker: "ok", mail: "ok" } as const;

  it("is ready while the database and storage are, whatever the worker and mail", () => {
    expect(readiness("0.2.0", all).status).toBe("ready");
    expect(readiness("0.2.0", { ...all, worker: "stale", mail: "failed" }).status).toBe("ready");
  });

  it("is not ready without the database or storage", () => {
    expect(readiness("0.2.0", { ...all, database: "failed" }).status).toBe("not_ready");
    expect(readiness("0.2.0", { ...all, storage: "failed" }).status).toBe("not_ready");
  });
});
