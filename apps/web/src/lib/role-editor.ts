import {
  type AccessArea,
  type AccessLevels,
  accessAreas,
  type PlayerTool,
  type ProjectPermission,
  permissionNames,
  playerTools,
} from "@hekate/shared";

/**
 * Roles and access, one role at a time (#506): the pure part of the editor. A role holds one
 * level in each area, and each level past None grants one permission (and those before it), so
 * an area reads as a list of rows, one per permission, and a row is on when the area's level
 * reaches it.
 */

/** One row of an area: the level that grants it and the permission it is. */
export interface AreaRow {
  level: string;
  permission: ProjectPermission;
  label: string;
}

/** An area as the editor shows it: its levels for the picker in its header, and its rows. */
export interface AreaGroup {
  id: AccessArea;
  label: string;
  hint: string;
  levels: { id: string; label: string }[];
  rows: AreaRow[];
}

/** Every area, in order, with a row for each permission it grants. */
export function permissionGroups(): AreaGroup[] {
  return accessAreas.map((area) => ({
    id: area.id,
    label: area.label,
    hint: area.hint,
    levels: area.levels.map((l) => ({ id: l.id, label: l.label })),
    rows: area.levels.flatMap((l) =>
      l.grants.map((permission) => ({
        level: l.id,
        permission,
        label: permissionNames[permission],
      })),
    ),
  }));
}

/** Where a level sits in its area: 0 for None; -1 for one the area does not have. */
export function levelIndex(area: AccessArea, level: string): number {
  return (accessAreas.find((a) => a.id === area)?.levels ?? []).findIndex((l) => l.id === level);
}

/** Whether a row is on: the area's level reaches the row's. */
export function rowOn(levels: AccessLevels, area: AccessArea, rowLevel: string): boolean {
  const at = levelIndex(area, rowLevel);
  return at > 0 && levelIndex(area, levels[area]) >= at;
}

/** Every row of an area set at once: the area at that level. A level it does not have changes nothing. */
export function setAreaLevel(levels: AccessLevels, area: AccessArea, level: string): AccessLevels {
  if (levelIndex(area, level) < 0) return levels;
  return { ...levels, [area]: level } as AccessLevels;
}

/**
 * One row switched: on, the area rises to that row (bringing the rows before it); off, it
 * falls to the level before that row (taking the rows after it too).
 */
export function setRow(
  levels: AccessLevels,
  area: AccessArea,
  rowLevel: string,
  on: boolean,
): AccessLevels {
  const at = levelIndex(area, rowLevel);
  const list = accessAreas.find((a) => a.id === area)?.levels;
  if (!list || at <= 0) return levels;
  const level = on ? rowLevel : list[at - 1]?.id;
  return level ? setAreaLevel(levels, area, level) : levels;
}

/** A role as the editor needs it. */
export interface EditableRole {
  id: string;
  name: string;
  levels: AccessLevels;
  tools: readonly PlayerTool[];
}

/**
 * The lowest level a role may be set to in an area: the only role that manages people keeps
 * that level, so the project is never left without someone to run it (the server holds the
 * same rule). Anywhere else, None.
 */
export function lowestLevel(
  role: EditableRole,
  roles: readonly EditableRole[],
  area: AccessArea,
): string {
  if (area === "people" && role.levels.people === "manage") {
    const managers = roles.filter((r) => r.levels.people === "manage");
    if (managers.length === 1 && managers[0]?.id === role.id) return "manage";
  }
  return "none";
}

/** A name not yet taken among the roles, for a copy of one: "Engineer copy", then "Engineer copy 2". */
export function copyName(name: string, taken: readonly string[]): string {
  const base = `${name} copy`.slice(0, 60);
  let candidate = base;
  for (let n = 2; taken.includes(candidate); n++) candidate = `${base.slice(0, 54)} ${n}`;
  return candidate;
}

/** A new role copied from another: every level and every tool, under a name not yet taken. */
export function copyOf(
  source: EditableRole,
  roles: readonly EditableRole[],
): { name: string; levels: AccessLevels; tools: PlayerTool[] } {
  return {
    name: copyName(
      source.name,
      roles.map((r) => r.name),
    ),
    levels: { ...source.levels },
    tools: [...source.tools],
  };
}

/** A role given another's every level and tool: its own name (and people) stay. */
export function copiedInto(
  target: EditableRole,
  source: EditableRole,
): { id: string; name: string; levels: AccessLevels; tools: PlayerTool[] } {
  return {
    id: target.id,
    name: target.name,
    levels: { ...source.levels },
    tools: [...source.tools],
  };
}

/** A role's tools with one switched, in the player's order. */
export function withTool(
  tools: readonly PlayerTool[],
  tool: PlayerTool,
  on: boolean,
): PlayerTool[] {
  return playerTools.filter((t) => (t === tool ? on : tools.includes(t)));
}

/** Every role's level in each area, by its label, and its tools: the read-only comparison. */
export function compareRows(roles: readonly EditableRole[]): {
  id: string;
  name: string;
  levels: { area: AccessArea; label: string; none: boolean }[];
  tools: number;
}[] {
  return roles.map((role) => ({
    id: role.id,
    name: role.name,
    levels: accessAreas.map((area) => {
      const level = role.levels[area.id];
      return {
        area: area.id,
        label: area.levels.find((l) => l.id === level)?.label ?? level,
        none: level === "none",
      };
    }),
    tools: role.tools.length,
  }));
}
