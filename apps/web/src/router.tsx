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
import { FilePage } from "~/routes/file";
import { InvitePage } from "~/routes/invite";
import { ProjectPage } from "~/routes/project";
import { ProjectsPage } from "~/routes/projects";
import { ReviewPage } from "~/routes/review";
import { SettingsPage } from "~/routes/settings";
import { TrackPage } from "~/routes/track";

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
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    typeof search.redirect === "string" ? { redirect: search.redirect } : {},
  beforeLoad: async ({ context, search }) => {
    if (await context.queryClient.ensureQueryData(setupQuery)) throw redirect({ to: "/setup" });
    if (!search.redirect && (await context.queryClient.fetchQuery(meQuery)))
      throw redirect({ to: "/" });
  },
  component: SignInPage,
});
const invite = createRoute({
  getParentRoute: () => root,
  path: "/invite/$token",
  component: function InviteRoute() {
    const { token } = invite.useParams();
    return <InvitePage token={token} />;
  },
});

/** Everything else needs a signed-in member. */
const app = createRoute({
  getParentRoute: () => root,
  id: "app",
  beforeLoad: async ({ context }) => {
    if (await context.queryClient.ensureQueryData(setupQuery)) throw redirect({ to: "/setup" });
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (!me) throw redirect({ to: "/sign-in", search: {} });
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
const track = createRoute({
  getParentRoute: () => app,
  path: "/tracks/$trackId",
  component: function TrackRoute() {
    const { trackId } = track.useParams();
    return <TrackPage trackId={trackId} />;
  },
});
const file = createRoute({
  getParentRoute: () => app,
  path: "/files/$fileId",
  component: function FileRoute() {
    const { fileId } = file.useParams();
    return <FilePage fileId={fileId} />;
  },
});
const review = createRoute({
  getParentRoute: () => app,
  path: "/reviews/$reviewId",
  component: function ReviewRoute() {
    const { reviewId } = review.useParams();
    return <ReviewPage reviewId={reviewId} />;
  },
});
const settings = createRoute({
  getParentRoute: () => app,
  path: "/members",
  component: SettingsPage,
});

export const router = createRouter({
  routeTree: root.addChildren([
    setup,
    signIn,
    invite,
    app.addChildren([projects, project, track, file, review, settings]),
  ]),
  context: { queryClient },
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
