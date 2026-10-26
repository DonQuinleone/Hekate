import { describe, expect, it } from "vitest";
import { exportUrl, filtered, logQuery, without } from "./access-log";

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
