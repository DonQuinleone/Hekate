import { describe, expect, it } from "vitest";
import { connectionOf } from "./connection";

const ok = { status: "ok", version: "0.2.0", database: "ok" } as const;

describe("the shell's connection", () => {
  it("is connected while the health check answers ok, with the server's version", () => {
    expect(connectionOf(ok, false)).toEqual({ state: "connected", version: "0.2.0" });
  });

  it("is checking before the first answer", () => {
    expect(connectionOf(undefined, false)).toEqual({ state: "checking" });
  });

  it("says when the server answers without its database", () => {
    expect(
      connectionOf({ status: "degraded", version: "0.2.0", database: "unreachable" }, false),
    ).toEqual({ state: "degraded", version: "0.2.0" });
  });

  it("says the API is unreachable once a check fails, keeping the version last known", () => {
    expect(connectionOf(ok, true)).toEqual({ state: "unreachable", version: "0.2.0" });
    expect(connectionOf(undefined, true)).toEqual({ state: "unreachable", version: null });
  });
});
