import { describe, expect, it } from "vitest";
import {
  actionChoices,
  actionCopy,
  actorParts,
  exportUrl,
  filtered,
  logQuery,
  without,
} from "./access-log";

const now = Date.parse("2026-10-14T12:00:00Z");

describe("the access log's filters", () => {
  it("reads only what is set, and a time as the moment it starts", () => {
    expect(logQuery({}, now)).toEqual({});
    expect(
      logQuery(
        {
          action: "download",
          projectId: "p",
          fileId: "f",
          reviewId: "r",
          guestId: "g",
          since: "week",
        },
        now,
      ),
    ).toEqual({
      action: "download",
      projectId: "p",
      fileId: "f",
      reviewId: "r",
      guestId: "g",
      from: "2026-10-07T12:00:00.000Z",
    });
    expect(logQuery({ userId: "u", since: "day" }, now)).toEqual({
      userId: "u",
      from: "2026-10-13T12:00:00.000Z",
    });
  });

  it("takes one away, and knows when none is left", () => {
    const both = { action: "download", userId: "u" };
    expect(without(both, "userId")).toEqual({ action: "download" });
    expect(filtered(without(without(both, "userId"), "action"))).toBe(false);
    expect(filtered(both)).toBe(true);
  });

  it("exports what the page shows", () => {
    expect(exportUrl({}, now)).toBe("/api/organisation/audit.csv");
    expect(exportUrl({ action: "page.render", fileId: "f" }, now)).toBe(
      "/api/organisation/audit.csv?action=page.render&fileId=f",
    );
  });
});

describe("the access log's actions", () => {
  it("offers each action once, under its current name, but reads an older entry too (decision 295)", () => {
    const offered = actionChoices.map(([action]) => action);
    expect(offered).toContain("variant.replace");
    expect(offered).not.toContain("variation.replace");
    expect(new Set(actionChoices.map(([, label]) => label)).size).toBe(actionChoices.length);
    expect(actionCopy["variation.replace"]).toBe("File replaced");
  });
});

describe("who an entry names (#596)", () => {
  it("shows the name alone, keeping the address and whether they were a guest", () => {
    expect(actorParts("Alex Rivera <producer@example.test>")).toEqual({
      name: "Alex Rivera",
      address: "producer@example.test",
      guest: false,
    });
    expect(actorParts("Mira Solberg <mira@example.test> (guest)")).toEqual({
      name: "Mira Solberg",
      address: "mira@example.test",
      guest: true,
    });
    expect(actorParts("Release pipeline (service token)")).toEqual({
      name: "Release pipeline (service token)",
      address: null,
      guest: false,
    });
    expect(actorParts("Hekate")).toEqual({ name: "Hekate", address: null, guest: false });
  });
});
