import { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { Shell } from "~/components/shell";
import { ProjectPage } from "~/routes/project";
import { ProjectsPage } from "~/routes/projects";
import { SettingsPage } from "~/routes/settings";

export const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000 } } });

const root = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: () => (
    <Shell>
      <Outlet />
    </Shell>
  ),
  notFoundComponent: () => <p className="p-8 text-ink-3">Not found.</p>,
});

const projects = createRoute({ getParentRoute: () => root, path: "/", component: ProjectsPage });
const project = createRoute({
  getParentRoute: () => root,
  path: "/projects/$projectId",
  component: function ProjectRoute() {
    const { projectId } = project.useParams();
    return <ProjectPage projectId={projectId} />;
  },
});
const settings = createRoute({
  getParentRoute: () => root,
  path: "/settings",
  component: SettingsPage,
});

export const router = createRouter({
  routeTree: root.addChildren([projects, project, settings]),
  context: { queryClient },
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
