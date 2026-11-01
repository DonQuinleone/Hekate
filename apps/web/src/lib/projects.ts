import type { ProjectWithFigures } from "./queries";

export const projectShows = ["all", "owned", "archived"] as const;
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

/** Each filter in words: what it leaves in the list, never a word another column uses. */
export const showLabels: Record<ProjectShow, string> = {
  all: "All",
  owned: "Owned by you",
  archived: "Archived",
};

/**
 * The projects to show, in order. "Owned by you" keeps those you are an owner of, which for
 * most members is a different list from every project they can see (decision 310); archived
 * ones arrive in their own list.
 */
export function arrangeProjects(
  projects: ProjectWithFigures[],
  show: ProjectShow,
  sort: ProjectSort,
): ProjectWithFigures[] {
  const shown = show === "owned" ? projects.filter((p) => p.owned) : [...projects];
  const recent = (p: ProjectWithFigures) => p.figures.lastActiveAt;
  return shown.sort((a, b) => {
    if (sort === "name") return byName.compare(a.name, b.name);
    if (sort === "newest") return b.createdAt.localeCompare(a.createdAt);
    return recent(b).localeCompare(recent(a)) || byName.compare(a.name, b.name);
  });
}
