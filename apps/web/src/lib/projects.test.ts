import { describe, expect, it } from "vitest";
import { arrangeProjects } from "./projects";
import type { ProjectWithFigures } from "./queries";

const project = (
  name: string,
  createdAt: string,
  lastActiveAt: string,
  mine = true,
): ProjectWithFigures => ({
  id: name,
  name,
  profile: "music",
  description: null,
  createdAt,
  archivedAt: null,
  mine,
  mayArchive: false,
  figures: {
    files: 0,
    tracks: 0,
    versionedTracks: 0,
    approvedTracks: 0,
    openComments: 0,
    openReviews: 0,
    members: 0,
    faces: [],
    lastActiveAt,
  },
});

const list = [
  project("Opening titles", "2026-01-02", "2026-03-01", false),
  project("joplin rags", "2026-02-01", "2026-02-01"),
  project("Album 10", "2026-01-01", "2026-03-05"),
  project("Album 9", "2026-01-03", "2026-03-05"),
];
const names = (p: ProjectWithFigures[]) => p.map((x) => x.name);

describe("arrangeProjects", () => {
  it("puts the most recently active first, then by name", () => {
    expect(names(arrangeProjects(list, "all", "recent"))).toEqual([
      "Album 9",
      "Album 10",
      "Opening titles",
      "joplin rags",
    ]);
  });

  it("sorts names as people read them, ignoring case and counting numbers", () => {
    expect(names(arrangeProjects(list, "all", "name"))).toEqual([
      "Album 9",
      "Album 10",
      "joplin rags",
      "Opening titles",
    ]);
  });

  it("puts the newest first, and keeps only yours when asked", () => {
    expect(names(arrangeProjects(list, "all", "newest"))[0]).toBe("joplin rags");
    expect(names(arrangeProjects(list, "mine", "name"))).not.toContain("Opening titles");
  });

  it("leaves the list it was given alone", () => {
    const before = names(list);
    arrangeProjects(list, "all", "name");
    expect(names(list)).toEqual(before);
  });
});
