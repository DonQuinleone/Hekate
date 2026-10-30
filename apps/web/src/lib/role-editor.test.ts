import {
  type AccessLevels,
  defaultRoleLevels,
  levelsOf,
  permissionsOfLevels,
  playerTools,
  projectPermissions,
} from "@hekate/shared";
import { describe, expect, it } from "vitest";
import {
  compareRows,
  copiedInto,
  copyName,
  copyOf,
  type EditableRole,
  lowestLevel,
  permissionGroups,
  rowOn,
  setAreaLevel,
  setRow,
  withTool,
} from "./role-editor";

const levelsNamed = (name: string): AccessLevels => {
  const found = defaultRoleLevels.find((r) => r.name === name);
  if (!found) throw new Error(name);
  return found.levels;
};
const producer: EditableRole = {
  id: "producer",
  name: "Producer",
  levels: levelsNamed("Producer"),
  tools: [...playerTools],
};
const engineer: EditableRole = {
  id: "engineer",
  name: "Engineer",
  levels: levelsNamed("Engineer"),
  tools: ["qa", "meters", "spectrogram", "compare"],
};
const viewer: EditableRole = {
  id: "viewer",
  name: "Viewer",
  levels: levelsNamed("Viewer"),
  tools: ["score"],
};
const roles = [producer, engineer, viewer];

describe("grouping permissions by area", () => {
  const groups = permissionGroups();

  it("lists the areas in order, each permission once, as a row of its own area", () => {
    expect(groups.map((g) => g.label)).toEqual([
      "Files",
      "Comments",
      "Reviews",
      "Downloads",
      "Sessions and takes",
      "Production tools",
      "Workflow",
      "Roles and people",
      "Project",
    ]);
    const rows = groups.flatMap((g) => g.rows.map((r) => r.permission));
    expect([...rows].sort()).toEqual([...projectPermissions].sort());
  });

  it("names each row by its permission and gives the header every level, None first", () => {
    const files = groups[0];
    expect(files?.rows.map((r) => r.label)).toEqual([
      "View files and tracks",
      "Upload files, versions, takes",
      "Organise folders and tracks",
      "Delete files and folders",
    ]);
    expect(files?.levels.map((l) => l.id)).toEqual([
      "none",
      "view",
      "upload",
      "organise",
      "delete",
    ]);
  });
});

describe("rows and levels", () => {
  it("shows a row on when the area's level reaches it", () => {
    expect(rowOn(engineer.levels, "files", "view")).toBe(true);
    expect(rowOn(engineer.levels, "files", "organise")).toBe(true);
    expect(rowOn(engineer.levels, "files", "delete")).toBe(false);
    expect(rowOn(engineer.levels, "reviews", "respond")).toBe(false);
    // None is the header's choice, never a row.
    expect(rowOn(engineer.levels, "files", "none")).toBe(false);
  });

  it("sets every row of an area at once, and leaves the other areas be", () => {
    const none = setAreaLevel(producer.levels, "comments", "none");
    expect(none.comments).toBe("none");
    expect(none.files).toBe("delete");
    expect(permissionsOfLevels(none)).not.toContain("read_comments");
    const all = setAreaLevel(viewer.levels, "files", "delete");
    expect(["view", "upload", "organise", "delete"].every((l) => rowOn(all, "files", l))).toBe(
      true,
    );
  });

  it("ignores a level the area does not have", () => {
    expect(setAreaLevel(viewer.levels, "downloads", "delete")).toBe(viewer.levels);
  });

  it("brings the rows before a row switched on, and takes those after one switched off", () => {
    const on = setRow(viewer.levels, "files", "organise", true);
    expect(on.files).toBe("organise");
    expect(rowOn(on, "files", "upload")).toBe(true);
    const off = setRow(producer.levels, "files", "upload", false);
    expect(off.files).toBe("view");
    expect(rowOn(off, "files", "delete")).toBe(false);
    // What the server keeps reads the same back.
    expect(levelsOf(permissionsOfLevels(off))).toEqual(off);
  });
});

describe("copying a role", () => {
  it("makes a new role with every level and every tool of another, under a free name", () => {
    const copy = copyOf(engineer, roles);
    expect(copy).toEqual({
      name: "Engineer copy",
      levels: engineer.levels,
      tools: engineer.tools,
    });
    // A copy, not the same objects: editing it leaves the original as it was.
    expect(copy.levels).not.toBe(engineer.levels);
    expect(copy.tools).not.toBe(engineer.tools);
  });

  it("numbers further copies, and keeps a long name within sixty characters", () => {
    expect(copyName("Engineer", ["Engineer", "Engineer copy"])).toBe("Engineer copy 2");
    expect(copyName("Engineer", ["Engineer copy", "Engineer copy 2"])).toBe("Engineer copy 3");
    const long = "A".repeat(60);
    expect(copyName(long, []).length).toBeLessThanOrEqual(60);
    expect(copyName(long, [copyName(long, [])]).length).toBeLessThanOrEqual(60);
  });

  it("gives a role another's every level and tool, keeping its own name", () => {
    expect(copiedInto(viewer, producer)).toEqual({
      id: "viewer",
      name: "Viewer",
      levels: producer.levels,
      tools: [...playerTools],
    });
  });
});

describe("the role that runs the project", () => {
  it("keeps the only role that manages people at that level", () => {
    expect(lowestLevel(producer, roles, "people")).toBe("manage");
    expect(lowestLevel(producer, roles, "files")).toBe("none");
    expect(lowestLevel(engineer, roles, "people")).toBe("none");
  });

  it("lets it go once another role manages people too", () => {
    const second = { ...engineer, levels: setAreaLevel(engineer.levels, "people", "manage") };
    expect(lowestLevel(producer, [producer, second, viewer], "people")).toBe("none");
  });
});

describe("player tools and comparing", () => {
  it("switches a tool and keeps the player's order", () => {
    expect(withTool(["score", "qa"], "meters", true)).toEqual(["qa", "meters", "score"]);
    expect(withTool(["score", "qa"], "qa", false)).toEqual(["score"]);
  });

  it("reads every role's level in each area by its label", () => {
    const [row] = compareRows([engineer]);
    expect(row?.levels.find((l) => l.area === "files")).toEqual({
      area: "files",
      label: "Organise",
      none: false,
    });
    expect(row?.levels.find((l) => l.area === "reviews")?.none).toBe(true);
    expect(row?.tools).toBe(4);
  });
});
