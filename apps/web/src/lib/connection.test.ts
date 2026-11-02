import { describe, expect, it } from "vitest";
import { connectionOf, connectionWords, reachOf } from "./connection";

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

  it("says it cannot reach the server once a check fails, keeping the version last known", () => {
    expect(connectionOf(ok, true)).toEqual({ state: "unreachable", version: "0.2.0" });
    expect(connectionOf(undefined, true)).toEqual({ state: "unreachable", version: null });
  });

  it("says what happened in plain words", () => {
    expect(connectionWords.unreachable).toBe("Can't reach the server");
    expect(connectionWords.degraded).toBe("Running slowly");
  });

  it("loses the server on a request without an answer, and finds it on any answer", () => {
    expect(reachOf(new TypeError("Failed to fetch"))).toBe("lost");
    expect(reachOf(new Response(null, { status: 502 }))).toBe("lost");
    expect(reachOf(new Response(null, { status: 504 }))).toBe("lost");
    expect(reachOf(new Response(null, { status: 404 }))).toBe("reached");
    expect(reachOf(new Response(null, { status: 503 }))).toBe("reached");
    expect(reachOf(new DOMException("Cancelled", "AbortError"))).toBeNull();
  });
});
