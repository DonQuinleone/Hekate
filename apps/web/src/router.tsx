import {
  fileKinds,
  type InstanceSection,
  instanceSectionIds,
  searchKinds,
  searchSince,
} from "@hekate/shared";
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
  type Me,
  meQuery,
  SecondFactorDueError,
  SignedOutError,
  SsoRequiredError,
  setupQuery,
  WorkspaceSuspendedError,
} from "~/lib/queries";
import { useFollowSystemTheme } from "~/lib/theme";
import { ViewerProvider } from "~/lib/viewer";
import { AccountPage } from "~/routes/account";
import {
  SecondFactorPage,
  SignInPage,
  type SignInSearch,
  SuspendedPage,
} from "~/routes/auth-pages";
import { BoardPage } from "~/routes/board";
import { ComparePage } from "~/routes/compare";
import { FilePage } from "~/routes/file";
import { GuestHomePage, GuestLinkPage, GuestShell, GuestSignedOutPage } from "~/routes/guest";
import { HomePage } from "~/routes/home";
import { InboxPage } from "~/routes/inbox";
import { InstallerPage } from "~/routes/install";
import { InstancePage } from "~/routes/instance";
import { InvitePage } from "~/routes/invite";
import { NotificationsPage } from "~/routes/notifications";
import { PatchListPage } from "~/routes/patch-list";
import { PersonnelPage } from "~/routes/personnel";
import {
  ProjectFilesPage,
  ProjectOverviewPage,
  ProjectPeoplePage,
  ProjectReviewsPage,
} from "~/routes/project";
import {
  ProjectSettingsPage,
  type ProjectSettingsSection,
  projectSettingsSections,
} from "~/routes/project-settings";
import { ProjectsPage } from "~/routes/projects";
import { RequestReviewPage } from "~/routes/request-review";
import { ReviewPage } from "~/routes/review";
import { ScoreMarkingPage } from "~/routes/score-marking";
import { SearchPage } from "~/routes/search";
import { SessionPage, SessionsPage } from "~/routes/sessions";
import { StagePlanPage } from "~/routes/stage-plan";
import { TakeLogPage } from "~/routes/take-log";
import { TasksPage } from "~/routes/tasks";
import { TrackPage } from "~/routes/track";
import { WorkflowsPage } from "~/routes/workflows";
import { WorkspaceSettingsPage } from "~/routes/workspace-settings";

/** Pages that are not a member's, where a session ending means nothing to undo. */
const outside = /^\/(sign-in|setup|invite|guest|second-factor|suspended|g(\/|$))/;

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
  // The instance's operators suspended the workspace: say why, except on the instance side,
  // which an operator or owner still needs (to reinstate it, or to read where it stands).
  if (
    error instanceof WorkspaceSuspendedError &&
    !outside.test(window.location.pathname) &&
    !window.location.pathname.startsWith("/instance")
  ) {
    void queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
    void router.navigate({ to: "/suspended" });
    return;
  }
  // The workspace now takes its members only through single sign-on: sign in that way.
  if (error instanceof SsoRequiredError && !outside.test(window.location.pathname)) {
    const here = window.location.pathname + window.location.search;
    void router.navigate({
      to: "/sign-in",
      search: { view: "sso", reason: "sso", redirect: here },
    });
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
    .enum(["forgot", "sent", "reset", "code", "recovery", "directory", "sso"])
    .optional()
    .catch(undefined),
  email: z.string().max(254).optional().catch(undefined),
  code: z
    .string()
    .regex(/^\d{6}$/)
    .optional()
    .catch(undefined),
  reason: z.enum(["expired", "sso"]).optional().catch(undefined),
  /** What an identity provider's sign-in came back with, when it failed. */
  error: z
    .string()
    .regex(/^[\w.-]{1,100}$/)
    .optional()
    .catch(undefined),
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
/** A file page's address: the passage looped, and the QA or triage view when one is open. */
const fileSearchSchema = loopSearchSchema.extend({
  view: z.enum(["qa", "triage"]).optional().catch(undefined),
  /** The details sheet, open beside the file. */
  sheet: z.enum(["details"]).optional().catch(undefined),
  /** The review it was opened from, whose decision can be given beside it (#15). */
  review: z.uuid().optional().catch(undefined),
  /** Where to start playing, in seconds: kept while switching version or variation (#15). */
  t: z.coerce.number().min(0).max(172_800).optional().catch(undefined),
  /** A thread to bring into view, as a task made from it links back to it (#140). */
  comment: z.uuid().optional().catch(undefined),
});
const fileSearch = (
  search: Record<string, unknown>,
): {
  loop?: string;
  view?: "qa" | "triage";
  sheet?: "details";
  review?: string;
  t?: number;
  comment?: string;
} => fileSearchSchema.parse(search);

/** Every page: follows the device's dark or light while the theme is "system". */
function Root() {
  useFollowSystemTheme();
  return <Outlet />;
}

const root = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Root,
  notFoundComponent: () => <p className="p-8 text-ink-3">Not found.</p>,
});

/** Public pages: the installer and first-run setup (decision 061), and sign-in. */
const setup = createRoute({
  getParentRoute: () => root,
  path: "/setup",
  beforeLoad: async ({ context }) => {
    if (!(await context.queryClient.ensureQueryData(setupQuery)))
      throw redirect({ to: "/sign-in" });
  },
  component: InstallerPage,
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
    const { loop, view, review, t } = guestFile.useSearch();
    const navigate = guestFile.useNavigate();
    return (
      <FilePage
        fileId={fileId}
        reviewId={review}
        startAt={t}
        onStarted={() =>
          void navigate({ search: (prev) => ({ ...prev, t: undefined }), replace: true })
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

/** A member whose workspace is suspended learns why here, and may go to another of theirs. */
const suspended = createRoute({
  getParentRoute: () => root,
  path: "/suspended",
  beforeLoad: async ({ context }) => {
    const me = await context.queryClient.fetchQuery(meQuery);
    if (!me) throw redirect({ to: "/sign-in", search: {} });
    if (!activeSuspended(me)) throw redirect({ to: "/" });
  },
  component: SuspendedPage,
});

const activeSuspended = (me: Me) =>
  !!me.organisations.find((o) => o.id === me.activeOrganisationId)?.suspended;

/** Everything else needs a signed-in member. */
const app = createRoute({
  getParentRoute: () => root,
  id: "app",
  beforeLoad: async ({ context, location }) => {
    if (await context.queryClient.ensureQueryData(setupQuery)) throw redirect({ to: "/setup" });
    const me = await context.queryClient.ensureQueryData(meQuery);
    if (!me) throw redirect({ to: "/sign-in", search: {} });
    if (!me.secondFactor.met) throw redirect({ to: "/second-factor" });
    // The instance side stays open: an operator reinstates from there.
    if (activeSuspended(me) && !location.pathname.startsWith("/instance"))
      throw redirect({ to: "/suspended" });
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
// Asking for a review: inside the project, optionally of one kind and about one item.
const requestReviewSearch = z.object({
  kind: z.enum(["approval", "feedback"]).optional().catch(undefined),
  item: z
    .string()
    .regex(/^(track|file):[0-9a-f-]{36}$/i)
    .optional()
    .catch(undefined),
});
const requestReview = createRoute({
  getParentRoute: () => app,
  path: "/projects/$projectId/reviews/new",
  validateSearch: requestReviewSearch,
  component: function RequestReviewRoute() {
    const { projectId } = requestReview.useParams();
    const { kind, item } = requestReview.useSearch();
    return <RequestReviewPage projectId={projectId} kind={kind} item={item} />;
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
// The project's board (#141): its tracks by where their workflow has them.
const projectBoard = createRoute({
  getParentRoute: () => app,
  path: "/projects/$projectId/board",
  // The timeline or the calendar, and its month, kept in the address.
  validateSearch: z.object({
    view: z.enum(["timeline", "calendar"]).optional().catch(undefined),
    month: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .optional()
      .catch(undefined),
  }),
  component: function ProjectBoardRoute() {
    const { projectId } = projectBoard.useParams();
    const { view, month } = projectBoard.useSearch();
    const navigate = projectBoard.useNavigate();
    return (
      <BoardPage
        projectId={projectId}
        mode={view ?? "board"}
        month={month}
        onChange={(next) =>
          void navigate({
            search: {
              view: next.mode === "board" ? undefined : next.mode,
              month: next.mode === "calendar" ? next.month : undefined,
            },
            replace: next.mode === "calendar" && view === "calendar",
          })
        }
      />
    );
  },
});
// The project's tasks (#140): one opened beside the list, or a new one being made.
const projectTasks = createRoute({
  getParentRoute: () => app,
  path: "/projects/$projectId/tasks",
  validateSearch: z.object({
    task: z.uuid().optional().catch(undefined),
    new: z.boolean().optional().catch(undefined),
  }),
  component: function ProjectTasksRoute() {
    const { projectId } = projectTasks.useParams();
    const { task, new: creating } = projectTasks.useSearch();
    return <TasksPage projectId={projectId} taskId={task} creating={creating === true} />;
  },
});
// The project's recording sessions (#21, #45), in its Production area.
const projectSessions = createRoute({
  getParentRoute: () => app,
  path: "/projects/$projectId/sessions",
  component: function ProjectSessionsRoute() {
    const { projectId } = projectSessions.useParams();
    return <SessionsPage projectId={projectId} />;
  },
});
// Score marking (#52): a track's score with the producer's marks, in Production.
const projectScoreMarking = createRoute({
  getParentRoute: () => app,
  path: "/projects/$projectId/score-marking",
  validateSearch: z.object({ track: z.uuid().optional().catch(undefined) }),
  component: function ProjectScoreMarkingRoute() {
    const { projectId } = projectScoreMarking.useParams();
    const { track } = projectScoreMarking.useSearch();
    return <ScoreMarkingPage projectId={projectId} trackId={track} />;
  },
});
// Personnel (#49): everyone on the production, in Production.
const projectPersonnel = createRoute({
  getParentRoute: () => app,
  path: "/projects/$projectId/personnel",
  component: function ProjectPersonnelRoute() {
    const { projectId } = projectPersonnel.useParams();
    return <PersonnelPage projectId={projectId} />;
  },
});
// Stage plans (#53): a venue's stage to scale and what stands on it, in Production.
const projectStage = createRoute({
  getParentRoute: () => app,
  path: "/projects/$projectId/stage",
  component: function ProjectStageRoute() {
    const { projectId } = projectStage.useParams();
    return <StagePlanPage projectId={projectId} />;
  },
});
// The patch list (#54): the project's stage boxes and their channels, in Production.
const projectPatch = createRoute({
  getParentRoute: () => app,
  path: "/projects/$projectId/patch",
  component: function ProjectPatchRoute() {
    const { projectId } = projectPatch.useParams();
    return <PatchListPage projectId={projectId} />;
  },
});
const session = createRoute({
  getParentRoute: () => app,
  path: "/sessions/$sessionId",
  component: function SessionRoute() {
    const { sessionId } = session.useParams();
    return <SessionPage sessionId={sessionId} />;
  },
});
// A session's live take log (#51).
const takeLog = createRoute({
  getParentRoute: () => app,
  path: "/sessions/$sessionId/log",
  component: function TakeLogRoute() {
    const { sessionId } = takeLog.useParams();
    return <TakeLogPage sessionId={sessionId} />;
  },
});
// The project's settings: the section in the query string, as in the prototype.
const projectSettings = createRoute({
  getParentRoute: () => app,
  path: "/projects/$projectId/settings",
  validateSearch: z.object({
    section: z
      .enum(projectSettingsSections as [ProjectSettingsSection])
      .optional()
      .catch(undefined),
  }),
  component: function ProjectSettingsRoute() {
    const { projectId } = projectSettings.useParams();
    const { section } = projectSettings.useSearch();
    return <ProjectSettingsPage projectId={projectId} section={section} />;
  },
});
// The project's workflows (#26), opened from its settings, as in the prototype.
const projectWorkflows = createRoute({
  getParentRoute: () => app,
  path: "/projects/$projectId/workflow",
  // Drawn on the canvas, or as lists of steps.
  validateSearch: z.object({
    view: z.enum(["basic", "advanced", "code"]).optional().catch(undefined),
  }),
  component: function ProjectWorkflowsRoute() {
    const { projectId } = projectWorkflows.useParams();
    const { view } = projectWorkflows.useSearch();
    return <WorkflowsPage projectId={projectId} view={view} />;
  },
});
const track = createRoute({
  getParentRoute: () => app,
  path: "/tracks/$trackId",
  // A track opens in the player; its versions and takes pages are asked for by name.
  validateSearch: z.object({ view: z.enum(["versions", "takes"]).optional().catch(undefined) }),
  component: function TrackRoute() {
    const { trackId } = track.useParams();
    const { view } = track.useSearch();
    return <TrackPage trackId={trackId} view={view} />;
  },
});
// Two versions of a track side by side (#137); left out, the latest two.
const trackCompare = createRoute({
  getParentRoute: () => app,
  path: "/tracks/$trackId/compare",
  validateSearch: z.object({
    a: z.coerce.number().int().min(1).optional().catch(undefined),
    b: z.coerce.number().int().min(1).optional().catch(undefined),
  }),
  component: function TrackCompareRoute() {
    const { trackId } = trackCompare.useParams();
    const { a, b } = trackCompare.useSearch();
    return <ComparePage trackId={trackId} a={a} b={b} />;
  },
});
const file = createRoute({
  getParentRoute: () => app,
  path: "/files/$fileId",
  validateSearch: fileSearch,
  component: function FileRoute() {
    const { fileId } = file.useParams();
    const { loop, view, sheet, review, t, comment } = file.useSearch();
    const navigate = file.useNavigate();
    return (
      <FilePage
        fileId={fileId}
        reviewId={review}
        focusComment={comment}
        startAt={t}
        onStarted={() =>
          void navigate({ search: (prev) => ({ ...prev, t: undefined }), replace: true })
        }
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
          void navigate({
            search: (prev) => ({ ...prev, view: next === "review" ? undefined : next }),
          })
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
/** The instance side (#155): operators and workspace owners; the server decides who sees what. */
const instanceHome = createRoute({
  getParentRoute: () => app,
  path: "/instance",
  component: () => <InstancePage section="overview" />,
});
const instanceSection = createRoute({
  getParentRoute: () => app,
  path: "/instance/$section",
  component: function InstanceRoute() {
    const { section } = instanceSection.useParams();
    return (
      <InstancePage
        section={
          (instanceSectionIds as readonly string[]).includes(section)
            ? (section as InstanceSection)
            : "overview"
        }
      />
    );
  },
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
    suspended,
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
      requestReview,
      projectPeople,
      projectBoard,
      projectTasks,
      projectSessions,
      projectScoreMarking,
      projectStage,
      projectPatch,
      projectPersonnel,
      session,
      takeLog,
      projectSettings,
      projectWorkflows,
      track,
      trackCompare,
      file,
      myReviews,
      inbox,
      instanceHome,
      instanceSection,
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
