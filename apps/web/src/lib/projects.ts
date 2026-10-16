import type { ProjectWithFigures } from "./queries";

export const projectShows = ["all", "mine", "archived"] as const;
export type ProjectShow = (typeof projectShows)[number];
export const projectSorts = ["recent", "name", "newest"] as const;
export type ProjectSort = (typeof projectSorts)[number];
export const projectViews = ["cards", "list"] as const;
export type ProjectView = (typeof projectViews)[number];

export const sortLabels: Record<ProjectSort, string> = {
  recent: "Recently active",
  name: "Name",
  newest: "Newest",
};

const byName = new Intl.Collator("en-GB", { sensitivity: "base", numeric: true });

/**
 * The projects to show, in order. "Mine" keeps those you are a member of (an admin sees every
 * project, and may want only their own); archived ones arrive in their own list.
 */
export function arrangeProjects(
  projects: ProjectWithFigures[],
  show: ProjectShow,
  sort: ProjectSort,
): ProjectWithFigures[] {
  const shown = show === "mine" ? projects.filter((p) => p.mine) : [...projects];
  const recent = (p: ProjectWithFigures) => p.figures.lastActiveAt;
  return shown.sort((a, b) => {
    if (sort === "name") return byName.compare(a.name, b.name);
    if (sort === "newest") return b.createdAt.localeCompare(a.createdAt);
    return recent(b).localeCompare(recent(a)) || byName.compare(a.name, b.name);
  });
}
