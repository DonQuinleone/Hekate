import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { Avatar } from "~/components/avatar";
import { Lockup, Mark } from "~/components/brand";
import { Icon, type IconName } from "~/components/icons";
import { Trail, useCurrentHeader } from "~/components/page-header";
import { Button } from "~/components/ui/button";
import { guests, organisation, personById } from "~/data";
import { cn } from "~/lib/cn";
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
        "relative flex h-[34px] shrink-0 items-center gap-2.5 rounded-control px-2.5 text-[13px] text-ink-2 no-underline hover:bg-raised hover:text-ink data-[status=active]:bg-raised data-[status=active]:text-ink data-[status=active]:shadow-1",
        collapsed && "justify-center px-0",
      )}
    >
      <Icon name={icon} />
      {!collapsed && <span className="truncate">{label}</span>}
      {count ? (
        <span
          className={cn(
            "tabular ml-auto rounded-chip bg-signal/15 px-1.5 text-[11px] leading-[18px] text-signal",
            collapsed && "absolute top-1 right-1 size-2 p-0 text-[0px] bg-signal",
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

/** The organisation, in the account area, where it can be switched. */
function AccountMenu() {
  const viewer = useViewer();
  const [open, setOpen] = useState(false);
  const person = personById(viewer.personId);
  const navigate = useNavigate();
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);
  return (
    <div className="relative" onPointerDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${person.name}`}
        onClick={() => setOpen((o) => !o)}
        className="flex h-8 items-center gap-2 rounded-full pr-0.5 pl-0.5 hover:bg-raised"
      >
        <Avatar personId={viewer.personId} size={28} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-40 mt-2 w-64 rounded-panel border border-edge bg-overlay p-1 shadow-3"
        >
          <div className="px-3 py-2">
            <div className="text-[13px] font-medium text-ink">{person.name}</div>
            <div className="truncate text-xs text-ink-3">{person.email}</div>
          </div>
          <div className="mx-1 my-1 h-px bg-hairline-soft" />
          <div className="label px-3 pt-1 pb-1">Organisation</div>
          <button
            type="button"
            role="menuitemradio"
            aria-checked="true"
            className="flex w-full items-center gap-2 rounded-control px-3 py-1.5 text-left text-[13px] text-ink hover:bg-raised"
          >
            <span className="tabular flex size-5 items-center justify-center rounded-chip bg-raised text-[10px] text-ink-2">
              EH
            </span>
            <span className="flex-1 truncate">{organisation.name}</span>
            <Icon name="check" size={14} />
          </button>
          <button
            type="button"
            role="menuitemradio"
            aria-checked="false"
            className="flex w-full items-center gap-2 rounded-control px-3 py-1.5 text-left text-[13px] text-ink-2 hover:bg-raised hover:text-ink"
          >
            <span className="tabular flex size-5 items-center justify-center rounded-chip bg-raised text-[10px]">
              NC
            </span>
            <span className="flex-1 truncate">North Choir Collective</span>
          </button>
          <div className="mx-1 my-1 h-px bg-hairline-soft" />
          {[
            { label: "Account", to: "/account" },
            { label: "Appearance and preferences", to: "/account/appearance" },
            ...(viewer.persona.organisationRole === "owner" ||
            viewer.persona.organisationRole === "admin"
              ? [{ label: "Organisation settings", to: "/settings" }]
              : []),
          ].map((item) => (
            <button
              key={item.to}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                navigate({ to: item.to });
              }}
              className="flex w-full rounded-control px-3 py-1.5 text-left text-[13px] text-ink hover:bg-raised"
            >
              {item.label}
            </button>
          ))}
          <div className="mx-1 my-1 h-px bg-hairline-soft" />
          <button
            type="button"
            role="menuitem"
            onClick={() => navigate({ to: "/sign-in" })}
            className="flex w-full rounded-control px-3 py-1.5 text-left text-[13px] text-ink-2 hover:bg-raised hover:text-ink"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

/** One bar: the trail and the page's actions. On a phone the actions take a row of their own under the title. */
function TopBar({ children }: { children?: ReactNode }) {
  const header = useCurrentHeader();
  return (
    <div className="shrink-0 border-b border-hairline">
      <header className="flex h-[52px] items-center gap-3 px-4 @3xl/app:px-6">
        {header ? <Trail spec={header} /> : <div className="flex-1" />}
        <div className="flex shrink-0 items-center gap-1">
          <span className="hidden items-center gap-1 @3xl/app:flex">{header?.actions}</span>
          {children}
        </div>
      </header>
      {header?.actions && (
        <div className="flex items-center gap-1 overflow-x-auto px-4 pb-2 @3xl/app:hidden">
          {header.actions}
        </div>
      )}
    </div>
  );
}

function SearchButton() {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate({ to: "/search" })}
      className="hidden h-8 w-52 items-center gap-2 rounded-control border border-hairline bg-surface px-2.5 text-[13px] text-ink-3 shadow-1 hover:border-edge hover:text-ink-2 @5xl/app:flex"
    >
      <Icon name="search" size={14} />
      <span className="flex-1 text-left">Search</span>
      <kbd className="tabular rounded-chip border border-edge px-1 text-[10px]">/</kbd>
    </button>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const viewer = useViewer();
  const [collapsed, setCollapsed] = useCollapsed();
  const navigate = useNavigate();
  const waiting = viewer.reviews().filter((r) => {
    const me = viewer.reviewerIn(r);
    return (
      r.status === "open" &&
      me &&
      (me.state === "invited" || me.state === "viewed" || me.state === "in_progress")
    );
  }).length;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=true]")) return;
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
          "hidden shrink-0 flex-col border-r border-hairline bg-nav @3xl/app:flex",
          collapsed ? "w-14" : "w-60",
        )}
      >
        <div className={cn("flex h-[52px] items-center px-4", collapsed && "justify-center px-0")}>
          <Link to="/" className="flex items-center no-underline" aria-label="Hekate home">
            {collapsed ? <Mark size={18} /> : <Lockup size={18} />}
          </Link>
        </div>
        <div className={cn("flex flex-col gap-0.5 px-2.5", collapsed && "px-2")}>
          <NavItem to="/" icon="home" label="Home" collapsed={collapsed} exact />
          <NavItem
            to="/reviews"
            icon="review"
            label="Reviews"
            collapsed={collapsed}
            count={waiting}
          />
          <NavItem to="/projects" icon="folder" label="Projects" collapsed={collapsed} />
          {!collapsed && projects.length > 0 && (
            <ul className="m-0 ml-[18px] flex list-none flex-col gap-px border-l border-hairline-soft p-0 pl-3">
              {projects.slice(0, 8).map((p) => (
                <li key={p.id}>
                  <Link
                    to="/projects/$projectId"
                    params={{ projectId: p.id }}
                    className="flex h-7 items-center truncate rounded-control px-2 text-[13px] text-ink-3 no-underline hover:bg-raised hover:text-ink data-[status=active]:bg-raised data-[status=active]:text-ink"
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
        <div
          className={cn(
            "mt-auto flex flex-col gap-1 border-t border-hairline-soft px-3 py-3",
            collapsed && "items-center px-2",
          )}
        >
          <div
            className={cn("flex items-center gap-2 px-1 text-xs text-ink-3", collapsed && "px-0")}
            title="Connected"
          >
            <span aria-hidden="true" className="size-[6px] rounded-full bg-ink" />
            {!collapsed && <span className="flex-1">Connected</span>}
            {!collapsed && <span className="tabular text-[11px]">v0.2.0</span>}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? "Show labels" : "Show icons only"}
            title={`${collapsed ? "Show labels" : "Show icons only"} ([)`}
            className={cn("justify-start text-ink-3", collapsed && "justify-center px-0")}
          >
            <Icon name="sidebar" />
            {!collapsed && <span>Icons only</span>}
          </Button>
        </div>
      </nav>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <TopBar>
          <SearchButton />
          <Link
            to="/notifications"
            aria-label="Notifications"
            className="relative flex size-8 items-center justify-center rounded-control text-ink-2 no-underline hover:bg-raised hover:text-ink"
          >
            <Icon name="bell" />
            <span
              aria-hidden="true"
              className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-signal"
            />
          </Link>
          <AccountMenu />
        </TopBar>
        <main className="min-h-0 min-w-0 flex-1 overflow-auto">{children}</main>
        <nav
          aria-label="Main"
          className="flex h-14 shrink-0 items-stretch border-t border-hairline bg-nav @3xl/app:hidden"
        >
          {[
            { to: "/", icon: "home" as const, label: "Home", exact: true, count: 0 },
            {
              to: "/reviews",
              icon: "review" as const,
              label: "Reviews",
              exact: false,
              count: waiting,
            },
            { to: "/projects", icon: "folder" as const, label: "Projects", exact: false, count: 0 },
            { to: "/members", icon: "users" as const, label: "Members", exact: false, count: 0 },
          ].map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeOptions={{ exact: item.exact }}
              className="relative flex flex-1 flex-col items-center justify-center gap-0.5 text-[11px] text-ink-3 no-underline data-[status=active]:text-ink"
            >
              <Icon name={item.icon} size={18} />
              <span>{item.label}</span>
              {item.count ? (
                <span className="absolute top-2 right-[calc(50%-18px)] size-1.5 rounded-full bg-signal" />
              ) : null}
            </Link>
          ))}
        </nav>
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
    <div className="flex h-full flex-col">
      <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-hairline bg-nav px-4 @3xl/app:px-6">
        <Link to="/g" className="flex items-center no-underline" aria-label="Your reviews">
          <Lockup size={18} />
        </Link>
        <span className="hidden text-xs text-ink-3 @3xl/app:inline">for {organisation.name}</span>
        <div className="mx-2 hidden h-5 w-px bg-hairline @3xl/app:block" />
        {header ? <Trail spec={header} compact /> : <div className="flex-1" />}
        <div className="flex items-center gap-2">
          {header?.actions}
          <div className="hidden flex-col items-end leading-tight @3xl/app:flex">
            <span className="text-[13px] text-ink">{person.name}</span>
            <span className="text-[11px] text-ink-3">{label ?? "Guest"}</span>
          </div>
          <Avatar personId={viewer.personId} size={28} />
          <Button variant="ghost" size="sm" onClick={() => navigate({ to: "/guest" })}>
            Sign out
          </Button>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-auto">{children}</main>
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
        className="hidden w-60 shrink-0 flex-col border-r border-hairline bg-nav @3xl/app:flex"
      >
        <div className="flex h-[52px] items-center gap-2 px-4">
          <Lockup size={18} />
          <span className="label">Instance</span>
        </div>
        <div className="flex flex-col gap-0.5 px-2.5">
          <NavItem to="/instance" icon="home" label="Overview" collapsed={false} exact />
          <NavItem to="/instance/tenants" icon="users" label="Tenants" collapsed={false} />
          <NavItem
            to="/instance/settings"
            icon="settings"
            label="Instance settings"
            collapsed={false}
          />
          <NavItem to="/instance/operations" icon="pulse" label="Operations" collapsed={false} />
        </div>
      </nav>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-hairline px-4 @3xl/app:px-6">
          {header ? <Trail spec={header} /> : <div className="flex-1" />}
          <div className="flex items-center gap-1">
            {header?.actions}
            <AccountMenu />
          </div>
        </header>
        <main className="min-h-0 min-w-0 flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}
