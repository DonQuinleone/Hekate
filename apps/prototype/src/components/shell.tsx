import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { Avatar } from "~/components/avatar";
import { Lockup, Mark } from "~/components/brand";
import { Icon, type IconName } from "~/components/icons";
import { Trail, useCurrentHeader } from "~/components/page-header";
import { MenuList, usePopover } from "~/components/ui/menu";
import { guests, organisation, personById } from "~/data";
import { cn } from "~/lib/cn";
import { inField } from "~/lib/dom";
import { needsYou } from "~/lib/reviews";
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

/** The organisation and the account, in one place at the top of the sidebar. */
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
        aria-label={`${organisation.name}, ${person.name}`}
        onClick={() => setOpen(!open)}
        className={cn(
          "flex h-9 w-full items-center gap-2.5 rounded-control px-2 text-left transition-colors hover:bg-raised/60",
          open && "bg-raised/60",
          collapsed && "justify-center px-0",
        )}
      >
        <Mark size={20} />
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">
              {organisation.name}
            </span>
            <Icon name="chevronDown" size={12} className="text-ink-3" />
          </>
        )}
      </button>
      {open && (
        <div className="rise-in absolute left-0 z-40 mt-1 w-64 rounded-panel bg-overlay p-1 shadow-3">
          <div className="flex items-center gap-2.5 px-2.5 py-2">
            <Avatar personId={viewer.personId} size={30} />
            <div className="min-w-0">
              <div className="truncate text-[14px] font-medium text-ink">{person.name}</div>
              <div className="truncate text-[13px] text-ink-3">{person.email}</div>
            </div>
          </div>
          <div className="mx-2 my-1 h-px bg-line" />
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
          <div className="mx-2 my-1 h-px bg-line" />
          <MenuList
            className="relative mt-0 min-w-0 bg-transparent p-0 shadow-none"
            onClose={() => setOpen(false)}
            actions={[
              { label: "Account", onSelect: () => navigate({ to: "/account" }) },
              {
                label: "Appearance",
                onSelect: () =>
                  navigate({ to: "/account/$section", params: { section: "appearance" } }),
              },
              ...(elevated
                ? [
                    {
                      label: "Organisation settings",
                      onSelect: () => navigate({ to: "/settings" }),
                    },
                  ]
                : []),
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
      <header className="flex h-12 items-center gap-3 px-3 @3xl/app:px-5">
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

export function Shell({ children }: { children: ReactNode }) {
  const viewer = useViewer();
  const [collapsed, setCollapsed] = useCollapsed();
  const navigate = useNavigate();
  const waiting = viewer.reviews().filter((r) => needsYou(r, viewer.reviewerIn(r))).length;

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

  return (
    <div className="flex h-full flex-col @3xl/app:flex-row">
      <nav
        aria-label="Main"
        className={cn(
          "hidden shrink-0 flex-col px-2.5 pt-2.5 pb-3 transition-[width] duration-200 @3xl/app:flex",
          collapsed ? "w-14" : "w-[232px]",
        )}
      >
        <div className={cn("flex items-center gap-1", collapsed && "flex-col")}>
          <div className="min-w-0 flex-1">
            <WorkspaceMenu collapsed={collapsed} />
          </div>
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
        <div className={cn("mt-4 flex flex-col gap-0.5", collapsed && "items-stretch")}>
          <NavItem to="/" icon="inbox" label="Inbox" collapsed={collapsed} count={waiting} exact />
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
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? "Show labels" : "Show icons only"}
          title={`${collapsed ? "Show labels" : "Show icons only"} ([)`}
          className={cn(
            "mt-auto flex h-8 items-center gap-2.5 rounded-control px-2.5 text-[13px] text-ink-3 transition-colors hover:bg-raised/60 hover:text-ink",
            collapsed && "justify-center px-0",
          )}
        >
          <Icon name="sidebar" />
          {!collapsed && <span>Collapse</span>}
        </button>
      </nav>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col @3xl/app:py-2.5 @3xl/app:pr-2.5">
        <Pane>
          <TopBar>
            <Link
              to="/notifications"
              aria-label="Notifications"
              className="relative flex size-8 items-center justify-center rounded-control text-ink-2 transition-colors hover:bg-raised hover:text-ink"
            >
              <Icon name="bell" />
              <span
                aria-hidden="true"
                className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-signal"
              />
            </Link>
          </TopBar>
          <main className="scroll-quiet min-h-0 min-w-0 flex-1 overflow-auto">{children}</main>
          <nav
            aria-label="Main"
            className="flex h-14 shrink-0 items-stretch border-t border-line bg-ground @3xl/app:hidden"
          >
            {[
              { to: "/", icon: "inbox" as const, label: "Inbox", exact: true, count: waiting },
              {
                to: "/projects",
                icon: "folder" as const,
                label: "Projects",
                exact: false,
                count: 0,
              },
              { to: "/members", icon: "users" as const, label: "Members", exact: false, count: 0 },
              { to: "/account", icon: "settings" as const, label: "You", exact: false, count: 0 },
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
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-3 @3xl/app:px-5">
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
        className="hidden w-[232px] shrink-0 flex-col px-2.5 pt-2.5 pb-3 @3xl/app:flex"
      >
        <div className="flex h-9 items-center gap-2 px-2">
          <Lockup size={18} />
          <span className="eyebrow">Instance</span>
        </div>
        <div className="mt-4 flex flex-col gap-0.5">
          <NavItem to="/instance" icon="home" label="Overview" collapsed={false} exact />
          <NavItem to="/instance/tenants" icon="users" label="Tenants" collapsed={false} />
          <NavItem to="/instance/settings" icon="settings" label="Settings" collapsed={false} />
          <NavItem to="/instance/operations" icon="pulse" label="Operations" collapsed={false} />
        </div>
      </nav>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col @3xl/app:py-2.5 @3xl/app:pr-2.5">
        <Pane>
          <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-3 @3xl/app:px-5">
            {header ? <Trail spec={header} /> : <div className="flex-1" />}
            <div className="flex items-center gap-1.5">{header?.actions}</div>
          </header>
          <main className="scroll-quiet min-h-0 min-w-0 flex-1 overflow-auto">{children}</main>
        </Pane>
      </div>
    </div>
  );
}
