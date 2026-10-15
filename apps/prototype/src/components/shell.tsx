import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { Avatar } from "~/components/avatar";
import { Lockup, Mark } from "~/components/brand";
import { Icon, type IconName } from "~/components/icons";
import { NotificationsMenu } from "~/components/notifications";
import { Trail, useCurrentHeader } from "~/components/page-header";
import { Dot, reviewDot } from "~/components/status";
import { MenuList, usePopover } from "~/components/ui/menu";
import { fileById, guests, organisation, personById, projectById, reviewById } from "~/data";
import { cn } from "~/lib/cn";
import { inField } from "~/lib/dom";
import { needsYou, reviewOutcome } from "~/lib/reviews";
import { useViewer } from "~/viewer/context";

function NavItem({
  to,
  icon,
  label,
  collapsed,
  count,
  exact = false,
}: {
  to: string;
  icon: IconName;
  label: string;
  collapsed: boolean;
  count?: number;
  exact?: boolean;
}) {
  return (
    <Link
      to={to}
      activeOptions={{ exact }}
      title={collapsed ? label : undefined}
      className={cn(
        "relative flex h-8 shrink-0 items-center gap-2.5 rounded-control px-2.5 text-[14px] text-ink-2 transition-colors duration-150 hover:bg-raised/60 hover:text-ink data-[status=active]:bg-raised data-[status=active]:text-ink data-[status=active]:shadow-1",
        collapsed && "justify-center px-0",
      )}
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

const SIDEBAR_KEY = "hekate.prototype.sidebar";

function useCollapsed(): [boolean, (next: boolean) => void] {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_KEY) === "collapsed";
    } catch {
      return false;
    }
  });
  const set = (next: boolean) => {
    setCollapsed(next);
    try {
      localStorage.setItem(SIDEBAR_KEY, next ? "collapsed" : "expanded");
    } catch {
      // Not remembered.
    }
  };
  return [collapsed, set];
}

/** The account and the organisation, at the foot of the sidebar; the menu opens upward. */
function WorkspaceMenu({ collapsed }: { collapsed: boolean }) {
  const viewer = useViewer();
  const [open, setOpen, box] = usePopover();
  const person = personById(viewer.personId);
  const navigate = useNavigate();
  const elevated =
    viewer.persona.organisationRole === "owner" || viewer.persona.organisationRole === "admin";
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${person.name}, ${organisation.name}`}
        onClick={() => setOpen(!open)}
        className={cn(
          "flex h-11 w-full items-center gap-2.5 rounded-control px-2 text-left transition-colors hover:bg-raised/60",
          open && "bg-raised/60",
          collapsed && "justify-center px-0",
        )}
      >
        <Avatar personId={viewer.personId} size={28} />
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-ink">{person.name}</span>
              <span className="block truncate text-[12px] text-ink-3">{organisation.name}</span>
            </span>
            <Icon name="chevronUp" size={12} className="text-ink-3" />
          </>
        )}
      </button>
      {open && (
        <div className="rise-in absolute bottom-full left-0 z-40 mb-1.5 w-64 rounded-panel-lg bg-overlay p-1 shadow-4">
          <div className="flex items-center gap-2.5 px-2.5 py-2">
            <Avatar personId={viewer.personId} size={30} />
            <div className="min-w-0">
              <div className="truncate text-[14px] font-medium text-ink">{person.name}</div>
              <div className="truncate text-[13px] text-ink-3">{person.email}</div>
            </div>
          </div>
          <MenuList
            className="relative mt-0 min-w-0 bg-transparent p-0 shadow-none"
            onClose={() => setOpen(false)}
            actions={[
              { label: "Your account", onSelect: () => navigate({ to: "/account" }) },
              {
                label: "Appearance",
                onSelect: () =>
                  navigate({ to: "/account/$section", params: { section: "appearance" } }),
              },
            ]}
          />
          <div className="mx-2 my-1 h-px bg-line" />
          <div className="eyebrow px-2.5 pt-1 pb-1">Organisation</div>
          {[
            { label: organisation.name, code: "EH", current: true },
            { label: "North Choir Collective", code: "NC", current: false },
          ].map((o) => (
            <button
              key={o.label}
              type="button"
              role="menuitemradio"
              aria-checked={o.current}
              onClick={() => setOpen(false)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-control px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-raised",
                o.current ? "text-ink" : "text-ink-2",
              )}
            >
              <span className="flex size-5 items-center justify-center rounded-chip bg-raised text-[10px] font-medium text-ink-2">
                {o.code}
              </span>
              <span className="flex-1 truncate">{o.label}</span>
              {o.current && <Icon name="check" size={14} />}
            </button>
          ))}
          <MenuList
            className="relative mt-0 min-w-0 bg-transparent p-0 shadow-none"
            onClose={() => setOpen(false)}
            actions={[
              ...(elevated
                ? [
                    {
                      label: "Organisation settings",
                      onSelect: () => navigate({ to: "/settings" }),
                    },
                  ]
                : []),
              { label: "Invite people", onSelect: () => navigate({ to: "/members" }) },
              "divider",
              { label: "Sign out", onSelect: () => navigate({ to: "/sign-in" }) },
            ]}
          />
        </div>
      )}
    </div>
  );
}

/** One bar: the trail and the page's actions. On a phone the actions take a row of their own. */
function TopBar({ children }: { children?: ReactNode }) {
  const header = useCurrentHeader();
  return (
    <div className="shrink-0 border-b border-line">
      <header className="flex h-12 items-center gap-3 px-3 @3xl/app:px-6">
        {header ? <Trail spec={header} /> : <div className="flex-1" />}
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="hidden items-center gap-1.5 @3xl/app:flex">{header?.actions}</span>
          {children}
        </div>
      </header>
      {header?.actions && (
        <div className="flex items-center gap-1.5 overflow-x-auto px-3 pb-2 @3xl/app:hidden">
          {header.actions}
        </div>
      )}
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

function SideLink({
  to,
  params,
  search,
  lead,
  label,
  hint,
}: {
  to: string;
  params?: Record<string, string>;
  search?: Record<string, string>;
  lead: ReactNode;
  label: string;
  hint?: string;
}) {
  return (
    <Link
      to={to}
      params={params}
      search={search}
      className="flex h-8 items-center gap-2.5 rounded-control px-2.5 text-[13px] text-ink-2 transition-colors hover:bg-raised/60 hover:text-ink data-[status=active]:bg-raised data-[status=active]:text-ink"
    >
      <span className="flex w-4 shrink-0 items-center justify-center">{lead}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {hint && <span className="shrink-0 truncate text-[12px] text-ink-3">{hint}</span>}
    </Link>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const viewer = useViewer();
  const [collapsed, setCollapsed] = useCollapsed();
  const navigate = useNavigate();
  const waitingReviews = viewer.reviews().filter((r) => needsYou(r, viewer.reviewerIn(r)));
  const waiting = waitingReviews.length;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (inField(event)) return;
      if (event.key === "[") setCollapsed(!collapsed);
      if (event.key === "/") {
        event.preventDefault();
        navigate({ to: "/search" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [collapsed, setCollapsed, navigate]);

  const projects = viewer.projects();
  const elevated =
    viewer.persona.organisationRole === "owner" || viewer.persona.organisationRole === "admin";
  const recent = [
    { kind: "file", id: "file-maple-v2-dry", label: "Maple Leaf Rag · V2 Dry" },
    { kind: "review", id: "rev-masters", label: "Album masters" },
    { kind: "file", id: "file-titles-c3", label: "Opening titles · cut 3" },
  ].filter((r) => {
    if (r.kind === "file") return viewer.fileAccess(r.id) !== null;
    const review = reviewById(r.id);
    return review ? viewer.canSee(review.projectId) || viewer.reviewerIn(review) : false;
  });

  return (
    <div className="flex h-full flex-col @3xl/app:flex-row">
      <nav
        aria-label="Main"
        className={cn(
          "hidden shrink-0 flex-col px-2.5 pt-3 pb-2.5 transition-[width] duration-200 @3xl/app:flex",
          collapsed ? "w-14" : "w-[240px]",
        )}
      >
        <div className={cn("flex h-9 items-center gap-1 px-1", collapsed && "flex-col gap-2 px-0")}>
          <Link
            to="/"
            aria-label="Home"
            className="flex min-w-0 flex-1 items-center rounded-control px-1 py-1 text-ink transition-opacity hover:opacity-80"
          >
            {collapsed ? <Mark size={22} /> : <Lockup size={20} />}
          </Link>
          <button
            type="button"
            aria-label="Search"
            title="Search (/)"
            onClick={() => navigate({ to: "/search" })}
            className="flex size-8 shrink-0 items-center justify-center rounded-control text-ink-3 transition-colors hover:bg-raised/60 hover:text-ink"
          >
            <Icon name="search" />
          </button>
        </div>
        <div className="scroll-quiet mt-5 flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className={cn("flex flex-col gap-0.5", collapsed && "items-stretch")}>
            <NavItem to="/" icon="dashboard" label="Home" collapsed={collapsed} exact />
            <NavItem to="/inbox" icon="inbox" label="Inbox" collapsed={collapsed} count={waiting} />
            <NavItem to="/projects" icon="folder" label="Projects" collapsed={collapsed} />
            {!collapsed && projects.length > 0 && (
              <ul className="mb-1 ml-[21px] flex flex-col gap-px border-l border-line pl-2.5">
                {projects.slice(0, 8).map((p) => (
                  <li key={p.id}>
                    <Link
                      to="/projects/$projectId"
                      params={{ projectId: p.id }}
                      className="flex h-7 items-center truncate rounded-control px-2 text-[13px] text-ink-3 transition-colors hover:bg-raised/60 hover:text-ink data-[status=active]:text-ink"
                    >
                      <span className="truncate">{p.name}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <NavItem to="/members" icon="users" label="Members" collapsed={collapsed} />
            {elevated && (
              <NavItem to="/settings" icon="settings" label="Settings" collapsed={collapsed} />
            )}
          </div>
          {waiting > 0 && (
            <SideSection title="Waiting on you" count={waiting} collapsed={collapsed}>
              {waitingReviews.slice(0, 4).map((r) => (
                <SideLink
                  key={r.id}
                  to="/reviews/$reviewId"
                  params={{ reviewId: r.id }}
                  lead={<Dot state={reviewDot(r.status, reviewOutcome(r))} />}
                  label={r.title}
                  hint={projectById(r.projectId)?.name.split(" ")[0]}
                />
              ))}
              {waiting > 4 && (
                <Link to="/inbox" className="px-2.5 text-[12px] text-ink-3 hover:text-ink">
                  and {waiting - 4} more
                </Link>
              )}
            </SideSection>
          )}
          {recent.length > 0 && (
            <SideSection title="Recent" collapsed={collapsed}>
              {recent.map((r) =>
                r.kind === "file" ? (
                  <SideLink
                    key={r.id}
                    to="/files/$fileId"
                    params={{ fileId: r.id }}
                    lead={
                      <Icon
                        name={fileById(r.id)?.kind === "video" ? "film" : "music"}
                        size={14}
                        className="text-ink-3"
                      />
                    }
                    label={r.label}
                  />
                ) : (
                  <SideLink
                    key={r.id}
                    to="/reviews/$reviewId"
                    params={{ reviewId: r.id }}
                    lead={<Icon name="review" size={14} className="text-ink-3" />}
                    label={r.label}
                  />
                ),
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

      <div className="flex min-h-0 min-w-0 flex-1 flex-col @3xl/app:py-2.5 @3xl/app:pr-2.5">
        <Pane>
          <TopBar>
            <NotificationsMenu waiting={waiting} />
          </TopBar>
          <main className="scroll-quiet min-h-0 min-w-0 flex-1 overflow-auto">{children}</main>
          <nav
            aria-label="Main"
            className="flex h-14 shrink-0 items-stretch border-t border-line bg-ground @3xl/app:hidden"
          >
            {[
              { to: "/", icon: "dashboard" as const, label: "Home", exact: true, count: 0 },
              {
                to: "/inbox",
                icon: "inbox" as const,
                label: "Inbox",
                exact: false,
                count: waiting,
              },
              {
                to: "/projects",
                icon: "folder" as const,
                label: "Projects",
                exact: false,
                count: 0,
              },
              { to: "/account", icon: "user" as const, label: "You", exact: false, count: 0 },
            ].map((item) => (
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
          </nav>
        </Pane>
      </div>
    </div>
  );
}

/** Guests see no navigation: their reviews, and the way out. */
export function GuestShell({ children }: { children: ReactNode }) {
  const viewer = useViewer();
  const person = personById(viewer.personId);
  const label = guests.find((g) => g.personId === viewer.personId)?.label;
  const header = useCurrentHeader();
  const navigate = useNavigate();
  return (
    <div className="flex h-full flex-col @3xl/app:p-2.5">
      <Pane>
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-3 @3xl/app:px-6">
          <Link to="/g" className="flex items-center" aria-label="Your reviews">
            <Lockup size={18} />
          </Link>
          <div className="mx-1 hidden h-5 w-px bg-line-strong @3xl/app:block" />
          {header ? <Trail spec={header} compact /> : <div className="flex-1" />}
          <div className="flex items-center gap-2">
            <span className="hidden items-center gap-1.5 @3xl/app:flex">{header?.actions}</span>
            <div className="hidden flex-col items-end leading-tight @3xl/app:flex">
              <span className="text-[13px] text-ink">{person.name}</span>
              <span className="text-[12px] text-ink-3">{label ?? "Guest"}</span>
            </div>
            <Avatar personId={viewer.personId} size={28} />
            <button
              type="button"
              onClick={() => navigate({ to: "/guest" })}
              className="h-8 rounded-control px-2.5 text-[13px] text-ink-3 transition-colors hover:bg-raised hover:text-ink"
            >
              Sign out
            </button>
          </div>
        </header>
        {header?.actions && (
          <div className="flex items-center gap-1.5 border-b border-line px-3 py-2 @3xl/app:hidden">
            {header.actions}
          </div>
        )}
        <main className="scroll-quiet min-h-0 flex-1 overflow-auto">{children}</main>
      </Pane>
    </div>
  );
}

/** The operator's side: tenants and the instance, nothing of the content. */
export function InstanceShell({ children }: { children: ReactNode }) {
  const header = useCurrentHeader();
  return (
    <div className="flex h-full flex-col @3xl/app:flex-row">
      <nav
        aria-label="Instance"
        className="hidden w-[240px] shrink-0 flex-col px-2.5 pt-3 pb-3 @3xl/app:flex"
      >
        <div className="flex h-9 items-center gap-2 px-2">
          <Lockup size={20} />
          <span className="eyebrow">Instance</span>
        </div>
        <div className="mt-5 flex flex-col gap-0.5">
          <NavItem to="/instance" icon="dashboard" label="Overview" collapsed={false} exact />
          <NavItem to="/instance/tenants" icon="building" label="Tenants" collapsed={false} />
          <NavItem to="/instance/settings" icon="settings" label="Settings" collapsed={false} />
          <NavItem to="/instance/operations" icon="pulse" label="Operations" collapsed={false} />
        </div>
      </nav>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col @3xl/app:py-2.5 @3xl/app:pr-2.5">
        <Pane>
          <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-3 @3xl/app:px-6">
            {header ? <Trail spec={header} /> : <div className="flex-1" />}
            <div className="flex items-center gap-1.5">{header?.actions}</div>
          </header>
          <main className="scroll-quiet min-h-0 min-w-0 flex-1 overflow-auto">{children}</main>
        </Pane>
      </div>
    </div>
  );
}
