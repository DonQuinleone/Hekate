import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Avatar } from "~/components/avatar";
import { Lockup, Mark } from "~/components/brand";
import { CommandPalette } from "~/components/command-palette";
import { Icon, type IconName } from "~/components/icons";
import { paletteKey } from "~/components/kbd";
import { NotificationsMenu } from "~/components/notifications";
import { HeaderSlotsProvider, useHeaderSlots } from "~/components/page-header";
import { ProjectCover } from "~/components/project-cover";
import { MenuList, usePopover } from "~/components/ui/menu";
import { type ReviewState, StatusDot } from "~/components/ui/status";
import { authClient } from "~/lib/auth";
import { cn } from "~/lib/cn";
import { inField } from "~/lib/dom";
import { docsUrl } from "~/lib/links";
import {
  fileQuery,
  type MyReview,
  meQuery,
  myReviewsQuery,
  type Project,
  projectsQuery,
  reviewQuery,
  trackQuery,
  useSwitchOrganisation,
} from "~/lib/queries";

/** The lamps in the room: slow, warm and cool, behind the chrome. */
export function Ambient() {
  return (
    <div className="ambient" aria-hidden="true">
      <div className="lamp lamp-warm" />
      <div className="lamp lamp-cool" />
      <div className="lamp lamp-deep" />
    </div>
  );
}

/** The pane the page is drawn on: lifted off the canvas, lit from the top left. */
export function Pane({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-pane @3xl/app:rounded-panel-lg @3xl/app:border @3xl/app:border-line @3xl/app:bg-pane/[0.94] @3xl/app:shadow-3 @3xl/app:backdrop-blur-2xl",
        "before:pointer-events-none before:absolute before:inset-0 before:z-0 before:bg-[radial-gradient(1200px_520px_at_18%_-12%,rgb(240_118_46/0.055),transparent_60%)]",
        className,
      )}
    >
      <div className="relative z-10 flex min-h-0 flex-1 flex-col">{children}</div>
    </div>
  );
}

const navClass =
  "relative flex h-8 shrink-0 items-center gap-2.5 rounded-control px-2.5 text-[14px] text-ink-2 transition-colors duration-150 hover:bg-raised/60 hover:text-ink data-[status=active]:bg-raised data-[status=active]:text-ink data-[status=active]:shadow-1";

function NavItem({
  to,
  icon,
  label,
  collapsed,
  count,
  exact = false,
}: {
  to: "/" | "/inbox" | "/projects";
  icon: IconName;
  label: string;
  collapsed: boolean;
  /** Something waiting, such as reviews it is your turn on. */
  count?: number;
  exact?: boolean;
}) {
  return (
    <Link
      to={to}
      activeOptions={{ exact }}
      title={collapsed ? label : undefined}
      aria-label={collapsed ? (count ? `${label}, ${count} waiting` : label) : undefined}
      className={cn(navClass, collapsed && "justify-center px-0")}
    >
      <Icon name={icon} />
      {!collapsed && <span className="truncate">{label}</span>}
      {count ? (
        <span
          className={cn(
            "tabular ml-auto rounded-full bg-signal px-1.5 text-[11px] leading-[18px] font-medium text-ground",
            collapsed && "absolute top-1 right-1 size-2 p-0 text-[0px]",
          )}
        >
          {count}
        </span>
      ) : null}
    </Link>
  );
}

const SIDEBAR_KEY = "hekate.sidebar";

/** The sidebar's width, remembered per browser; storage can be missing or refuse. */
function useCollapsed(): [boolean, (next: boolean) => void] {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === "collapsed";
    } catch {
      return false;
    }
  });
  const set = useCallback((next: boolean) => {
    setCollapsed(next);
    try {
      localStorage.setItem(SIDEBAR_KEY, next ? "collapsed" : "expanded");
    } catch {
      // Not remembered; the choice still holds for this visit.
    }
  }, []);
  return [collapsed, set];
}

/** The project the current page belongs to, whatever the page is: the sidebar follows it. */
function useCurrentProjectId(): string | undefined {
  const { pathname } = useLocation();
  const [, head = "", id = ""] = pathname.split("/");
  const track = useQuery({ ...trackQuery(id), enabled: head === "tracks" && Boolean(id) });
  const file = useQuery({ ...fileQuery(id), enabled: head === "files" && Boolean(id) });
  const review = useQuery({ ...reviewQuery(id), enabled: head === "reviews" && Boolean(id) });
  if (head === "projects" && id) return id;
  if (head === "tracks") return track.data?.projectId;
  if (head === "files") return file.data?.projectId;
  if (head === "reviews" && id) return review.data?.projectId;
  return undefined;
}

/** A project's sections, in the sidebar once it is open. More arrive with their pages. */
const projectSections = [
  { id: "", label: "Overview", icon: "dashboard", to: "/projects/$projectId" },
  { id: "files", label: "Files", icon: "folder", to: "/projects/$projectId/files" },
  { id: "reviews", label: "Reviews", icon: "review", to: "/projects/$projectId/reviews" },
  { id: "people", label: "People", icon: "users", to: "/projects/$projectId/people" },
] as const;

const reviewState = (r: MyReview): ReviewState => {
  if (r.status === "cancelled") return "cancelled";
  if (r.outcome === "approved") return "approved";
  if (r.outcome === "changes_requested") return "changes_requested";
  if (r.status === "completed") return "submitted";
  return "in_review";
};

/** The open project, and the way to any other. */
function ProjectSwitcher({
  project,
  projects,
  collapsed,
}: {
  project: Project;
  projects: Project[];
  collapsed: boolean;
}) {
  const navigate = useNavigate();
  const [open, setOpen, box] = usePopover();
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Project: ${project.name}. Switch project`}
        onClick={() => setOpen(!open)}
        className={cn(
          "flex h-10 w-full items-center gap-2.5 rounded-control px-2 text-left transition-colors hover:bg-raised/60",
          open && "bg-raised/60",
          collapsed && "justify-center px-0",
        )}
      >
        <ProjectCover profile={project.profile} size="xs" />
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">
              {project.name}
            </span>
            <Icon name="chevronDown" size={12} className="text-ink-3" />
          </>
        )}
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Switch project"
          className="rise-in absolute top-full left-0 z-40 mt-1 w-64 rounded-panel-lg bg-overlay p-1 shadow-4"
        >
          <div className="eyebrow px-2.5 pt-1.5 pb-1">Projects</div>
          {projects.map((p) => (
            <button
              key={p.id}
              type="button"
              role="menuitemradio"
              aria-checked={p.id === project.id}
              onClick={() => {
                setOpen(false);
                void navigate({ to: "/projects/$projectId/files", params: { projectId: p.id } });
              }}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-control px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-raised",
                p.id === project.id ? "text-ink" : "text-ink-2",
              )}
            >
              <ProjectCover profile={p.profile} size="xs" />
              <span className="flex-1 truncate">{p.name}</span>
              {p.id === project.id && <Icon name="check" size={14} />}
            </button>
          ))}
          <div className="mx-2 my-1 h-px bg-line" />
          <MenuList
            role="group"
            className="relative mt-0 min-w-0 bg-transparent p-0 shadow-none"
            onClose={() => setOpen(false)}
            actions={[
              { label: "All projects", onSelect: () => void navigate({ to: "/projects" }) },
            ]}
          />
        </div>
      )}
    </div>
  );
}

/** The account and the workspace, at the foot of the sidebar; the menu opens upward. */
function WorkspaceMenu({ collapsed, tab = false }: { collapsed: boolean; tab?: boolean }) {
  const { data: me } = useQuery(meQuery);
  const client = useQueryClient();
  const navigate = useNavigate();
  const switchTo = useSwitchOrganisation();
  const [open, setOpen, box] = usePopover();
  if (!me) return null;
  const workspace = me.organisations.find((o) => o.id === me.activeOrganisationId);
  const role = workspace?.role ?? "member";
  const signOut = async () => {
    await authClient.signOut();
    client.clear();
    await navigate({ to: "/sign-in" });
  };
  return (
    <div ref={box} className={cn("relative", tab && "flex flex-1")}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${me.user.name}, ${workspace?.name ?? "workspace"}`}
        onClick={() => setOpen(!open)}
        className={cn(
          tab
            ? "flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] text-ink-3 transition-colors hover:text-ink"
            : "flex h-11 w-full items-center gap-2.5 rounded-control px-2 text-left transition-colors hover:bg-raised/60",
          open && !tab && "bg-raised/60",
          open && tab && "text-ink",
          collapsed && !tab && "justify-center px-0",
        )}
      >
        {tab ? (
          <>
            <Icon name="user" size={18} />
            <span>You</span>
          </>
        ) : (
          <>
            <Avatar id={me.user.id} name={me.user.name} size={28} />
            {!collapsed && (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-ink">
                    {me.user.name}
                  </span>
                  <span className="block truncate text-[12px] text-ink-3">{workspace?.name}</span>
                </span>
                <Icon name="chevronUp" size={12} className="text-ink-3" />
              </>
            )}
          </>
        )}
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Account and workspace"
          className={cn(
            "rise-in absolute bottom-full z-40 mb-1.5 w-64 rounded-panel-lg bg-overlay p-1 shadow-4",
            tab ? "right-2" : "left-0",
          )}
        >
          <div className="flex items-center gap-2.5 px-2.5 py-2">
            <Avatar id={me.user.id} name={me.user.name} size={30} />
            <div className="min-w-0">
              <div className="truncate text-[14px] font-medium text-ink">{me.user.name}</div>
              <div className="truncate text-[13px] text-ink-3">{me.user.email}</div>
            </div>
          </div>
          <div className="mx-2 my-1 h-px bg-line" />
          <div className="eyebrow px-2.5 pt-1 pb-1">Workspace</div>
          {me.organisations.map((o) => (
            <button
              key={o.id}
              type="button"
              role="menuitemradio"
              aria-checked={o.id === me.activeOrganisationId}
              onClick={() => {
                setOpen(false);
                if (o.id !== me.activeOrganisationId) switchTo.mutate(o.id);
              }}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-control px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-raised",
                o.id === me.activeOrganisationId ? "text-ink" : "text-ink-2",
              )}
            >
              <span className="flex size-5 items-center justify-center rounded-chip bg-raised text-[10px] font-medium text-ink-2">
                {o.name
                  .split(/\s+/)
                  .map((w) => w[0])
                  .join("")
                  .slice(0, 2)
                  .toUpperCase()}
              </span>
              <span className="flex-1 truncate">{o.name}</span>
              {o.id === me.activeOrganisationId && <Icon name="check" size={14} />}
            </button>
          ))}
          <MenuList
            role="group"
            className="relative mt-0 min-w-0 bg-transparent p-0 shadow-none"
            onClose={() => setOpen(false)}
            actions={[
              ...(role === "owner" || role === "admin"
                ? [
                    {
                      label: "Workspace settings",
                      onSelect: () =>
                        void navigate({ to: "/settings/$section", params: { section: "general" } }),
                    },
                  ]
                : []),
              {
                label: "Members",
                onSelect: () =>
                  void navigate({ to: "/settings/$section", params: { section: "members" } }),
              },
              {
                label: "Your account",
                onSelect: () =>
                  void navigate({ to: "/account/$section", params: { section: "notifications" } }),
              },
              "divider",
              { label: "Sign out", onSelect: () => void signOut() },
            ]}
          />
        </div>
      )}
    </div>
  );
}

/** Help, beside the bell: the documentation now; tickets come with the support module. */
function HelpMenu() {
  const [open, setOpen, box] = usePopover();
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Help"
        title="Help"
        onClick={() => setOpen(!open)}
        className={cn(
          "flex size-8 items-center justify-center rounded-control text-ink-3 transition-colors hover:bg-raised/60 hover:text-ink",
          open && "bg-raised/60 text-ink",
        )}
      >
        <Icon name="help" size={18} />
      </button>
      {open && (
        <MenuList
          onClose={() => setOpen(false)}
          actions={[
            {
              label: "View documentation",
              hint: docsUrl.replace(/^https?:\/\//, ""),
              onSelect: () => window.open(docsUrl, "_blank", "noopener"),
            },
          ]}
        />
      )}
    </div>
  );
}

function SideSection({
  title,
  count,
  collapsed,
  children,
}: {
  title: string;
  count?: number;
  collapsed: boolean;
  children: ReactNode;
}) {
  if (collapsed) return null;
  return (
    <div className="mt-6 flex flex-col gap-0.5">
      <div className="flex h-7 items-center gap-2 px-2.5">
        <span className="eyebrow text-[12px]">{title}</span>
        {count ? <span className="tabular text-[12px] text-ink-3">{count}</span> : null}
      </div>
      {children}
    </div>
  );
}

/** The top bar: the page's trail and actions (drawn in by the page), then the shell's own. */
function TopBar({
  onTrail,
  onActions,
  onSearch,
}: {
  onTrail: (el: HTMLElement | null) => void;
  onActions: (el: HTMLElement | null) => void;
  onSearch: () => void;
}) {
  return (
    <header className="relative flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 border-b border-line px-3 @3xl/app:flex-nowrap @3xl/app:px-6">
      <div ref={onTrail} className="flex h-12 min-w-0 flex-1 items-center" />
      {/* The page's actions: beside the trail on a wide screen, a row of their own on a phone. */}
      <div
        ref={onActions}
        className="order-last flex w-full items-center gap-1.5 overflow-x-auto pb-2 empty:hidden @3xl/app:order-none @3xl/app:w-auto @3xl/app:overflow-visible @3xl/app:pb-0"
      />
      <div className="flex shrink-0 items-center gap-1.5">
        {/* On a phone there is no sidebar, so search sits beside the bell. */}
        <button
          type="button"
          aria-label="Search and commands"
          onClick={onSearch}
          className="flex size-8 items-center justify-center rounded-control text-ink-2 transition-colors hover:bg-raised hover:text-ink @3xl/app:hidden"
        >
          <Icon name="search" />
        </button>
        <NotificationsMenu />
        <HelpMenu />
      </div>
    </header>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useCollapsed();
  const [slots, onTrail, onActions] = useHeaderSlots();
  const { data: reviews } = useQuery(myReviewsQuery);
  const { data: projects = [] } = useQuery(projectsQuery);
  const projectId = useCurrentProjectId();
  const current = projects.find((p) => p.id === projectId);
  const { pathname } = useLocation();
  const section = pathname.split("/")[3] ?? "";
  const waitingAll = reviews?.filter((r) => r.yourTurn) ?? [];
  const waitingHere = current ? waitingAll.filter((r) => r.projectId === current.id) : waitingAll;

  const navigate = useNavigate();
  const [palette, setPalette] = useState(false);
  const chord = useRef(0);
  const toggleSidebar = useCallback(() => setCollapsed(!collapsed), [collapsed, setCollapsed]);

  // Ctrl or ⌘ K opens the palette anywhere, "/" outside a field; "[" shows or hides the
  // labels, as in Linear; "g" then h, i or p jumps. Never while typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette((open) => !open);
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || inField(event) || palette) return;
      if (event.key === "[") toggleSidebar();
      if (event.key === "/") {
        event.preventDefault();
        setPalette(true);
      }
      // The second key of a "g" chord must follow within a second.
      if (event.key === "g") {
        chord.current = Date.now();
        return;
      }
      if (Date.now() - chord.current < 1000) {
        chord.current = 0;
        if (event.key === "h") void navigate({ to: "/" });
        if (event.key === "i") void navigate({ to: "/inbox" });
        if (event.key === "p") void navigate({ to: "/projects" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [palette, toggleSidebar, navigate]);

  return (
    <div className="relative flex h-full flex-col @3xl/app:flex-row">
      <Ambient />
      <CommandPalette
        open={palette}
        onClose={() => setPalette(false)}
        onToggleSidebar={toggleSidebar}
      />
      <nav
        aria-label="Main"
        className={cn(
          "relative z-10 hidden shrink-0 flex-col px-2.5 pt-3 pb-2.5 transition-[width] duration-200 @3xl/app:flex",
          collapsed ? "w-14" : "w-[240px]",
        )}
      >
        <div className={cn("flex h-9 items-center gap-1 px-1", collapsed && "justify-center px-0")}>
          <Link
            to="/"
            aria-label="Hekate"
            className="flex min-w-0 flex-1 items-center rounded-control px-1 py-1 text-ink transition-opacity hover:opacity-80"
          >
            {collapsed ? <Mark size={22} /> : <Lockup size={20} />}
          </Link>
          {!collapsed && (
            <button
              type="button"
              aria-label="Search and commands"
              title={`Search and commands (${paletteKey})`}
              onClick={() => setPalette(true)}
              className="flex size-8 shrink-0 items-center justify-center rounded-control text-ink-3 transition-colors hover:bg-raised/60 hover:text-ink"
            >
              <Icon name="search" />
            </button>
          )}
        </div>
        <div className="scroll-quiet mt-5 flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="flex flex-col gap-0.5">
            <NavItem to="/" icon="dashboard" label="Home" collapsed={collapsed} exact />
            <NavItem
              to="/inbox"
              icon="inbox"
              label="Inbox"
              collapsed={collapsed}
              count={waitingAll.length}
              exact
            />
            {current ? (
              <>
                <div className="mt-4 mb-1">
                  <ProjectSwitcher project={current} projects={projects} collapsed={collapsed} />
                </div>
                {projectSections.map((item) => (
                  <Link
                    key={item.id}
                    to={item.to}
                    params={{ projectId: current.id }}
                    // The overview's address sits above every other section's.
                    activeOptions={{ exact: item.id === "" }}
                    title={collapsed ? item.label : undefined}
                    aria-current={
                      section === item.id && pathname.startsWith("/projects/") ? "page" : undefined
                    }
                    className={cn(
                      navClass,
                      "aria-[current=page]:bg-raised aria-[current=page]:text-ink aria-[current=page]:shadow-1",
                      collapsed && "justify-center px-0",
                    )}
                  >
                    <Icon name={item.icon} />
                    {!collapsed && <span className="truncate">{item.label}</span>}
                  </Link>
                ))}
              </>
            ) : (
              <>
                <NavItem to="/projects" icon="folder" label="Projects" collapsed={collapsed} />
                {!collapsed && projects.length > 0 && (
                  <ul className="mb-1 ml-[21px] flex flex-col gap-px border-l border-line pl-2.5">
                    {projects.slice(0, 8).map((p) => (
                      <li key={p.id}>
                        <Link
                          to="/projects/$projectId/files"
                          params={{ projectId: p.id }}
                          className="flex h-7 items-center truncate rounded-control px-2 text-[13px] text-ink-3 transition-colors hover:bg-raised/60 hover:text-ink"
                        >
                          <span className="truncate">{p.name}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
          {waitingHere.length > 0 && (
            <SideSection title="Waiting on you" count={waitingHere.length} collapsed={collapsed}>
              {waitingHere.slice(0, 4).map((r) => (
                <Link
                  key={r.id}
                  to="/reviews/$reviewId"
                  params={{ reviewId: r.id }}
                  className="flex h-8 items-center gap-2.5 rounded-control px-2.5 text-[13px] text-ink-2 transition-colors hover:bg-raised/60 hover:text-ink data-[status=active]:bg-raised data-[status=active]:text-ink"
                >
                  <span className="flex w-4 shrink-0 items-center justify-center">
                    <StatusDot state={reviewState(r)} />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{r.title}</span>
                  {!current && (
                    <span className="max-w-[40%] shrink-0 truncate text-[12px] text-ink-3">
                      {r.projectName}
                    </span>
                  )}
                </Link>
              ))}
              {waitingHere.length > 4 && (
                <Link to="/inbox" className="px-2.5 text-[12px] text-ink-3 hover:text-ink">
                  and {waitingHere.length - 4} more
                </Link>
              )}
            </SideSection>
          )}
        </div>
        <div className="mt-2 flex flex-col gap-1 border-t border-line pt-2">
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? "Show labels" : "Show icons only"}
            title={`${collapsed ? "Show labels" : "Show icons only"} ([)`}
            className={cn(
              "flex h-7 items-center gap-2.5 rounded-control px-2.5 text-[12px] text-ink-3 transition-colors hover:bg-raised/60 hover:text-ink",
              collapsed && "justify-center px-0",
            )}
          >
            <Icon name="sidebar" size={14} />
            {!collapsed && <span>Collapse</span>}
          </button>
          <WorkspaceMenu collapsed={collapsed} />
        </div>
      </nav>

      <div className="relative z-10 flex min-h-0 min-w-0 flex-1 flex-col @3xl/app:py-2.5 @3xl/app:pr-2.5">
        <Pane>
          <HeaderSlotsProvider slots={slots}>
            <TopBar onTrail={onTrail} onActions={onActions} onSearch={() => setPalette(true)} />
            {current && (
              <nav
                aria-label={current.name}
                className="scroll-quiet flex shrink-0 gap-1 overflow-x-auto border-b border-line px-3 py-1.5 @3xl/app:hidden"
              >
                {projectSections.map((item) => (
                  <Link
                    key={item.id}
                    to={item.to}
                    params={{ projectId: current.id }}
                    activeOptions={{ exact: item.id === "" }}
                    aria-current={
                      section === item.id && pathname.startsWith("/projects/") ? "page" : undefined
                    }
                    className="h-7 shrink-0 rounded-control px-2.5 text-[13px] leading-7 whitespace-nowrap text-ink-3 transition-colors aria-[current=page]:bg-raised aria-[current=page]:text-ink"
                  >
                    {item.label}
                  </Link>
                ))}
              </nav>
            )}
            <main className="scroll-quiet min-h-0 min-w-0 flex-1 overflow-auto">{children}</main>
          </HeaderSlotsProvider>
          <nav
            aria-label="Main"
            className="flex h-14 shrink-0 items-stretch border-t border-line bg-ground @3xl/app:hidden"
          >
            {(
              [
                { to: "/", icon: "dashboard", label: "Home", count: 0, exact: true },
                {
                  to: "/inbox",
                  icon: "inbox",
                  label: "Inbox",
                  count: waitingAll.length,
                  exact: true,
                },
                { to: "/projects", icon: "folder", label: "Projects", count: 0, exact: false },
              ] as const
            ).map((item) => (
              <Link
                key={item.to}
                to={item.to}
                activeOptions={{ exact: item.exact }}
                className="relative flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] text-ink-3 transition-colors data-[status=active]:text-ink"
              >
                <Icon name={item.icon} size={18} />
                <span>{item.label}</span>
                {item.count ? (
                  <span className="absolute top-2 right-[calc(50%-18px)] size-1.5 rounded-full bg-signal" />
                ) : null}
              </Link>
            ))}
            <WorkspaceMenu collapsed={false} tab />
          </nav>
        </Pane>
      </div>
    </div>
  );
}

/** Guests see no navigation: their reviews, and the way out. */
export function GuestFrame({ account, children }: { account: ReactNode; children: ReactNode }) {
  const [slots, onTrail, onActions] = useHeaderSlots();
  return (
    <div className="relative flex h-full flex-col @3xl/app:p-2.5">
      <Ambient />
      <Pane>
        <HeaderSlotsProvider slots={slots}>
          <header className="relative flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 border-b border-line px-3 @3xl/app:flex-nowrap @3xl/app:px-6">
            <Link to="/g" className="flex shrink-0 items-center" aria-label="Your reviews">
              <Lockup size={18} />
            </Link>
            <div className="mx-1 hidden h-5 w-px bg-line-strong @3xl/app:block" />
            <div ref={onTrail} className="flex h-12 min-w-0 flex-1 items-center" />
            <div
              ref={onActions}
              className="order-last flex w-full items-center gap-1.5 overflow-x-auto pb-2 empty:hidden @3xl/app:order-none @3xl/app:w-auto @3xl/app:pb-0"
            />
            <div className="flex shrink-0 items-center gap-2">{account}</div>
          </header>
          <main className="scroll-quiet min-h-0 flex-1 overflow-auto">{children}</main>
        </HeaderSlotsProvider>
      </Pane>
    </div>
  );
}
