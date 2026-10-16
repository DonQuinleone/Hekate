import { useLocation } from "@tanstack/react-router";
import type { IconName } from "~/components/icons";
import {
  fileById,
  type Project,
  projectById,
  reviewById,
  reviews,
  sessions,
  takeById,
  tasks,
  trackById,
} from "~/data";
import type { Viewer } from "~/viewer/context";

/** The project the current page belongs to, whatever the page is: the sidebar follows it. */
export function useCurrentProject(): Project | undefined {
  const { pathname, search } = useLocation();
  const [, head = "", id = ""] = pathname.split("/");
  let projectId: string | undefined;
  if (head === "projects") projectId = id;
  else if (head === "tracks") projectId = trackById(id)?.projectId;
  else if (head === "files") projectId = fileById(id)?.projectId;
  else if (head === "reviews")
    projectId = id === "new" ? (search as { project?: string }).project : reviewById(id)?.projectId;
  else if (head === "sessions") projectId = sessions.find((s) => s.id === id)?.projectId;
  else if (head === "takes") {
    const take = takeById(id);
    projectId = take ? sessions.find((s) => s.id === take.sessionId)?.projectId : undefined;
  }
  return projectId ? projectById(projectId) : undefined;
}

export interface ProjectNavItem {
  id: string;
  label: string;
  icon: IconName;
  count?: number;
  /** Other views that light this item up. */
  also?: string[];
}

/** The project's primary navigation: what the sidebar shows once a project is open. */
export function projectNav(project: Project, viewer: Viewer): ProjectNavItem[] {
  const items: ProjectNavItem[] = [
    { id: "overview", label: "Overview", icon: "dashboard" },
    { id: "files", label: "Files", icon: "folder" },
    { id: "board", label: "Board", icon: "board" },
    {
      id: "reviews",
      label: "Reviews",
      icon: "review",
      count: reviews.filter((r) => r.projectId === project.id && r.status === "open").length,
    },
    {
      id: "tasks",
      label: "Tasks",
      icon: "task",
      count: tasks.filter((t) => t.projectId === project.id && t.status !== "done").length,
    },
    { id: "people", label: "People", icon: "users" },
  ];
  if (project.profile === "music" && viewer.tools(project.id).has("production"))
    items.push({
      id: "production",
      label: "Production",
      icon: "mic",
      also: ["coverage", "sessions"],
    });
  if (viewer.can(project.id, "manage_roles") || viewer.can(project.id, "edit_workflows"))
    items.push({ id: "settings", label: "Settings", icon: "sliders", also: ["workflow"] });
  return items;
}

export const viewLabel = (project: Project, viewer: Viewer, view: string): string =>
  projectNav(project, viewer).find((i) => i.id === view || i.also?.includes(view))?.label ??
  project.name;
