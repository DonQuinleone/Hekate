import { fileKinds, searchKinds, searchSince } from "@hekate/shared";
import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { useCallback } from "react";
import { z } from "zod";
import { Shell } from "~/components/shell";
import { type BrowserFilters, filtersFrom, filtersTo } from "~/lib/browser";
import { formatLoop, parseLoop } from "~/lib/loop";
import { projectShows, projectSorts, projectViews } from "~/lib/projects";
import {
  guestMeQuery,
  meQuery,
  SecondFactorDueError,
  SignedOutError,
  setupQuery,
} from "~/lib/queries";
import { useFollowSystemTheme } from "~/lib/theme";
import { ViewerProvider } from "~/lib/viewer";
import { AccountPage } from "~/routes/account";
import { SecondFactorPage, SetupPage, SignInPage, type SignInSearch } from "~/routes/auth-pages";
import { FilePage } from "~/routes/file";
import { GuestHomePage, GuestLinkPage, GuestShell, GuestSignedOutPage } from "~/routes/guest";
import { HomePage } from "~/routes/home";
import { InboxPage } from "~/routes/inbox";
import { InvitePage } from "~/routes/invite";
import { NotificationsPage } from "~/routes/notifications";
import {
  ProjectFilesPage,
  ProjectOverviewPage,
  ProjectPeoplePage,
  ProjectReviewsPage,
} from "~/routes/project";
import { ProjectsPage } from "~/routes/projects";
import { ReviewPage } from "~/routes/review";
import { SearchPage } from "~/routes/search";
import { TrackPage } from "~/routes/track";
import { WorkspaceSettingsPage } from "~/routes/workspace-settings";

/** Pages that are not a member's, where a session ending means nothing to undo. */
const outside = /^\/(sign-in|setup|invite|guest|second-factor|g(\/|$))/;

/**
 * A member whose session ends mid-visit (it ran out, or was ended from another device) is
 * taken to sign in, told why, and brought back to where they were.
 */
function onSignedOut(error: unknown) {
  // The workspace now asks for a second factor (an admin just turned it on): add one first.
  if (error instanceof SecondFactorDueError && !outside.test(window.location.pathname)) {
    void queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
    void router.navigate({ to: "/second-factor" });
    return;
  }
  if (!(error instanceof SignedOutError) || outside.test(window.location.pathname)) return;
  if (!queryClient.getQueryData(meQuery.queryKey)) return;
  const here = window.location.pathname + window.location.search;
  queryClient.clear();
  void router.navigate({ to: "/sign-in", search: { reason: "expired", redirect: here } });
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onSignedOut }),
  mutationCache: new MutationCache({ onError: onSignedOut }),
  defaultOptions: { queries: { staleTime: 10_000 } },
});

/** Sign-in's address: where to go after, which state of the forgotten password, and why. */
const signInSearch = z.object({
  redirect: z.string().max(2000).optional().catch(undefined),
  view: z
    .enum(["forgot", "sent", "reset", "code", "recovery", "directory"])
    .optional()
    .catch(undefined),
  email: z.string().max(254).optional().catch(undefined),
  code: z
    .string()
    .regex(/^\d{6}$/)
    .optional()
    .catch(undefined),
  reason: z.enum(["expired"]).optional().catch(undefined),
});

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
  /** The details sheet, open beside the file. */
  sheet: z.enum(["details"]).optional().catch(undefined),
});
const fileSearch = (
  search: Record<string, unknown>,
): { loop?: string; view?: "qa"; sheet?: "details" } => fileSearchSchema.parse(search);

/** Every page: follows the device's dark or light while the theme is "system". */
function Root() {
  useFollowSystemTheme();
  return <Outlet />;
}

const root = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Root,
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
  validateSearch: (search: Record<string, unknown>): SignInSearch => signInSearch.parse(search),
  beforeLoad: async ({ context, search }) => {
    if (await context.queryClient.ensureQueryData(setupQuery)) throw redirect({ to: "/setup" });
    // Someone signed in has nothing to do here, unless they came to set a new password.
    if (!search.redirect && !search.view && (await context.queryClient.fetchQuery(meQuery)))
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

/** A member who owes a second factor adds one here before anything else. */
const secondFactor = createRoute({
  getParentRoute: () => root,
  path: "/second-factor",
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.fetchQuery(meQuery);
    if (!me) throw redirect({ to: "/sign-in", search: {} });
    if (me.secondFactor.met) throw redirect({ to: "/" });
  },
  component: SecondFactorPage,
});

/** Everything else needs a signed-in member. */
const app = createRoute({
  getParentRoute: () => root,
  id: "app",
  beforeLoad: async ({ context }) => {
    if (await context.queryClient.ensureQueryData(setupQuery)) throw redirect({ to: "/setup" });
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (!me) throw redirect({ to: "/sign-in", search: {} });
    if (!me.secondFactor.met) throw redirect({ to: "/second-factor" });
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
/** The projects page's address: which projects, in what order, how shown; `new=1` opens the form. */
const projectsSearchSchema = z.object({
  show: z.enum(projectShows).optional().catch(undefined),
  sort: z.enum(projectSorts).optional().catch(undefined),
  view: z.enum(projectViews).optional().catch(undefined),
  new: z.coerce.number().pipe(z.literal(1)).optional().catch(undefined),
});
const projects = createRoute({
  getParentRoute: () => app,
  path: "/projects",
  validateSearch: (search: Record<string, unknown>) => projectsSearchSchema.parse(search),
  component: function ProjectsRoute() {
    const search = projects.useSearch();
    const navigate = projects.useNavigate();
    return (
      <ProjectsPage
        show={search.show}
        sort={search.sort}
        view={search.view}
        onChange={(next) =>
          void navigate({ search: (prev) => ({ ...prev, ...next }), replace: true })
        }
        creatingFirst={search.new === 1}
        onCreatingDone={() => {
          if (search.new === 1)
            void navigate({ search: ({ new: _, ...rest }) => rest, replace: true });
        }}
      />
    );
  },
});
const folderSearch = (search: Record<string, unknown>): { folder?: string } =>
  typeof search.folder === "string" && /^[0-9a-f-]{36}$/i.test(search.folder)
    ? { folder: search.folder }
    : {};
// A project opens on its overview; an address with a folder in it still opens the files there.
const project = createRoute({
  getParentRoute: () => app,
  path: "/projects/$projectId",
  validateSearch: folderSearch,
  beforeLoad: ({ params, search }) => {
    if (search.folder) throw redirect({ to: "/projects/$projectId/files", params, search });
  },
  component: function ProjectRoute() {
    const { projectId } = project.useParams();
    return <ProjectOverviewPage projectId={projectId} />;
  },
});
const projectFiles = createRoute({
  getParentRoute: () => app,
  path: "/projects/$projectId/files",
  // The open folder and the filters live in the address, so they survive a reload and can be
  // shared. Opening a folder leaves the filters behind.
  validateSearch: (search: Record<string, unknown>) => ({
    ...folderSearch(search),
    ...filtersTo(filtersFrom(search)),
  }),
  component: function ProjectFilesRoute() {
    const { projectId } = projectFiles.useParams();
    const search = projectFiles.useSearch();
    const navigate = projectFiles.useNavigate();
    const open = useCallback(
      (next: string | null) =>
        void navigate({ search: next ? { folder: next } : {}, replace: false }),
      [navigate],
    );
    const filter = useCallback(
      (next: BrowserFilters) =>
        void navigate({
          search: ({ folder }) => ({ ...(folder ? { folder } : {}), ...filtersTo(next) }),
          replace: true,
        }),
      [navigate],
    );
    return (
      <ProjectFilesPage
        projectId={projectId}
        folderId={search.folder ?? null}
        onOpenFolder={open}
        filters={filtersFrom(search)}
        onFilter={filter}
      />
    );
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
    const { loop, view, sheet } = file.useSearch();
    const navigate = file.useNavigate();
    return (
      <FilePage
        fileId={fileId}
        details={sheet === "details"}
        onDetails={(open) =>
          void navigate({
            search: (prev) => ({ ...prev, sheet: open ? "details" : undefined }),
            replace: true,
          })
        }
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
/** A search's words and filters, from its address; anything that does not read is dropped. */
const searchPageSchema = z.object({
  // Untrimmed: the field writes what is typed, trailing space and all.
  q: z.string().max(200).optional().catch(undefined),
  kind: z.enum(searchKinds).optional().catch(undefined),
  projectId: z.uuid().optional().catch(undefined),
  personId: z.string().min(1).max(100).optional().catch(undefined),
  fileKind: z.enum(fileKinds).optional().catch(undefined),
  tagId: z.uuid().optional().catch(undefined),
  since: z.enum(searchSince).optional().catch(undefined),
});
const searchPage = createRoute({
  getParentRoute: () => app,
  path: "/search",
  validateSearch: (search: Record<string, unknown>) => searchPageSchema.parse(search),
  component: function SearchRoute() {
    const search = searchPage.useSearch();
    return <SearchPage search={{ ...search, q: search.q ?? "" }} />;
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
    throw redirect({ to: "/account/$section", params: { section: "account" } });
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

/**
 * The design system reference: in development and in the build the visual suite captures
 * (VITE_REFERENCE=1), never in a release, where this branch and its chunk are left out.
 */
const reference =
  import.meta.env.DEV || import.meta.env.VITE_REFERENCE === "1"
    ? [
        createRoute({
          getParentRoute: () => root,
          path: "/reference",
          component: lazyRouteComponent(() => import("~/routes/reference")),
        }),
      ]
    : [];

export const router = createRouter({
  routeTree: root.addChildren([
    secondFactor,
    setup,
    signIn,
    invite,
    guestLink,
    guestSignedOut,
    guestApp.addChildren([guestHome, guestReview, guestFile]),
    ...reference,
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
      searchPage,
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
