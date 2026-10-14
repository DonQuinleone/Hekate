import { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { Shell } from "~/components/shell";
import { meQuery, setupQuery } from "~/lib/queries";
import { SetupPage, SignInPage } from "~/routes/auth-pages";
import { ProjectPage } from "~/routes/project";
import { ProjectsPage } from "~/routes/projects";
import { SettingsPage } from "~/routes/settings";

export const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000 } } });

const root = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Outlet,
  notFoundComponent: () => <p className="p-8 text-ink-3">Not found.</p>,
});

/** Public pages: first-run setup and sign-in. */
const setup = createRoute({
  getParentRoute: () => root,
  path: "/setup",
  beforeLoad: async ({ context }) => {
    if (!(await context.queryClient.ensureQueryData(setupQuery)))
      throw redirect({ to: "/sign-in" });
  },
  component: SetupPage,
});
const signIn = createRoute({
  getParentRoute: () => root,
  path: "/sign-in",
  beforeLoad: async ({ context }) => {
    if (await context.queryClient.ensureQueryData(setupQuery)) throw redirect({ to: "/setup" });
    if (await context.queryClient.fetchQuery(meQuery)) throw redirect({ to: "/" });
  },
  component: SignInPage,
});

/** Everything else needs a signed-in member. */
const app = createRoute({
  getParentRoute: () => root,
  id: "app",
  beforeLoad: async ({ context }) => {
    if (await context.queryClient.ensureQueryData(setupQuery)) throw redirect({ to: "/setup" });
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (!me) throw redirect({ to: "/sign-in" });
    return { me };
  },
  component: () => (
    <Shell>
      <Outlet />
    </Shell>
  ),
});

const projects = createRoute({ getParentRoute: () => app, path: "/", component: ProjectsPage });
const project = createRoute({
  getParentRoute: () => app,
  path: "/projects/$projectId",
  component: function ProjectRoute() {
    const { projectId } = project.useParams();
    return <ProjectPage projectId={projectId} />;
  },
});
const settings = createRoute({
  getParentRoute: () => app,
  path: "/settings",
  component: SettingsPage,
});

export const router = createRouter({
  routeTree: root.addChildren([setup, signIn, app.addChildren([projects, project, settings])]),
  context: { queryClient },
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
