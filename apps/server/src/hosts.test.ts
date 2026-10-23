import { describe, expect, it } from "vitest";
import {
  hostKind,
  linkBase,
  passkeyOrigins,
  rootAddress,
  subdomainsOf,
  workspaceAddress,
  workspaceOrigin,
} from "./hosts.ts";

describe("workspace subdomains (#176)", () => {
  const subdomains = subdomainsOf("https://review.example", true);
  if (!subdomains) throw new Error("Subdomains should be on");

  it("are off unless asked for", () => {
    expect(subdomainsOf("https://review.example", false)).toBeNull();
  });

  it("tell the root, a workspace's host and anything else apart", () => {
    expect(hostKind("review.example", subdomains)).toEqual({ kind: "root" });
    expect(hostKind("Review.Example:443", subdomains)).toEqual({ kind: "root" });
    expect(hostKind("endless-hall.review.example", subdomains)).toEqual({
      kind: "workspace",
      slug: "endless-hall",
    });
    for (const other of [
      undefined,
      "10.0.0.4:3000",
      "review.example.evil",
      "evilreview.example",
      "a.b.review.example",
      "-x.review.example",
      // Kept for the instance: never a workspace's.
      "www.review.example",
      "api.review.example",
    ])
      expect(hostKind(other, subdomains)).toEqual({ kind: "other" });
  });

  it("give each workspace its address, with the root's scheme and port", () => {
    expect(workspaceAddress(subdomains, "lantern")).toBe("https://lantern.review.example");
    const local = subdomainsOf("http://review.test:3000", true);
    if (!local) throw new Error("Subdomains should be on");
    expect(workspaceAddress(local, "lantern")).toBe("http://lantern.review.test:3000");
  });

  it("let passkeys be used at any workspace's host, and nowhere else", () => {
    expect(workspaceOrigin(subdomains, "https://north-choir.review.example")).toBe(true);
    for (const other of [
      "https://review.example",
      "http://north-choir.review.example",
      "https://north-choir.review.example:8443",
      "https://north-choir.review.example/path",
      "https://www.review.example",
      "https://evil.example",
      "not a url",
    ])
      expect(workspaceOrigin(subdomains, other)).toBe(false);
    expect(workspaceOrigin(null, "https://north-choir.review.example")).toBe(false);
    // The plugin's list holds what it was given, and answers for every workspace's host too.
    const given = rootAddress(subdomains);
    const workspace = workspaceAddress(subdomains, "north-choir");
    const origins = passkeyOrigins([given], subdomains);
    expect(Array.isArray(origins)).toBe(true);
    expect([given, workspace].map((o) => origins.includes(o))).toEqual([true, true]);
    const off = passkeyOrigins([given], null);
    expect([given, workspace].map((o) => off.includes(o))).toEqual([true, false]);
  });

  it("make links in mail at each workspace's own host, and at PUBLIC_URL with them off (#437)", () => {
    expect(linkBase({ publicUrl: "https://review.example/", subdomains }, "lantern")).toBe(
      "https://lantern.review.example",
    );
    expect(linkBase({ publicUrl: "https://review.example/", subdomains: null }, "lantern")).toBe(
      "https://review.example",
    );
    expect(linkBase({ publicUrl: "https://review.example" }, "lantern")).toBe(
      "https://review.example",
    );
    // A workspace not found (gone meanwhile) falls back to the root.
    expect(linkBase({ publicUrl: "https://review.example", subdomains }, undefined)).toBe(
      "https://review.example",
    );
  });
});
