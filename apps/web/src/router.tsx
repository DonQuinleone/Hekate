import { QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { useCallback } from "react";
import { z } from "zod";
import { Shell } from "~/components/shell";
import { formatLoop, parseLoop } from "~/lib/loop";
import { guestMeQuery, meQuery, setupQuery } from "~/lib/queries";
import { ViewerProvider } from "~/lib/viewer";
import { AccountPage } from "~/routes/account";
import { SetupPage, SignInPage } from "~/routes/auth-pages";
import { FilePage } from "~/routes/file";
import { GuestHomePage, GuestLinkPage, GuestShell, GuestSignedOutPage } from "~/routes/guest";
import { HomePage } from "~/routes/home";
import { InboxPage } from "~/routes/inbox";
import { InvitePage } from "~/routes/invite";
import { NotificationsPage } from "~/routes/notifications";
import { ProjectFilesPage, ProjectPeoplePage, ProjectReviewsPage } from "~/routes/project";
import { ProjectsPage } from "~/routes/projects";
import { ReviewPage } from "~/routes/review";
import { TrackPage } from "~/routes/track";
import { WorkspaceSettingsPage } from "~/routes/workspace-settings";

export const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 10_000 } } });

/** A file page's loop, from its address: kept only when it reads as one. */
const loopSearchSchema = z.object({
  loop: z
    .string()
    .max(40)
    .refine((text) => parseLoop(text) !== null)
    .optional()
    .catch(undefined),
});
/** A file page's address: the passage looped, and the QA view when it is open. */
const fileSearchSchema = loopSearchSchema.extend({
  view: z.enum(["qa"]).optional().catch(undefined),
});
const fileSearch = (search: Record<string, unknown>): { loop?: string; view?: "qa" } =>
  fileSearchSchema.parse(search);

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
  validateSearch: fileSearch,
  component: function GuestFileRoute() {
    const { fileId } = guestFile.useParams();
    const { loop, view } = guestFile.useSearch();
    const navigate = guestFile.useNavigate();
    return (
      <FilePage
        fileId={fileId}
        loop={parseLoop(loop)}
        onLoop={(next) =>
          void navigate({
            search: (prev) => ({ ...prev, loop: next ? formatLoop(next) : undefined }),
            replace: true,
          })
        }
        view={view ?? "review"}
        onView={(next) =>
          void navigate({ search: (prev) => ({ ...prev, view: next === "qa" ? "qa" : undefined }) })
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

const home = createRoute({
  getParentRoute: () => app,
  path: "/",
  component: HomePage,
});
const projects = createRoute({
  getParentRoute: () => app,
  path: "/projects",
  // `?new=1` opens the form for a new project, as the palette's action does.
  validateSearch: (search: Record<string, unknown>): { new?: 1 } =>
    search.new === 1 || search.new === "1" ? { new: 1 } : {},
  component: function ProjectsRoute() {
    const search = projects.useSearch();
    const navigate = projects.useNavigate();
    return (
      <ProjectsPage
        creatingFirst={search.new === 1}
        onCreatingDone={() => {
          if (search.new === 1) void navigate({ search: {}, replace: true });
        }}
      />
    );
  },
});
const folderSearch = (search: Record<string, unknown>): { folder?: string } =>
  typeof search.folder === "string" && /^[0-9a-f-]{36}$/i.test(search.folder)
    ? { folder: search.folder }
    : {};
// A project opens on its files until its overview arrives (#113).
const project = createRoute({
  getParentRoute: () => app,
  path: "/projects/$projectId",
  validateSearch: folderSearch,
  beforeLoad: ({ params, search }) => {
    throw redirect({ to: "/projects/$projectId/files", params, search });
  },
});
const projectFiles = createRoute({
  getParentRoute: () => app,
  path: "/projects/$projectId/files",
  // The open folder lives in the address, so it survives a reload and can be shared.
  validateSearch: folderSearch,
  component: function ProjectFilesRoute() {
    const { projectId } = projectFiles.useParams();
    const { folder } = projectFiles.useSearch();
    const navigate = projectFiles.useNavigate();
    const open = useCallback(
      (next: string | null) =>
        void navigate({ search: next ? { folder: next } : {}, replace: false }),
      [navigate],
    );
    return <ProjectFilesPage projectId={projectId} folderId={folder ?? null} onOpenFolder={open} />;
  },
});
const projectReviews = createRoute({
  getParentRoute: () => app,
  path: "/projects/$projectId/reviews",
  component: function ProjectReviewsRoute() {
    const { projectId } = projectReviews.useParams();
    return <ProjectReviewsPage projectId={projectId} />;
  },
});
const projectPeople = createRoute({
  getParentRoute: () => app,
  path: "/projects/$projectId/people",
  component: function ProjectPeopleRoute() {
    const { projectId } = projectPeople.useParams();
    return <ProjectPeoplePage projectId={projectId} />;
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
  validateSearch: fileSearch,
  component: function FileRoute() {
    const { fileId } = file.useParams();
    const { loop, view } = file.useSearch();
    const navigate = file.useNavigate();
    return (
      <FilePage
        fileId={fileId}
        loop={parseLoop(loop)}
        onLoop={(next) =>
          void navigate({
            search: (prev) => ({ ...prev, loop: next ? formatLoop(next) : undefined }),
            replace: true,
          })
        }
        view={view ?? "review"}
        onView={(next) =>
          void navigate({ search: (prev) => ({ ...prev, view: next === "qa" ? "qa" : undefined }) })
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
const inboxSearch = z.object({
  item: z.string().uuid().optional().catch(undefined),
  show: z.enum(["needs", "following", "done"]).optional().catch(undefined),
});
const inbox = createRoute({
  getParentRoute: () => app,
  path: "/inbox",
  validateSearch: (search: Record<string, unknown>) => inboxSearch.parse(search),
  component: function InboxRoute() {
    const { item, show } = inbox.useSearch();
    return <InboxPage item={item} show={show} />;
  },
});
const notifications = createRoute({
  getParentRoute: () => app,
  path: "/notifications",
  component: NotificationsPage,
});
const account = createRoute({
  getParentRoute: () => app,
  path: "/account",
  beforeLoad: () => {
    throw redirect({ to: "/account/$section", params: { section: "notifications" } });
  },
});
const accountSection = createRoute({
  getParentRoute: () => app,
  path: "/account/$section",
  component: function AccountRoute() {
    const { section } = accountSection.useParams();
    return <AccountPage section={section} />;
  },
});
// The reviews list became the inbox; the old address still works.
const myReviews = createRoute({
  getParentRoute: () => app,
  path: "/reviews",
  beforeLoad: () => {
    throw redirect({ to: "/inbox", search: {} });
  },
});
// Members live in the workspace's settings now (decision 038); the old address still works.
const members = createRoute({
  getParentRoute: () => app,
  path: "/members",
  beforeLoad: () => {
    throw redirect({ to: "/settings/$section", params: { section: "members" } });
  },
});
const settingsHome = createRoute({
  getParentRoute: () => app,
  path: "/settings",
  beforeLoad: () => {
    throw redirect({ to: "/settings/$section", params: { section: "general" } });
  },
});
const settings = createRoute({
  getParentRoute: () => app,
  path: "/settings/$section",
  component: function SettingsRoute() {
    const { section } = settings.useParams();
    return <WorkspaceSettingsPage section={section} />;
  },
});

export const router = createRouter({
  routeTree: root.addChildren([
    setup,
    signIn,
    invite,
    guestLink,
    guestSignedOut,
    guestApp.addChildren([guestHome, guestReview, guestFile]),
    app.addChildren([
      home,
      projects,
      project,
      projectFiles,
      projectReviews,
      projectPeople,
      track,
      file,
      myReviews,
      inbox,
      notifications,
      account,
      accountSection,
      review,
      members,
      settingsHome,
      settings,
    ]),
  ]),
  context: { queryClient },
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
