import { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { useCallback } from "react";
import { Shell } from "~/components/shell";
import { formatLoop, parseLoop } from "~/lib/loop";
import { guestMeQuery, meQuery, setupQuery } from "~/lib/queries";
import { ViewerProvider } from "~/lib/viewer";
import { SetupPage, SignInPage } from "~/routes/auth-pages";
import { FilePage } from "~/routes/file";
import { GuestHomePage, GuestLinkPage, GuestShell, GuestSignedOutPage } from "~/routes/guest";
import { InvitePage } from "~/routes/invite";
import { ProjectPage } from "~/routes/project";
import { ProjectsPage } from "~/routes/projects";
import { ReviewPage } from "~/routes/review";
import { SettingsPage } from "~/routes/settings";
import { TrackPage } from "~/routes/track";

export const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000 } } });

/** A file page's loop, from its address: kept only when it reads as one. */
const loopSearch = (search: Record<string, unknown>): { loop?: string } =>
  typeof search.loop === "string" && parseLoop(search.loop) ? { loop: search.loop } : {};

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

/** Guest reviewers: a magic link, and the pages of their reviews (docs/security.md). */
const guestLink = createRoute({
  getParentRoute: () => root,
  path: "/guest/$token",
  component: function GuestLinkRoute() {
    const { token } = guestLink.useParams();
    return <GuestLinkPage token={token} />;
  },
});
const guestSignedOut = createRoute({
  getParentRoute: () => root,
  path: "/guest",
  component: GuestSignedOutPage,
});
const guestApp = createRoute({
  getParentRoute: () => root,
  id: "guest-app",
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.ensureQueryData(guestMeQuery);
    if (!me) throw redirect({ to: "/guest" });
  },
  component: () => (
    <ViewerProvider viewer={{ guest: true }}>
      <GuestShell>
        <Outlet />
      </GuestShell>
    </ViewerProvider>
  ),
});
const guestHome = createRoute({
  getParentRoute: () => guestApp,
  path: "/g",
  component: GuestHomePage,
});
const guestReview = createRoute({
  getParentRoute: () => guestApp,
  path: "/g/reviews/$reviewId",
  component: function GuestReviewRoute() {
    const { reviewId } = guestReview.useParams();
    return <ReviewPage reviewId={reviewId} />;
  },
});
const guestFile = createRoute({
  getParentRoute: () => guestApp,
  path: "/g/files/$fileId",
  validateSearch: loopSearch,
  component: function GuestFileRoute() {
    const { fileId } = guestFile.useParams();
    const { loop } = guestFile.useSearch();
    const navigate = guestFile.useNavigate();
    return (
      <FilePage
        fileId={fileId}
        loop={parseLoop(loop)}
        onLoop={(next) =>
          void navigate({ search: next ? { loop: formatLoop(next) } : {}, replace: true })
        }
      />
    );
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
  // The open folder lives in the address, so it survives a reload and can be shared.
  validateSearch: (search: Record<string, unknown>): { folder?: string } =>
    typeof search.folder === "string" && /^[0-9a-f-]{36}$/i.test(search.folder)
      ? { folder: search.folder }
      : {},
  component: function ProjectRoute() {
    const { projectId } = project.useParams();
    const { folder } = project.useSearch();
    const navigate = project.useNavigate();
    const open = useCallback(
      (next: string | null) =>
        void navigate({ search: next ? { folder: next } : {}, replace: false }),
      [navigate],
    );
    return <ProjectPage projectId={projectId} folderId={folder ?? null} onOpenFolder={open} />;
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
  validateSearch: loopSearch,
  component: function FileRoute() {
    const { fileId } = file.useParams();
    const { loop } = file.useSearch();
    const navigate = file.useNavigate();
    return (
      <FilePage
        fileId={fileId}
        loop={parseLoop(loop)}
        onLoop={(next) =>
          void navigate({ search: next ? { loop: formatLoop(next) } : {}, replace: true })
        }
      />
    );
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
    guestLink,
    guestSignedOut,
    guestApp.addChildren([guestHome, guestReview, guestFile]),
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
