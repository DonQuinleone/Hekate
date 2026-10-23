import { describe, expect, it } from "vitest";
import { addressFor, notMemberAddress } from "./hosts";
import type { Me } from "./queries";

const me = (root: string | null): Me =>
  ({
    root,
    activeOrganisationId: "studio",
    organisations: [
      { id: "studio", name: "Studio", url: root ? "https://studio.review.example" : null },
      { id: "north", name: "North Choir", url: root ? "https://north.review.example" : null },
    ],
  }) as unknown as Me;

describe("workspace subdomains (#176)", () => {
  it("sends a workspace's pages to the active workspace's host", () => {
    expect(addressFor(me("https://review.example"), "/projects", "review.example")).toBe(
      "https://studio.review.example",
    );
    expect(addressFor(me("https://review.example"), "/projects", "north.review.example")).toBe(
      "https://studio.review.example",
    );
    expect(addressFor(me("https://review.example"), "/", "studio.review.example")).toBeNull();
  });

  it("keeps the instance's pages at the root", () => {
    expect(addressFor(me("https://review.example"), "/instance", "studio.review.example")).toBe(
      "https://review.example",
    );
    expect(
      addressFor(me("https://review.example"), "/instance/debug", "review.example"),
    ).toBeNull();
  });

  it("takes someone from a workspace's host that is not theirs to the root (#437)", () => {
    expect(notMemberAddress("https://review.example", "/projects/p1", "?folder=f")).toBe(
      "https://review.example/",
    );
    // An invitation is for someone not yet a member: the same one, at the root.
    expect(notMemberAddress("https://review.example", "/invite/abc", "")).toBe(
      "https://review.example/invite/abc",
    );
  });

  it("leaves everything where it is with subdomains off", () => {
    expect(addressFor(me(null), "/projects", "review.example")).toBeNull();
    expect(addressFor(me(null), "/instance", "review.example")).toBeNull();
  });
});
