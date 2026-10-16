import { describe, expect, it } from "vitest";
import { type HomeActivity, latestActivity } from "./home.ts";

const comment = (id: string, at: string, who: string, fileId: string): HomeActivity => ({
  kind: "comment",
  id,
  at,
  who: { id: who, name: who },
  projectId: "p",
  fileId,
  fileName: fileId,
  count: 1,
});

describe("latestActivity", () => {
  it("puts the newest first and folds a run of comments on one file into one line", () => {
    const entries: HomeActivity[] = [
      comment("a", "2026-10-15T10:00:00Z", "mira", "mix"),
      comment("b", "2026-10-15T10:01:00Z", "mira", "mix"),
      comment("c", "2026-10-15T10:02:00Z", "mira", "mix"),
      comment("d", "2026-10-15T10:03:00Z", "tomas", "mix"),
      {
        kind: "version",
        id: "v",
        at: "2026-10-15T09:00:00Z",
        who: null,
        projectId: "p",
        trackId: "t",
        trackName: "Bethena",
        number: 2,
      },
    ];
    const out = latestActivity(entries, 3);
    expect(out.map((e) => e.id)).toEqual(["d", "c", "v"]);
    expect(out[1]).toMatchObject({ kind: "comment", count: 3 });
  });

  it("stops at the limit", () => {
    const entries = ["a", "b", "c"].map((f, i) => comment(f, `2026-10-15T10:0${i}:00Z`, "mira", f));
    expect(latestActivity(entries, 2).map((e) => e.id)).toEqual(["c", "b"]);
  });
});
