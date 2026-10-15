import {
  createHashHistory,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { PageHeaderProvider } from "~/components/page-header";
import { GuestShell, InstanceShell, Shell } from "~/components/shell";
import { appRoot } from "~/lib/dom";
import { AccountPage } from "~/routes/account";
import {
  GuestLinkPage,
  GuestSignedOutPage,
  InstallerPage,
  InvitationPage,
  SignInPage,
  UploadRequestPage,
} from "~/routes/arrive";
import { ComparePage } from "~/routes/compare";
import { DashboardPage } from "~/routes/dashboard";
import { FilePage } from "~/routes/file";
import { GuestHomePage } from "~/routes/guest";
import { InboxPage } from "~/routes/home";
import { InstancePage } from "~/routes/instance";
import { MembersPage } from "~/routes/members";
import { NotificationsPage, SearchPage } from "~/routes/misc";
import { ProjectPage } from "~/routes/project";
import { ProjectsPage } from "~/routes/projects";
import { RequestReviewPage } from "~/routes/request-review";
import { ReviewPage } from "~/routes/review";
import { SettingsPage } from "~/routes/settings";
import { SessionPage, TakePage } from "~/routes/takes";
import { TrackPage } from "~/routes/track";
import { useViewer, ViewerProvider } from "~/viewer/context";
import { Frame } from "~/viewer/frame";
import { Switcher } from "~/viewer/switcher";

/** The named search parameters, each kept only when it is a string, so every one is optional. */
function pick<K extends string>(s: Record<string, unknown>, keys: K[]): Partial<Record<K, string>> {
  const out: Partial<Record<K, string>> = {};
  for (const k of keys) if (typeof s[k] === "string") out[k] = s[k] as string;
  return out;
}

function history() {
  try {
    const h = createHashHistory();
    void h.location;
    return h;
  } catch {
    return createMemoryHistory();
  }
}

function Root() {
  return (
    <ViewerProvider>
      <PageHeaderProvider>
        <Frame>
          <Outlet />
        </Frame>
        <Switcher />
      </PageHeaderProvider>
    </ViewerProvider>
  );
}

const root = createRootRoute({
  component: Root,
  notFoundComponent: () => (
    <div className="mx-auto max-w-md px-6 py-16">
      <h1 className="text-[16px] font-medium">Not found</h1>
      <p className="mt-1 text-ink-2">
        There is nothing at this address, or you do not have access to it.
      </p>
    </div>
  ),
});

/** Scrolls the main pane to the top on each page. */
function ScrollTop() {
  useEffect(() => {
    appRoot().querySelector("main")?.scrollTo({ top: 0 });
  });
  return null;
}

/** Members' pages: a guest or an operator who lands here is sent to their own side. */
function App() {
  const viewer = useViewer();
  if (viewer.isGuest) return <GuestSignedOutPage />;
  if (viewer.isInstance)
    return (
      <InstanceShell>
        <InstancePage section="overview" />
      </InstanceShell>
    );
  return (
    <Shell>
      <ScrollTop />
      <Outlet />
    </Shell>
  );
}

function GuestApp() {
  const viewer = useViewer();
  if (!viewer.isGuest) return <GuestSignedOutPage />;
  return (
    <GuestShell>
      <ScrollTop />
      <Outlet />
    </GuestShell>
  );
}

function InstanceApp() {
  const viewer = useViewer();
  if (!viewer.isInstance) return <SignInPage />;
  return (
    <InstanceShell>
      <ScrollTop />
      <Outlet />
    </InstanceShell>
  );
}

const signIn = createRoute({ getParentRoute: () => root, path: "/sign-in", component: SignInPage });
const guestLink = createRoute({
  getParentRoute: () => root,
  path: "/guest/link",
  component: GuestLinkPage,
});
const guestOut = createRoute({
  getParentRoute: () => root,
  path: "/guest",
  component: GuestSignedOutPage,
});

const install = createRoute({
  getParentRoute: () => root,
  path: "/install",
  component: InstallerPage,
});
const invite = createRoute({
  getParentRoute: () => root,
  path: "/invite",
  component: InvitationPage,
});
const uploadRequest = createRoute({
  getParentRoute: () => root,
  path: "/u/$code",
  component: function UploadRequestRoute() {
    const { code } = uploadRequest.useParams();
    return <UploadRequestPage code={code} />;
  },
});
const app = createRoute({ getParentRoute: () => root, id: "app", component: App });
const home = createRoute({ getParentRoute: () => app, path: "/", component: DashboardPage });
const inbox = createRoute({
  getParentRoute: () => app,
  path: "/inbox",
  validateSearch: (s: Record<string, unknown>) => pick(s, ["item"]),
  component: function InboxRoute() {
    const search = inbox.useSearch();
    return <InboxPage item={search.item} />;
  },
});
const requestReview = createRoute({
  getParentRoute: () => app,
  path: "/reviews/new",
  validateSearch: (s: Record<string, unknown>) => pick(s, ["project", "kind", "item"]),
  component: function RequestReviewRoute() {
    const search = requestReview.useSearch();
    return <RequestReviewPage projectId={search.project} kind={search.kind} item={search.item} />;
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
const projectsRoute = createRoute({
  getParentRoute: () => app,
  path: "/projects",
  validateSearch: (s: Record<string, unknown>) => pick(s, ["new"]),
  component: function ProjectsRoute() {
    const search = projectsRoute.useSearch();
    return <ProjectsPage create={search.new === "1"} />;
  },
});
const project = createRoute({
  getParentRoute: () => app,
  path: "/projects/$projectId",
  validateSearch: (s: Record<string, unknown>) => pick(s, ["folder", "section", "task", "month"]),
  component: function ProjectRoute() {
    const { projectId } = project.useParams();
    const search = project.useSearch();
    return (
      <ProjectPage
        projectId={projectId}
        view="overview"
        folderId={search.folder}
        section={search.section}
        taskId={search.task}
        month={search.month}
      />
    );
  },
});
const projectView = createRoute({
  getParentRoute: () => app,
  path: "/projects/$projectId/$view",
  validateSearch: (s: Record<string, unknown>) =>
    pick(s, ["folder", "section", "task", "month", "new"]),
  component: function ProjectViewRoute() {
    const { projectId, view } = projectView.useParams();
    const search = projectView.useSearch();
    return (
      <ProjectPage
        projectId={projectId}
        view={view}
        folderId={search.folder}
        section={search.section}
        taskId={search.task}
        month={search.month}
        create={search.new === "1"}
      />
    );
  },
});
const track = createRoute({
  getParentRoute: () => app,
  path: "/tracks/$trackId",
  validateSearch: (s: Record<string, unknown>) => pick(s, ["view"]),
  component: function TrackRoute() {
    const { trackId } = track.useParams();
    const search = track.useSearch();
    return <TrackPage trackId={trackId} view={search.view} />;
  },
});
const compare = createRoute({
  getParentRoute: () => app,
  path: "/tracks/$trackId/compare",
  validateSearch: (s: Record<string, unknown>) => pick(s, ["a", "b"]),
  component: function CompareRoute() {
    const { trackId } = compare.useParams();
    const search = compare.useSearch();
    return <ComparePage trackId={trackId} a={search.a} b={search.b} />;
  },
});
const fileSearch = (s: Record<string, unknown>) =>
  pick(s, ["view", "comment", "review", "version", "variation"]);
const file = createRoute({
  getParentRoute: () => app,
  path: "/files/$fileId",
  validateSearch: fileSearch,
  component: function FileRoute() {
    const { fileId } = file.useParams();
    const search = file.useSearch();
    return (
      <FilePage
        fileId={fileId}
        view={search.view}
        commentId={search.comment}
        reviewId={search.review}
      />
    );
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
const take = createRoute({
  getParentRoute: () => app,
  path: "/takes/$takeId",
  component: function TakeRoute() {
    const { takeId } = take.useParams();
    return <TakePage takeId={takeId} />;
  },
});
const members = createRoute({
  getParentRoute: () => app,
  path: "/members",
  component: MembersPage,
});
const settings = createRoute({
  getParentRoute: () => app,
  path: "/settings",
  component: () => <SettingsPage section="general" />,
});
const settingsSection = createRoute({
  getParentRoute: () => app,
  path: "/settings/$section",
  component: function SettingsRoute() {
    const { section } = settingsSection.useParams();
    return <SettingsPage section={section} />;
  },
});
const account = createRoute({
  getParentRoute: () => app,
  path: "/account",
  component: () => <AccountPage section="account" />,
});
const accountSection = createRoute({
  getParentRoute: () => app,
  path: "/account/$section",
  component: function AccountRoute() {
    const { section } = accountSection.useParams();
    return <AccountPage section={section} />;
  },
});
const notifications = createRoute({
  getParentRoute: () => app,
  path: "/notifications",
  component: NotificationsPage,
});
const search = createRoute({
  getParentRoute: () => app,
  path: "/search",
  validateSearch: (s: Record<string, unknown>) => pick(s, ["q"]),
  component: function SearchRoute() {
    const s = search.useSearch();
    return <SearchPage query={s.q} />;
  },
});

const guestApp = createRoute({ getParentRoute: () => root, id: "guest-app", component: GuestApp });
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
    const search = guestFile.useSearch();
    return (
      <FilePage
        fileId={fileId}
        view={search.view}
        commentId={search.comment}
        reviewId={search.review}
      />
    );
  },
});

const instanceApp = createRoute({
  getParentRoute: () => root,
  id: "instance-app",
  component: InstanceApp,
});
const instanceHome = createRoute({
  getParentRoute: () => instanceApp,
  path: "/instance",
  component: () => <InstancePage section="overview" />,
});
const instanceSection = createRoute({
  getParentRoute: () => instanceApp,
  path: "/instance/$section",
  component: function InstanceRoute() {
    const { section } = instanceSection.useParams();
    return <InstancePage section={section} />;
  },
});

export const router = createRouter({
  routeTree: root.addChildren([
    signIn,
    guestLink,
    guestOut,
    install,
    invite,
    uploadRequest,
    app.addChildren([
      home,
      inbox,
      requestReview,
      review,
      projectsRoute,
      project,
      projectView,
      track,
      compare,
      file,
      session,
      take,
      members,
      settings,
      settingsSection,
      account,
      accountSection,
      notifications,
      search,
    ]),
    guestApp.addChildren([guestHome, guestReview, guestFile]),
    instanceApp.addChildren([instanceHome, instanceSection]),
  ]),
  history: history(),
  defaultPreload: "intent",
  scrollRestoration: false,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
