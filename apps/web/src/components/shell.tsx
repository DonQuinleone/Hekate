import {
  type InstanceSection,
  instanceSections,
  instanceSectionsFor,
  overallLine,
  reachesInstance,
  serviceStateNames,
} from "@hekate/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { Fragment, type ReactNode, useCallback, useEffect, useState } from "react";
import { Avatar } from "~/components/avatar";
import { Lockup, Mark, WorkspaceLogo } from "~/components/brand";
import { CommandPalette } from "~/components/command-palette";
import { Icon, type IconName } from "~/components/icons";
import { paletteKey } from "~/components/kbd";
import { NeedsYouDot } from "~/components/needs-you";
import { NotificationsMenu } from "~/components/notifications";
import { HeaderSlotsProvider, useHeaderSlots } from "~/components/page-header";
import { ProjectCover } from "~/components/project-cover";
import { StateDot } from "~/components/status";
import { DialogLayer } from "~/components/ui/dialog";
import { Floating } from "~/components/ui/floating";
import { MenuList, usePopover } from "~/components/ui/menu";
import { UploadQueueProvider, UploadTray } from "~/components/upload-queue";
import { authClient } from "~/lib/auth";
import { cn } from "~/lib/cn";
import {
  type Connection,
  connectionOf,
  connectionWords,
  tryingAgain,
  useReach,
} from "~/lib/connection";
import { useDensitySync } from "~/lib/density";
import { docsUrl } from "~/lib/links";
import { localeKey, setLocale } from "~/lib/locale";
import {
  fileQuery,
  healthQuery,
  instanceAccessQuery,
  meQuery,
  myReviewsQuery,
  type Project,
  projectsQuery,
  projectTasksQuery,
  reviewQuery,
  sessionQuery,
  takeQuery,
  trackQuery,
  useProjectCan,
  useSwitchOrganisation,
} from "~/lib/queries";
import {
  type Opened,
  openedAt,
  readOpened,
  recentShown,
  switcherOrder,
  withOpened,
  writeOpened,
} from "~/lib/recent";
import { useAnnounce, useShortcuts } from "~/lib/shortcuts";
import { listsNeedsYou, sectionAt } from "~/lib/sidebar";
import { statusNowQuery } from "~/lib/status";
import { useThemeSync } from "~/lib/theme";
import { mayOpenSettings } from "~/routes/project-settings";
import { openShortcutMap } from "./shortcut-map";
import { SubNav } from "./ui/sub-nav";

/** Each instance section's mark in the navigation, as in the prototype. */
const instanceIcons: Record<InstanceSection, IconName> = {
  overview: "dashboard",
  workspaces: "building",
  operators: "fingerprint",
  billing: "chart",
  support: "comment",
  health: "pulse",
  queues: "clock",
  logs: "list",
  settings: "settings",
  system: "server",
  debug: "sliders",
  operations: "database",
};

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
      <DialogLayer className="relative z-10 flex min-h-0 flex-1 flex-col">{children}</DialogLayer>
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
  const session = useQuery({ ...sessionQuery(id), enabled: head === "sessions" && Boolean(id) });
  // A take's page is its project's as a session's is (#612, #480).
  const take = useQuery({ ...takeQuery(id), enabled: head === "takes" && Boolean(id) });
  if (head === "projects" && id) return id;
  if (head === "takes") return take.data?.track.projectId;
  if (head === "sessions") return session.data?.projectId;
  if (head === "tracks") return track.data?.projectId;
  if (head === "files") return file.data?.projectId;
  if (head === "reviews" && id) return review.data?.projectId;
  return undefined;
}

/** A project's sections, in the sidebar once it is open. More arrive with their pages. */
const projectSections = [
  { id: "", label: "Overview", icon: "dashboard", to: "/projects/$projectId" },
  { id: "files", label: "Files", icon: "folder", to: "/projects/$projectId/files" },
  { id: "board", label: "Board", icon: "board", to: "/projects/$projectId/board" },
  { id: "reviews", label: "Reviews", icon: "review", to: "/projects/$projectId/reviews" },
  { id: "tasks", label: "Tasks", icon: "task", to: "/projects/$projectId/tasks" },
  { id: "people", label: "People", icon: "users", to: "/projects/$projectId/people" },
  // The production tools (#21, #45, #47), as in the prototype: the repertoire, the schedule,
  // sessions and takes, score marking, the stage plan, the patch list, personnel, venues and
  // import. Which pages each section holds is `sectionAt`'s.
  { id: "sessions", label: "Production", icon: "mic", to: "/projects/$projectId/sessions" },
  { id: "settings", label: "Settings", icon: "sliders", to: "/projects/$projectId/settings" },
] as const;

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
        title={collapsed ? project.name : undefined}
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
        <Floating
          anchor={box}
          align="start"
          // Beside the rail when the sidebar is collapsed, over the pane, not over the rail.
          side={collapsed ? "right" : "bottom"}
          // Clear of the rail, over the pane.
          gap={collapsed ? 12 : 4}
          onClose={() => setOpen(false)}
          role="menu"
          aria-label="Switch project"
          className="rise-in w-64 rounded-panel-lg bg-overlay p-1 shadow-4"
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
        </Floating>
      )}
    </div>
  );
}

/**
 * The account and the workspace, at the foot of the sidebar; the menu opens upward, or beside
 * the rail when the sidebar is collapsed.
 */
function WorkspaceMenu({ collapsed, tab = false }: { collapsed: boolean; tab?: boolean }) {
  const { data: me } = useQuery(meQuery);
  const client = useQueryClient();
  const navigate = useNavigate();
  const switchTo = useSwitchOrganisation();
  const [open, setOpen, box] = usePopover();
  const { data: instanceAccess } = useQuery(instanceAccessQuery);
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
        // Named by the name and workspace it shows; with only the avatar or "You" left, by them in words.
        aria-label={
          tab
            ? `You: ${me.user.name}, ${workspace?.name ?? "workspace"}`
            : collapsed
              ? `${me.user.name}, ${workspace?.name ?? "workspace"}`
              : undefined
        }
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
            <Avatar person={me.user.id} name={me.user.name} size={28} />
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
        <Floating
          anchor={box}
          align={tab || collapsed ? "end" : "start"}
          side={collapsed && !tab ? "right" : "top"}
          // Clear of the rail, over the pane.
          gap={collapsed ? 12 : 4}
          onClose={() => setOpen(false)}
          role="menu"
          aria-label="Account and workspace"
          className="rise-in w-64 rounded-panel-lg bg-overlay p-1 shadow-4"
        >
          <div className="flex items-center gap-2.5 px-2.5 py-2">
            <Avatar person={me.user.id} name={me.user.name} size={30} />
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
              ...(instanceAccess && reachesInstance(instanceAccess)
                ? [
                    {
                      label: "Instance management",
                      onSelect: () => void navigate({ to: "/instance" }),
                    },
                  ]
                : []),
              "divider",
              { label: "Sign out", onSelect: () => void signOut() },
            ]}
          />
        </Floating>
      )}
    </div>
  );
}

/**
 * Help, beside the bell: the documentation, the status page with what is open on it (#183),
 * and with the support module (#181) the workspace's tickets and a new one, which knows the
 * file or review it was asked from; or the operators' own desk or mailbox where the instance
 * answers elsewhere. The button carries a dot only while the status is not normal, and says
 * why when pointed at; the status's dot sits after its words, so every label starts at one edge.
 */
function HelpMenu() {
  const [open, setOpen, box] = usePopover();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { data: me } = useQuery(meQuery);
  const { data: status } = useQuery(statusNowQuery);
  const incidents = status?.open ?? [];
  const state = status?.state ?? "operational";
  const unusual = state !== "operational" || incidents.length > 0;
  const why =
    incidents.length > 1
      ? `${incidents.length} incidents are open`
      : state === "operational" && incidents[0]
        ? `An incident is open: ${serviceStateNames[incidents[0].impact]}`
        : overallLine[state];
  const support = me?.support;
  const statusUrl = support?.statusUrl ?? "/status";
  const docs = support?.docsUrl ?? docsUrl;
  const on = /^\/(files|reviews)\/([0-9a-f-]{36})/.exec(pathname);
  const from = on ? `${on[1] === "files" ? "file" : "review"}:${on[2]}` : undefined;
  const elsewhere =
    support?.mode === "link" && support.address
      ? support.address
      : support?.mode === "mail" && support.address
        ? `mailto:${support.address}`
        : null;
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={unusual ? `Help. ${why}` : "Help"}
        title={unusual ? `Help · ${why}` : "Help"}
        onClick={() => setOpen(!open)}
        className={cn(
          "relative flex size-8 items-center justify-center rounded-control text-ink-3 transition-colors hover:bg-raised/60 hover:text-ink",
          open && "bg-raised/60 text-ink",
        )}
      >
        <Icon name="help" size={18} />
        {unusual && (
          <span
            aria-hidden="true"
            className="absolute top-1 right-1 size-2 rounded-full bg-signal ring-2 ring-pane"
          />
        )}
      </button>
      {open && (
        <MenuList
          anchor={box}
          onClose={() => setOpen(false)}
          actions={[
            {
              label: "Keyboard shortcuts",
              // "?" opens it only for those who keep it on (Account, Appearance).
              ...(me?.user.preferences?.keyboardMapOnQuestion === false ? {} : { hint: "?" }),
              onSelect: openShortcutMap,
            },
            {
              label: "View documentation",
              hint: docs.replace(/^https?:\/\//, "").replace(/\/$/, ""),
              onSelect: () => window.open(docs, "_blank", "noopener"),
            },
            {
              label: "Status",
              // In the status page's own words (#617): its line for the whole, or the
              // incident's state, or how many are open.
              hint:
                incidents.length === 0
                  ? overallLine[state]
                  : incidents.length === 1
                    ? serviceStateNames[incidents[0]?.impact ?? "degraded"]
                    : `${incidents.length} incidents`,
              trail: <StateDot state={state} />,
              onSelect: () => window.open(statusUrl, "_blank", "noopener"),
            },
            ...(support?.mode === "app"
              ? [
                  {
                    label: "My tickets",
                    onSelect: () =>
                      void navigate({ to: "/settings/$section", params: { section: "support" } }),
                  },
                  {
                    label: "Contact support",
                    onSelect: () =>
                      void navigate({
                        to: "/settings/$section",
                        params: { section: "support" },
                        search: { new: "1" as const, ...(from ? { from } : {}) },
                      }),
                  },
                ]
              : elsewhere
                ? [
                    {
                      label: "Contact support",
                      onSelect: () => window.open(elsewhere, "_blank", "noopener"),
                    },
                  ]
                : []),
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

/**
 * The way to the instance side, beside the bell, for operators and workspace owners (#155):
 * the server it runs on, named Instance. A phone keeps its four slots for the page; the
 * account menu leads there instead.
 */
function InstanceLink() {
  const { data: access } = useQuery(instanceAccessQuery);
  const { pathname } = useLocation();
  if (!access || !reachesInstance(access)) return null;
  const here = pathname === "/instance" || pathname.startsWith("/instance/");
  return (
    <Link
      to="/instance"
      aria-label="Instance"
      title="Instance"
      aria-current={here ? "page" : undefined}
      className={cn(
        "hidden size-8 items-center justify-center rounded-control transition-colors hover:bg-raised/60 hover:text-ink @3xl/app:flex",
        here ? "bg-signal/15 text-signal" : "text-ink-3",
      )}
    >
      <Icon name="instance" size={18} />
    </Link>
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
  // The search page has its own field; a second way in would repeat it (#620).
  const onSearchPage = useLocation().pathname === "/search";
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
        {!onSearchPage && (
          <button
            type="button"
            aria-label="Search and commands"
            onClick={onSearch}
            className="flex size-8 items-center justify-center rounded-control text-ink-2 transition-colors hover:bg-raised hover:text-ink @3xl/app:hidden"
          >
            <Icon name="search" />
          </button>
        )}
        {/* In the prototype's order: help, the instance, the bell. */}
        <HelpMenu />
        <InstanceLink />
        <NotificationsMenu />
      </div>
    </header>
  );
}

/**
 * The sidebar's foot (the prototype's Shell): whether the app reaches its server, and the
 * server's version, from the health check and the app's own requests. Losing the server turns
 * it to the signal colour and says so in plain words, with "Trying again" where the version
 * was; it clears on its own once the server answers again.
 */
function ConnectionFoot({ connection, collapsed }: { connection: Connection; collapsed: boolean }) {
  const words = connectionWords[connection.state];
  const lost = connection.state === "unreachable" || connection.state === "degraded";
  const version = "version" in connection ? connection.version : null;
  return (
    <output
      aria-live="polite"
      title={
        lost
          ? `${words}. ${tryingAgain}.${version ? ` Hekate ${version}` : ""}`
          : version
            ? `${words} · Hekate ${version}`
            : words
      }
      className={cn(
        "flex h-6 items-center gap-2 px-2.5 text-[11px]",
        lost ? "text-signal" : "text-ink-3",
        collapsed && "justify-center px-0",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "inline-block size-[7px] shrink-0 rounded-full",
          connection.state === "connected" && "bg-ok",
          connection.state === "degraded" && "bg-warn",
          connection.state === "unreachable" && "bg-signal",
          connection.state === "checking" && "breathe bg-ink-3",
        )}
      />
      {collapsed ? (
        <span className="sr-only">{lost ? `${words}. ${tryingAgain}.` : words}</span>
      ) : (
        <>
          <span className="truncate">{words}</span>
          {lost ? (
            <span className="ml-auto shrink-0 text-ink-3">{tryingAgain}</span>
          ) : (
            version && <span className="tabular ml-auto shrink-0 text-ink-3">{version}</span>
          )}
        </>
      )}
    </output>
  );
}

const sideLink =
  "flex h-8 items-center gap-2.5 rounded-control px-2.5 text-[13px] text-ink-2 transition-colors hover:bg-raised/60 hover:text-ink";

/**
 * One thing opened lately, by its name as it is now: something gone, or no longer open to the
 * viewer, drops out rather than leading to a refusal.
 */
function RecentLink({ opened }: { opened: Opened }) {
  const file = useQuery({ ...fileQuery(opened.id), enabled: opened.kind === "file" });
  const track = useQuery({ ...trackQuery(opened.id), enabled: opened.kind === "track" });
  const review = useQuery({ ...reviewQuery(opened.id), enabled: opened.kind === "review" });
  const lead = (name: IconName) => (
    <span className="flex w-4 shrink-0 items-center justify-center text-ink-3">
      <Icon name={name} size={14} />
    </span>
  );
  if (opened.kind === "file" && file.data)
    return (
      <Link to="/files/$fileId" params={{ fileId: opened.id }} className={sideLink}>
        {lead(file.data.kind === "video" ? "film" : file.data.kind === "audio" ? "music" : "file")}
        <span className="min-w-0 flex-1 truncate">{file.data.name}</span>
      </Link>
    );
  if (opened.kind === "track" && track.data)
    return (
      <Link to="/tracks/$trackId" params={{ trackId: opened.id }} className={sideLink}>
        {lead("track")}
        <span className="min-w-0 flex-1 truncate">{track.data.name}</span>
      </Link>
    );
  if (opened.kind === "review" && review.data)
    return (
      <Link to="/reviews/$reviewId" params={{ reviewId: opened.id }} className={sideLink}>
        {lead("review")}
        <span className="min-w-0 flex-1 truncate">{review.data.title}</span>
      </Link>
    );
  return null;
}

/** What this person opened lately in this workspace, remembered as each page opens. */
function useOpened(pathname: string, projectId: string | undefined): Opened[] {
  const { data: me } = useQuery(meQuery);
  const userId = me?.user.id;
  const organisationId = me?.activeOrganisationId;
  const [list, setList] = useState<Opened[]>([]);
  useEffect(() => {
    if (userId && organisationId) setList(readOpened(userId, organisationId));
  }, [userId, organisationId]);
  useEffect(() => {
    if (!userId || !organisationId) return;
    const here = openedAt(pathname);
    const at = Date.now();
    setList((before) => {
      let next = here ? withOpened(before, { ...here, at }) : before;
      // A file, a track or a session opens its project too, for the switcher's order.
      if (projectId) next = withOpened(next, { kind: "project", id: projectId, at });
      if (next === before) return before;
      writeOpened(userId, organisationId, next);
      return next;
    });
  }, [pathname, projectId, userId, organisationId]);
  return list;
}

export function Shell({ children }: { children: ReactNode }) {
  const { data: signedIn } = useQuery(meQuery);
  // Dates and numbers in the member's language (else the workspace's) and time zone; the page
  // redraws if they change.
  const workspace = signedIn?.organisations.find((o) => o.id === signedIn.activeOrganisationId);
  setLocale(signedIn?.user.locale ?? workspace?.locale, signedIn?.user.timeZone);
  const page = <Fragment key={localeKey()}>{children}</Fragment>;
  useThemeSync(signedIn?.user.preferences?.theme);
  useDensitySync(signedIn?.user.preferences?.density);
  const [collapsed, setCollapsed] = useCollapsed();
  const [slots, onTrail, onActions] = useHeaderSlots();
  const { data: reviews } = useQuery(myReviewsQuery);
  const { data: projects = [] } = useQuery(projectsQuery);
  const projectId = useCurrentProjectId();
  const current = projects.find((p) => p.id === projectId);
  const { pathname } = useLocation();
  const section = sectionAt(pathname);
  const { data: instanceAccess } = useQuery(instanceAccessQuery);
  const health = useQuery(healthQuery);
  // The health check, and what the app's own requests found (#616): a failed write turns the
  // foot at once, and asks the health check again so it clears as soon as the server answers.
  const reach = useReach();
  const { refetch: checkHealth } = health;
  useEffect(() => {
    if (reach === "lost") void checkHealth();
  }, [reach, checkHealth]);
  const connection = connectionOf(health.data, health.isError || reach === "lost");
  const opened = useOpened(pathname, projectId);
  const here = openedAt(pathname);
  const recent = recentShown(opened, here);
  const atInstance = pathname === "/instance" || pathname.startsWith("/instance/");
  const instanceView = atInstance ? pathname.split("/")[2] || "overview" : "";
  const instanceNav =
    atInstance && instanceAccess && reachesInstance(instanceAccess)
      ? instanceSectionsFor(instanceAccess)
      : [];
  const can = useProjectCan(current?.id);
  // Settings appear to whoever may change something there.
  const sectionsHere = projectSections.filter((item) =>
    item.id === "settings"
      ? mayOpenSettings(can)
      : // Production is a music project's, for the roles that see its sessions and takes or its
        // production tools.
        item.id !== "sessions" ||
        (current?.profile === "music" && (can("view_takes") || can("view_production"))),
  );
  // Production opens at its sessions, or at the repertoire for a role that sees no sessions.
  const destinationOf = (item: (typeof projectSections)[number]) =>
    item.id === "sessions" && !can("view_takes") ? "/projects/$projectId/repertoire" : item.to;
  const waitingAll = reviews?.filter((r) => r.yourTurn && r.status === "open") ?? [];
  const waitingHere = current ? waitingAll.filter((r) => r.projectId === current.id) : waitingAll;
  // Home and the inbox list what waits on you themselves; the sidebar would repeat it (#613).
  const showNeedsYou = waitingHere.length > 0 && !listsNeedsYou(pathname) && !atInstance;
  // The prototype's counts (#618): reviews in this project waiting on you, and your open tasks.
  const tasks = useQuery({
    ...projectTasksQuery(current?.id ?? ""),
    enabled: Boolean(current) && can("view"),
  });
  const myTasks =
    tasks.data?.tasks.filter((t) => t.assignee?.id === signedIn?.user.id && t.status !== "done")
      .length ?? 0;
  const countOf = (id: string) =>
    id === "reviews" ? waitingHere.length : id === "tasks" ? myTasks : 0;
  const switcher = switcherOrder(projects, current?.id, opened);

  const navigate = useNavigate();
  const [palette, setPalette] = useState(false);
  const say = useAnnounce();
  const toggleSidebar = useCallback(() => {
    setCollapsed(!collapsed);
    say(collapsed ? "Sidebar shown" : "Sidebar hidden");
  }, [collapsed, setCollapsed, say]);

  // Ctrl or ⌘ K opens the palette anywhere, "/" outside a field, under one name (#699); "["
  // shows or hides the labels, as in Linear; "g" then h, i or p jumps. The palette, once open,
  // keeps its keys.
  useShortcuts("global", "Everywhere", [
    {
      keys: ["Mod+K", "/"],
      label: "Search and commands",
      run: () => setPalette((open) => !open),
      anywhere: true,
    },
    { keys: ["["], label: "Show or hide the sidebar", run: toggleSidebar },
    { keys: ["g h"], label: "Go home", run: () => void navigate({ to: "/" }) },
    { keys: ["g i"], label: "Go to the inbox", run: () => void navigate({ to: "/inbox" }) },
    { keys: ["g p"], label: "Go to projects", run: () => void navigate({ to: "/projects" }) },
  ]);

  return (
    // The app's uploads live here, not on the page that started them (#552).
    <UploadQueueProvider>
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
          <div
            className={cn("flex h-9 items-center gap-1 px-1", collapsed && "justify-center px-0")}
          >
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
              {/* With a project open, only its section is current: Projects never lights up
                beside it, as Linear's fixed links do not with a child (#612). */}
              <NavItem
                to="/projects"
                icon="folder"
                label="Projects"
                collapsed={collapsed}
                exact={Boolean(projectId)}
              />
              {current ? (
                <>
                  <div className="mt-4 mb-1">
                    <ProjectSwitcher project={current} projects={switcher} collapsed={collapsed} />
                  </div>
                  {sectionsHere.map((item) => {
                    const count = countOf(item.id);
                    return (
                      <Link
                        key={item.id}
                        to={destinationOf(item)}
                        params={{ projectId: current.id }}
                        // Marked by `sectionAt`; the router's own match is only ever the same item.
                        activeOptions={{ exact: true, includeSearch: false }}
                        title={collapsed ? item.label : undefined}
                        aria-label={
                          collapsed && count ? `${item.label}, ${count} for you` : undefined
                        }
                        aria-current={section === item.id ? "page" : undefined}
                        className={cn(
                          navClass,
                          "aria-[current=page]:bg-raised aria-[current=page]:text-ink aria-[current=page]:shadow-1",
                          collapsed && "justify-center px-0",
                        )}
                      >
                        <Icon name={item.icon} />
                        {!collapsed && <span className="truncate">{item.label}</span>}
                        {count > 0 && !collapsed && (
                          <span className="tabular ml-auto text-[12px] text-ink-3">{count}</span>
                        )}
                      </Link>
                    );
                  })}
                </>
              ) : instanceNav.length > 0 ? (
                <>
                  <div
                    className={cn(
                      "mt-4 mb-1 flex h-10 items-center gap-2.5 px-2",
                      collapsed && "justify-center px-0",
                    )}
                  >
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-[6px] bg-raised text-ink-2">
                      <Icon name="instance" size={14} />
                    </span>
                    {!collapsed && (
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14px] font-medium text-ink">
                          Instance
                        </span>
                        <span className="block truncate text-[11px] text-ink-3">
                          {window.location.host}
                        </span>
                      </span>
                    )}
                  </div>
                  {instanceNav.map((id) => (
                    <Link
                      key={id}
                      to={id === "overview" ? "/instance" : "/instance/$section"}
                      params={{ section: id }}
                      activeOptions={{ exact: true }}
                      title={collapsed ? instanceSections[id].label : undefined}
                      aria-current={instanceView === id ? "page" : undefined}
                      className={cn(
                        navClass,
                        "aria-[current=page]:bg-raised aria-[current=page]:text-ink aria-[current=page]:shadow-1",
                        collapsed && "justify-center px-0",
                      )}
                    >
                      <Icon name={instanceIcons[id]} />
                      {!collapsed && <span className="truncate">{instanceSections[id].label}</span>}
                    </Link>
                  ))}
                </>
              ) : null}
            </div>
            {showNeedsYou && (
              <SideSection title="Needs you" count={waitingHere.length} collapsed={collapsed}>
                {waitingHere.slice(0, 4).map((r) => (
                  <Link
                    key={r.id}
                    to="/reviews/$reviewId"
                    params={{ reviewId: r.id }}
                    className={sideLink}
                  >
                    {/* Your turn: the signal, as for whatever needs a person (#613). */}
                    <span className="flex w-4 shrink-0 items-center justify-center">
                      <NeedsYouDot />
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
            {/* The prototype's Recent (#618): the last things this person opened here. */}
            {!atInstance && recent.length > 0 && (
              <SideSection title="Recent" collapsed={collapsed}>
                {recent.map((o) => (
                  <RecentLink key={`${o.kind}-${o.id}`} opened={o} />
                ))}
              </SideSection>
            )}
          </div>
          <div className="mt-2 flex flex-col gap-1 border-t border-line pt-2">
            <button
              type="button"
              onClick={() => setCollapsed(!collapsed)}
              // Named by its word while it shows one; by what it does once only the icon is left.
              aria-label={collapsed ? "Show labels" : undefined}
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
            <ConnectionFoot connection={connection} collapsed={collapsed} />
          </div>
        </nav>

        <div className="relative z-10 flex min-h-0 min-w-0 flex-1 flex-col @3xl/app:py-2.5 @3xl/app:pr-2.5">
          <Pane>
            <HeaderSlotsProvider slots={slots}>
              <TopBar onTrail={onTrail} onActions={onActions} onSearch={() => setPalette(true)} />
              {current && (
                <SubNav
                  label={current.name}
                  className="shrink-0 gap-1 border-b border-line px-3 py-1.5 @3xl/app:hidden"
                >
                  {sectionsHere.map((item) => (
                    <Link
                      key={item.id}
                      to={destinationOf(item)}
                      params={{ projectId: current.id }}
                      activeOptions={{ exact: true, includeSearch: false }}
                      aria-current={section === item.id ? "page" : undefined}
                      className="h-7 shrink-0 rounded-control px-2.5 text-[13px] leading-7 whitespace-nowrap text-ink-3 transition-colors aria-[current=page]:bg-raised aria-[current=page]:text-ink"
                    >
                      {item.label}
                    </Link>
                  ))}
                </SubNav>
              )}
              {instanceNav.length > 1 && (
                <SubNav
                  label="Instance"
                  className="shrink-0 gap-1 border-b border-line px-3 py-1.5 @3xl/app:hidden"
                >
                  {instanceNav.map((id) => (
                    <Link
                      key={id}
                      to={id === "overview" ? "/instance" : "/instance/$section"}
                      params={{ section: id }}
                      activeOptions={{ exact: true }}
                      aria-current={instanceView === id ? "page" : undefined}
                      className="h-7 shrink-0 rounded-control px-2.5 text-[13px] leading-7 whitespace-nowrap text-ink-3 transition-colors aria-[current=page]:bg-raised aria-[current=page]:text-ink"
                    >
                      {instanceSections[id].label}
                    </Link>
                  ))}
                </SubNav>
              )}
              {/* A phone has no sidebar foot, so losing the server says so above the page. */}
              {(connection.state === "unreachable" || connection.state === "degraded") && (
                <p
                  role="status"
                  className="m-0 flex shrink-0 items-center gap-2 border-b border-line px-4 py-2 text-[13px] text-ink-2 @3xl/app:hidden"
                >
                  <StateDot state="major" />
                  {connectionWords[connection.state]}. {tryingAgain}.
                </p>
              )}
              <main className="scroll-quiet min-h-0 min-w-0 flex-1 overflow-auto">{page}</main>
              <UploadTray />
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
    </UploadQueueProvider>
  );
}

/**
 * Guests see no navigation: their reviews, and the way out. The workspace's logo leads where it
 * has one (#185); otherwise Hekate's lockup does.
 */
export function GuestFrame({
  account,
  logo,
  children,
}: {
  account: ReactNode;
  logo?: { url: string; width: number; height: number; name: string } | null;
  children: ReactNode;
}) {
  const [slots, onTrail, onActions] = useHeaderSlots();
  return (
    <div className="relative flex h-full flex-col @3xl/app:p-2.5">
      <Ambient />
      <Pane>
        <HeaderSlotsProvider slots={slots}>
          <header className="relative flex min-h-12 shrink-0 flex-wrap items-center gap-x-3 border-b border-line px-3 @3xl/app:flex-nowrap @3xl/app:px-6">
            <Link to="/g" className="flex shrink-0 items-center" aria-label="Your reviews">
              {logo ? (
                <WorkspaceLogo logo={logo} name={logo.name} height={24} maxWidth={140} />
              ) : (
                <Lockup size={18} />
              )}
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
